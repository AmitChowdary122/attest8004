import { canonicalJson } from "@attest8004/sdk";
import { collectPermissions, type MandateInputs, type MandateRecord, type PinnedBlock } from "@attest8004/validator-mandate";
import { getAddress, isAddress, keccak256, type Address, type Hex } from "viem";
import { z } from "zod";
import { type ToolName } from "./findings.ts";
import { RISK_V1 } from "./params.ts";
import type { RiskReader } from "./reader.ts";
import { flattenTrace, type JsonObject } from "./trace.ts";
import type { JsonValue } from "./types.ts";

/**
 * The five read-only tools this task implements (the P5 plan's seven, minus the two Nansen tools,
 * which Task 9 adds). `runTool` answers every other name — including the two not-yet-implemented
 * Nansen names — with `{error: "UNKNOWN_TOOL"}`; Task 9 widens that check.
 */
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

/** One entry of the OpenAI-compatible `tools` array sent to the model. */
function toolDefinition(
  name: OnchainToolName,
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

/**
 * The OpenAI `tools` array for the five onchain tools (Task 9 appends the two Nansen entries).
 * `get_mandate`/`simulate_action`/`recent_permission_events` take no arguments: they always read the
 * request's own target/gate/agent, never a model-supplied address.
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
    {
      address: {
        type: "string",
        description:
          "A 0x-prefixed, 20-byte EVM address. Must be in scope: the target, the gate, the owner, a mandate-allowed target, or an address a previous tool call returned.",
      },
    },
    ["address"],
  ),
  toolDefinition(
    "erc8004_reputation",
    "Read an ERC-8004 agent's current owner and its Reputation Registry summary (client count and, when it has clients, the aggregate feedback over the first 16).",
    { agentId: { type: "string", description: "The agent's ERC-8004 token id, as a decimal string." } },
    ["agentId"],
  ),
];

/** Everything a tool call reads from: the chain reader, the pinned block, the request, and the live address scope. */
export interface ToolContext {
  reader: RiskReader;
  pinned: PinnedBlock;
  request: MandateInputs["request"];
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

function validateArguments(name: OnchainToolName, parsed: unknown): ToolArgs | null {
  if (name === "counterparty_onchain") {
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

/** Every `0x`-address-shaped string anywhere in `value`, lower-cased, added to `out`. */
function collectAddresses(value: JsonValue, out: Set<string>): void {
  if (typeof value === "string") {
    if (/^0x[0-9a-fA-F]{40}$/.test(value)) out.add(value.toLowerCase());
  } else if (Array.isArray(value)) {
    for (const item of value) collectAddresses(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectAddresses(item, out);
  }
}

/** `wei` as a decimal MON string with no floats (e.g. `1_000_000_000_000_000n` -> `"0.001"`). */
function weiToMon(wei: bigint): string {
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
  const [code, balance, nonce, agentsOwned] = await Promise.all([
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
    agentsOwned: agentsOwned.toString(),
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

async function execute(name: OnchainToolName, args: ToolArgs, ctx: ToolContext): Promise<{ output: JsonValue; untrusted: UntrustedField[] }> {
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
  }
}

/** `canonicalJson(value)`'s UTF-8 byte length. */
function byteLength(value: JsonValue): number {
  return new TextEncoder().encode(canonicalJson(value)).length;
}

/** The `{key, array}` of the longest array anywhere in `value` (ties: the first one found), or `null`. */
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

function withTruncated(value: JsonValue, field: string | null, dropped: number): JsonValue {
  if (field === null || dropped === 0) return value;
  return { ...(value as { [key: string]: JsonValue }), truncated: { field, dropped } };
}

/**
 * Caps `output`'s canonical JSON to `maxBytes`, deterministically: while it is too long, finds the
 * longest array anywhere in the structure and pops one element from its end, tracking how many came
 * from that array; once a different array becomes the longest, the count restarts for it. The final
 * result carries `truncated: {field, dropped}` (the array's own key, and how many of its elements were
 * dropped) only when something was actually cut; `maxBytes` is checked against the *final* shape,
 * including that marker's own bytes.
 */
export function capOutput(output: JsonValue, maxBytes: number): JsonValue {
  const working = structuredClone(output);
  let field: string | null = null;
  let dropped = 0;
  for (;;) {
    if (byteLength(withTruncated(working, field, dropped)) <= maxBytes) break;
    const found = longestArray(working);
    if (found === null || found.array.length === 0) break;
    if (field !== found.key) {
      field = found.key;
      dropped = 0;
    }
    found.array.pop();
    dropped++;
  }
  return withTruncated(working, field, dropped);
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
 * R3): never throws on bad input — an unknown `name` or one of the two not-yet-implemented Nansen
 * names gives `{error: "UNKNOWN_TOOL"}`; a `rawArguments` that isn't JSON, or doesn't match that
 * tool's shape, gives `{error: "INVALID_ARGUMENTS"}`; an address argument outside `ctx.scope` gives
 * `{error: "ADDRESS_OUT_OF_SCOPE"}` with no chain reads. Any other failure (an RPC or transport error)
 * throws, so it can never become a tool output. The returned `arguments` is the parsed JSON when
 * `rawArguments` parsed, else the raw string itself, so the record always keeps what the model sent.
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
  const argumentsRecord: JsonValue = parsedOk ? (parsed as JsonValue) : rawArguments;

  if (!isOnchainToolName(name)) {
    return { arguments: argumentsRecord, output: { error: "UNKNOWN_TOOL" }, onchain: false, untrusted: [] };
  }
  const onchain = true;

  const args = parsedOk ? validateArguments(name, parsed) : null;
  if (args === null) {
    return { arguments: argumentsRecord, output: { error: "INVALID_ARGUMENTS" }, onchain, untrusted: [] };
  }

  const { output, untrusted } = await execute(name, args, ctx);
  const capped = capOutput(output, RISK_V1.toolOutputMaxBytes);
  collectAddresses(capped, ctx.scope);
  return { arguments: argumentsRecord, output: capped, onchain, untrusted };
}
