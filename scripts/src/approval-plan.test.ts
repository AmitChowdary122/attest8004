import { readFileSync } from "node:fs";
import { approvalSchema, type Approval } from "@attest8004/sdk";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { approvalProblems, resolveInputPath, type ApprovalChainState } from "./approval-plan.ts";

// The SDK's committed approval document: signed with a fixed test key, consistent with itself.
const approval: Approval = approvalSchema.parse(
  JSON.parse(readFileSync(new URL("../../packages/sdk/test/webauthn-vector.json", import.meta.url), "utf8")),
);
const OWNER: Address = "0x3EFEB3Cf2FB54A7D99abE90AaB786cE5A831a8CF";
const OTHER_HASH: Hex = `0x${"11".repeat(32)}`;

/** Chain state that agrees with the approval in every respect. */
function matching(): ApprovalChainState {
  return {
    chainId: approval.chainId,
    registry: approval.registry,
    nonce: BigInt(approval.nonce),
    qx: approval.passkey.qx,
    qy: approval.passkey.qy,
    owner: OWNER,
    sender: OWNER,
    contractMandateHash: approval.changeHash,
    contractChallenge: approval.challenge,
  };
}

const codes = (problems: string[]) => problems.map((p) => p.slice(0, p.indexOf(":")));

describe("resolveInputPath", () => {
  it("resolves a relative path against INIT_CWD (where pnpm was run), keeps an absolute one", () => {
    expect(resolveInputPath("approval.json", { INIT_CWD: "/home/me/attest8004" })).toBe("/home/me/attest8004/approval.json");
    expect(resolveInputPath("../Downloads/a.json", { INIT_CWD: "/home/me/attest8004" })).toBe("/home/me/Downloads/a.json");
    expect(resolveInputPath("/tmp/a.json", { INIT_CWD: "/home/me/attest8004" })).toBe("/tmp/a.json");
  });

  it("falls back to the process directory without INIT_CWD", () => {
    expect(resolveInputPath("a.json", {})).toBe(`${process.cwd()}/a.json`);
  });
});

describe("approvalProblems", () => {
  it("is empty for the committed vector against matching chain state", async () => {
    await expect(approvalProblems(approval, matching())).resolves.toEqual([]);
  });

  it("STALE_NONCE says to approve again", async () => {
    const problems = await approvalProblems(approval, { ...matching(), nonce: BigInt(approval.nonce) + 1n });
    expect(codes(problems)).toEqual(["STALE_NONCE"]);
    expect(problems[0]).toContain("approve again at https://attest8004.vercel.app/approve");
  });

  it("names each chain mismatch on its own", async () => {
    const cases: [Partial<ApprovalChainState>, string][] = [
      [{ chainId: 143 }, "WRONG_CHAIN"],
      [{ registry: "0x0000000000000000000000000000000000000001" }, "WRONG_REGISTRY"],
      [{ qx: OTHER_HASH }, "PASSKEY_MISMATCH"],
      [{ sender: "0x0000000000000000000000000000000000000002" }, "NOT_OWNER"],
      [{ contractMandateHash: OTHER_HASH }, "CHANGE_HASH_MISMATCH"],
      [{ contractChallenge: OTHER_HASH }, "CHALLENGE_MISMATCH"],
    ];
    for (const [change, code] of cases) {
      expect(codes(await approvalProblems(approval, { ...matching(), ...change })), code).toEqual([code]);
    }
  });

  it("an agent with no passkey says to run set-passkey first", async () => {
    const zero: Hex = `0x${"00".repeat(32)}`;
    const problems = await approvalProblems(approval, { ...matching(), qx: zero, qy: zero });
    expect(codes(problems)).toEqual(["PASSKEY_MISMATCH"]);
    expect(problems[0]).toContain("run set-passkey first");
  });

  it("a tampered signature is SIGNATURE, and a tampered mandate is caught before any send", async () => {
    const r = `0x${(BigInt(approval.auth.r) ^ 1n).toString(16).padStart(64, "0")}` as Hex;
    expect(codes(await approvalProblems({ ...approval, auth: { ...approval.auth, r } }, matching()))).toEqual(["SIGNATURE"]);
    const mandate = { ...approval.change.mandate, maxValuePerDay: "6000000000000000" };
    const tampered = { ...approval, change: { kind: "setMandate" as const, mandate } };
    expect(codes(await approvalProblems(tampered, matching()))).toContain("CHANGE_HASH_MISMATCH");
  });
});
