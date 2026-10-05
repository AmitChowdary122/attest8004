import { DEPLOYMENTS } from "@attest8004/sdk";
import { getAddress, isAddress, type Address } from "viem";
import type { ServedGate } from "./validator.ts";

// mandate-v1's (gate, agent) allowlist: parsing MANDATE_V1_GATES and the decline texts. Moved here unchanged from
// config.ts and MandateValidator.accepts() so validator A and the /evaluate service (P11) answer for the same pairs
// with the same words.

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const UINT256_LIMIT = 2n ** 256n;

/**
 * `MANDATE_V1_GATES` (comma-separated `<gate address>:<agentId>`) as served gates, pushing one text per bad item onto
 * `problems`. Unset or blank: the demo vault for agent 1984 (`DEPLOYMENTS[10143]`).
 */
export function parseGateList(value: string | undefined, problems: string[]): ServedGate[] {
  const testnet = DEPLOYMENTS[10143];
  const gates: ServedGate[] = [];
  if (value === undefined || value.trim() === "") {
    gates.push({ gate: testnet.demoAgentVault, agentId: testnet.demoAgents[0] as bigint });
    return gates;
  }
  for (const item of value.split(",").map((s) => s.trim())) {
    if (item === "") {
      problems.push("MANDATE_V1_GATES has an empty item");
      continue;
    }
    const parts = item.split(":").map((s) => s.trim());
    if (parts.length !== 2) {
      problems.push(`MANDATE_V1_GATES: "${item}" must be <gate address>:<agentId>, e.g. ${testnet.demoAgentVault}:${testnet.demoAgents[0]}`);
      continue;
    }
    const [gate, agentId] = parts as [string, string];
    if (!isAddress(gate, { strict: true })) {
      problems.push(`MANDATE_V1_GATES: "${gate}" is not an address`);
    } else if (!DECIMAL.test(agentId) || BigInt(agentId) >= UINT256_LIMIT) {
      problems.push(`MANDATE_V1_GATES: agentId "${agentId}" for gate ${getAddress(gate)} must be a decimal integer below 2^256`);
    } else {
      gates.push({ gate: getAddress(gate), agentId: BigInt(agentId) });
    }
  }
  return gates;
}

/** The agents each served gate (lower-case) is answered for. */
export function servedGateMap(gates: readonly ServedGate[]): ReadonlyMap<string, ReadonlySet<bigint>> {
  const served = new Map<string, Set<bigint>>();
  for (const { gate, agentId } of gates) {
    const key = gate.toLowerCase();
    const agents = served.get(key) ?? new Set<bigint>();
    agents.add(agentId);
    served.set(key, agents);
  }
  return served;
}

/**
 * Why `agentId`'s request through `gate` isn't served (`GATE_NOT_SERVED: …` or `GATE_NOT_FOR_AGENT: …`), or `null`
 * when it is. Gates compare case-insensitively.
 */
export function servedGateDecline(served: ReadonlyMap<string, ReadonlySet<bigint>>, gate: Address, agentId: bigint): string | null {
  const agents = served.get(gate.toLowerCase());
  if (agents === undefined) {
    return `GATE_NOT_SERVED: agent ${agentId} requested through gate ${gate}, which this validator doesn't serve`;
  }
  if (!agents.has(agentId)) {
    const listed = [...agents].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const list = listed.length === 1 ? `agent ${listed[0]}` : `agents ${listed.join(", ")}`;
    return `GATE_NOT_FOR_AGENT: gate ${gate} serves ${list}, not ${agentId}`;
  }
  return null;
}
