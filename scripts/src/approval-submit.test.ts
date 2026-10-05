import { readFileSync } from "node:fs";
import { approvalSchema, type Approval } from "@attest8004/sdk";
import type { Address, Hex, PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { readApprovalChainState } from "./approval-submit.ts";

// The SDK's committed approvals (the same ones approval-plan.test.ts uses): a mandate at nonce 0, an inbox key at nonce 1.
const approval: Approval = approvalSchema.parse(JSON.parse(readFileSync(new URL("../../packages/sdk/test/webauthn-vector.json", import.meta.url), "utf8")));
const inboxApproval: Approval = approvalSchema.parse(
  JSON.parse(readFileSync(new URL("../../packages/sdk/test/webauthn-inbox-vector.json", import.meta.url), "utf8")),
);
const REGISTRY = "0x00000000000000000000000000000000000000aa" as Address;
const IDENTITY = "0x00000000000000000000000000000000000000bb" as Address;
const SENDER = "0x3EFEB3Cf2FB54A7D99abE90AaB786cE5A831a8CF" as Address;
const QX = `0x${"01".repeat(32)}` as Hex;
const QY = `0x${"02".repeat(32)}` as Hex;
const INBOX = `0x${"03".repeat(32)}` as Hex;
const HASH = `0x${"04".repeat(32)}` as Hex;
const CHALLENGE = `0x${"05".repeat(32)}` as Hex;

/** A client whose readContract answers by function name and records every call. */
function fakeClient() {
  const calls: { address: Address; functionName: string; args: readonly unknown[] }[] = [];
  const answers: Record<string, unknown> = {
    nonceOf: 7n,
    passkeyOf: [QX, QY],
    ownerOf: SENDER.toLowerCase(),
    inboxKeyOf: INBOX,
    mandateHashOf: HASH,
    challengeFor: CHALLENGE,
  };
  const client = {
    async readContract(o: { address: Address; functionName: string; args: readonly unknown[] }) {
      calls.push({ address: o.address, functionName: o.functionName, args: o.args });
      if (!(o.functionName in answers)) throw new Error(`unexpected read ${o.functionName}`);
      return answers[o.functionName];
    },
  } as unknown as PublicClient;
  return { client, calls };
}

describe("readApprovalChainState", () => {
  it("reads a mandate approval's chain state: the nonce, the passkey, the owner (checksummed), the inbox key, mandateHashOf and challengeFor", async () => {
    const { client, calls } = fakeClient();
    const state = await readApprovalChainState({ publicClient: client, chainId: 10143, registry: REGISTRY, identityRegistry: IDENTITY, approval, sender: SENDER });
    expect(state).toEqual({
      chainId: 10143,
      registry: REGISTRY,
      nonce: 7n,
      qx: QX,
      qy: QY,
      owner: SENDER,
      sender: SENDER,
      contractChangeHash: HASH,
      contractChallenge: CHALLENGE,
      currentInboxKey: INBOX,
    });
    const agentId = BigInt(approval.agentId);
    expect(calls.find((c) => c.functionName === "ownerOf")).toEqual({ address: IDENTITY, functionName: "ownerOf", args: [agentId] });
    // The challenge is the registry's own, for the approval's change hash at the approval's nonce (not the chain's).
    expect(calls.find((c) => c.functionName === "challengeFor")).toEqual({
      address: REGISTRY,
      functionName: "challengeFor",
      args: [agentId, approval.changeHash, BigInt(approval.nonce)],
    });
  });

  it("reads no mandateHashOf for an inbox-key approval: the registry has no view for its change hash", async () => {
    const { client, calls } = fakeClient();
    const state = await readApprovalChainState({
      publicClient: client,
      chainId: 10143,
      registry: REGISTRY,
      identityRegistry: IDENTITY,
      approval: inboxApproval,
      sender: SENDER,
    });
    expect(state.contractChangeHash).toBeNull();
    expect(calls.some((c) => c.functionName === "mandateHashOf")).toBe(false);
  });
});
