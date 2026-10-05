// Our AttestGate vaults: an action that ran. `actionHash` commits to the gate, so every request whose decoded action
// has this hash ran on this gate (plan decision 12).
import { indexer } from "envio";
import { anchorOf, bumpSummary } from "./shared.ts";

indexer.onEvent({ contract: "DemoAgentVault", event: "ActionConsumed" }, async ({ event, context }) => {
  const a = anchorOf(event);
  const actionHash = event.params.actionHash.toLowerCase();
  const agentId = event.params.agentId.toString();
  context.ActionExecution.set({ id: actionHash, gate: event.srcAddress.toLowerCase(), agentId, block: a.block, time: a.time, tx: a.tx, logIndex: a.logIndex });
  for (const request of await context.ValidationRequest.getWhere({ actionHash: { _eq: actionHash } })) {
    context.ValidationRequest.set({ ...request, executedTx: a.tx, executedBlock: a.block });
  }
  await bumpSummary(context, agentId, a.block, { executed: 1 });
});
