// Reading an agent's operator reports (SPEC §4.7, ARCHITECTURE §6): find them on chain with public reads, keep only
// the posts the trust rule allows, then open them with the inbox key. Browser-safe: viem and the SDK only.
//
// The trust rule: a FindingsPosted post counts only when `ValidationRegistry.getValidationStatus(requestHash)` names
// that post's validator and agent. Anyone can post to the board; everything else is ignored.
//
// Two ways to find each verdict's reports, after the same chain reads of the agent's verdicts:
// - through the Envio indexer (P8, `findInboxEntriesViaIndexer`): one query for every post on those requests, each
//   then re-checked on chain (the trust rule against the chain's status, and the post's own receipt), with no limit
//   on how long after its verdict a report was posted;
// - on chain alone (`findInboxEntries`): the registry's `lastUpdate` gives the block the response landed in, and the
//   validator posts right after it, so the search covers the next REPORT_SEARCH_BLOCKS.
// `discoverInbox` uses the indexer when one is recorded and falls back to the chain when it fails; verdicts whose
// report window the indexer hasn't fully processed yet are searched on chain either way.
import { getAddress, TransactionReceiptNotFoundError, zeroHash, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { findingsPostedEvent, validationRegistryAbi, validationResponseEvent } from "./abi.ts";
import { NoBlockAtOrAfterError, blocksWithTimestamp, firstBlockAtOrAfter } from "./blocks.ts";
import type { Deployment, FindingsBoardDeployment } from "./deployments.ts";
import { openEnvelope, wipe, type EnvelopeProblem, type SecretTracker } from "./inbox-crypto.ts";
import { MAX_LOG_BLOCK_RANGE } from "./logs.ts";
import { decodeReport, type OperatorReport } from "./report.ts";
import { TrustApiError, findIndexedReports, postMatchesReceipt, type ReceiptLog, type TrustApiOptions } from "./trust-api.ts";

/** How far after its verdict a report is searched for: 600 blocks, about 3 minutes. */
export const REPORT_SEARCH_BLOCKS = 600n;
/** The most recent responses `findInboxEntries` looks at by default, per known validator. */
export const MAX_INBOX_RESPONSES = 20;
/**
 * The most recent responses from validators the reader doesn't know that discovery keeps (P12, AUD-03). Anyone holding
 * the agent's hot key can name any address as validator, answer as it, and post a report the trust rule accepts, so
 * such verdicts are listed apart and capped: they can never push a known validator's verdict out.
 */
export const MAX_OTHER_VALIDATOR_RESPONSES = 5;

/** `getValidationStatus(requestHash)`, with the hash it was read for. */
export interface InboxStatus {
  requestHash: Hex;
  validator: Address;
  agentId: bigint;
  response: number;
  responseHash: Hex;
  tag: string;
  lastUpdate: bigint;
}

/** One `FindingsPosted` log. */
export interface FindingsPost {
  requestHash: Hex;
  agentId: bigint;
  validator: Address;
  envelope: Hex;
  blockNumber: bigint;
  txHash: Hash;
  logIndex: number;
}

/** The public chain reads discovery needs. `viemInboxReader` is the real one. */
export interface InboxReader {
  head(): Promise<bigint>;
  blockTimestamp(block: bigint): Promise<bigint>;
  agentValidations(agentId: bigint): Promise<Hex[]>;
  statuses(hashes: Hex[]): Promise<InboxStatus[]>;
  /** `FindingsPosted` logs filtered by all three topics, over at most 100 blocks. */
  findingsLogs(f: { requestHash: Hex; agentId: bigint; validator: Address; fromBlock: bigint; toBlock: bigint }): Promise<FindingsPost[]>;
  /** The transaction of the last `ValidationResponse` for `requestHash` in the range, or `null`. */
  responseTx(f: { requestHash: Hex; fromBlock: bigint; toBlock: bigint }): Promise<Hash | null>;
}

/** An {@link InboxReader} that can also read a transaction's receipt logs (null for an unknown transaction). */
export interface IndexedInboxReader extends InboxReader {
  receiptLogs(txHash: Hash): Promise<readonly ReceiptLog[] | null>;
}

/** The trust rule for one post: the validator, the agent and the request the registry's status names. */
export function isTrustedPost(post: FindingsPost, status: InboxStatus): boolean {
  return (
    getAddress(post.validator) === getAddress(status.validator) &&
    post.agentId === status.agentId &&
    post.requestHash.toLowerCase() === status.requestHash.toLowerCase()
  );
}

/** One answered response for the agent, its response transaction, and the trusted posts found for it. */
export interface InboxEntry {
  status: InboxStatus;
  responseTx: Hash | null;
  posts: FindingsPost[];
  /** The last block searched for posts: on chain, the end of the window; through the indexer, its progress block. */
  searchedTo: bigint;
  /** How this entry's posts were found. */
  source: "indexer" | "chain";
  /** Whether the verdict's validator is one of the reader's `knownValidators` (P12, AUD-03). */
  validatorKnown: boolean;
}

/** A post the indexer listed that the chain doesn't carry as listed: dropped, and shown as a warning. */
export interface RejectedPost {
  post: FindingsPost;
  problem: "NOT_ON_CHAIN";
}

const answered = (s: InboxStatus) => s.responseHash !== zeroHash || s.tag !== "";

interface DiscoveryOptions {
  agentId: bigint;
  findingsBoard: FindingsBoardDeployment;
  /**
   * The validators the reader trusts to have written a report (for /inbox, `DEPLOYMENTS`' A, B and C). Each keeps its
   * own newest `maxResponses`; every other validator's verdicts share {@link MAX_OTHER_VALIDATOR_RESPONSES}, after them.
   */
  knownValidators: readonly Address[];
  maxResponses?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * The agent's answered responses since the board was deployed, from the chain: each known validator's newest
 * `maxResponses`, newest first, then every other validator's newest {@link MAX_OTHER_VALIDATOR_RESPONSES}.
 * A status naming another agent (a squatted hash) is skipped.
 */
async function answeredCandidates(reader: InboxReader, o: DiscoveryOptions): Promise<{ candidates: InboxStatus[]; head: bigint }> {
  const { agentId, findingsBoard } = o;
  const hashes = await reader.agentValidations(agentId);
  if (hashes.length === 0) return { candidates: [], head: 0n };
  const [statuses, head] = await Promise.all([reader.statuses(hashes), reader.head()]);
  const boardTime = await reader.blockTimestamp(findingsBoard.fromBlock);
  const newestFirst = statuses
    .filter((s) => answered(s) && s.agentId === agentId && s.lastUpdate >= boardTime)
    .sort((a, b) => (a.lastUpdate === b.lastUpdate ? 0 : a.lastUpdate > b.lastUpdate ? -1 : 1));
  const perKnown = o.maxResponses ?? MAX_INBOX_RESPONSES;
  const taken = new Map<string, number>();
  const ours: InboxStatus[] = [];
  const others: InboxStatus[] = [];
  for (const s of newestFirst) {
    if (!isKnown(o, s.validator)) {
      if (others.length < MAX_OTHER_VALIDATOR_RESPONSES) others.push(s);
      continue;
    }
    const validator = getAddress(s.validator);
    const count = taken.get(validator) ?? 0;
    if (count < perKnown) {
      ours.push(s);
      taken.set(validator, count + 1);
    }
  }
  return { candidates: [...ours, ...others], head };
}

/** Whether `validator` is one the reader named as known. */
function isKnown(o: Pick<DiscoveryOptions, "knownValidators">, validator: Address): boolean {
  return o.knownValidators.some((v) => getAddress(v) === getAddress(validator));
}

/**
 * A decrypted report's string as plain text (P12, AUD-03): tabs, newlines and carriage returns become spaces; other
 * C0 and C1 controls, bidi controls (U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069) and invisible characters
 * (U+200B-U+200D, U+2060-U+2064, U+FEFF) become "?", so a report can't reorder or hide what the page shows. Other
 * Unicode is kept: a model's explanation may use it.
 */
export function reportText(text: string): string {
  return text
    .replace(/[\t\n\r]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "?");
}

/** The response's transaction, from the blocks carrying its `lastUpdate`, or null. */
async function responseTxOf(reader: InboxReader, status: InboxStatus, head: bigint): Promise<Hash | null> {
  const responseBlocks = await blocksWithTimestamp((n) => reader.blockTimestamp(n), status.lastUpdate, head);
  return responseBlocks ? await reader.responseTx({ requestHash: status.requestHash, ...responseBlocks }) : null;
}

/**
 * One verdict's reports on chain alone: from the first block carrying its `lastUpdate`, over
 * {@link REPORT_SEARCH_BLOCKS}, never past the head, stopping at the first 100-block window that finds a trusted post.
 */
async function chainEntry(
  reader: InboxReader,
  status: InboxStatus,
  agentId: bigint,
  head: bigint,
  findingsBoard: FindingsBoardDeployment,
): Promise<Omit<InboxEntry, "validatorKnown">> {
  let start: bigint;
  try {
    start = await firstBlockAtOrAfter((n) => reader.blockTimestamp(n), status.lastUpdate, head, findingsBoard.fromBlock);
  } catch (error) {
    if (!(error instanceof NoBlockAtOrAfterError)) throw error;
    return { status, responseTx: null, posts: [], searchedTo: head, source: "chain" };
  }
  const responseTx = await responseTxOf(reader, status, head);
  const end = start + REPORT_SEARCH_BLOCKS - 1n < head ? start + REPORT_SEARCH_BLOCKS - 1n : head;
  for (let from = start; from <= end; from += MAX_LOG_BLOCK_RANGE) {
    const to = from + MAX_LOG_BLOCK_RANGE - 1n < end ? from + MAX_LOG_BLOCK_RANGE - 1n : end;
    const found = await reader.findingsLogs({ requestHash: status.requestHash, agentId, validator: status.validator, fromBlock: from, toBlock: to });
    const trusted = found.filter((post) => isTrustedPost(post, status));
    if (trusted.length > 0) return { status, responseTx, posts: trusted, searchedTo: to, source: "chain" };
  }
  return { status, responseTx, posts: [], searchedTo: end, source: "chain" };
}

async function chainEntries(reader: InboxReader, o: DiscoveryOptions, candidates: InboxStatus[], head: bigint): Promise<InboxEntry[]> {
  const entries: InboxEntry[] = [];
  o.onProgress?.(0, candidates.length);
  for (const status of candidates) {
    entries.push({ ...(await chainEntry(reader, status, o.agentId, head, o.findingsBoard)), validatorKnown: isKnown(o, status.validator) });
    o.onProgress?.(entries.length, candidates.length);
  }
  return entries;
}

/**
 * The agent's answered responses since the board was deployed (at most `maxResponses`, newest first), each with the
 * posts the trust rule keeps, found on chain alone. The search for a report starts at the first block carrying its
 * response's `lastUpdate` and covers {@link REPORT_SEARCH_BLOCKS}, never past the head, stopping at the first
 * 100-block window that finds one. `onProgress(done, total)` runs before the first response and after each.
 */
export async function findInboxEntries(reader: InboxReader, o: DiscoveryOptions): Promise<InboxEntry[]> {
  const { candidates, head } = await answeredCandidates(reader, o);
  return candidates.length === 0 ? [] : chainEntries(reader, o, candidates, head);
}

async function indexedEntries(
  reader: IndexedInboxReader,
  o: DiscoveryOptions & { trustApi: TrustApiOptions },
  candidates: InboxStatus[],
  head: bigint,
): Promise<{ entries: InboxEntry[]; rejected: RejectedPost[]; indexedTo: bigint | null }> {
  if (candidates.length === 0) return { entries: [], rejected: [], indexedTo: null };
  // Only each verdict's own validator's posts: nobody else's posts on those requests can crowd them out of the answer.
  const { reports, indexedTo, truncated } = await findIndexedReports({
    ...o.trustApi,
    agentId: o.agentId,
    requests: candidates.map((c) => ({ requestHash: c.requestHash, validator: c.validator })),
  });
  if (truncated) throw new TrustApiError("INCOMPLETE", "the indexer's answer hit its row limit, so it may be missing reports");
  // A verdict's report window is fully indexed when it ends at or before the indexer's progress block, i.e. when its
  // response time is at or before that of block (indexedTo − window + 1). Later ones are searched on chain too.
  const lastIndexed = indexedTo < head ? indexedTo : head;
  const cutoffBlock = lastIndexed - REPORT_SEARCH_BLOCKS + 1n;
  const cutoffTime = cutoffBlock >= 0n ? await reader.blockTimestamp(cutoffBlock) : -1n;
  const entries: InboxEntry[] = [];
  const rejected: RejectedPost[] = [];
  o.onProgress?.(0, candidates.length);
  for (const status of candidates) {
    if (status.lastUpdate > cutoffTime) {
      entries.push({ ...(await chainEntry(reader, status, o.agentId, head, o.findingsBoard)), validatorKnown: isKnown(o, status.validator) });
    } else {
      const posts: FindingsPost[] = [];
      for (const indexed of reports.filter((r) => r.requestHash === status.requestHash.toLowerCase())) {
        const post: FindingsPost = {
          requestHash: indexed.requestHash,
          agentId: indexed.agentId,
          validator: indexed.validator,
          envelope: indexed.envelope,
          blockNumber: indexed.blockNumber,
          txHash: indexed.txHash,
          logIndex: indexed.logIndex,
        };
        // The trust rule against the chain's status, never the indexer's flag; then the post's own receipt.
        if (!isTrustedPost(post, status)) continue;
        const logs = await reader.receiptLogs(post.txHash);
        if (logs !== null && postMatchesReceipt(post, logs, o.findingsBoard.address)) posts.push(post);
        else rejected.push({ post, problem: "NOT_ON_CHAIN" });
      }
      entries.push({ status, responseTx: await responseTxOf(reader, status, head), posts, searchedTo: indexedTo, source: "indexer", validatorKnown: isKnown(o, status.validator) });
    }
    o.onProgress?.(entries.length, candidates.length);
  }
  return { entries, rejected, indexedTo };
}

/**
 * {@link findInboxEntries}, with the posts found through the indexer: one query for every post on the agent's
 * verdicts, each kept only if the chain's status names its validator and agent and its receipt carries it exactly.
 * Throws {@link TrustApiError} when the indexer fails.
 */
export async function findInboxEntriesViaIndexer(
  reader: IndexedInboxReader,
  o: DiscoveryOptions & { trustApi: TrustApiOptions },
): Promise<{ entries: InboxEntry[]; rejected: RejectedPost[]; indexedTo: bigint | null }> {
  const { candidates, head } = await answeredCandidates(reader, o);
  return indexedEntries(reader, o, candidates, head);
}

/**
 * What `/inbox` runs: through the indexer when `trustApi` is given, else on chain; any indexer failure falls back to
 * the chain scan over the same verdicts, with the reason. Chain errors propagate either way.
 */
export async function discoverInbox(
  reader: IndexedInboxReader,
  o: DiscoveryOptions & { trustApi: TrustApiOptions | null },
): Promise<{ entries: InboxEntry[]; rejected: RejectedPost[]; via: "indexer" | "chain"; fallbackReason: string | null; indexedTo: bigint | null }> {
  const { candidates, head } = await answeredCandidates(reader, o);
  if (candidates.length === 0) return { entries: [], rejected: [], via: o.trustApi === null ? "chain" : "indexer", fallbackReason: null, indexedTo: null };
  if (o.trustApi !== null) {
    try {
      const found = await indexedEntries(reader, { ...o, trustApi: o.trustApi }, candidates, head);
      return { ...found, via: "indexer", fallbackReason: null };
    } catch (error) {
      if (!(error instanceof TrustApiError)) throw error;
      const entries = await chainEntries(reader, o, candidates, head);
      return { entries, rejected: [], via: "chain", fallbackReason: `${error.kind}: ${error.message}`, indexedTo: null };
    }
  }
  return { entries: await chainEntries(reader, o, candidates, head), rejected: [], via: "chain", fallbackReason: null, indexedTo: null };
}

/**
 * An `InboxReader` over viem for one load: block timestamps are cached for its lifetime. Statuses come through
 * Multicall3. Throws if the deployment has no FindingsBoard.
 */
export function viemInboxReader(o: { publicClient: PublicClient; deployment: Deployment }): IndexedInboxReader {
  const { publicClient, deployment } = o;
  if (deployment.findingsBoard === null) throw new Error("no FindingsBoard is recorded for this chain");
  const board = getAddress(deployment.findingsBoard.address);
  const registry = getAddress(deployment.validationRegistry);
  const timestamps = new Map<bigint, Promise<bigint>>();
  return {
    head: () => publicClient.getBlockNumber({ cacheTime: 0 }),
    blockTimestamp(block) {
      let cached = timestamps.get(block);
      if (!cached) {
        cached = publicClient.getBlock({ blockNumber: block }).then((b) => b.timestamp);
        cached.catch(() => timestamps.delete(block));
        timestamps.set(block, cached);
      }
      return cached;
    },
    async agentValidations(agentId) {
      return [...(await publicClient.readContract({ address: registry, abi: validationRegistryAbi, functionName: "getAgentValidations", args: [agentId] }))];
    },
    async statuses(hashes) {
      if (hashes.length === 0) return [];
      const results = await publicClient.multicall({
        contracts: hashes.map((h) => ({ address: registry, abi: validationRegistryAbi, functionName: "getValidationStatus", args: [h] }) as const),
        allowFailure: false,
      });
      return results.map(([validator, agentId, response, responseHash, tag, lastUpdate], i) => ({
        requestHash: hashes[i] as Hex,
        validator: getAddress(validator),
        agentId,
        response,
        responseHash,
        tag,
        lastUpdate,
      }));
    },
    async findingsLogs({ requestHash, agentId, validator, fromBlock, toBlock }) {
      const logs = await publicClient.getLogs({ address: board, event: findingsPostedEvent, args: { requestHash, agentId, validator }, fromBlock, toBlock });
      const posts: FindingsPost[] = [];
      for (const log of logs) {
        const a = log.args;
        if (!a.requestHash || a.agentId === undefined || !a.validator || a.envelope === undefined) continue;
        posts.push({
          requestHash: a.requestHash,
          agentId: a.agentId,
          validator: getAddress(a.validator),
          envelope: a.envelope,
          blockNumber: log.blockNumber,
          txHash: log.transactionHash,
          logIndex: log.logIndex,
        });
      }
      return posts;
    },
    async responseTx({ requestHash, fromBlock, toBlock }) {
      const logs = await publicClient.getLogs({ address: registry, event: validationResponseEvent, args: { requestHash }, fromBlock, toBlock });
      return logs.at(-1)?.transactionHash ?? null;
    },
    async receiptLogs(txHash) {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
        return receipt.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, logIndex: l.logIndex }));
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
  };
}

/** One post, opened: the report (and whether it matches the verdict onchain now), or why it couldn't be read. */
export type OpenedReport =
  | { ok: true; report: OperatorReport; matchesOnchain: boolean }
  | { ok: false; problem: EnvelopeProblem | "NOT_UTF8" | "NOT_JSON" | "SCHEMA" | "REPORT_MISMATCH" };

/**
 * Opens every post in `entries` with the inbox key. Refuses outright when the agent has no inbox key, or when
 * `publicKey` (this passkey's) isn't the agent's onchain key: then nothing is opened. A report whose request, agent
 * or tag differs from its log and status is `REPORT_MISMATCH`; one whose tag, score and `responseHash` equal the
 * status `matchesOnchain`. Every decrypted plaintext is wiped once decoded; the caller wipes `privateKey`.
 */
export function openInbox(o: {
  entries: InboxEntry[];
  privateKey: Uint8Array;
  publicKey: Hex;
  onchainInboxKey: Hex;
  chainId: number;
  findingsBoard: Address;
  validationRegistry: Address;
  tracker?: SecretTracker;
}): { ok: false; problem: "NO_INBOX_KEY" | "KEY_MISMATCH" } | { ok: true; reports: { post: FindingsPost; status: InboxStatus; opened: OpenedReport }[] } {
  if (BigInt(o.onchainInboxKey) === 0n) return { ok: false, problem: "NO_INBOX_KEY" };
  if (o.publicKey.toLowerCase() !== o.onchainInboxKey.toLowerCase()) return { ok: false, problem: "KEY_MISMATCH" };
  const reports: { post: FindingsPost; status: InboxStatus; opened: OpenedReport }[] = [];
  for (const { status, posts } of o.entries) {
    for (const post of posts) reports.push({ post, status, opened: openOne(o, post, status) });
  }
  return { ok: true, reports };
}

function openOne(
  o: { privateKey: Uint8Array; publicKey: Hex; chainId: number; findingsBoard: Address; validationRegistry: Address; tracker?: SecretTracker },
  post: FindingsPost,
  status: InboxStatus,
): OpenedReport {
  let result: ReturnType<typeof openEnvelope>;
  try {
    result = openEnvelope({
      envelope: post.envelope,
      privateKey: o.privateKey,
      context: {
        chainId: o.chainId,
        findingsBoard: o.findingsBoard,
        validationRegistry: o.validationRegistry,
        requestHash: post.requestHash,
        agentId: post.agentId,
        validator: post.validator,
        recipient: o.publicKey,
      },
      tracker: o.tracker,
    });
  } catch {
    // openEnvelope throws only on a malformed context; a log can't give a valid one, so the post is unreadable.
    return { ok: false, problem: "MALFORMED" };
  }
  if (!result.ok) return { ok: false, problem: result.problem };
  const plaintext = result.plaintext;
  o.tracker?.track(plaintext);
  try {
    const decoded = decodeReport(plaintext);
    if (!decoded.ok) return { ok: false, problem: decoded.problem };
    const report = decoded.report;
    if (report.requestHash.toLowerCase() !== post.requestHash.toLowerCase() || BigInt(report.agentId) !== post.agentId || report.tag !== status.tag) {
      return { ok: false, problem: "REPORT_MISMATCH" };
    }
    const matchesOnchain = report.score === status.response && report.responseHash.toLowerCase() === status.responseHash.toLowerCase();
    return { ok: true, report, matchesOnchain };
  } finally {
    wipe(plaintext);
  }
}
