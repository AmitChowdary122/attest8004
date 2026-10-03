import {
  computeActionHashFromParts,
  computeRequestHashFromParts,
  decodeJsonDataUri,
  EVIDENCE_SCHEMA_V1,
  type RequestParts,
  type ValidationStatus,
} from "@attest8004/sdk";
import { getAddress, isAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { z } from "zod";
import { mapWithConcurrency } from "./concurrency.ts";
import { MANDATE_V1 } from "./params.ts";
import type { MandateReader } from "./reader.ts";
import type { MandateInputs, MandateRecord, PermissionEvent, PinnedBlock, SpendEntry } from "./types.ts";

/**
 * The action fields of requests already authenticated against their `requestHash`, keyed by that
 * hash (lower-case hex, as viem decodes it). The validator fills it with the requests it checks, and
 * `collectInputs` with every approval whose evidence it authenticates, so a hit skips the evidence
 * lookup. The parts are bound to the hash, so a hit and a miss give the same entry.
 */
export type PreimageCache = Map<Hex, Omit<RequestParts, "validator">>;

/** The largest approval evidence URI `collectInputs` decodes. */
export const MAX_EVIDENCE_URI_BYTES = 131_072;

/** How many approvals' status, evidence and `consumed()` reads run at once. */
const SPEND_READ_CONCURRENCY = 8;

/**
 * State at `P` shows an approval, but its `ValidationResponse` log wasn't found at the blocks carrying
 * its `lastUpdate` timestamp. That is RPC or log-index lag (or a search bug), not evidence about the
 * approval, so it is never a verdict: the check throws and the validator retries it in a later cycle.
 */
export class SpendLogNotFoundError extends Error {
  readonly requestHash: Hex;
  readonly approvedAt: bigint;

  constructor(requestHash: Hex, approvedAt: bigint) {
    super(`no ValidationResponse log found for approval ${requestHash} at timestamp ${approvedAt}; retry later`);
    this.name = "SpendLogNotFoundError";
    this.requestHash = requestHash;
    this.approvedAt = approvedAt;
  }
}

/**
 * The mandate at `P` was set inside the permission window (or, inconsistently, after `P`), but its own
 * `MandateSet` log isn't among the window's events, so permission events can't be ordered against it.
 * Inconsistent data or lag, never a verdict: the check throws and is retried.
 */
export class MandateSetLogNotFoundError extends Error {
  readonly setAtBlock: bigint;

  constructor(setAtBlock: bigint, fromBlock: bigint, toBlock: bigint) {
    super(
      `the mandate was set at block ${setAtBlock}, but no MandateSet log for it was found in [${fromBlock}, ${toBlock}]; retry later`,
    );
    this.name = "MandateSetLogNotFoundError";
    this.setAtBlock = setAtBlock;
  }
}

/**
 * Whether an approval's value counts toward the daily cap at `P`: it was consumed; or it is
 * unconsumed and can still execute (`deadline >= P.timestamp`); or its `consumed()` read failed
 * (`null`), which counts (fail closed). An approval that expired unconsumed can never execute, so it
 * never counts.
 */
export function countsTowardSpend(consumed: boolean | null, deadline: bigint, pinnedTs: bigint): boolean {
  return consumed === true || consumed === null || deadline >= pinnedTs;
}

const UINT256_MAX = 2n ** 256n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const DECIMAL = /^(0|[1-9]\d*)$/;

// zod runs a refinement even after the regex has failed, so the range check repeats the regex rather
// than letting BigInt() throw on "abc".
const decimal = (max: bigint) =>
  z
    .string()
    .regex(DECIMAL, "must be a decimal string without leading zeros")
    .refine((s) => DECIMAL.test(s) && BigInt(s) <= max, "out of range");

// Lower-case is accepted; mixed case must be a valid EIP-55 checksum. Output is checksummed.
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address")
  .refine((s) => isAddress(s, { strict: true }), "bad EIP-55 checksum")
  .transform((s) => getAddress(s));

const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be 32 bytes of 0x-prefixed hex")
  .transform((s) => s.toLowerCase() as Hex);

/**
 * The part of a `mandate-v1` evidence document the spend history reads. `request` is strict (an
 * unknown key is rejected); the document's other keys (`block`, `params`, `mandate`, `spend`,
 * `permissions`, `simulation`) explain the verdict and aren't read here.
 */
const approvalEvidenceSchema = z.object({
  schema: z.literal(EVIDENCE_SCHEMA_V1),
  validator: z.literal(MANDATE_V1.tag),
  requestHash: bytes32,
  score: z.number().int(),
  reasons: z.array(z.string()),
  request: z.strictObject({
    block: decimal(UINT64_MAX),
    chainId: z.number().int().positive().refine(Number.isSafeInteger, "must be a safe integer"),
    gate: address,
    agentId: decimal(UINT256_MAX),
    target: address,
    value: decimal(UINT256_MAX),
    dataHash: bytes32,
    selector: z.union([z.string().regex(/^0x[0-9a-fA-F]{8}$/, "must be 4 bytes of 0x-prefixed hex"), z.null()]),
    deadline: decimal(UINT64_MAX),
    salt: bytes32,
  }),
});

/**
 * Parses a `mandate-v1` evidence document (its JSON text) strictly, into the `requestHash` it names
 * and the request parts it logged: everything `computeRequestHashFromParts` needs except the
 * validator. Never throws; anything else is `{ error }`.
 */
export function parseApprovalParts(
  json: string,
): { requestHash: Hex; parts: Omit<RequestParts, "validator"> } | { error: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return { error: "the evidence is not JSON" };
  }
  let parsed: ReturnType<typeof approvalEvidenceSchema.safeParse>;
  try {
    parsed = approvalEvidenceSchema.safeParse(doc);
  } catch (error) {
    // Defence in depth: a refinement that throws on hostile input is still a schema rejection.
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid" };
  }
  const { requestHash, request } = parsed.data;
  return {
    requestHash,
    parts: {
      chainId: request.chainId,
      gate: request.gate,
      agentId: BigInt(request.agentId),
      target: request.target,
      value: BigInt(request.value),
      dataHash: request.dataHash,
      deadline: BigInt(request.deadline),
      salt: request.salt,
    },
  };
}

/**
 * Reads every input of a `mandate-v1` verdict at the pinned block `P` (`pinned`): the owner, the
 * mandate, the spend history (only when there is a mandate), the permission events in `(P − N, P]`
 * and the simulation. Every reader call is given `P`'s number, and every log range ends at `P`.
 *
 * - **Spend.** The entries are this validator's `mandate-v1` approvals (response 100) of this agent's
 *   actions with `lastUpdate > P.timestamp − MANDATE_V1.spendWindowSeconds`, in `getAgentValidations`
 *   order, skipping the request being evaluated. Each one's action fields come from the cache, or
 *   else from its own evidence, authenticated twice: its keccak256 must be the approval's
 *   `responseHash`, and its request parts must recompute to the approval's `requestHash`. Evidence
 *   that was found but fails either check, or doesn't parse, makes the whole spend
 *   `{ unreadable: "<requestHash>: <why>" }` (the first such approval in order). Evidence that wasn't
 *   found throws {@link SpendLogNotFoundError}. `total` sums the entries that
 *   {@link countsTowardSpend}.
 * - **Permissions.** An event is `afterMandate` when its `(block, logIndex)` comes after the current
 *   mandate's own `MandateSet` log (the last one for this agent in block `setAtBlock`). A mandate set
 *   before the window, or no mandate at all, makes every event after it. A mandate set inside the
 *   window whose log isn't there throws {@link MandateSetLogNotFoundError}.
 * - **Simulation.** The action as the gate would make it: from `gate` to `target` with `value` and
 *   `data`, capped at `MANDATE_V1.simulationGas`.
 *
 * Any reader failure rejects, so a transient RPC error never becomes a verdict.
 */
export async function collectInputs(o: {
  reader: MandateReader;
  validator: Address;
  request: MandateInputs["request"];
  pinned: PinnedBlock;
  cache: PreimageCache;
}): Promise<MandateInputs> {
  const { reader, request, pinned } = o;
  const at = pinned.number;
  const [owner, mandate] = await Promise.all([reader.ownerOf(request.agentId, at), reader.mandate(request.agentId, at)]);
  const [spend, permissions, simulation] = await Promise.all([
    mandate === null ? null : collectSpend(o),
    collectPermissions(reader, request.agentId, owner, mandate, pinned),
    reader.simulate(
      { from: request.gate, to: request.target, value: request.value, data: request.data, gas: MANDATE_V1.simulationGas },
      at,
    ),
  ]);
  return { pinned, owner, request, mandate, spend, permissions, simulation };
}

async function collectSpend(o: {
  reader: MandateReader;
  validator: Address;
  request: MandateInputs["request"];
  pinned: PinnedBlock;
  cache: PreimageCache;
}): Promise<NonNullable<MandateInputs["spend"]>> {
  const { reader, validator, request, pinned, cache } = o;
  const at = pinned.number;
  const since = pinned.timestamp - MANDATE_V1.spendWindowSeconds;
  const current = request.requestHash.toLowerCase();
  const hashes = (await reader.agentValidations(request.agentId, at)).filter((hash) => hash.toLowerCase() !== current);

  const results = await mapWithConcurrency(
    hashes,
    SPEND_READ_CONCURRENCY,
    async (requestHash): Promise<SpendEntry | { unreadable: string } | null> => {
      const status = await reader.status(requestHash, at);
      if (!isSpendApproval(status, validator, since)) return null;
      const key = requestHash.toLowerCase() as Hex;
      let parts = cache.get(key);
      if (parts === undefined) {
        const authenticated = await authenticatedParts(reader, requestHash, status, at);
        if ("unreadable" in authenticated) return authenticated;
        parts = authenticated;
        cache.set(key, parts);
      }
      const consumed = await reader.consumed(parts.gate, computeActionHashFromParts(parts), at);
      return {
        requestHash,
        approvedAt: status.lastUpdate,
        gate: getAddress(parts.gate),
        value: parts.value,
        deadline: parts.deadline,
        consumed,
        counted: countsTowardSpend(consumed, parts.deadline, pinned.timestamp),
      };
    },
  );

  const entries: SpendEntry[] = [];
  for (const result of results) {
    if (result === null) continue;
    if ("unreadable" in result) return result;
    entries.push(result);
  }
  const total = entries.reduce((sum, entry) => (entry.counted ? sum + entry.value : sum), 0n);
  return { since, entries, total };
}

function isSpendApproval(status: ValidationStatus, validator: Address, since: bigint): boolean {
  return (
    status.validator.toLowerCase() === validator.toLowerCase() &&
    status.tag === MANDATE_V1.tag &&
    status.response === 100 &&
    status.lastUpdate > since
  );
}

/** The approval's request parts from its own evidence, authenticated, or why the evidence fails. */
async function authenticatedParts(
  reader: MandateReader,
  requestHash: Hex,
  status: ValidationStatus,
  notAfter: bigint,
): Promise<Omit<RequestParts, "validator"> | { unreadable: string }> {
  const uri = await reader.responseEvidence(requestHash, status.lastUpdate, notAfter);
  if (uri === null) throw new SpendLogNotFoundError(requestHash, status.lastUpdate);
  const unreadable = (why: string) => ({ unreadable: `${requestHash}: ${why}` });

  const decoded = decodeJsonDataUri(uri, MAX_EVIDENCE_URI_BYTES);
  if (!decoded.ok) return unreadable(`the response URI is not a JSON data: URI (${decoded.reason}: ${decoded.detail})`);
  const evidenceHash = keccak256(stringToBytes(decoded.text));
  if (evidenceHash !== status.responseHash.toLowerCase()) {
    return unreadable(`the evidence hashes to ${evidenceHash}, not the responseHash ${status.responseHash}`);
  }
  const parsed = parseApprovalParts(decoded.text);
  if ("error" in parsed) return unreadable(`not mandate-v1 evidence with request parts (${parsed.error})`);
  if (parsed.requestHash !== requestHash.toLowerCase()) {
    return unreadable(`the evidence is for requestHash ${parsed.requestHash}`);
  }
  const recomputed = computeRequestHashFromParts({ ...parsed.parts, validator: status.validator });
  if (recomputed !== requestHash.toLowerCase()) {
    return unreadable(`the evidence's request parts recompute to requestHash ${recomputed}`);
  }
  return parsed.parts;
}

async function collectPermissions(
  reader: MandateReader,
  agentId: bigint,
  owner: Address,
  mandate: MandateRecord | null,
  pinned: PinnedBlock,
): Promise<MandateInputs["permissions"]> {
  const toBlock = pinned.number;
  const first = toBlock - MANDATE_V1.permissionWindowBlocks + 1n;
  const fromBlock = first > 0n ? first : 0n;
  const logs = await reader.permissionLogs(fromBlock, toBlock, { agentId, owner });
  const mandateLog = currentMandateLog(mandate, fromBlock, toBlock, logs);
  return {
    fromBlock,
    toBlock,
    events: logs.map((event) => ({
      ...event,
      afterMandate:
        mandateLog === null ||
        event.block > mandateLog.block ||
        (event.block === mandateLog.block && event.logIndex > mandateLog.logIndex),
    })),
  };
}

/**
 * Where the current mandate's own `MandateSet` log is, to order the window's events against it: the
 * last `MandateSet` in block `setAtBlock`. `null` when every event in the window is after the mandate
 * (there is none, or it was set before the window).
 */
function currentMandateLog(
  mandate: MandateRecord | null,
  fromBlock: bigint,
  toBlock: bigint,
  logs: Array<Omit<PermissionEvent, "afterMandate">>,
): { block: bigint; logIndex: number } | null {
  if (mandate === null || mandate.setAtBlock < fromBlock) return null;
  let found: { block: bigint; logIndex: number } | null = null;
  if (mandate.setAtBlock <= toBlock) {
    for (const event of logs) {
      if (event.emitter !== "MandateRegistry" || event.event !== "MandateSet" || event.block !== mandate.setAtBlock) continue;
      if (found === null || event.logIndex > found.logIndex) found = { block: event.block, logIndex: event.logIndex };
    }
  }
  if (found === null) throw new MandateSetLogNotFoundError(mandate.setAtBlock, fromBlock, toBlock);
  return found;
}
