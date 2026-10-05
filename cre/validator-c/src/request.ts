import { zeroHash, type Address, type Hex } from "viem";
import { parseRequestUri, requestHashOfJson, type RequestJsonV1 } from "../../../packages/sdk/src/request.ts";
import { MANDATE_V1 } from "../../../validators/mandate/src/params.ts";
import type { WorkflowConfig } from "./config.ts";
import type { TriggerRequest } from "./trigger.ts";

/** A request the workflow turns away: no write, and a one-line summary as the execution's result. */
export interface Decline {
  decline: string;
  detail: string;
}

/** `getValidationStatus` as the workflow reads it (the timestamp isn't needed). */
export interface OnchainStatus {
  validator: Address;
  agentId: bigint;
  response: number;
  responseHash: Hex;
  tag: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The trigger's own request JSON, authenticated by recomputing its requestHash with the repo SDK (never trusting the
 * URI's word), naming C, this agent and this chain, through a (gate, agent) pair the workflow serves. The service
 * enforces the same allowlist with validator A's texts; this is the workflow's own pre-filter.
 */
export function checkRequest(t: TriggerRequest, cfg: WorkflowConfig): { json: RequestJsonV1; deadline: bigint } | Decline {
  if (!same(t.validator, cfg.creValidator)) return { decline: "WRONG_VALIDATOR", detail: `the event names ${t.validator}` };
  const parsed = parseRequestUri(t.requestURI);
  if (!parsed.ok) return { decline: parsed.reason, detail: parsed.detail };
  const { json } = parsed;
  const recomputed = requestHashOfJson(json);
  if (recomputed !== t.requestHash) return { decline: "HASH_MISMATCH", detail: `the request JSON hashes to ${recomputed}` };
  if (!same(json.validator, cfg.creValidator)) return { decline: "WRONG_VALIDATOR", detail: `the request names ${json.validator}` };
  if (BigInt(json.agentId) !== t.agentId) return { decline: "AGENT_MISMATCH", detail: `the request is for agent ${json.agentId}, the event for ${t.agentId}` };
  if (json.chainId !== cfg.chainId) return { decline: "WRONG_CHAIN", detail: `the request is for chain ${json.chainId}` };
  const agents = cfg.gates.filter((g) => same(g.gate, json.gate)).map((g) => g.agentId);
  if (agents.length === 0) return { decline: "GATE_NOT_SERVED", detail: `gate ${json.gate} isn't served` };
  if (!agents.includes(json.agentId)) return { decline: "GATE_NOT_FOR_AGENT", detail: `gate ${json.gate} serves agent(s) ${agents.join(", ")}, not ${json.agentId}` };
  return { json, deadline: BigInt(json.action.deadline) };
}

/**
 * The workflow's own reads at the pin P (the request's block): the header there must be the trigger's block (else a
 * reorg or a bad RPC: it throws, so nothing is written), the request must exist there naming C and this agent, and
 * the deadline must be at most 3,600 s after P's time (what `verify` requires).
 */
export function checkPinned(o: {
  t: TriggerRequest;
  header: { hash: Hex; timestamp: bigint };
  status: OnchainStatus | null;
  deadline: bigint;
  cfg: WorkflowConfig;
}): { pinTime: bigint } | Decline {
  const { t, header, status, deadline, cfg } = o;
  if (!same(header.hash, t.blockHash)) {
    throw new Error(`PIN_HASH_MISMATCH: block ${t.block} reads as ${header.hash}, the trigger's log was in ${t.blockHash}`);
  }
  if (status === null || !same(status.validator, cfg.creValidator) || status.agentId !== t.agentId) {
    return { decline: "REQUEST_NOT_AT_PIN", detail: `request ${t.requestHash} for C and agent ${t.agentId} isn't at block ${t.block}` };
  }
  if (deadline > header.timestamp + MANDATE_V1.maxDeadlineAheadSeconds) {
    return { decline: "DEADLINE_TOO_FAR", detail: `deadline ${deadline} is more than 3600 s after block ${t.block}'s time ${header.timestamp}` };
  }
  return { pinTime: header.timestamp };
}

/**
 * At the finalized head: the pin must be `pinLagBlocks` under it (else retry: the run fails and is re-run), the
 * deadline not passed, and the request not answered yet (a non-zero responseHash or a tag means answered).
 */
export function checkLive(o: {
  P: bigint;
  finalized: { number: bigint; timestamp: bigint };
  finalizedStatus: OnchainStatus;
  deadline: bigint;
  cfg: WorkflowConfig;
}): true | Decline | { retry: string } {
  const { P, finalized, finalizedStatus, deadline, cfg } = o;
  if (finalized.number < P + BigInt(cfg.pinLagBlocks)) {
    return { retry: `NOT_FINAL: the finalized head ${finalized.number} is under block ${P} + ${cfg.pinLagBlocks}` };
  }
  if (deadline < finalized.timestamp) return { decline: "DEADLINE_PASSED", detail: `deadline ${deadline} < finalized time ${finalized.timestamp}` };
  if (finalizedStatus.responseHash !== zeroHash || finalizedStatus.tag !== "") {
    return { decline: "ALREADY_ANSWERED", detail: `request already answered with tag "${finalizedStatus.tag.slice(0, 32)}"` };
  }
  return true;
}
