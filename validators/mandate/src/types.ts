import type { Address, Hex } from "viem";

/**
 * The block `mandate-v1` pins every read to, so a re-run of `verify` reads the same chain state
 * and reaches the same verdict (the "Reproducibility" global constraint).
 */
export interface PinnedBlock {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

/**
 * The agent's mandate, as read from `MandateRegistry.getMandate` at `P` (contracts/src/MandateRegistry.sol):
 * the allowlists and caps the owner set, plus `mandateHash`, the `owner` who set it (stale once the
 * agent is transferred) and the block it was set at (`setAtBlock`, for `(block, logIndex)` ordering
 * against permission-change events).
 */
export interface MandateRecord {
  allowedTargets: Address[];
  allowedSelectors: Hex[];
  maxValuePerTx: bigint;
  maxValuePerDay: bigint;
  validUntil: bigint;
  mandateHash: Hex;
  owner: Address;
  setAtBlock: bigint;
}

/**
 * One `mandate-v1` approval of this agent's action, found via `getAgentValidations` and its
 * `ValidationResponse` evidence (Decision 1). `counted` is whether the collector's "which approvals
 * count toward spend" rule (consumed, or unconsumed with `deadline >= P.ts`, or a failed `consumed()`
 * read) included it in `total`; `consumed` is `null` when the gate's `consumed()` read failed
 * (fail-closed: still `counted`).
 */
export interface SpendEntry {
  requestHash: Hex;
  approvedAt: bigint;
  gate: Address;
  value: bigint;
  deadline: bigint;
  consumed: boolean | null;
  counted: boolean;
}

/**
 * One event in the permission-change window `(P - N, P]` (the "Permission changes" global
 * constraint): the Identity Registry's `Transfer`/`Approval`/`ApprovalForAll` for the owner at `P`,
 * the forwarder's `AgentKeySet`, or the MandateRegistry's `MandateSet`/`MandateRevoked`.
 * `afterMandate` is computed by the collector by comparing `(block, logIndex)` against the current
 * mandate's `setAtBlock`: `true` means the event happened after the mandate was set, so it was never
 * reviewed when the owner approved this mandate.
 */
export interface PermissionEvent {
  block: bigint;
  logIndex: number;
  txHash: Hex;
  emitter: "IdentityRegistry" | "AgentRequestForwarder" | "MandateRegistry";
  event: "Transfer" | "Approval" | "ApprovalForAll" | "AgentKeySet" | "MandateSet" | "MandateRevoked";
  afterMandate: boolean;
}

/** The result of simulating the action at `P`, before committing to a verdict. */
export type Simulation =
  | { ok: true }
  | { ok: false; error: "REVERTED" | "INSUFFICIENT_FUNDS" | "OUT_OF_GAS"; revertSelector: Hex | null };

/**
 * Everything `evaluate()` needs, all read at the pinned block `P` (`pinned`). `mandate` is `null`
 * when the agent has none; `spend` is `null` exactly when `mandate` is `null` (there is nothing to
 * cap), a `{ unreadable }` document when found evidence failed its checks (Decision 1, amendment 1),
 * or the full `{ since, entries, total }` document with `total` already summed by the collector.
 */
export interface MandateInputs {
  pinned: PinnedBlock;
  owner: Address;
  request: {
    block: bigint;
    requestHash: Hex;
    chainId: number;
    gate: Address;
    agentId: bigint;
    target: Address;
    value: bigint;
    data: Hex;
    deadline: bigint;
    salt: Hex;
  };
  mandate: MandateRecord | null;
  spend: { since: bigint; entries: SpendEntry[]; total: bigint } | { unreadable: string } | null;
  permissions: { fromBlock: bigint; toBlock: bigint; events: PermissionEvent[] };
  simulation: Simulation;
}
