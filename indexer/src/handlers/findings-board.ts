// FindingsBoard: every encrypted operator report, trusted or not. Anyone can post, so `trusted` applies SPEC §4.7's
// rule to the indexed request: the post's validator and agent are the ones the request names (decision 15). A request
// can't change once made (RequestExists), so the flag is final, except for a post that arrives before its request,
// which the request handler re-evaluates. Readers still re-check every post against the chain (ARCHITECTURE §7).
import { indexer, type EvmOnEventContext, type FindingsPost, type ValidationRequest } from "envio";
import { anchorOf, bumpSummary, eventId } from "./shared.ts";

type TrustProblem = NonNullable<FindingsPost["trustProblem"]>;

function trustProblemOf(request: Pick<ValidationRequest, "validator" | "agentId"> | undefined, validator: string, agentId: string): TrustProblem | undefined {
  if (!request) return "NO_REQUEST";
  if (request.validator !== validator) return "WRONG_VALIDATOR";
  if (request.agentId !== agentId) return "WRONG_AGENT";
  return undefined;
}

const counter = (trusted: boolean) => (trusted ? "trustedReports" : "untrustedReports");

indexer.onEvent({ contract: "FindingsBoard", event: "FindingsPosted" }, async ({ event, context }) => {
  const a = anchorOf(event);
  const requestHash = event.params.requestHash.toLowerCase();
  const agentId = event.params.agentId.toString();
  const validator = event.params.validator.toLowerCase();
  const envelope = event.params.envelope.toLowerCase();
  const problem = trustProblemOf(await context.ValidationRequest.get(requestHash), validator, agentId);
  const counted = (await context.AgentTrustSummary.get(agentId)) !== undefined;
  context.FindingsPost.set({
    id: eventId(a),
    requestHash,
    agentId,
    validator,
    envelope,
    envelopeBytes: (envelope.length - 2) / 2,
    trusted: problem === undefined,
    trustProblem: problem,
    counted,
    block: a.block,
    time: a.time,
    tx: a.tx,
    logIndex: a.logIndex,
  });
  if (counted) await bumpSummary(context, agentId, a.block, { [counter(problem === undefined)]: 1 });
});

/**
 * Called by the ValidationRequest handler, after the agent is known: posts for this request that were indexed before
 * it (`NO_REQUEST`) are judged now, and the agent's summary counts each one once, under its final flag.
 */
export async function reevaluatePosts(context: EvmOnEventContext, request: Pick<ValidationRequest, "id" | "validator" | "agentId">, block: bigint): Promise<void> {
  for (const post of await context.FindingsPost.getWhere({ requestHash: { _eq: request.id } })) {
    if (post.trustProblem !== "NO_REQUEST") continue;
    const problem = trustProblemOf(request, post.validator, post.agentId);
    const trusted = problem === undefined;
    const known = (await context.AgentTrustSummary.get(post.agentId)) !== undefined;
    context.FindingsPost.set({ ...post, trusted, trustProblem: problem, counted: post.counted || known });
    if (post.counted) {
      if (trusted) await bumpSummary(context, post.agentId, block, { untrustedReports: -1, trustedReports: 1 });
    } else if (known) {
      await bumpSummary(context, post.agentId, block, { [counter(trusted)]: 1 });
    }
  }
}
