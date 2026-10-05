// The canonical ERC-8004 Identity Registry (plan decision 9). Every token's owner is tracked internally (TokenOwner,
// hidden from GraphQL), so an agent's owner is known when it first appears in our contracts. Permission events are
// recorded only for those agents, from their first appearance on.
import { indexer } from "envio";
import { anchorOf, recordPermission } from "./shared.ts";

indexer.onEvent({ contract: "IdentityRegistry", event: "Transfer" }, async ({ event, context }) => {
  const a = anchorOf(event);
  const tokenId = event.params.tokenId.toString();
  const to = event.params.to.toLowerCase();
  context.TokenOwner.set({ id: tokenId, owner: to, block: a.block });
  const agent = await context.Agent.get(tokenId);
  if (!agent) return;
  context.Agent.set({ ...agent, owner: to });
  await recordPermission(context, a, { agentId: tokenId, kind: "TRANSFER", source: event.srcAddress.toLowerCase(), inEpoch: true, from: event.params.from.toLowerCase(), to });
});

indexer.onEvent({ contract: "IdentityRegistry", event: "Approval" }, async ({ event, context }) => {
  const tokenId = event.params.tokenId.toString();
  if (!(await context.Agent.get(tokenId))) return;
  await recordPermission(context, anchorOf(event), {
    agentId: tokenId,
    kind: "APPROVAL",
    source: event.srcAddress.toLowerCase(),
    inEpoch: true,
    from: event.params.owner.toLowerCase(),
    to: event.params.approved.toLowerCase(),
  });
});

// An operator approval covers every agent of that owner: one permission event per known agent it currently owns.
indexer.onEvent({ contract: "IdentityRegistry", event: "ApprovalForAll" }, async ({ event, context }) => {
  const a = anchorOf(event);
  const owner = event.params.owner.toLowerCase();
  for (const agent of await context.Agent.getWhere({ owner: { _eq: owner } })) {
    await recordPermission(
      context,
      a,
      { agentId: agent.id, kind: "APPROVAL_FOR_ALL", source: event.srcAddress.toLowerCase(), inEpoch: true, from: owner, to: event.params.operator.toLowerCase(), approved: event.params.approved },
      `-${agent.id}`,
    );
  }
});
