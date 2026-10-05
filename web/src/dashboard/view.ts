// /dashboard's view model: indexed data turned into plain strings (never HTML), links only from explorer.ts, and our
// own validators and demo agents labelled as ours, so the page never passes our e2e traffic off as anyone else's.
// Pure: the page renders these strings as React text.
import { CRE_VALIDATOR_LABEL, currentMandateRegistry, type Deployment, type IndexedVerdict, type TrustApiErrorKind, type ValidatorStats } from "@attest8004/sdk/browser";
import { getAddress, type Address } from "viem";
import { explorerAddress, explorerTx } from "../explorer.ts";

/** Monad testnet's measured block time (0.305 s), for showing a latency in seconds as well as blocks. */
const BLOCK_SECONDS = 0.305;

export function validatorLabel(address: Address, deployment: Deployment): string {
  const a = getAddress(address);
  if (a === getAddress(deployment.validators.mandateV1)) return "ours (A · mandate-v1)";
  if (a === getAddress(deployment.validators.riskV1)) return "ours (B · risk-v1)";
  if (a === getAddress(deployment.validators.creMandateV1)) return `ours (C · mandate-v1) · ${CRE_VALIDATOR_LABEL}`;
  return a;
}

/** P1's round-trip and gated-execute test agent. */
const TEST_AGENT = 1982n;

export function agentLabel(agentId: bigint, deployment: Deployment): string {
  if (deployment.demoAgents.includes(agentId)) return `${agentId} (demo agent, ours)`;
  if (agentId === TEST_AGENT) return `${agentId} (test agent, ours)`;
  return agentId.toString();
}

export const isOurs = (agentId: bigint, deployment: Deployment) => deployment.demoAgents.includes(agentId) || agentId === TEST_AGENT;

/** The latest instant a JavaScript Date can hold, in seconds (8.64e15 ms). */
const MAX_DATE_SECONDS = 8_640_000_000_000n;

/**
 * A timestamp as `YYYY-MM-DD hh:mm:ss UTC`, or the raw number when no Date can hold it: a mandate's `validUntil` is
 * any uint64 its owner chose, so a stranger's agent can carry 2^64 − 1.
 */
export function utcTime(seconds: bigint | null): string {
  if (seconds === null) return "—";
  if (seconds < 0n || seconds > MAX_DATE_SECONDS) return `${seconds} (unix seconds)`;
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

const EVIDENCE: Record<NonNullable<IndexedVerdict["evidenceStatus"]>, string> = {
  VERIFIED: "inline evidence, hash matches",
  HASH_MISMATCH: "evidence doesn't match its hash",
  NOT_INLINE: "evidence elsewhere (not read)",
  UNREADABLE: "evidence unreadable",
};

export interface VerdictRow {
  key: string;
  time: string;
  agent: string;
  validator: string;
  tag: string;
  score: string;
  reasons: string;
  evidence: string;
  executed: string;
  requestHash: string;
  txUrl: string | null;
  verifyLine: string;
  pending: boolean;
}

/** One request and its latest verdict, as text. */
export function verdictRow(v: IndexedVerdict, deployment: Deployment): VerdictRow {
  const pending = v.responses === 0 || v.score === null;
  return {
    key: v.requestHash,
    time: utcTime(pending ? v.requestTime : v.responseTime),
    agent: agentLabel(v.agentId, deployment),
    validator: validatorLabel(v.validator, deployment),
    tag: v.tag ?? "—",
    score: pending ? "pending" : String(v.score),
    reasons: pending ? "" : v.reasons === null ? "not read" : v.reasons.length === 0 ? "none" : v.reasons.join(", "),
    evidence: v.evidenceStatus === null ? "" : EVIDENCE[v.evidenceStatus],
    executed: v.executedTx !== null ? "executed" : "not executed",
    requestHash: v.requestHash,
    txUrl: pending ? null : explorerTx(v.responseTx),
    verifyLine: `pnpm attest8004 verify ${v.requestHash}`,
    pending,
  };
}

export interface ValidatorRowView {
  validator: string;
  address: Address;
  addressUrl: string | null;
  tags: string;
  requests: string;
  answered: string;
  avgScore: string;
  /** Counts for scores 0, 1–39, 40–79, 80–99 and 100. */
  buckets: string[];
  avgLatency: string;
}

export function validatorRow(v: ValidatorStats, deployment: Deployment): ValidatorRowView {
  return {
    validator: validatorLabel(v.validator, deployment),
    address: v.validator,
    addressUrl: explorerAddress(v.validator),
    tags: v.tagCount > v.tags.length ? `${v.tags.join(", ")} (+${v.tagCount - v.tags.length} more)` : v.tags.join(", "),
    requests: String(v.requests),
    answered: String(v.answered),
    avgScore: v.avgScore === null || v.answered === 0 ? "—" : v.avgScore.toFixed(1),
    buckets: [v.buckets.score0, v.buckets.score1to39, v.buckets.score40to79, v.buckets.score80to99, v.buckets.score100].map(String),
    avgLatency: v.avgLatencyBlocks === null ? "—" : `${v.avgLatencyBlocks.toFixed(1)} blocks (~${Math.round(v.avgLatencyBlocks * BLOCK_SECONDS)} s)`,
  };
}

/** Whether a mandate binds the agent now: active, unexpired, and set by its current owner (SPEC §4.5's rules 1–3). */
export function mandateInForce(m: { active: boolean; validUntil: bigint; owner: Address }, currentOwner: Address | null, now: bigint): string {
  if (!m.active) return "revoked";
  if (currentOwner !== null && getAddress(m.owner) !== getAddress(currentOwner)) return "stale: set by a previous owner";
  if (m.validUntil < now) return "expired";
  return "in force";
}

const OFFLINE: Record<TrustApiErrorKind, string> = {
  NOT_CONFIGURED: "The Envio indexer isn't deployed yet.",
  NETWORK: "The Envio indexer can't be reached right now.",
  HTTP: "The Envio indexer answered with an error.",
  RATE_LIMITED: "The Envio indexer is rate-limited (100 queries a minute on Envio's free plan); try again in a minute.",
  TIMEOUT: "The Envio indexer didn't answer in time.",
  GRAPHQL: "The Envio indexer refused the query.",
  SHAPE: "The Envio indexer's answer wasn't in the expected shape, so nothing from it is shown.",
  INCOMPLETE: "The Envio indexer's answer may be incomplete, so nothing from it is shown.",
};

export interface OfflineView {
  reason: string;
  contracts: { label: string; address: Address; url: string | null }[];
  verifyLine: string;
  inbox: string;
}

/** What the page shows without the indexer: the reason, the contracts to read directly, and how to check a verdict. */
export function offlineView(deployment: Deployment, kind: TrustApiErrorKind): OfflineView {
  const contract = (label: string, address: Address) => ({ label, address: getAddress(address), url: explorerAddress(address) });
  return {
    reason: OFFLINE[kind],
    contracts: [
      contract("ValidationRegistry", deployment.validationRegistry),
      contract("MandateRegistry (current)", currentMandateRegistry(deployment).address),
      ...(deployment.findingsBoard ? [contract("FindingsBoard", deployment.findingsBoard.address)] : []),
      contract("AgentRequestForwarder", deployment.agentRequestForwarder),
      contract("DemoAgentVault", deployment.demoAgentVault),
      contract("Validator A (mandate-v1)", deployment.validators.mandateV1),
      contract("Validator B (risk-v1)", deployment.validators.riskV1),
      contract(`Validator C (CreValidator) · ${CRE_VALIDATOR_LABEL}`, deployment.validators.creMandateV1),
    ],
    verifyLine: "pnpm attest8004 verify <requestHash>",
    inbox: "/inbox still finds reports from the chain (within 600 blocks of each verdict) and decrypts them with your passkey.",
  };
}
