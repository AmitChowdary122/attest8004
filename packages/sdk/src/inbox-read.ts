// Reading an agent's operator reports (SPEC §4.7, ARCHITECTURE §6): find them on chain with public reads, keep only
// the posts the trust rule allows, then open them with the inbox key. Browser-safe: viem and the SDK only.
//
// The trust rule: a FindingsPosted post counts only when `ValidationRegistry.getValidationStatus(requestHash)` names
// that post's validator and agent. Anyone can post to the board; everything else is ignored.
//
// Without an indexer (P8), each report is found from its verdict: the registry's `lastUpdate` gives the block the
// response landed in, and the validator posts right after it, so the search covers the next REPORT_SEARCH_BLOCKS.
import { getAddress, zeroHash, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { findingsPostedEvent, validationRegistryAbi, validationResponseEvent } from "./abi.ts";
import { NoBlockAtOrAfterError, blocksWithTimestamp, firstBlockAtOrAfter } from "./blocks.ts";
import type { Deployment, FindingsBoardDeployment } from "./deployments.ts";
import { openEnvelope, wipe, type EnvelopeProblem, type SecretTracker } from "./inbox-crypto.ts";
import { MAX_LOG_BLOCK_RANGE } from "./logs.ts";
import { decodeReport, type OperatorReport } from "./report.ts";

/** How far after its verdict a report is searched for: 600 blocks, about 3 minutes. */
export const REPORT_SEARCH_BLOCKS = 600n;
/** The most recent responses `findInboxEntries` looks at by default. */
export const MAX_INBOX_RESPONSES = 20;

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
  /** The last block searched for posts. */
  searchedTo: bigint;
}

const answered = (s: InboxStatus) => s.responseHash !== zeroHash || s.tag !== "";

/**
 * The agent's answered responses since the board was deployed (at most `maxResponses`, newest first), each with the
 * posts the trust rule keeps. A status naming another agent (a squatted hash) is skipped. The search for a report
 * starts at the first block carrying its response's `lastUpdate` and covers {@link REPORT_SEARCH_BLOCKS}, never past
 * the head, stopping at the first 100-block window that finds one. `onProgress(done, total)` runs before the first
 * response and after each.
 */
export async function findInboxEntries(
  reader: InboxReader,
  o: { agentId: bigint; findingsBoard: FindingsBoardDeployment; maxResponses?: number; onProgress?: (done: number, total: number) => void },
): Promise<InboxEntry[]> {
  const { agentId, findingsBoard } = o;
  const hashes = await reader.agentValidations(agentId);
  if (hashes.length === 0) return [];
  const [statuses, head] = await Promise.all([reader.statuses(hashes), reader.head()]);
  const boardTime = await reader.blockTimestamp(findingsBoard.fromBlock);
  const candidates = statuses
    .filter((s) => answered(s) && s.agentId === agentId && s.lastUpdate >= boardTime)
    .sort((a, b) => (a.lastUpdate === b.lastUpdate ? 0 : a.lastUpdate > b.lastUpdate ? -1 : 1))
    .slice(0, o.maxResponses ?? MAX_INBOX_RESPONSES);

  const timestamp = (n: bigint) => reader.blockTimestamp(n);
  const entries: InboxEntry[] = [];
  o.onProgress?.(0, candidates.length);
  for (const status of candidates) {
    let start: bigint;
    try {
      start = await firstBlockAtOrAfter(timestamp, status.lastUpdate, head, findingsBoard.fromBlock);
    } catch (error) {
      if (!(error instanceof NoBlockAtOrAfterError)) throw error;
      entries.push({ status, responseTx: null, posts: [], searchedTo: head });
      o.onProgress?.(entries.length, candidates.length);
      continue;
    }
    const responseBlocks = await blocksWithTimestamp(timestamp, status.lastUpdate, head);
    const responseTx = responseBlocks ? await reader.responseTx({ requestHash: status.requestHash, ...responseBlocks }) : null;

    const end = start + REPORT_SEARCH_BLOCKS - 1n < head ? start + REPORT_SEARCH_BLOCKS - 1n : head;
    let posts: FindingsPost[] = [];
    let searchedTo = end;
    for (let from = start; from <= end; from += MAX_LOG_BLOCK_RANGE) {
      const to = from + MAX_LOG_BLOCK_RANGE - 1n < end ? from + MAX_LOG_BLOCK_RANGE - 1n : end;
      const found = await reader.findingsLogs({ requestHash: status.requestHash, agentId, validator: status.validator, fromBlock: from, toBlock: to });
      const trusted = found.filter((post) => isTrustedPost(post, status));
      if (trusted.length > 0) {
        posts = trusted;
        searchedTo = to;
        break;
      }
    }
    entries.push({ status, responseTx, posts, searchedTo });
    o.onProgress?.(entries.length, candidates.length);
  }
  return entries;
}

/**
 * An `InboxReader` over viem for one load: block timestamps are cached for its lifetime. Statuses come through
 * Multicall3. Throws if the deployment has no FindingsBoard.
 */
export function viemInboxReader(o: { publicClient: PublicClient; deployment: Deployment }): InboxReader {
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
