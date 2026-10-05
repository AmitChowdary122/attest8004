// indexer-check's comparisons (plan Task 7): what the Envio indexer says against what the chain says, at one block.
// Pure: indexer-check.ts reads both sides; these name every difference.
import { getAddress, zeroHash, type Address, type Hash, type Hex } from "viem";
import { displayText, type ValidatorStats } from "@attest8004/sdk";

export interface Mismatch {
  what: string;
  chain: string;
  indexer: string;
}

/** One request's `getValidationStatus`. */
export interface ChainStatus {
  requestHash: Hex;
  validator: Address;
  agentId: bigint;
  response: number;
  responseHash: Hex;
  tag: string;
}

export interface ReportRef {
  txHash: Hash;
  logIndex: number;
}

/** An agent's requests from the chain, and the trusted reports the chain search finds for them. */
export interface ChainAgentView {
  agentId: bigint;
  statuses: ChainStatus[];
  trustedReports: ReportRef[];
}

/** The same agent from the indexer. */
export interface IndexedAgentView {
  agentId: bigint;
  verdicts: { requestHash: Hex; validator: Address; agentId: bigint; responses: number; score: number | null; responseHash: Hex | null; tag: string | null }[];
  trustedReports: ReportRef[];
}

const answered = (s: ChainStatus) => s.responseHash !== zeroHash || s.tag !== "";
const ref = (r: ReportRef) => `${r.txHash.toLowerCase()}#${r.logIndex}`;

/**
 * The indexer's requests and verdicts for an agent against the chain's: every request on both sides, then for each
 * its validator, agent, whether it is answered, and the latest score, `responseHash` and tag. Every trusted report the
 * chain search finds must be in the indexer too (the indexer may hold more: posts later than the chain search's
 * window, which indexer-check confirms from their receipts instead).
 */
export function compareAgent(chain: ChainAgentView, indexed: IndexedAgentView): Mismatch[] {
  const out: Mismatch[] = [];
  const who = `agent ${chain.agentId}`;
  const byHash = new Map(indexed.verdicts.map((v) => [v.requestHash.toLowerCase(), v]));
  const onChain = new Set(chain.statuses.map((s) => s.requestHash.toLowerCase()));
  for (const s of chain.statuses) {
    const v = byHash.get(s.requestHash.toLowerCase());
    const at = `${who}: request ${s.requestHash}`;
    if (!v) {
      out.push({ what: `${at} missing from the indexer`, chain: answered(s) ? `${s.tag} ${s.response}` : "pending", indexer: "none" });
      continue;
    }
    if (getAddress(v.validator) !== getAddress(s.validator)) out.push({ what: `${at} validator`, chain: s.validator, indexer: v.validator });
    if (v.agentId !== s.agentId) out.push({ what: `${at} agentId`, chain: String(s.agentId), indexer: String(v.agentId) });
    const indexedAnswered = v.responses > 0;
    if (indexedAnswered !== answered(s)) {
      out.push({ what: `${at} answered`, chain: answered(s) ? "answered" : "pending", indexer: indexedAnswered ? "answered" : "pending" });
      continue;
    }
    if (!indexedAnswered) continue;
    if (v.score !== s.response) out.push({ what: `${at} score`, chain: String(s.response), indexer: String(v.score) });
    if ((v.responseHash ?? "").toLowerCase() !== s.responseHash.toLowerCase()) out.push({ what: `${at} responseHash`, chain: s.responseHash, indexer: String(v.responseHash) });
    if (v.tag !== displayText(s.tag)) out.push({ what: `${at} tag`, chain: displayText(s.tag), indexer: String(v.tag) });
  }
  for (const v of indexed.verdicts) {
    if (!onChain.has(v.requestHash.toLowerCase())) out.push({ what: `${who}: request ${v.requestHash} not on chain`, chain: "none", indexer: v.tag ?? "pending" });
  }
  const indexedReports = new Set(indexed.trustedReports.map(ref));
  for (const r of chain.trustedReports) {
    if (!indexedReports.has(ref(r))) out.push({ what: `${who}: report ${r.txHash}#${r.logIndex} missing from the indexer`, chain: "trusted", indexer: "none" });
  }
  return out;
}

/** A validator's counts from the chain: its requests, the answered ones, and buckets over each latest score. */
export interface ChainValidatorView {
  validator: Address;
  requests: number;
  answered: number;
  buckets: ValidatorStats["buckets"];
}

export function compareValidator(chain: ChainValidatorView, indexed: Pick<ValidatorStats, "validator" | "requests" | "answered" | "buckets"> | null): Mismatch[] {
  const who = `validator ${chain.validator}`;
  if (indexed === null) return [{ what: `${who}: missing from the indexer`, chain: `${chain.requests} requests`, indexer: "none" }];
  const out: Mismatch[] = [];
  const pairs: [string, number, number][] = [
    ["requests", chain.requests, indexed.requests],
    ["answered", chain.answered, indexed.answered],
    ...Object.entries(chain.buckets).map(([k, n]) => [k, n, indexed.buckets[k as keyof ValidatorStats["buckets"]]] as [string, number, number]),
  ];
  for (const [what, c, i] of pairs) if (c !== i) out.push({ what: `${who}: ${what}`, chain: String(c), indexer: String(i) });
  return out;
}
