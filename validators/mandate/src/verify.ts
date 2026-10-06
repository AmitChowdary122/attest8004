import {
  buildEvidence,
  canonicalJson,
  decodeJsonDataUri,
  deploymentsFor,
  parseRequestUri,
  requestHashOfJson,
  validationRegistryAbi,
  type RequestJsonV1,
  type ValidationStatus,
} from "@attest8004/sdk";
import { decodeErrorResult, keccak256, stringToBytes, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { MAX_EVIDENCE_URI_BYTES, type PreimageCache } from "./collect.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import { MANDATE_V1 } from "./params.ts";
import { firstMandateRegistryBlock, mandateAddressesAt, mandateContractsFor, type MandateContracts, type VerifyReader } from "./reader.ts";
import { mandateRequestOf, runMandateV1 } from "./run.ts";
import type { PermissionEvent, PinnedBlock, SpendEntry } from "./types.ts";

/**
 * Why `verify` didn't find a match. Each one either proves the validator misbehaved (a mismatch) or
 * means the verdict couldn't be re-run (unverifiable); see {@link MISMATCH_PROBLEMS}.
 *
 * - `NOT_MANDATE_V1`: the response is tagged something else, so there is no `mandate-v1` run to
 *   repeat. Unverifiable: another validator's verdict (an agentic `risk-v1` one, say) is not
 *   re-executable by design, and its tag proves nothing against it.
 * - `RESPONSE_NOT_FOUND`: the request has no response yet, or its `ValidationResponse` log wasn't
 *   found at the status's `lastUpdate`. Unverifiable.
 * - `EVIDENCE_NOT_DECODED`: the response URI isn't inline JSON that `verify` decodes: not a `data:`
 *   URI (`verify` never fetches), over {@link MAX_EVIDENCE_URI_BYTES}, or malformed. Nothing was
 *   compared, so unverifiable.
 * - `EVIDENCE_HASH_MISMATCH`: the decoded evidence doesn't hash to the onchain `responseHash`. A
 *   mismatch: the validator sends the URI and the hash in one transaction.
 * - `REQUEST_NOT_FOUND`: the registry has no such request; or state confirms the request was made in
 *   the block the evidence names, but its `ValidationRequest` log wasn't returned (RPC or log-index
 *   lag). Unverifiable.
 * - `REQUEST_BLOCK_WRONG`: the evidence names a request block in which the request wasn't made. The
 *   registry refuses to reuse a `requestHash`, so a request's block is a fact of state: the first
 *   block at which its status exists. A block before the registry was deployed is wrong without
 *   reading anything. A mismatch.
 * - `REQUEST_INVALID`: the request's own log carries a request JSON that doesn't parse, doesn't hash
 *   to `requestHash`, names another validator or agent than the registry records, names another chain
 *   than the one `verify` reads, or has a deadline more than 3,600 s after `P`'s time. A `mandate-v1`
 *   validator must not answer such a request (the SDK's base never does, and `MandateValidator` never
 *   pins where its deadline is that far ahead), so a mismatch.
 * - `PIN_OUT_OF_RANGE`: the evidence's pinned block is before the request's block, after the block
 *   the response landed in, or before the first MandateRegistry in the history. A mismatch: an honest
 *   validator pins between the first two, and can't pin before the third (it reads the mandate there).
 * - `SCORE_MISMATCH`: the onchain score isn't the recomputed one. A mismatch.
 * - `PIN_SKIPS_APPROVAL` (P12, AUD-02): one of this validator's own `mandate-v1` approvals (score 100) of the same
 *   agent became answered after `P` and no later than the block the response landed in, so the re-run at `P`
 *   couldn't count it toward the daily spend, although the validator had already given it. An honest validator pins
 *   after its own last approval of the agent landed ({@link approvalsAfterPin}); one that pins earlier under-counts
 *   spend while its verdict still re-runs to the same bytes. A mismatch. Validators whose documented pin rule is the
 *   request's own block (validator C, docs/cre.md) are exempt: {@link VerifyContext.pinAtRequestBlock}.
 * - `RESPONSE_HASH_MISMATCH`: the onchain `responseHash` isn't the hash of the recomputed evidence,
 *   or it commits to evidence that isn't a `mandate-v1` document at all (no pinned block or request
 *   block to re-run at), which no `mandate-v1` run produces. A mismatch.
 */
export type VerifyProblem =
  | "NOT_MANDATE_V1"
  | "RESPONSE_NOT_FOUND"
  | "EVIDENCE_NOT_DECODED"
  | "EVIDENCE_HASH_MISMATCH"
  | "REQUEST_NOT_FOUND"
  | "REQUEST_BLOCK_WRONG"
  | "REQUEST_INVALID"
  | "PIN_OUT_OF_RANGE"
  | "SCORE_MISMATCH"
  | "RESPONSE_HASH_MISMATCH"
  | "PIN_SKIPS_APPROVAL";

/** The problems that prove the validator misbehaved. Every other problem means the verdict couldn't be re-run. */
export const MISMATCH_PROBLEMS: ReadonlySet<VerifyProblem> = new Set([
  "EVIDENCE_HASH_MISMATCH",
  "REQUEST_BLOCK_WRONG",
  "REQUEST_INVALID",
  "PIN_OUT_OF_RANGE",
  "SCORE_MISMATCH",
  "RESPONSE_HASH_MISMATCH",
  "PIN_SKIPS_APPROVAL",
]);

/**
 * `match`: the re-run gave the posted score and `responseHash`. `mismatch`: public proof that the
 * validator misbehaved. `unverifiable`: nothing is proven either way.
 */
export type VerifyVerdict = "match" | "mismatch" | "unverifiable";

/** What `verifyRequest` found. Integers stay `bigint`. */
export interface VerifyReport {
  /** Lower-case. */
  requestHash: Hex;
  /** The validator the registry records for the request (the zero address when it has no such request). */
  validator: Address;
  /** The pinned block `P` the posted evidence names; `null` when no evidence was read. */
  pinnedBlock: bigint | null;
  /** Block `P` as read from the chain for the re-run; `null` when there was no re-run. */
  pinned: PinnedBlock | null;
  /** `verdict === "match"`. */
  match: boolean;
  verdict: VerifyVerdict;
  /** What the registry records: the onchain score, `responseHash` and tag. */
  posted: { score: number; responseHash: Hex; tag: string };
  /** The re-run at `P`: its score, the hash of its rebuilt evidence and its reasons; `null` when it didn't run. */
  recomputed: { score: number; responseHash: Hex; reasons: string[] } | null;
  /** Empty exactly when the verdict is `match`. */
  problems: VerifyProblem[];
  /** The top-level evidence keys whose canonical JSON differs between the posted and the rebuilt document, sorted. */
  differingKeys: string[];
  /** The re-run's spend entries, as its evidence records them. */
  spendEntries: SpendEntry[];
  /** The re-run's permission events in `(P − N, P]`, as its evidence records them. */
  permissionEvents: PermissionEvent[];
  /** This validator's approvals of the agent answered after `P` and by the response's block (`PIN_SKIPS_APPROVAL`). */
  skippedApprovals: Hex[];
}

/**
 * What `verifyRequest` checks a verdict against besides the chain: the contracts to re-run with, the
 * MandateRegistry history among them (the re-run at `P` uses the registry valid at `P`, and a pin
 * before the first one is out of range), and the block the ValidationRegistry was deployed in (before
 * it its address has no code, so reads there return no data instead of an answer).
 */
export interface VerifyContext {
  contracts: MandateContracts;
  validationRegistryDeployBlock: bigint;
  /**
   * Validators whose documented pin is the request's own block (validator C: its stateless CRE workflow judges each
   * request against its spend as of that block, docs/cre.md), so `PIN_SKIPS_APPROVAL` doesn't apply to them.
   */
  pinAtRequestBlock?: readonly Address[];
}

/** The {@link VerifyContext} for `chainId` from the SDK's recorded deployment (`DEPLOYMENTS`). Throws for a chain with none. */
export function verifyContextFor(chainId: number): VerifyContext {
  const { validationRegistryDeployBlock, validators } = deploymentsFor(chainId);
  return { contracts: mandateContractsFor(chainId), validationRegistryDeployBlock, pinAtRequestBlock: [validators.creMandateV1] };
}

const DECIMAL = /^(0|[1-9]\d*)$/;
const UINT64_LIMIT = 2n ** 64n;

/**
 * Re-runs the `mandate-v1` verdict on `requestHash` from chain data alone and compares it with the
 * one posted onchain (SPEC §4.5, ARCHITECTURE §5.5). In order, stopping at the first problem:
 *
 * 1. Reads the request's status at the finalized head. Unknown → `REQUEST_NOT_FOUND`; no response →
 *    `RESPONSE_NOT_FOUND`; another tag → `NOT_MANDATE_V1`.
 * 2. Finds its `ValidationResponse` log through the status's `lastUpdate` (→ `RESPONSE_NOT_FOUND`),
 *    decodes the inline evidence (→ `EVIDENCE_NOT_DECODED`), checks that it hashes to the
 *    `responseHash` (→ `EVIDENCE_HASH_MISMATCH`) and names a pinned block `P` and the request's
 *    block (→ `RESPONSE_HASH_MISMATCH`).
 * 3. `P` must be at or after the evidence's request block and the first MandateRegistry's
 *    `fromBlock`, and at or before the response's own block (→ `PIN_OUT_OF_RANGE`, with no read at
 *    `P`).
 * 4. Reads block `P`'s header (its time). The evidence's request block must not be before
 *    `validationRegistryDeployBlock` (→ `REQUEST_BLOCK_WRONG`, with no state read). Reads the
 *    `ValidationRequest` log in that block. If none
 *    is returned, state decides: the request's status must exist at that block and not one block
 *    before (→ `REQUEST_BLOCK_WRONG` if not, else `REQUEST_NOT_FOUND`). The log's request JSON must
 *    hash to `requestHash`, name the validator and agent the registry records and the chain the reader is
 *    on, and have a deadline at most 3,600 s after `P`'s time (→ `REQUEST_INVALID`).
 * 5. Runs `runMandateV1` at `P` as that validator, with an empty cache (so every past approval's
 *    amount is rebuilt from its own evidence) and the addresses valid at `P` (`mandateAddressesAt`:
 *    the MandateRegistry valid there), rebuilds the evidence with `buildEvidence` and hashes its
 *    canonical JSON.
 * 6. Compares the score (→ `SCORE_MISMATCH`) and the `responseHash` (→ `RESPONSE_HASH_MISMATCH`),
 *    listing the top-level evidence keys that differ.
 * 7. Unless the validator pins at the request's block by design (`pinAtRequestBlock`: validator C), checks that
 *    none of its own approvals of the agent became answered after `P` and by the response's block
 *    ({@link approvalsAfterPin} → `PIN_SKIPS_APPROVAL`).
 *
 * Rejects, rather than report, when a read fails: an RPC error (including history the node no longer
 * serves, and any revert other than the registry's `UnknownRequest`), or an input log the re-run
 * can't find (`SpendLogNotFoundError`, `MandateSetLogNotFoundError`). Like the validator, it never
 * turns a failed read into a verdict, let alone a mismatch; retry later or use another RPC.
 */
export async function verifyRequest(o: { reader: VerifyReader; requestHash: Hex } & VerifyContext): Promise<VerifyReport> {
  const { reader, contracts, validationRegistryDeployBlock } = o;
  const requestHash = o.requestHash.toLowerCase() as Hex;
  const head = await reader.finalized();

  const status = await statusOrUnknown(reader, requestHash, head.number);
  if (status === null) {
    return report({ requestHash, validator: zeroAddress, posted: { score: 0, responseHash: zeroHash, tag: "" } }, ["REQUEST_NOT_FOUND"]);
  }
  const base = {
    requestHash,
    validator: status.validator,
    posted: { score: status.response, responseHash: status.responseHash.toLowerCase() as Hex, tag: status.tag },
  };
  if (base.posted.responseHash === zeroHash && status.tag === "") return report(base, ["RESPONSE_NOT_FOUND"]);
  if (status.tag !== MANDATE_V1.tag) return report(base, ["NOT_MANDATE_V1"]);

  const response = await reader.responseLog(requestHash, status.lastUpdate, head.number);
  if (response === null) return report(base, ["RESPONSE_NOT_FOUND"]);
  const decoded = decodeJsonDataUri(response.uri, MAX_EVIDENCE_URI_BYTES);
  if (!decoded.ok) return report(base, ["EVIDENCE_NOT_DECODED"]);
  if (keccak256(stringToBytes(decoded.text)) !== base.posted.responseHash) return report(base, ["EVIDENCE_HASH_MISMATCH"]);
  const posted = postedEvidence(decoded.text);
  if (posted === null) return report(base, ["RESPONSE_HASH_MISMATCH"]);

  const { doc, pinnedBlock, requestBlock } = posted;
  if (pinnedBlock < requestBlock || pinnedBlock > response.block || pinnedBlock < firstMandateRegistryBlock(contracts)) {
    return report({ ...base, pinnedBlock }, ["PIN_OUT_OF_RANGE"]);
  }

  const pinned = await reader.block(pinnedBlock);
  const request = await requestAt(reader, requestHash, requestBlock, validationRegistryDeployBlock, status, pinned);
  if ("problem" in request) return report({ ...base, pinnedBlock }, [request.problem]);
  const { json } = request;

  const cache: PreimageCache = new Map();
  const result = await runMandateV1({
    reader,
    addresses: mandateAddressesAt(contracts, pinnedBlock),
    validator: status.validator,
    request: mandateRequestOf(json, requestHash, requestBlock),
    pinned,
    cache,
  });
  const rebuilt = buildEvidence({ tag: MANDATE_V1.tag, requestHash, result });
  const recomputed = { score: result.score, responseHash: keccak256(stringToBytes(canonicalJson(rebuilt))), reasons: result.reasons };

  const problems: VerifyProblem[] = [];
  if (recomputed.score !== base.posted.score) problems.push("SCORE_MISMATCH");
  if (recomputed.responseHash !== base.posted.responseHash) problems.push("RESPONSE_HASH_MISMATCH");
  const exempt = (o.pinAtRequestBlock ?? []).some((v) => v.toLowerCase() === status.validator.toLowerCase());
  const skippedApprovals = exempt
    ? []
    : await approvalsAfterPin({ reader, validator: status.validator, agentId: status.agentId, pin: pinnedBlock, upTo: response.block, exclude: requestHash });
  if (skippedApprovals.length > 0) problems.push("PIN_SKIPS_APPROVAL");
  return report(
    {
      ...base,
      pinnedBlock,
      pinned,
      recomputed,
      differingKeys: differingKeys(doc, rebuilt),
      // Built by mandateEvidence() field for field from the collected SpendEntry and PermissionEvent values.
      spendEntries: (rebuilt.spend as { entries?: SpendEntry[] } | null)?.entries ?? [],
      permissionEvents: (rebuilt.permissions as { events: PermissionEvent[] }).events,
      skippedApprovals,
    },
    problems,
  );
}

/**
 * `validator`'s `mandate-v1` approvals (score 100) of `agentId` that are answered at block `upTo` but weren't at
 * `pin` (unknown there, or answered differently), leaving out `exclude`: approvals a verdict pinned at `pin` couldn't
 * count toward the daily spend (P12, AUD-02). State only: the agent's list and each status, at both blocks. `verify`
 * runs it up to the response's block (`PIN_SKIPS_APPROVAL`); validator A's pin waits until it is empty up to the
 * finalized head, so even a restarted process never pins before its own last approval of the agent.
 */
export async function approvalsAfterPin(o: {
  reader: Pick<VerifyReader, "agentValidations" | "status">;
  validator: Address;
  agentId: bigint;
  pin: bigint;
  upTo: bigint;
  exclude: Hex;
  /**
   * Requests seen naming another validator or agent: a request's validator and agent never change, so a caller that
   * checks repeatedly (validator A's pin, while it waits) passes one set and they are read only once (P12 re-check, N2).
   */
  notOurs?: Set<string>;
}): Promise<Hex[]> {
  const { reader, validator, agentId, pin, upTo, notOurs } = o;
  const excluded = o.exclude.toLowerCase();
  const hashes = (await reader.agentValidations(agentId, upTo)).filter((hash) => hash.toLowerCase() !== excluded && !notOurs?.has(hash.toLowerCase()));
  const skipped = await mapWithConcurrency(hashes, 8, async (requestHash): Promise<Hex | null> => {
    const now = await reader.status(requestHash, upTo);
    if (now.validator.toLowerCase() !== validator.toLowerCase() || now.agentId !== agentId) {
      notOurs?.add(requestHash.toLowerCase());
      return null;
    }
    const isApproval = now.tag === MANDATE_V1.tag && now.response === 100;
    if (!isApproval) return null;
    const then = await statusOrUnknown(reader, requestHash, pin);
    const alreadyThere = then !== null && then.response === 100 && then.tag === MANDATE_V1.tag && then.responseHash.toLowerCase() === now.responseHash.toLowerCase();
    return alreadyThere ? null : requestHash;
  });
  return skipped.filter((hash): hash is Hex => hash !== null);
}

function report(
  fields: Pick<VerifyReport, "requestHash" | "validator" | "posted"> & Partial<VerifyReport>,
  problems: VerifyProblem[],
): VerifyReport {
  const verdict: VerifyVerdict =
    problems.length === 0 ? "match" : problems.some((problem) => MISMATCH_PROBLEMS.has(problem)) ? "mismatch" : "unverifiable";
  return {
    requestHash: fields.requestHash,
    validator: fields.validator,
    pinnedBlock: fields.pinnedBlock ?? null,
    pinned: fields.pinned ?? null,
    match: verdict === "match",
    verdict,
    posted: fields.posted,
    recomputed: fields.recomputed ?? null,
    problems,
    differingKeys: fields.differingKeys ?? [],
    spendEntries: fields.spendEntries ?? [],
    permissionEvents: fields.permissionEvents ?? [],
    skippedApprovals: fields.skippedApprovals ?? [],
  };
}

/**
 * The status at `at`, or `null` when the registry reverts `UnknownRequest` there (no such request
 * yet). Exported so `risk-v1`'s prerequisite check (P5) can read validator A's status at its own
 * pinned block the same way `verify` does.
 */
export async function statusOrUnknown(reader: Pick<VerifyReader, "status">, requestHash: Hex, at: bigint): Promise<ValidationStatus | null> {
  try {
    return await reader.status(requestHash, at);
  } catch (error) {
    if (isUnknownRequest(error)) return null;
    throw error;
  }
}

/**
 * Whether a failed read is the registry's `UnknownRequest` revert: some error on the `cause` chain
 * carries JSON-RPC code 3 and revert data (a hex string, or `{ data: hex }`) that decodes as that
 * error. That covers a raw provider error (`{ code: 3, data }`), viem's HTTP `RpcRequestError` (code
 * 3 at the top) and viem's `UnknownRpcError` wrapping a custom transport's error (code -1, with the
 * revert as its cause). Anything else, a transport failure or another revert, is a failed read.
 * Exported for the same reason as {@link statusOrUnknown}.
 */
export function isUnknownRequest(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 16 && typeof current === "object" && current !== null; depth++) {
    const e = current as { code?: unknown; data?: unknown; cause?: unknown };
    if (e.code === 3) {
      const data = typeof e.data === "object" && e.data !== null && "data" in e.data ? (e.data as { data: unknown }).data : e.data;
      if (typeof data === "string" && /^0x[0-9a-fA-F]*$/.test(data) && revertName(data as Hex) === "UnknownRequest") return true;
    }
    current = e.cause;
  }
  return false;
}

function revertName(data: Hex): string | null {
  try {
    return decodeErrorResult({ abi: validationRegistryAbi, data }).errorName;
  } catch {
    return null;
  }
}

/** The posted evidence as JSON, with the pinned block and the request block it names; `null` if it names neither. */
function postedEvidence(text: string): { doc: Record<string, unknown>; pinnedBlock: bigint; requestBlock: bigint } | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isJsonObject(doc) || !isJsonObject(doc.block) || !isJsonObject(doc.request)) return null;
  const pinnedBlock = uint64(doc.block.number);
  const requestBlock = uint64(doc.request.block);
  return pinnedBlock === null || requestBlock === null ? null : { doc, pinnedBlock, requestBlock };
}

/**
 * The request JSON in the `ValidationRequest` log at `block` (the evidence's request block), or why
 * there isn't one to re-run.
 *
 * - The JSON must be one the SDK's base would answer at a head no later than `pinned`: it hashes to
 *   `requestHash`, names the validator and agent the registry records and the chain the reader is on
 *   (`WRONG_CHAIN` otherwise), and its deadline is at most `maxDeadlineAheadSeconds` (3,600 s) after
 *   `pinned`'s time (`DEADLINE_TOO_FAR` otherwise). If not, `REQUEST_INVALID`.
 * - A block before the registry's deployment is wrong, and nothing is read: the contract had no code
 *   there, so a status read would return no data rather than revert `UnknownRequest`, and fail.
 * - When no log is returned, state decides whether the evidence named the wrong block: the registry
 *   refuses to reuse a `requestHash` (`RequestExists`), so the request was made in exactly one block,
 *   the first at which its status exists. If the status exists at `block` and not at `block − 1` (or
 *   `block` is the deployment block itself), the block is right and only the log is missing
 *   (`REQUEST_NOT_FOUND`: lag, not evidence); otherwise the evidence is wrong (`REQUEST_BLOCK_WRONG`).
 *   A failed status read rejects, so a transport error is never a mismatch.
 *
 * Exported so `risk-v1`'s `verify` (P5) can re-read validator A's own request the same way, when
 * checking the prerequisite verdict it required.
 */
export async function requestAt(
  reader: VerifyReader,
  requestHash: Hex,
  block: bigint,
  deployBlock: bigint,
  status: ValidationStatus,
  pinned: PinnedBlock,
): Promise<{ json: RequestJsonV1 } | { problem: VerifyProblem }> {
  if (block < deployBlock) return { problem: "REQUEST_BLOCK_WRONG" };
  const uri = await reader.requestUri(requestHash, block);
  if (uri === null) {
    const existsAtBlock = (await statusOrUnknown(reader, requestHash, block)) !== null;
    const existedBefore = existsAtBlock && block > deployBlock && (await statusOrUnknown(reader, requestHash, block - 1n)) !== null;
    return { problem: existsAtBlock && !existedBefore ? "REQUEST_NOT_FOUND" : "REQUEST_BLOCK_WRONG" };
  }
  const parsed = parseRequestUri(uri);
  if (!parsed.ok) return { problem: "REQUEST_INVALID" };
  const { json } = parsed;
  const matches =
    requestHashOfJson(json) === requestHash &&
    json.validator.toLowerCase() === status.validator.toLowerCase() &&
    BigInt(json.agentId) === status.agentId;
  if (!matches) return { problem: "REQUEST_INVALID" };
  if (json.chainId !== (await reader.chainId())) return { problem: "REQUEST_INVALID" };
  if (BigInt(json.action.deadline) > pinned.timestamp + MANDATE_V1.maxDeadlineAheadSeconds) return { problem: "REQUEST_INVALID" };
  return { json };
}

/**
 * The top-level keys, in either document, whose values differ as canonical JSON (a missing key, or a
 * value canonical JSON can't encode, differs from anything), sorted.
 */
function differingKeys(posted: Record<string, unknown>, rebuilt: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(posted), ...Object.keys(rebuilt)]);
  return [...keys].filter((key) => canonicalAt(posted, key) !== canonicalAt(rebuilt, key)).sort();
}

function canonicalAt(doc: Record<string, unknown>, key: string): string | symbol {
  if (!Object.hasOwn(doc, key)) return Symbol("missing");
  try {
    return canonicalJson(doc[key]);
  } catch {
    return Symbol("unencodable");
  }
}

function uint64(value: unknown): bigint | null {
  return typeof value === "string" && DECIMAL.test(value) && BigInt(value) < UINT64_LIMIT ? BigInt(value) : null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
