import { canonicalJson } from "@attest8004/sdk";
import { collectPermissions, type MandateInputs, type MandateRecord, type PinnedBlock } from "@attest8004/validator-mandate";
import { getAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import { z } from "zod";
import { type ToolName } from "./findings.ts";
import type { NansenClient } from "./nansen.ts";
import { RISK_V1 } from "./params.ts";
import type { RiskReader } from "./reader.ts";
import { dropTrailingLoneSurrogate, flattenTrace, type JsonObject } from "./trace.ts";
import type { JsonValue } from "./types.ts";

/** The five tools that read the chain directly, all `onchain: true` and re-run byte-for-byte by `verify`. */
export const ONCHAIN_TOOLS = [
  "get_mandate",
  "simulate_action",
  "recent_permission_events",
  "counterparty_onchain",
  "erc8004_reputation",
] as const satisfies readonly ToolName[];

type OnchainToolName = (typeof ONCHAIN_TOOLS)[number];

function isOnchainToolName(name: string): name is OnchainToolName {
  return (ONCHAIN_TOOLS as readonly string[]).includes(name);
}

/**
 * The two Nansen tools (Task 9): always `onchain: false`, so `verify` reports them `unchecked` rather
 * than re-running them (types.ts's `ToolCallRecord` doc). Both take the same single `address`
 * argument as `counterparty_onchain`, subject to the same scope check (Decision 18).
 */
export const NANSEN_TOOLS = ["nansen_counterparty_profile", "nansen_flows"] as const satisfies readonly ToolName[];

type NansenToolName = (typeof NANSEN_TOOLS)[number];

function isNansenToolName(name: string): name is NansenToolName {
  return (NANSEN_TOOLS as readonly string[]).includes(name);
}

/** One entry of the OpenAI-compatible `tools` array sent to the model. */
function toolDefinition(
  name: OnchainToolName | NansenToolName,
  description: string,
  properties: Record<string, { type: string; description: string }>,
  required: string[] = [],
) {
  return {
    type: "function" as const,
    function: {
      name,
      description,
      parameters: { type: "object" as const, properties, required, additionalProperties: false },
    },
  };
}

/** The description every address argument shares (Decision 18): what scope means, independent of which tool. */
const ADDRESS_ARG_DESCRIPTION =
  "A 0x-prefixed, 20-byte EVM address. Must be in scope: the target, the gate, the owner, a mandate-allowed target, or an address a previous tool call returned.";

/**
 * The OpenAI `tools` array for all seven tools, in {@link ONCHAIN_TOOLS} then {@link NANSEN_TOOLS}
 * order (matching `findings.ts`'s `TOOL_NAMES`). `get_mandate`/`simulate_action`/
 * `recent_permission_events` take no arguments: they always read the request's own
 * target/gate/agent, never a model-supplied address.
 */
export const TOOL_DEFINITIONS = [
  toolDefinition("get_mandate", "Read the requesting agent's mandate and its owner, both at the pinned block.", {}),
  toolDefinition(
    "simulate_action",
    "Simulate the requested action (debug_traceCall) at the pinned block, from the gate to the request's target, with the request's value and data. Shows every call it makes and where value ends up.",
    {},
  ),
  toolDefinition(
    "recent_permission_events",
    "List ownership and mandate-change events for the requesting agent in the recent block window ending at the pinned block.",
    {},
  ),
  toolDefinition(
    "counterparty_onchain",
    "Read onchain facts about one address at the pinned block: whether it has code, an EIP-7702 delegate, balance, nonce, how many ERC-8004 agents it owns, and an age estimate.",
    { address: { type: "string", description: ADDRESS_ARG_DESCRIPTION } },
    ["address"],
  ),
  toolDefinition(
    "erc8004_reputation",
    "Read an ERC-8004 agent's current owner and its Reputation Registry summary (client count and, when it has clients, the aggregate feedback over the first 16).",
    { agentId: { type: "string", description: "The agent's ERC-8004 token id, as a decimal string." } },
    ["agentId"],
  ),
  toolDefinition(
    "nansen_counterparty_profile",
    "Look up Nansen's entity/behavioural labels and funding origin (first funder) for one address, searched across every chain Nansen indexes. Unavailable (no NANSEN_API_KEY) today.",
    { address: { type: "string", description: ADDRESS_ARG_DESCRIPTION } },
    ["address"],
  ),
  toolDefinition(
    "nansen_flows",
    "Look up Nansen's top counterparties (by USD volume) for one address over the 30 days ending at the pinned block's time, searched across every chain Nansen indexes. Unavailable (no NANSEN_API_KEY) today.",
    { address: { type: "string", description: ADDRESS_ARG_DESCRIPTION } },
    ["address"],
  ),
];

/** Everything a tool call reads from: the chain reader, the pinned block, the request, Nansen, and the live address scope. */
export interface ToolContext {
  reader: RiskReader;
  pinned: PinnedBlock;
  request: MandateInputs["request"];
  nansen: NansenClient;
  /**
   * Lower-case addresses an address argument may name (Decision 18), seeded by {@link initialScope}.
   * **`runTool` mutates this set**: every address found anywhere in a tool's own (capped) output is
   * added to it (lower-cased), so a later call in the same run may use an address this run turned up
   * (e.g. `simulate_action`'s sink). `runTool` never removes an address, so later calls see everything
   * earlier ones added, in whatever order the loop made the calls.
   */
  scope: Set<string>;
}

/** One screened field `runTool` found in a tool's own output (Decision 12: the simulation's revert reason). */
export interface UntrustedField {
  source: string;
  text: string;
}

const addressArg = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address")
  .refine((s) => isAddress(s, { strict: true }), "bad EIP-55 checksum")
  .transform((s) => getAddress(s));

const UINT256_MAX = 2n ** 256n - 1n;
const DECIMAL = /^(0|[1-9]\d*)$/;
const agentIdArg = z
  .string()
  .regex(DECIMAL, "must be a decimal string without leading zeros")
  .refine((s) => DECIMAL.test(s) && BigInt(s) <= UINT256_MAX, "out of range")
  .transform((s) => BigInt(s));

const noArgsSchema = z.strictObject({});
const counterpartyArgsSchema = z.strictObject({ address: addressArg });
const reputationArgsSchema = z.strictObject({ agentId: agentIdArg });

/** The validated arguments `execute` needs per tool, or `null` for a schema mismatch. */
type ToolArgs = { address?: Address; agentId?: bigint };

function validateArguments(name: OnchainToolName | NansenToolName, parsed: unknown): ToolArgs | null {
  if (name === "counterparty_onchain" || name === "nansen_counterparty_profile" || name === "nansen_flows") {
    const result = counterpartyArgsSchema.safeParse(parsed);
    return result.success ? { address: result.data.address } : null;
  }
  if (name === "erc8004_reputation") {
    const result = reputationArgsSchema.safeParse(parsed);
    return result.success ? { agentId: result.data.agentId } : null;
  }
  const result = noArgsSchema.safeParse(parsed);
  return result.success ? {} : null;
}

/** Whether an own `__proto__` key appears in any object at any depth of `value`. */
function hasProtoKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasProtoKey);
  if (value === null || typeof value !== "object") return false;
  return Object.prototype.hasOwnProperty.call(value, "__proto__") || Object.values(value).some(hasProtoKey);
}

/**
 * Whether parsed model JSON can be recorded as is (Ruling R3): canonical-JSON-safe (no float, no
 * integer past 2^53), and with no own `__proto__` key at any depth. `JSON.parse` keeps `"__proto__"`
 * as an ordinary own key and `canonicalJson` writes it, but zod's records drop it silently, so a
 * record holding one could never be parsed back into the same evidence bytes (fix round 1 for Task
 * 11). Anything else is recorded as the raw string. `runTool` and the agent loop both decide this way.
 */
export function isRecordableJson(value: unknown): value is JsonValue {
  try {
    canonicalJson(value);
  } catch {
    return false;
  }
  return !hasProtoKey(value);
}

/**
 * Every `0x`-address-shaped string anywhere in `value`, lower-cased, added to `out`: what `runTool`
 * adds to the scope from a tool's capped output. Exported so `verify` rebuilds the scope from the
 * recorded outputs exactly this way.
 */
export function collectAddresses(value: JsonValue, out: Set<string>): void {
  if (typeof value === "string") {
    if (/^0x[0-9a-fA-F]{40}$/.test(value)) out.add(value.toLowerCase());
  } else if (Array.isArray(value)) {
    for (const item of value) collectAddresses(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectAddresses(item, out);
  }
}

/** `wei` as a decimal MON string with no floats (e.g. `1_000_000_000_000_000n` -> `"0.001"`). */
export function weiToMon(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / 1_000_000_000_000_000_000n;
  const frac = abs % 1_000_000_000_000_000_000n;
  const fracDigits = frac.toString().padStart(18, "0").replace(/0+$/, "");
  const body = fracDigits.length > 0 ? `${whole}.${fracDigits}` : whole.toString();
  return negative ? `-${body}` : body;
}

async function getMandateTool(ctx: ToolContext): Promise<{ output: JsonValue; untrusted: UntrustedField[] }> {
  const at = ctx.pinned.number;
  const agentId = ctx.request.agentId;
  const [mandate, owner] = await Promise.all([ctx.reader.mandate(agentId, at), ctx.reader.ownerOf(agentId, at)]);
  const mandateOwnerIsCurrent = mandate !== null && mandate.owner.toLowerCase() === owner.toLowerCase();
  const output: JsonValue = {
    owner: getAddress(owner),
    mandateOwnerIsCurrent,
    mandate:
      mandate === null
        ? null
        : {
            allowedTargets: mandate.allowedTargets.map((a) => getAddress(a)),
            allowedSelectors: [...mandate.allowedSelectors],
            maxValuePerTx: mandate.maxValuePerTx.toString(),
            maxValuePerTxMon: weiToMon(mandate.maxValuePerTx),
            maxValuePerDay: mandate.maxValuePerDay.toString(),
            maxValuePerDayMon: weiToMon(mandate.maxValuePerDay),
            validUntil: mandate.validUntil.toString(),
            mandateHash: mandate.mandateHash,
            owner: getAddress(mandate.owner),
            setAtBlock: mandate.setAtBlock.toString(),
          },
  };
  return { output, untrusted: [] };
}

async function simulateActionTool(ctx: ToolContext): Promise<{ output: JsonValue; untrusted: UntrustedField[] }> {
  const { reader, request, pinned } = ctx;
  const result = await reader.trace(
    { from: request.gate, to: request.target, value: request.value, data: request.data, gas: RISK_V1.simulationGas },
    pinned.number,
  );
  const flattened: JsonObject = flattenTrace(result, RISK_V1.maxTraceCalls);
  const untrusted: UntrustedField[] = [];
  const revertReason = flattened.revertReason;
  if (typeof revertReason === "string" && revertReason.length > 0) {
    untrusted.push({ source: "tool:simulate_action", text: revertReason });
  }
  return { output: flattened, untrusted };
}

async function recentPermissionEventsTool(ctx: ToolContext): Promise<{ output: JsonValue; untrusted: UntrustedField[] }> {
  const { reader, request, pinned } = ctx;
  const at = pinned.number;
  const [owner, mandate] = await Promise.all([reader.ownerOf(request.agentId, at), reader.mandate(request.agentId, at)]);
  const result = await collectPermissions(reader, request.agentId, owner, mandate, pinned);
  const output: JsonValue = {
    fromBlock: result.fromBlock.toString(),
    toBlock: result.toBlock.toString(),
    events: result.events.map((event) => ({
      block: event.block.toString(),
      logIndex: event.logIndex,
      txHash: event.txHash,
      emitter: event.emitter,
      event: event.event,
      afterMandate: event.afterMandate,
    })),
  };
  return { output, untrusted: [] };
}

/** `code`'s EIP-7702 delegate (`0xef0100` followed by exactly 20 bytes), or `null`. */
function eip7702DelegateOf(code: Hex): Address | null {
  const lower = code.toLowerCase();
  if (lower.length === 48 && lower.startsWith("0xef0100")) return getAddress(`0x${lower.slice(8)}`);
  return null;
}

async function counterpartyOnchainTool(address: Address, ctx: ToolContext): Promise<{ output: JsonValue; untrusted: UntrustedField[] }> {
  if (!ctx.scope.has(address.toLowerCase())) {
    return { output: { error: "ADDRESS_OUT_OF_SCOPE" }, untrusted: [] };
  }
  const at = ctx.pinned.number;
  const { reader } = ctx;
  const [code, balance, nonce, agentsOwnedCount] = await Promise.all([
    reader.code(address, at),
    reader.balance(address, at),
    reader.nonce(address, at),
    reader.agentsOwned(address, at),
  ]);
  const delegatesTo = eip7702DelegateOf(code);
  const isContract = code !== "0x" && delegatesTo === null;

  const probeBlocks = RISK_V1.ageProbeBlocks.filter((blocks) => at - blocks >= 0n);
  let age: { neverSent: boolean | null; youngerThanBlocks: string | null };
  if (isContract) {
    const probes = await Promise.all(probeBlocks.map(async (blocks) => ({ blocks, code: await reader.code(address, at - blocks) })));
    const absent = probes.find((p) => p.code === "0x");
    age = { neverSent: null, youngerThanBlocks: absent ? absent.blocks.toString() : null };
  } else if (nonce === 0n) {
    age = { neverSent: true, youngerThanBlocks: null };
  } else {
    const probes = await Promise.all(probeBlocks.map(async (blocks) => ({ blocks, nonce: await reader.nonce(address, at - blocks) })));
    const zero = probes.find((p) => p.nonce === 0n);
    age = { neverSent: false, youngerThanBlocks: zero ? zero.blocks.toString() : null };
  }

  const output: JsonValue = {
    address: getAddress(address),
    isContract,
    codeSize: (code.length - 2) / 2,
    codeHash: code === "0x" ? null : keccak256(code),
    delegatesTo,
    balance: balance.toString(),
    nonce: nonce.toString(),
    // `null` only when the Identity Registry's balanceOf reverted (e.g. address zero's
    // ERC721InvalidOwner) — fix round 1, finding 5: never thrown, since the chain state here is
    // deterministic and re-derivable by `verify`, not an RPC failure.
    agentsOwned: agentsOwnedCount === null ? null : agentsOwnedCount.toString(),
    age,
  };
  return { output, untrusted: [] };
}

async function erc8004ReputationTool(agentId: bigint, ctx: ToolContext): Promise<{ output: JsonValue; untrusted: UntrustedField[] }> {
  const at = ctx.pinned.number;
  const { reader } = ctx;
  const owner = await reader.agentOwner(agentId, at);
  const clients = await reader.reputationClients(agentId, at);
  const sample = clients.slice(0, RISK_V1.reputationMaxClients);
  let summary: JsonValue = null;
  if (sample.length > 0) {
    const result = await reader.reputationSummary(agentId, sample, at);
    summary = { count: result.count.toString(), value: result.value.toString(), decimals: result.decimals };
  }
  const output: JsonValue = {
    owner: owner === null ? null : getAddress(owner),
    clientCount: clients.length,
    clients: sample.map((a) => getAddress(a)),
    summary,
  };
  return { output, untrusted: [] };
}

/** A plain JSON object (not an array, not `null`/`undefined`) — a small local guard for reading Nansen's own output shape back out. */
function asPlainObject(value: JsonValue | undefined): { [key: string]: JsonValue } | null {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * Every `label` in a `nansen_counterparty_profile` output's `labels[]`, plus `firstFunder.name` when
 * present (Decision 12-13; context's "Strings from Nansen ... are returned in `untrusted`"). `output`
 * is read defensively: an unavailable result (`{available: false, reason}`) has neither key, so this
 * is `[]` for it, exactly as it is for any other tool that found nothing to screen.
 */
function untrustedFromProfile(output: JsonValue): UntrustedField[] {
  const obj = asPlainObject(output);
  if (obj === null) return [];
  const fields: UntrustedField[] = [];
  const labels = obj.labels;
  if (Array.isArray(labels)) {
    for (const entry of labels) {
      const label = asPlainObject(entry)?.label;
      if (typeof label === "string" && label.length > 0) fields.push({ source: "tool:nansen_counterparty_profile", text: label });
    }
  }
  const firstFunderName = asPlainObject(obj.firstFunder)?.name;
  if (typeof firstFunderName === "string" && firstFunderName.length > 0) {
    fields.push({ source: "tool:nansen_counterparty_profile", text: firstFunderName });
  }
  return fields;
}

/** Every label in a `nansen_flows` output's `counterparties[].labels[]` (Decision 12-13). */
function untrustedFromFlows(output: JsonValue): UntrustedField[] {
  const obj = asPlainObject(output);
  if (obj === null) return [];
  const counterparties = obj.counterparties;
  if (!Array.isArray(counterparties)) return [];
  const fields: UntrustedField[] = [];
  for (const entry of counterparties) {
    const labels = asPlainObject(entry)?.labels;
    if (!Array.isArray(labels)) continue;
    for (const label of labels) {
      if (typeof label === "string" && label.length > 0) fields.push({ source: "tool:nansen_flows", text: label });
    }
  }
  return fields;
}

/**
 * `nansen_counterparty_profile(address)` (Decision 16, 18, 20): the same scope check as
 * `counterparty_onchain`, then `ctx.nansen.profile` — which never throws and, with no
 * `NANSEN_API_KEY`, answers `{available: false, reason}` without a fetch.
 */
async function nansenCounterpartyProfileTool(address: Address, ctx: ToolContext): Promise<{ output: JsonValue; untrusted: UntrustedField[] }> {
  if (!ctx.scope.has(address.toLowerCase())) {
    return { output: { error: "ADDRESS_OUT_OF_SCOPE" }, untrusted: [] };
  }
  const output = await ctx.nansen.profile(address);
  return { output, untrusted: untrustedFromProfile(output) };
}

/**
 * `nansen_flows(address)` (Decision 16, 18, 20): the window is `[P.timestamp - nansenWindowSeconds,
 * P.timestamp]` — pinned to the block, never wall-clock time, so a re-check sees the same window.
 */
async function nansenFlowsTool(address: Address, ctx: ToolContext): Promise<{ output: JsonValue; untrusted: UntrustedField[] }> {
  if (!ctx.scope.has(address.toLowerCase())) {
    return { output: { error: "ADDRESS_OUT_OF_SCOPE" }, untrusted: [] };
  }
  const to = ctx.pinned.timestamp;
  const from = to - RISK_V1.nansenWindowSeconds;
  const output = await ctx.nansen.flows(address, from, to);
  return { output, untrusted: untrustedFromFlows(output) };
}

async function execute(
  name: OnchainToolName | NansenToolName,
  args: ToolArgs,
  ctx: ToolContext,
): Promise<{ output: JsonValue; untrusted: UntrustedField[] }> {
  switch (name) {
    case "get_mandate":
      return getMandateTool(ctx);
    case "simulate_action":
      return simulateActionTool(ctx);
    case "recent_permission_events":
      return recentPermissionEventsTool(ctx);
    case "counterparty_onchain":
      return counterpartyOnchainTool(args.address as Address, ctx);
    case "erc8004_reputation":
      return erc8004ReputationTool(args.agentId as bigint, ctx);
    case "nansen_counterparty_profile":
      return nansenCounterpartyProfileTool(args.address as Address, ctx);
    case "nansen_flows":
      return nansenFlowsTool(args.address as Address, ctx);
  }
}

/** `canonicalJson(value)`'s UTF-8 byte length. */
function byteLength(value: JsonValue): number {
  return new TextEncoder().encode(canonicalJson(value)).length;
}

/**
 * The `{key, array}` of the longest array anywhere in `value` (ties: the first one found), or `null`.
 * `key` is the nearest enclosing object property name — an array nested directly inside another
 * array's elements (not our shape, but handled defensively) isn't attributed to any key, matching
 * {@link longestString}'s identical rule.
 */
function longestArray(value: JsonValue): { key: string; array: JsonValue[] } | null {
  let best: { key: string; array: JsonValue[] } | null = null;
  const visit = (node: JsonValue, parentKey: string | null): void => {
    if (Array.isArray(node)) {
      if (parentKey !== null && (best === null || node.length > best.array.length)) best = { key: parentKey, array: node };
      for (const item of node) visit(item, null);
    } else if (node !== null && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) visit(item, key);
    }
  };
  visit(value, null);
  return best;
}

/**
 * The longest string leaf anywhere in `value` (ties: the first one found), with a `set` callback that
 * writes a replacement back into its exact slot — used only once every array is already empty, so
 * `capOutput`'s `maxBytes` guarantee still holds when one field is a giant string (e.g. a hostile or
 * just very long revert reason) rather than a long array.
 */
function longestString(value: JsonValue): { key: string; value: string; set: (next: string) => void } | null {
  let best: { key: string; value: string; set: (next: string) => void } | null = null;
  const visit = (node: JsonValue, parentKey: string | null, set: (next: string) => void): void => {
    if (typeof node === "string") {
      if (parentKey !== null && (best === null || node.length > best.value.length)) best = { key: parentKey, value: node, set };
    } else if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, null, (next) => { (node as JsonValue[])[i] = next; }));
    } else if (node !== null && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) {
        visit(item, key, (next) => { (node as Record<string, JsonValue>)[key] = next; });
      }
    }
  };
  visit(value, null, () => {});
  return best;
}

function withTruncated(value: JsonValue, drops: ReadonlyMap<string, number>): JsonValue {
  if (drops.size === 0) return value;
  return { ...(value as { [key: string]: JsonValue }), truncated: Object.fromEntries(drops) };
}

/**
 * Caps `output`'s canonical JSON to `maxBytes`, deterministically (fix round 1, finding 3):
 *
 * 1. While still too long, finds the longest array anywhere in the structure and pops one element
 *    from its end. Whichever array is longest can change between pops — cutting `calls` down may
 *    hand off to `valueFlows`, say — so drops are tracked **cumulatively per field** in a map, not
 *    reset when the target changes; the recorded count for a field is always exactly how many of its
 *    elements are missing relative to the input, however the cutting was interleaved.
 * 2. Once every array is empty (or there were none), it cuts the longest *string* leaf instead,
 *    removing however many characters the current overage needs in one step (not one at a time — a
 *    20,000-character string must not cost 20,000 iterations), looping to correct for JSON-escaping
 *    overhead if one cut wasn't quite enough. This is what keeps the ≤ `maxBytes` guarantee even when
 *    a single string field dominates the output. Every such cut also drops a trailing lone (unpaired)
 *    UTF-16 surrogate it may have produced (fix round 2, finding 2; see
 *    {@link import("./trace.ts").dropTrailingLoneSurrogate}) — a cut landing inside an emoji must
 *    never leave this text, which can reach the Prompt Guard and the model, ill-formed.
 *
 * The result carries `truncated: {field: dropped, ...}` (one entry per field that lost anything —
 * element count for an array, character count for a string) only when something was actually cut;
 * `maxBytes` is checked against the *final* shape, including that marker's own bytes. Never mutates
 * `output` (operates on a `structuredClone`).
 */
export function capOutput(output: JsonValue, maxBytes: number): JsonValue {
  const working = structuredClone(output);
  const drops = new Map<string, number>();
  const bump = (key: string, by: number): void => {
    drops.set(key, (drops.get(key) ?? 0) + by);
  };
  const currentSize = (): number => byteLength(withTruncated(working, drops));

  while (currentSize() > maxBytes) {
    const arrayTarget = longestArray(working);
    if (arrayTarget !== null && arrayTarget.array.length > 0) {
      arrayTarget.array.pop();
      bump(arrayTarget.key, 1);
      continue;
    }

    const stringTarget = longestString(working);
    if (stringTarget === null || stringTarget.value.length === 0) break; // nothing left to cut
    const over = currentSize() - maxBytes;
    const removeChars = Math.min(stringTarget.value.length, Math.max(1, over));
    const before = stringTarget.value;
    // Fix round 2, finding 2: the slice can land inside a surrogate pair (an emoji straddling the
    // cut), leaving a lone high surrogate at the end — drop it too, so this text (which may reach
    // the Prompt Guard/model as JSON) is never left ill-formed. The actual drop count can therefore
    // be one more than `removeChars`; `bump` is given the real before/after length difference.
    const next = dropTrailingLoneSurrogate(before.slice(0, before.length - removeChars));
    stringTarget.set(next);
    bump(stringTarget.key, before.length - next.length);
  }

  return withTruncated(working, drops);
}

/**
 * The address scope `runTool` starts a check with (Decision 18): the action's target and gate, the
 * owner at `P`, and every address the mandate allows (none when there is no mandate). Lower-case.
 */
export function initialScope(request: MandateInputs["request"], owner: Address, mandate: MandateRecord | null): Set<string> {
  const scope = new Set<string>([request.target.toLowerCase(), request.gate.toLowerCase(), owner.toLowerCase()]);
  if (mandate !== null) {
    for (const target of mandate.allowedTargets) scope.add(target.toLowerCase());
  }
  return scope;
}

/**
 * Runs one model tool call, deterministically, from the raw argument string the model sent (Ruling
 * R3): never throws on bad input — an unknown `name` gives `{error: "UNKNOWN_TOOL"}`; a
 * `rawArguments` that isn't JSON, or doesn't match that tool's shape, gives
 * `{error: "INVALID_ARGUMENTS"}`; an address argument outside `ctx.scope` gives
 * `{error: "ADDRESS_OUT_OF_SCOPE"}` with no chain read or Nansen call. Any other failure (an RPC or
 * transport error — Nansen's own failures never throw; see `nansen.ts`) throws, so it can never
 * become a tool output. The returned `arguments` is the parsed JSON when `rawArguments` parsed, else
 * the raw string itself, so the record always keeps what the model sent.
 *
 * `onchain` is `true` for one of the five onchain tool names (whatever the outcome — success,
 * `INVALID_ARGUMENTS` or `ADDRESS_OUT_OF_SCOPE`) and for an unrecognised name (fix round 1, finding
 * 6: so `verify` still re-checks `UNKNOWN_TOOL` deterministically, never skipping it); it is `false`
 * for the two Nansen tool names (Task 9), since `verify` reports those `unchecked` instead.
 *
 * The output is capped with {@link capOutput} at `RISK_V1.toolOutputMaxBytes`, and **every address
 * found in that capped output is added to `ctx.scope`** (lower-cased) before this resolves — see
 * {@link ToolContext.scope}'s own doc.
 */
export async function runTool(
  name: string,
  rawArguments: string,
  ctx: ToolContext,
): Promise<{ arguments: JsonValue; output: JsonValue; onchain: boolean; untrusted: UntrustedField[] }> {
  let parsed: unknown;
  let parsedOk = true;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    parsedOk = false;
  }
  // Ruling R3/fix round 1, finding 4: `parsed` can be JSON-valid but not canonical-JSON-safe (a
  // fractional number, or an integer above 2^53, e.g. `{"agentId": 1.5}`) — recording it as-is would
  // make a later `canonicalJson` call (building evidence) throw, turning a deterministic
  // INVALID_ARGUMENTS answer into a thrown error. When that would happen, record the raw string
  // instead, exactly as for unparseable JSON.
  // Fix round 1 for Task 11: likewise for an own `__proto__` key at any depth (see isRecordableJson).
  let argumentsRecord: JsonValue = rawArguments;
  if (parsedOk) {
    if (isRecordableJson(parsed)) argumentsRecord = parsed;
    else parsedOk = false; // treated the same as unparseable from here on: validateArguments is skipped
  }

  // Fix round 1, finding 6: an unrecognised name is still `onchain: true`, so `verify` re-checks
  // `UNKNOWN_TOOL` deterministically rather than skipping it. The two Nansen names are the only
  // ones ever `onchain: false` (Task 9) — independent of their outcome.
  if (!isOnchainToolName(name) && !isNansenToolName(name)) {
    return { arguments: argumentsRecord, output: { error: "UNKNOWN_TOOL" }, onchain: true, untrusted: [] };
  }
  const onchain = isOnchainToolName(name);

  const args = parsedOk ? validateArguments(name, parsed) : null;
  if (args === null) {
    return { arguments: argumentsRecord, output: { error: "INVALID_ARGUMENTS" }, onchain, untrusted: [] };
  }

  const { output, untrusted } = await execute(name, args, ctx);
  const capped = capOutput(output, RISK_V1.toolOutputMaxBytes);
  collectAddresses(capped, ctx.scope);
  return { arguments: argumentsRecord, output: capped, onchain, untrusted };
}
