// Both MandateRegistries (P4's owner-set one, then P6's v2), each read only in its own epoch, the way mandate-v1 reads
// the registry valid at its pin (plan decision 8). Mandates, passkeys and inbox keys are kept per registry; a retired
// registry's later events are stored as out-of-epoch permission events and change nothing.
import { indexer } from "envio";
import { bytes4 } from "../lib/decode.ts";
import { inEpoch } from "../lib/epochs.ts";
import { anchorOf, recordPermission, touchAgent } from "./shared.ts";

for (const contract of ["MandateRegistryV1", "MandateRegistryV2"] as const) {
  indexer.onEvent({ contract, event: "MandateSet" }, async ({ event, context }) => {
    const a = anchorOf(event);
    const registry = event.srcAddress.toLowerCase();
    const agentId = event.params.agentId.toString();
    const owner = event.params.owner.toLowerCase();
    const mandateHash = event.params.mandateHash.toLowerCase();
    const current = inEpoch(registry, a.block);
    if (current) {
      await touchAgent(context, agentId, a.block, owner);
      context.Mandate.set({
        id: `${registry}-${agentId}`,
        agentId,
        registry,
        mandateHash,
        owner,
        allowedTargets: event.params.allowedTargets.map((t) => t.toLowerCase()),
        allowedSelectors: event.params.allowedSelectors.map(bytes4),
        maxValuePerTx: event.params.maxValuePerTx.toString(),
        maxValuePerDay: event.params.maxValuePerDay.toString(),
        validUntil: event.params.validUntil,
        setAtBlock: event.params.setAtBlock,
        active: true,
        changedBlock: a.block,
        changedTx: a.tx,
      });
    }
    await recordPermission(context, a, { agentId, kind: "MANDATE_SET", source: registry, inEpoch: current, from: owner, mandateHash });
  });

  indexer.onEvent({ contract, event: "MandateRevoked" }, async ({ event, context }) => {
    const a = anchorOf(event);
    const registry = event.srcAddress.toLowerCase();
    const agentId = event.params.agentId.toString();
    const owner = event.params.owner.toLowerCase();
    const current = inEpoch(registry, a.block);
    if (current) {
      await touchAgent(context, agentId, a.block, owner);
      const mandate = await context.Mandate.get(`${registry}-${agentId}`);
      if (mandate) context.Mandate.set({ ...mandate, active: false, changedBlock: a.block, changedTx: a.tx });
    }
    await recordPermission(context, a, { agentId, kind: "MANDATE_REVOKED", source: registry, inEpoch: current, from: owner, mandateHash: event.params.mandateHash.toLowerCase() });
  });

  indexer.onEvent({ contract, event: "PasskeySet" }, async ({ event, context }) => {
    const a = anchorOf(event);
    const registry = event.srcAddress.toLowerCase();
    const agentId = event.params.agentId.toString();
    const owner = event.params.owner.toLowerCase();
    const current = inEpoch(registry, a.block);
    if (current) {
      await touchAgent(context, agentId, a.block, owner);
      const { qx, qy } = event.params;
      context.Passkey.set({ id: `${registry}-${agentId}`, agentId, registry, qx: qx.toLowerCase(), qy: qy.toLowerCase(), owner, block: a.block, tx: a.tx });
    }
    await recordPermission(context, a, { agentId, kind: "PASSKEY_SET", source: registry, inEpoch: current, from: owner });
  });

  indexer.onEvent({ contract, event: "PasskeyRotated" }, async ({ event, context }) => {
    const a = anchorOf(event);
    const registry = event.srcAddress.toLowerCase();
    const agentId = event.params.agentId.toString();
    const owner = event.params.owner.toLowerCase();
    const current = inEpoch(registry, a.block);
    if (current) {
      await touchAgent(context, agentId, a.block, owner);
      const { qx, qy } = event.params;
      context.Passkey.set({ id: `${registry}-${agentId}`, agentId, registry, qx: qx.toLowerCase(), qy: qy.toLowerCase(), owner, block: a.block, tx: a.tx });
    }
    await recordPermission(context, a, { agentId, kind: "PASSKEY_ROTATED", source: registry, inEpoch: current, from: owner });
  });

  // The inbox key is state, not a permission change (SPEC §4.7): no PermissionEvent.
  indexer.onEvent({ contract, event: "InboxKeySet" }, async ({ event, context }) => {
    const a = anchorOf(event);
    const registry = event.srcAddress.toLowerCase();
    const agentId = event.params.agentId.toString();
    if (!inEpoch(registry, a.block)) {
      context.log.warn(`InboxKeySet from ${registry} outside its epoch at block ${a.block}: ignored`);
      return;
    }
    const owner = event.params.owner.toLowerCase();
    await touchAgent(context, agentId, a.block, owner);
    const id = `${registry}-${agentId}`;
    const previous = await context.InboxKey.get(id);
    context.InboxKey.set({ id, agentId, registry, x25519Pub: event.params.x25519Pub.toLowerCase(), owner, changes: (previous?.changes ?? 0) + 1, block: a.block, tx: a.tx });
  });
}
