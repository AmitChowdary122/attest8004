// AgentRequestForwarder: an agent's hot key, registered (or revoked with the zero address) by its current owner.
// A permission event for mandate-v1 (SPEC §4.5).
import { indexer } from "envio";
import { anchorOf, recordPermission, touchAgent } from "./shared.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

indexer.onEvent({ contract: "AgentRequestForwarder", event: "AgentKeySet" }, async ({ event, context }) => {
  const a = anchorOf(event);
  const agentId = event.params.agentId.toString();
  const owner = event.params.owner.toLowerCase();
  const key = event.params.key.toLowerCase();
  await touchAgent(context, agentId, a.block, owner);
  const agent = await context.Agent.getOrThrow(agentId);
  context.Agent.set({ ...agent, hotKey: key === ZERO ? undefined : key, hotKeyOwner: owner });
  await recordPermission(context, a, { agentId, kind: "AGENT_KEY_SET", source: event.srcAddress.toLowerCase(), inEpoch: true, from: owner, to: key });
});
