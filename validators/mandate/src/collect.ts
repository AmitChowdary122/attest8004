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

/**
 * How many approvals are worked on at once. It bounds queued work, not requests: the reader bounds
 * the RPCs it sends (`viemMandateReader`'s single limiter covers spend and permission reads alike).
 */
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

const evidenceSchemaField = z.literal(EVIDENCE_SCHEMA_V1);
const validatorField = z.literal(MANDATE_V1.tag);
const scoreField = z.number().int();
const reasonsField = z.array(z.string());
const block = decimal(UINT64_MAX);
const chainId = z.number().int().positive().refine(Number.isSafeInteger, "must be a safe integer");
const uint256 = decimal(UINT256_MAX);
const uint64 = decimal(UINT64_MAX);
const selector = z.union([z.string().regex(/^0x[0-9a-fA-F]{8}$/, "must be 4 bytes of 0x-prefixed hex"), z.null()]);

/** The keys of an evidence document's `request`, in the order they are checked. */
const REQUEST_KEYS = ["block", "chainId", "gate", "agentId", "target", "value", "dataHash", "selector", "deadline", "salt"];

const INVALID = Symbol("invalid");

/** `value` parsed by `schema`, or {@link INVALID}. A refinement that throws on hostile input is invalid too. */
function check<S extends z.ZodType>(schema: S, value: unknown): z.output<S> | typeof INVALID {
  try {
    const result = schema.safeParse(value);
    return result.success ? result.data : INVALID;
  } catch {
    return INVALID;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses a `mandate-v1` evidence document (its JSON text) strictly, into the `requestHash` it names
 * and the request parts it logged: everything `computeRequestHashFromParts` needs except the
 * validator. Never throws; anything else is `{ error }`.
 *
 * The top level must have `schema` (`attest8004.evidence.v1`), `validator` (`mandate-v1`),
 * `requestHash` (bytes32), `score` (an integer) and `reasons` (strings); its other keys explain the
 * verdict and aren't read here. `request` is strict: `block`, `agentId`, `value` and `deadline` as
 * decimal strings, `chainId` as a JSON number, `gate` and `target` as addresses (lower-case or EIP-55),
 * `dataHash` and `salt` as bytes32, `selector` as 4 bytes or `null`, and no other key.
 *
 * The error is one of a fixed set of our own strings, never a library's message: `not JSON`,
 * `not a JSON object`, `invalid at <field>` naming the first failing field in the order above, or
 * `unknown key in request`. It can end up in hashed evidence, so it must not change with a
 * dependency upgrade.
 */
export function parseApprovalParts(
  json: string,
): { requestHash: Hex; parts: Omit<RequestParts, "validator"> } | { error: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return { error: "not JSON" };
  }
  if (!isJsonObject(doc)) return { error: "not a JSON object" };
  const invalid = (field: string) => ({ error: `invalid at ${field}` });

  if (check(evidenceSchemaField, doc.schema) === INVALID) return invalid("schema");
  if (check(validatorField, doc.validator) === INVALID) return invalid("validator");
  const requestHash = check(bytes32, doc.requestHash);
  if (requestHash === INVALID) return invalid("requestHash");
  if (check(scoreField, doc.score) === INVALID) return invalid("score");
  if (check(reasonsField, doc.reasons) === INVALID) return invalid("reasons");

  const request = doc.request;
  if (!isJsonObject(request)) return invalid("request");
  if (check(block, request.block) === INVALID) return invalid("request.block");
  const parsedChainId = check(chainId, request.chainId);
  if (parsedChainId === INVALID) return invalid("request.chainId");
  const gate = check(address, request.gate);
  if (gate === INVALID) return invalid("request.gate");
  const agentId = check(uint256, request.agentId);
  if (agentId === INVALID) return invalid("request.agentId");
  const target = check(address, request.target);
  if (target === INVALID) return invalid("request.target");
  const value = check(uint256, request.value);
  if (value === INVALID) return invalid("request.value");
  const dataHash = check(bytes32, request.dataHash);
  if (dataHash === INVALID) return invalid("request.dataHash");
  if (check(selector, request.selector) === INVALID) return invalid("request.selector");
  const deadline = check(uint64, request.deadline);
  if (deadline === INVALID) return invalid("request.deadline");
  const salt = check(bytes32, request.salt);
  if (salt === INVALID) return invalid("request.salt");
  if (Object.keys(request).some((key) => !REQUEST_KEYS.includes(key))) return { error: "unknown key in request" };

  return {
    requestHash,
    parts: {
      chainId: parsedChainId,
      gate,
      agentId: BigInt(agentId),
      target,
      value: BigInt(value),
      dataHash,
      deadline: BigInt(deadline),
      salt,
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
 * Any reader failure rejects, so a transient RPC error never becomes a verdict. Spend, permission
 * and simulation reads run side by side; the reader bounds how many requests are in flight.
 *
 * An `unreadable` reason is built only from our own fixed text, hashes and the URI rejection code,
 * never from a library's message, because it is part of the hashed evidence: the validator and a
 * later `verify` must produce the same bytes.
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
    mandate === null
      ? null
      : collectSpend({ reader, validator: o.validator, agentId: request.agentId, pinned, cache: o.cache, exclude: request.requestHash }),
    collectPermissions(reader, request.agentId, owner, mandate, pinned),
    reader.simulate(
      { from: request.gate, to: request.target, value: request.value, data: request.data, gas: MANDATE_V1.simulationGas },
      at,
    ),
  ]);
  return { pinned, owner, request, mandate, spend, permissions, simulation };
}

/**
 * The agent's `mandate-v1` spend at `P`, exactly as {@link collectInputs} reads it for a verdict (see
 * "Spend" there): this validator's approvals of `agentId` in the 25 h window, each authenticated, with
 * `total` summing the ones that count. `exclude` names a request to leave out (a verdict leaves out the
 * request it evaluates); without it every approval is an entry, which is what a check before requesting
 * wants (would one more action fit under the daily cap?). A missing approval log throws
 * {@link SpendLogNotFoundError}, never a smaller spend.
 */
export async function collectSpend(o: {
  reader: MandateReader;
  validator: Address;
  agentId: bigint;
  pinned: PinnedBlock;
  cache: PreimageCache;
  exclude?: Hex;
}): Promise<NonNullable<MandateInputs["spend"]>> {
  const { reader, validator, agentId, pinned, cache } = o;
  const at = pinned.number;
  const since = pinned.timestamp - MANDATE_V1.spendWindowSeconds;
  const excluded = o.exclude?.toLowerCase();
  const hashes = (await reader.agentValidations(agentId, at)).filter((hash) => hash.toLowerCase() !== excluded);

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
  // Fixed text only (see collectInputs): the URI's rejection code, never its detail message.
  const unreadable = (why: string) => ({ unreadable: `${requestHash.toLowerCase()}: ${why}` });

  const decoded = decodeJsonDataUri(uri, MAX_EVIDENCE_URI_BYTES);
  if (!decoded.ok) return unreadable(`response URI rejected (${decoded.reason})`);
  const evidenceHash = keccak256(stringToBytes(decoded.text));
  const responseHash = status.responseHash.toLowerCase();
  if (evidenceHash !== responseHash) return unreadable(`evidence hash ${evidenceHash} is not the responseHash ${responseHash}`);
  const parsed = parseApprovalParts(decoded.text);
  if ("error" in parsed) return unreadable(`not mandate-v1 evidence (${parsed.error})`);
  if (parsed.requestHash !== requestHash.toLowerCase()) return unreadable(`evidence names requestHash ${parsed.requestHash}`);
  const recomputed = computeRequestHashFromParts({ ...parsed.parts, validator: status.validator });
  if (recomputed !== requestHash.toLowerCase()) return unreadable(`evidence request parts recompute to requestHash ${recomputed}`);
  return parsed.parts;
}

/**
 * The permission-change events `collectInputs` reads for a `mandate-v1` verdict (see "Permissions"
 * there): `reader.permissionLogs` over `(P − MANDATE_V1.permissionWindowBlocks, P]`, each with whether
 * it came after the current mandate's own `MandateSet` log. Exported so `risk-v1`'s
 * `recent_permission_events` tool (P5) can reuse it unchanged, over the same reader and window.
 */
export async function collectPermissions(
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
