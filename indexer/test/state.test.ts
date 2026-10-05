import { createTestIndexer } from "envio";
import { zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  B,
  FORWARDER,
  HOT_KEY,
  IDENTITY,
  MANDATE_V1,
  MANDATE_V2,
  OTHER_OWNER,
  OWNER,
  STRANGER,
  V2_FROM,
  VALIDATOR_A,
  VALIDATOR_B,
  VAULT,
  at,
  request,
  requestEvent,
  txHash,
} from "./helpers.ts";

// Mandates per registry epoch, passkeys, inbox keys, mandate-v1's permission events for our agents, and executed
// actions (plan Task 3, decisions 8–10, 12).

const run = (indexer: ReturnType<typeof createTestIndexer>, simulate: unknown[]) => indexer.process({ chains: { 10143: { simulate: simulate as never } } });

const MANDATE_HASH = "0x" + "11".repeat(32);
const QX = "0x" + "21".repeat(32);
const QY = "0x" + "22".repeat(32);
const QX2 = "0x" + "31".repeat(32);
const QY2 = "0x" + "32".repeat(32);
const INBOX = "0x" + "41".repeat(32);

const mandateSet = (registry: Address, block: number, o: { agentId?: bigint; owner?: Address } = {}) => ({
  contract: registry === MANDATE_V1 ? ("MandateRegistryV1" as const) : ("MandateRegistryV2" as const),
  event: "MandateSet" as const,
  srcAddress: registry,
  params: {
    agentId: o.agentId ?? 1984n,
    mandateHash: MANDATE_HASH,
    owner: o.owner ?? OWNER,
    allowedTargets: ["0x00000000000000000000000000000000000000D4" as Address],
    // As HyperSync decodes a bytes4[] element: the full left-aligned 32-byte word.
    allowedSelectors: ["0x" + "00".repeat(32), "0xa9059cbb" + "00".repeat(28)],
    maxValuePerTx: 2_000_000_000_000_000n,
    maxValuePerDay: 5_000_000_000_000_000n,
    validUntil: 1_793_404_800n,
    setAtBlock: BigInt(block),
  },
  ...at(block),
});
const registryEvent = (registry: Address, event: string, params: Record<string, unknown>, block: number) => ({
  contract: registry === MANDATE_V1 ? "MandateRegistryV1" : "MandateRegistryV2",
  event,
  srcAddress: registry,
  params,
  ...at(block),
});
const transfer = (from: Address, to: Address, tokenId: bigint, block: number, logIndex = 0) => ({
  contract: "IdentityRegistry",
  event: "Transfer",
  srcAddress: IDENTITY,
  params: { from, to, tokenId },
  ...at(block, logIndex),
});
const approvalForAll = (owner: Address, operator: Address, approved: boolean, block: number) => ({
  contract: "IdentityRegistry",
  event: "ApprovalForAll",
  srcAddress: IDENTITY,
  params: { owner, operator, approved },
  ...at(block),
});
const permissionEvents = async (indexer: ReturnType<typeof createTestIndexer>, agentId = "1984") =>
  (await indexer.PermissionEvent.getAll()).filter((e) => e.agentId === agentId).sort((x, y) => Number(x.block - y.block));

describe("MandateRegistries", () => {
  it("a V1 mandate in its epoch sets state and counts a permission change", async () => {
    const indexer = createTestIndexer();
    await run(indexer, [mandateSet(MANDATE_V1, V2_FROM - 100)]);
    const mandate = await indexer.Mandate.getOrThrow(`${MANDATE_V1}-1984`);
    expect(mandate).toMatchObject({
      agentId: "1984",
      registry: MANDATE_V1,
      mandateHash: MANDATE_HASH,
      owner: OWNER,
      allowedTargets: ["0x00000000000000000000000000000000000000d4"],
      allowedSelectors: ["0x00000000", "0xa9059cbb"],
      maxValuePerTx: "2000000000000000",
      maxValuePerDay: "5000000000000000",
      validUntil: 1_793_404_800n,
      setAtBlock: BigInt(V2_FROM - 100),
      active: true,
      changedTx: txHash(V2_FROM - 100),
    });
    const [event] = await permissionEvents(indexer);
    expect(event).toMatchObject({ kind: "MANDATE_SET", source: MANDATE_V1, inEpoch: true, from: OWNER, mandateHash: MANDATE_HASH });
    expect(await indexer.AgentTrustSummary.getOrThrow("1984")).toMatchObject({ permissionChanges: 1, lastPermissionChangeBlock: BigInt(V2_FROM - 100) });
    expect((await indexer.Agent.getOrThrow("1984")).owner).toBe(OWNER);
  });

  it("a V1 event after the switch is stored out of epoch and changes nothing", async () => {
    const indexer = createTestIndexer();
    await run(indexer, [mandateSet(MANDATE_V1, V2_FROM - 100), { ...mandateSet(MANDATE_V1, V2_FROM), params: { ...mandateSet(MANDATE_V1, V2_FROM).params, mandateHash: "0x" + "99".repeat(32) } }]);
    const events = await permissionEvents(indexer);
    expect(events.map((e) => [e.kind, e.inEpoch])).toEqual([
      ["MANDATE_SET", true],
      ["MANDATE_SET", false],
    ]);
    expect((await indexer.Mandate.getOrThrow(`${MANDATE_V1}-1984`)).mandateHash).toBe(MANDATE_HASH);
    expect((await indexer.AgentTrustSummary.getOrThrow("1984")).permissionChanges).toBe(1);
  });

  it("revoke deactivates the mandate", async () => {
    const indexer = createTestIndexer();
    await run(indexer, [
      mandateSet(MANDATE_V2, B),
      registryEvent(MANDATE_V2, "MandateRevoked", { agentId: 1984n, mandateHash: MANDATE_HASH, owner: OWNER }, B + 10),
    ]);
    expect(await indexer.Mandate.getOrThrow(`${MANDATE_V2}-1984`)).toMatchObject({ active: false, changedBlock: BigInt(B + 10), changedTx: txHash(B + 10) });
    expect((await permissionEvents(indexer)).map((e) => e.kind)).toEqual(["MANDATE_SET", "MANDATE_REVOKED"]);
    expect((await indexer.AgentTrustSummary.getOrThrow("1984")).permissionChanges).toBe(2);
  });

  it("passkey set and rotation", async () => {
    const indexer = createTestIndexer();
    await run(indexer, [
      registryEvent(MANDATE_V2, "PasskeySet", { agentId: 1984n, owner: OWNER, qx: QX, qy: QY }, B),
      registryEvent(MANDATE_V2, "PasskeyRotated", { agentId: 1984n, owner: OWNER, oldQx: QX, oldQy: QY, qx: QX2, qy: QY2 }, B + 5),
    ]);
    expect(await indexer.Passkey.getOrThrow(`${MANDATE_V2}-1984`)).toMatchObject({ agentId: "1984", registry: MANDATE_V2, qx: QX2, qy: QY2, owner: OWNER, block: BigInt(B + 5) });
    expect((await permissionEvents(indexer)).map((e) => e.kind)).toEqual(["PASSKEY_SET", "PASSKEY_ROTATED"]);
    expect((await indexer.AgentTrustSummary.getOrThrow("1984")).permissionChanges).toBe(2);
  });

  it("an inbox key is state, not a permission change", async () => {
    const indexer = createTestIndexer();
    await run(indexer, [registryEvent(MANDATE_V2, "InboxKeySet", { agentId: 1984n, owner: OWNER, x25519Pub: INBOX }, B)]);
    expect(await indexer.InboxKey.getOrThrow(`${MANDATE_V2}-1984`)).toMatchObject({ x25519Pub: INBOX, owner: OWNER, changes: 1, block: BigInt(B), tx: txHash(B) });
    expect(await indexer.PermissionEvent.getAll()).toEqual([]);
    expect((await indexer.AgentTrustSummary.getOrThrow("1984")).permissionChanges).toBe(0);
  });
});

describe("the forwarder and the Identity Registry", () => {
  it("an agent key sets the hot key", async () => {
    const indexer = createTestIndexer();
    await run(indexer, [{ contract: "AgentRequestForwarder", event: "AgentKeySet", srcAddress: FORWARDER, params: { agentId: 1984n, owner: OWNER, key: HOT_KEY }, ...at(B) }]);
    expect(await indexer.Agent.getOrThrow("1984")).toMatchObject({ owner: OWNER, hotKey: HOT_KEY, hotKeyOwner: OWNER });
    const [event] = await permissionEvents(indexer);
    expect(event).toMatchObject({ kind: "AGENT_KEY_SET", source: FORWARDER, inEpoch: true, from: OWNER, to: HOT_KEY });
  });

  it("a revoked agent key clears the hot key", async () => {
    const indexer = createTestIndexer();
    await run(indexer, [
      { contract: "AgentRequestForwarder", event: "AgentKeySet", srcAddress: FORWARDER, params: { agentId: 1984n, owner: OWNER, key: HOT_KEY }, ...at(B) },
      { contract: "AgentRequestForwarder", event: "AgentKeySet", srcAddress: FORWARDER, params: { agentId: 1984n, owner: OWNER, key: zeroAddress }, ...at(B + 1) },
    ]);
    expect((await indexer.Agent.getOrThrow("1984")).hotKey).toBeUndefined();
  });

  it("a transfer of an unknown token records only its owner", async () => {
    const indexer = createTestIndexer();
    await run(indexer, [transfer(zeroAddress, OWNER, 1984n, B)]);
    expect(await indexer.Agent.get("1984")).toBeUndefined();
    expect(await indexer.PermissionEvent.getAll()).toEqual([]);
    expect(await indexer.TokenOwner.getOrThrow("1984")).toMatchObject({ owner: OWNER, block: BigInt(B) });
  });

  it("an agent first seen later takes its owner from TokenOwner", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [transfer(zeroAddress, OWNER, 1984n, B), requestEvent(r, { validator: VALIDATOR_A, block: B + 50 })]);
    expect(await indexer.Agent.getOrThrow("1984")).toMatchObject({ owner: OWNER, firstSeenBlock: BigInt(B + 50) });
  });

  it("a transfer of a known agent", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [transfer(zeroAddress, OWNER, 1984n, B), requestEvent(r, { validator: VALIDATOR_A, block: B + 1 }), transfer(OWNER, OTHER_OWNER, 1984n, B + 2)]);
    expect((await indexer.Agent.getOrThrow("1984")).owner).toBe(OTHER_OWNER);
    expect((await indexer.TokenOwner.getOrThrow("1984")).owner).toBe(OTHER_OWNER);
    const [event] = await permissionEvents(indexer);
    expect(event).toMatchObject({ kind: "TRANSFER", source: IDENTITY, inEpoch: true, from: OWNER, to: OTHER_OWNER, block: BigInt(B + 2) });
    expect((await indexer.AgentTrustSummary.getOrThrow("1984")).permissionChanges).toBe(1);
  });

  it("an approval of a known agent is a permission event; of an unknown one, nothing", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [
      transfer(zeroAddress, OWNER, 1984n, B),
      requestEvent(r, { validator: VALIDATOR_A, block: B + 1 }),
      { contract: "IdentityRegistry", event: "Approval", srcAddress: IDENTITY, params: { owner: OWNER, approved: FORWARDER, tokenId: 1984n }, ...at(B + 2) },
      { contract: "IdentityRegistry", event: "Approval", srcAddress: IDENTITY, params: { owner: STRANGER, approved: FORWARDER, tokenId: 7n }, ...at(B + 3) },
    ]);
    const events = await indexer.PermissionEvent.getAll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agentId: "1984", kind: "APPROVAL", from: OWNER, to: FORWARDER });
  });

  it("ApprovalForAll lists every known agent of that owner", async () => {
    const indexer = createTestIndexer();
    const r1 = request({ validator: VALIDATOR_A, agentId: 1984n });
    const r2 = request({ validator: VALIDATOR_B, agentId: 1985n });
    await run(indexer, [
      transfer(zeroAddress, OWNER, 1984n, B),
      transfer(zeroAddress, OWNER, 1985n, B, 1),
      requestEvent(r1, { validator: VALIDATOR_A, agentId: 1984n, block: B + 1 }),
      requestEvent(r2, { validator: VALIDATOR_B, agentId: 1985n, block: B + 1, logIndex: 1 }),
      approvalForAll(OWNER, FORWARDER, true, B + 2),
      approvalForAll(STRANGER, FORWARDER, true, B + 3),
    ]);
    const events = await indexer.PermissionEvent.getAll();
    expect(events.map((e) => [e.agentId, e.kind, e.from, e.to, e.approved]).sort()).toEqual([
      ["1984", "APPROVAL_FOR_ALL", OWNER, FORWARDER, true],
      ["1985", "APPROVAL_FOR_ALL", OWNER, FORWARDER, true],
    ]);
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
  });

  it("after a transfer, the old owner's ApprovalForAll no longer lists the agent", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [
      transfer(zeroAddress, OWNER, 1984n, B),
      requestEvent(r, { validator: VALIDATOR_A, block: B + 1 }),
      transfer(OWNER, OTHER_OWNER, 1984n, B + 2),
      approvalForAll(OWNER, FORWARDER, true, B + 3),
    ]);
    expect((await permissionEvents(indexer)).map((e) => e.kind)).toEqual(["TRANSFER"]);
  });
});

describe("the vaults", () => {
  it("ActionConsumed marks every request of that action executed", async () => {
    const indexer = createTestIndexer();
    const a = request({ validator: VALIDATOR_A, salt: "one" });
    const b = request({ validator: VALIDATOR_B, salt: "one" });
    const other = request({ validator: VALIDATOR_A, salt: "two" });
    expect(a.actionHash).toBe(b.actionHash);
    await run(indexer, [
      requestEvent(a, { validator: VALIDATOR_A, block: B }),
      requestEvent(b, { validator: VALIDATOR_B, block: B, logIndex: 1 }),
      requestEvent(other, { validator: VALIDATOR_A, block: B, logIndex: 2 }),
      { contract: "DemoAgentVault", event: "ActionConsumed", srcAddress: VAULT, params: { actionHash: a.actionHash, agentId: 1984n }, ...at(B + 100) },
    ]);
    expect(await indexer.ActionExecution.getOrThrow(a.actionHash)).toMatchObject({ gate: VAULT, agentId: "1984", block: BigInt(B + 100), tx: txHash(B + 100) });
    for (const r of [a, b]) expect(await indexer.ValidationRequest.getOrThrow(r.requestHash)).toMatchObject({ executedTx: txHash(B + 100), executedBlock: BigInt(B + 100) });
    expect((await indexer.ValidationRequest.getOrThrow(other.requestHash)).executedTx).toBeUndefined();
    expect((await indexer.AgentTrustSummary.getOrThrow("1984")).executed).toBe(1);
  });

  // One process() per test: Envio 3.12.1's test indexer refuses a second run once its progress passes a contract's
  // start block (the #1656 family), so a second consumption is its own test.
  it("each consumed action counts once", async () => {
    const indexer = createTestIndexer();
    const one = request({ validator: VALIDATOR_A, salt: "one" });
    const two = request({ validator: VALIDATOR_A, salt: "two" });
    await run(indexer, [
      requestEvent(one, { validator: VALIDATOR_A, block: B }),
      requestEvent(two, { validator: VALIDATOR_A, block: B, logIndex: 1 }),
      { contract: "DemoAgentVault", event: "ActionConsumed", srcAddress: VAULT, params: { actionHash: one.actionHash, agentId: 1984n }, ...at(B + 100) },
      { contract: "DemoAgentVault", event: "ActionConsumed", srcAddress: VAULT, params: { actionHash: two.actionHash, agentId: 1984n }, ...at(B + 200) },
    ]);
    expect((await indexer.AgentTrustSummary.getOrThrow("1984")).executed).toBe(2);
    expect(await indexer.ActionExecution.getAll()).toHaveLength(2);
  });
});
