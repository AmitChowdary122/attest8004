import {
  buildEvidence,
  canonicalJson,
  decodeJsonDataUri,
  parseRequestUri,
  requestHashOfJson,
  validationRegistryAbi,
  type RequestJsonV1,
  type ValidationStatus,
} from "@attest8004/sdk";
import { decodeErrorResult, keccak256, stringToBytes, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { MAX_EVIDENCE_URI_BYTES, type PreimageCache } from "./collect.ts";
import { MANDATE_V1 } from "./params.ts";
import type { MandateAddresses, VerifyReader } from "./reader.ts";
import { mandateRequestOf, runMandateV1 } from "./run.ts";
import type { PermissionEvent, PinnedBlock, SpendEntry } from "./types.ts";

/**
 * Why `verify` didn't find a match. Each one either proves the validator misbehaved (a mismatch) or
 * means the verdict couldn't be re-run (unverifiable); see {@link MISMATCH_PROBLEMS}.
 *
 * - `NOT_MANDATE_V1`: the response is tagged something else, so there is no `mandate-v1` run to
 *   repeat. Unverifiable: another validator's verdict (an agentic `risk-qwen-v1` one, say) is not
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
 *   block at which its status exists. A mismatch.
 * - `REQUEST_INVALID`: the request's own log carries a request JSON that doesn't parse, doesn't hash
 *   to `requestHash`, or names another validator or agent than the registry records. A
 *   `mandate-v1` validator must not answer such a request (the SDK's base never does), so a mismatch.
 * - `PIN_OUT_OF_RANGE`: the evidence's pinned block is before the request's block or after the block
 *   the response landed in. A mismatch: an honest validator pins between the two.
 * - `SCORE_MISMATCH`: the onchain score isn't the recomputed one. A mismatch.
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
  | "RESPONSE_HASH_MISMATCH";

/** The problems that prove the validator misbehaved. Every other problem means the verdict couldn't be re-run. */
export const MISMATCH_PROBLEMS: ReadonlySet<VerifyProblem> = new Set([
  "EVIDENCE_HASH_MISMATCH",
  "REQUEST_BLOCK_WRONG",
  "REQUEST_INVALID",
  "PIN_OUT_OF_RANGE",
  "SCORE_MISMATCH",
  "RESPONSE_HASH_MISMATCH",
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
 * 3. `P` must be at or after the evidence's request block and at or before the response's own block
 *    (→ `PIN_OUT_OF_RANGE`).
 * 4. Reads the `ValidationRequest` log in the evidence's request block. If none is returned, state
 *    decides: the request's status must exist at that block and not one block before
 *    (→ `REQUEST_BLOCK_WRONG` if not, else `REQUEST_NOT_FOUND`). The log's request JSON must hash
 *    to `requestHash` and name the validator and agent the registry records (→ `REQUEST_INVALID`).
 * 5. Runs `runMandateV1` at `P` as that validator, with an empty cache (so every past approval's
 *    amount is rebuilt from its own evidence) and `addresses`, rebuilds the evidence with
 *    `buildEvidence` and hashes its canonical JSON.
 * 6. Compares the score (→ `SCORE_MISMATCH`) and the `responseHash` (→ `RESPONSE_HASH_MISMATCH`),
 *    listing the top-level evidence keys that differ.
 *
 * Rejects, rather than report, when a read fails: an RPC error (including history the node no longer
 * serves, and any revert other than the registry's `UnknownRequest`), or an input log the re-run
 * can't find (`SpendLogNotFoundError`, `MandateSetLogNotFoundError`). Like the validator, it never
 * turns a failed read into a verdict, let alone a mismatch; retry later or use another RPC.
 */
export async function verifyRequest(o: { reader: VerifyReader; requestHash: Hex; addresses: MandateAddresses }): Promise<VerifyReport> {
  const { reader, addresses } = o;
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
  if (pinnedBlock < requestBlock || pinnedBlock > response.block) return report({ ...base, pinnedBlock }, ["PIN_OUT_OF_RANGE"]);

  const request = await requestAt(reader, requestHash, requestBlock, status);
  if ("problem" in request) return report({ ...base, pinnedBlock }, [request.problem]);
  const { json } = request;

  const pinned = await reader.block(pinnedBlock);
  const cache: PreimageCache = new Map();
  const result = await runMandateV1({
    reader,
    addresses,
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
    },
    problems,
  );
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
  };
}

/** The status at `at`, or `null` when the registry reverts `UnknownRequest` there (no such request yet). */
async function statusOrUnknown(reader: VerifyReader, requestHash: Hex, at: bigint): Promise<ValidationStatus | null> {
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
 */
function isUnknownRequest(error: unknown): boolean {
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
 * When no log is returned, state decides whether the evidence named the wrong block: the registry
 * refuses to reuse a `requestHash` (`RequestExists`), so the request was made in exactly one block,
 * the first at which its status exists. If the status exists at `block` and not at `block − 1`, the
 * block is right and only the log is missing (`REQUEST_NOT_FOUND`: lag, not evidence); otherwise the
 * evidence is wrong (`REQUEST_BLOCK_WRONG`). A failed status read rejects, so a transport error is
 * never a mismatch.
 */
async function requestAt(
  reader: VerifyReader,
  requestHash: Hex,
  block: bigint,
  status: ValidationStatus,
): Promise<{ json: RequestJsonV1 } | { problem: VerifyProblem }> {
  const uri = await reader.requestUri(requestHash, block);
  if (uri === null) {
    const existsAtBlock = (await statusOrUnknown(reader, requestHash, block)) !== null;
    const existedBefore = existsAtBlock && block > 0n && (await statusOrUnknown(reader, requestHash, block - 1n)) !== null;
    return { problem: existsAtBlock && !existedBefore ? "REQUEST_NOT_FOUND" : "REQUEST_BLOCK_WRONG" };
  }
  const parsed = parseRequestUri(uri);
  if (!parsed.ok) return { problem: "REQUEST_INVALID" };
  const { json } = parsed;
  const matches =
    requestHashOfJson(json) === requestHash &&
    json.validator.toLowerCase() === status.validator.toLowerCase() &&
    BigInt(json.agentId) === status.agentId;
  return matches ? { json } : { problem: "REQUEST_INVALID" };
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
