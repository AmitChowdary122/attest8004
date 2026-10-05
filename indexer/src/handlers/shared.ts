// State helpers shared by the handlers: the agents that use our contracts, their summaries, and the bookkeeping that
// keeps validator and agent-tag stats over each request's latest response (plan decisions 10 and 13).
import type { AgentTagSummary, AgentTrustSummary, EvmOnEventContext, PermissionEvent, Validator } from "envio";
import { scoreBucket } from "../lib/stats.ts";

type Context = EvmOnEventContext;

/** Envio's event metadata, as every handler records it. */
export interface Anchor {
  block: bigint;
  time: bigint;
  tx: string;
  logIndex: number;
}

export function anchorOf(event: { block: { number: number; timestamp: number }; transaction: { hash: string }; logIndex: number }): Anchor {
  return { block: BigInt(event.block.number), time: BigInt(event.block.timestamp), tx: event.transaction.hash.toLowerCase(), logIndex: event.logIndex };
}

/** An event row's id: its transaction and log index. */
export const eventId = (a: Anchor) => `${a.tx}-${a.logIndex}`;

/**
 * The agent's row and summary, created on its first appearance in our contracts (decision 10). The owner comes from
 * the Identity Registry's last transfer of that token, else from `ownerHint` (an event of ours that names the owner).
 */
export async function touchAgent(context: Context, agentId: string, block: bigint, ownerHint?: string): Promise<void> {
  const agent = await context.Agent.get(agentId);
  if (!agent) {
    const owner = (await context.TokenOwner.get(agentId))?.owner ?? ownerHint;
    context.Agent.set({ id: agentId, owner, firstSeenBlock: block, hotKey: undefined, hotKeyOwner: undefined });
  } else if (agent.owner === undefined && ownerHint !== undefined) {
    context.Agent.set({ ...agent, owner: ownerHint });
  }
  if (!(await context.AgentTrustSummary.get(agentId))) {
    context.AgentTrustSummary.set({
      id: agentId,
      requests: 0,
      answered: 0,
      executed: 0,
      trustedReports: 0,
      untrustedReports: 0,
      permissionChanges: 0,
      lastPermissionChangeBlock: undefined,
      lastActivityBlock: block,
    });
  }
}

type Counter = "requests" | "answered" | "executed" | "trustedReports" | "untrustedReports" | "permissionChanges";

/** Adds `delta` to a known agent's summary counters; an agent that never appeared in our contracts has none. */
export async function bumpSummary(context: Context, agentId: string, block: bigint, delta: Partial<Record<Counter, number>>, permissionChange = false): Promise<void> {
  const summary = await context.AgentTrustSummary.get(agentId);
  if (!summary) return;
  const next: Record<string, unknown> = { ...summary, lastActivityBlock: block > summary.lastActivityBlock ? block : summary.lastActivityBlock };
  for (const [key, value] of Object.entries(delta)) next[key] = (summary[key as Counter] as number) + (value as number);
  if (permissionChange) next.lastPermissionChangeBlock = block;
  context.AgentTrustSummary.set(next as AgentTrustSummary);
}

/** The most tags a validator's row lists: anyone can answer their own requests with new tags, so the list is capped. */
export const MAX_VALIDATOR_TAGS = 16;

export function newValidator(id: string, block: bigint): Validator {
  return {
    id,
    requests: 0,
    answered: 0,
    responseEvents: 0,
    scoreSum: 0n,
    avgScore: undefined,
    score0: 0,
    score1to39: 0,
    score40to79: 0,
    score80to99: 0,
    score100: 0,
    latencyBlocksSum: 0n,
    latencyCount: 0,
    avgLatencyBlocks: undefined,
    tags: [],
    firstSeenBlock: block,
    lastActivityBlock: block,
  };
}

export interface Verdict {
  score: number;
  tag: string;
}

/**
 * Moves a validator's buckets and score sum from a request's previous latest response (or none) to its new one, and
 * counts the response event; `latencyBlocks` is given for a request's first response only.
 */
export function applyToValidator(v: Validator, previous: Verdict | null, next: Verdict, block: bigint, latencyBlocks: bigint | null): Validator {
  const counts: Record<string, unknown> = { ...v };
  let scoreSum = v.scoreSum;
  let answered = v.answered;
  if (previous) {
    const old = scoreBucket(previous.score);
    counts[old] = (v[old] as number) - 1;
    scoreSum -= BigInt(previous.score);
  } else {
    answered += 1;
  }
  const bucket = scoreBucket(next.score);
  counts[bucket] = (counts[bucket] as number) + 1;
  scoreSum += BigInt(next.score);
  const latencyBlocksSum = v.latencyBlocksSum + (latencyBlocks ?? 0n);
  const latencyCount = v.latencyCount + (latencyBlocks === null ? 0 : 1);
  return {
    ...(counts as Validator),
    answered,
    responseEvents: v.responseEvents + 1,
    scoreSum,
    avgScore: answered > 0 ? Number(scoreSum) / answered : undefined,
    latencyBlocksSum,
    latencyCount,
    avgLatencyBlocks: latencyCount > 0 ? Number(latencyBlocksSum) / latencyCount : undefined,
    tags: v.tags.includes(next.tag) || v.tags.length >= MAX_VALIDATOR_TAGS ? v.tags : [...v.tags, next.tag],
    lastActivityBlock: block,
  };
}

/** Moves an agent's per-tag summaries from a request's previous latest response (or none) to its new one. */
export async function applyToAgentTags(context: Context, agentId: string, requestHash: string, previous: Verdict | null, next: Verdict, block: bigint): Promise<void> {
  const load = async (tag: string): Promise<AgentTagSummary> =>
    (await context.AgentTagSummary.get(`${agentId}-${tag}`)) ?? {
      id: `${agentId}-${tag}`,
      agentId,
      tag,
      verdicts: 0,
      scoreSum: 0n,
      avgScore: undefined,
      zeroScores: 0,
      fullScores: 0,
      lastScore: undefined,
      lastRequestHash: undefined,
      lastResponseBlock: undefined,
    };
  const average = (s: AgentTagSummary) => ({ ...s, avgScore: s.verdicts > 0 ? Number(s.scoreSum) / s.verdicts : undefined });

  if (previous) {
    const old = await load(previous.tag);
    context.AgentTagSummary.set(
      average({
        ...old,
        verdicts: old.verdicts - 1,
        scoreSum: old.scoreSum - BigInt(previous.score),
        zeroScores: old.zeroScores - (previous.score === 0 ? 1 : 0),
        fullScores: old.fullScores - (previous.score === 100 ? 1 : 0),
      }),
    );
  }
  const current = await load(next.tag);
  context.AgentTagSummary.set(
    average({
      ...current,
      verdicts: current.verdicts + 1,
      scoreSum: current.scoreSum + BigInt(next.score),
      zeroScores: current.zeroScores + (next.score === 0 ? 1 : 0),
      fullScores: current.fullScores + (next.score === 100 ? 1 : 0),
      lastScore: next.score,
      lastRequestHash: requestHash,
      lastResponseBlock: block,
    }),
  );
}

/**
 * One of mandate-v1's permission events for an agent (ARCHITECTURE §6). An in-epoch event counts in the agent's
 * summary; a retired registry's event after its successor took over is stored with `inEpoch: false` and counted
 * nowhere. `idSuffix` keeps one log's rows apart when it concerns several agents (ApprovalForAll).
 */
export async function recordPermission(
  context: Context,
  a: Anchor,
  e: Pick<PermissionEvent, "agentId" | "kind" | "source" | "inEpoch"> & Partial<Pick<PermissionEvent, "from" | "to" | "approved" | "mandateHash">>,
  idSuffix = "",
): Promise<void> {
  context.PermissionEvent.set({
    id: `${eventId(a)}${idSuffix}`,
    agentId: e.agentId,
    kind: e.kind,
    source: e.source,
    inEpoch: e.inEpoch,
    from: e.from,
    to: e.to,
    approved: e.approved,
    mandateHash: e.mandateHash,
    block: a.block,
    time: a.time,
    tx: a.tx,
    logIndex: a.logIndex,
  });
  if (e.inEpoch) await bumpSummary(context, e.agentId, a.block, { permissionChanges: 1 }, true);
}
