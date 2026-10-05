import { readFileSync } from "node:fs";
import { approvalSchema, type Approval, type Mandate } from "@attest8004/sdk";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  SET_INBOX_KEY_GAS_CAP,
  SET_PASSKEY_GAS_CAP,
  approvalProblems,
  confirmationCode,
  confirms,
  parseAgentId,
  parseArgs,
  resolveInputPath,
  setMandateGasCap,
  type ApprovalChainState,
} from "./approval-plan.ts";

// The SDK's committed approval document: signed with a fixed test key, consistent with itself.
const approval: Approval = approvalSchema.parse(
  JSON.parse(readFileSync(new URL("../../packages/sdk/test/webauthn-vector.json", import.meta.url), "utf8")),
);
// The SDK's committed setInboxKey approval: the same test key, at nonce 1, after the mandate vector.
const inboxApproval: Approval = approvalSchema.parse(
  JSON.parse(readFileSync(new URL("../../packages/sdk/test/webauthn-inbox-vector.json", import.meta.url), "utf8")),
);
const OWNER: Address = "0x3EFEB3Cf2FB54A7D99abE90AaB786cE5A831a8CF";
const OTHER_HASH: Hex = `0x${"11".repeat(32)}`;
const ZERO: Hex = `0x${"00".repeat(32)}`;

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
    contractChangeHash: approval.changeHash,
    contractChallenge: approval.challenge,
    currentInboxKey: ZERO,
  };
}

/** Chain state that agrees with the inbox approval: the registry has no view for its change hash. */
function matchingInbox(): ApprovalChainState {
  return {
    ...matching(),
    nonce: BigInt(inboxApproval.nonce),
    contractChangeHash: null,
    contractChallenge: inboxApproval.challenge,
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
      [{ contractChangeHash: OTHER_HASH }, "CHANGE_HASH_MISMATCH"],
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
    if (approval.change.kind !== "setMandate") throw new Error("the SDK vector is a mandate approval");
    const mandate = { ...approval.change.mandate, maxValuePerDay: "6000000000000000" };
    const tampered = { ...approval, change: { kind: "setMandate" as const, mandate } };
    expect(codes(await approvalProblems(tampered, matching()))).toContain("CHANGE_HASH_MISMATCH");
  });
});

describe("approvalProblems for setInboxKey", () => {
  it("inbox approval: no problems on a matching chain state", async () => {
    await expect(approvalProblems(inboxApproval, matchingInbox())).resolves.toEqual([]);
  });

  it("INBOX_KEY_UNCHANGED when the same key is set", async () => {
    if (inboxApproval.change.kind !== "setInboxKey") throw new Error("the SDK inbox vector sets an inbox key");
    const problems = await approvalProblems(inboxApproval, { ...matchingInbox(), currentInboxKey: inboxApproval.change.x25519Pub });
    expect(codes(problems)).toEqual(["INBOX_KEY_UNCHANGED"]);
  });

  it("STALE_NONCE, PASSKEY_MISMATCH, NOT_OWNER as for mandates", async () => {
    const cases: [Partial<ApprovalChainState>, string][] = [
      [{ nonce: 2n }, "STALE_NONCE"],
      [{ qx: OTHER_HASH }, "PASSKEY_MISMATCH"],
      [{ sender: "0x0000000000000000000000000000000000000002" }, "NOT_OWNER"],
      [{ contractChallenge: OTHER_HASH }, "CHALLENGE_MISMATCH"],
    ];
    for (const [change, code] of cases) {
      expect(codes(await approvalProblems(inboxApproval, { ...matchingInbox(), ...change })), code).toEqual([code]);
    }
  });

  it("contractChangeHash null skips the registry-hash check, the self-check still recomputes", async () => {
    const tampered = { ...inboxApproval, change: { kind: "setInboxKey" as const, x25519Pub: OTHER_HASH } };
    expect(codes(await approvalProblems(tampered, matchingInbox()))).toContain("CHANGE_HASH_MISMATCH");
    const zeroed = { ...inboxApproval, change: { kind: "setInboxKey" as const, x25519Pub: ZERO } };
    expect(codes(await approvalProblems(zeroed, matchingInbox()))).toContain("INBOX_KEY_ZERO");
  });
});

describe("gas caps", () => {
  const mandate = (targets: number, selectors: number): Mandate => ({
    allowedTargets: Array.from({ length: targets }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Address),
    allowedSelectors: Array.from({ length: selectors }, (_, i) => `0x${(i + 1).toString(16).padStart(8, "0")}` as Hex),
    maxValuePerTx: 1n,
    maxValuePerDay: 1n,
    validUntil: 2n,
  });

  it("setPasskey's cap clears the fork-measured live cost (≈130,239) by 1.3×", () => {
    expect(SET_PASSKEY_GAS_CAP).toBe(170_000n);
    expect(SET_PASSKEY_GAS_CAP * 10n >= 130_239n * 13n).toBe(true);
  });

  it("setInboxKey's cap clears the fork-measured live cost (≈172,264) by 1.3×", () => {
    expect(SET_INBOX_KEY_GAS_CAP).toBe(224_000n);
    expect(SET_INBOX_KEY_GAS_CAP * 10n >= 172_264n * 13n).toBe(true);
  });

  it("setMandate's cap is 470,000 up to the e2e mandate's 3 entries, then grows 40,000 per entry", () => {
    expect(setMandateGasCap(mandate(2, 1))).toBe(470_000n);
    expect(setMandateGasCap(mandate(1, 1))).toBe(470_000n);
    expect(setMandateGasCap(mandate(3, 1))).toBe(510_000n);
    expect(setMandateGasCap(mandate(16, 16))).toBe(470_000n + 29n * 40_000n);
    expect(setMandateGasCap(mandate(2, 1)) * 10n >= 361_300n * 13n).toBe(true);
  });
});

describe("parseArgs", () => {
  it("takes one positional and the known flags, each with a value", () => {
    expect(parseArgs(["--", "file.json", "--agent", "1985", "--confirm", "0xabcdef12"], ["agent", "confirm"])).toEqual({
      file: "file.json",
      flags: { agent: "1985", confirm: "0xabcdef12" },
    });
    expect(parseArgs(["file.json"], ["confirm"])).toEqual({ file: "file.json", flags: {} });
  });

  it("refuses unknown flags, --flag=value, a flag without a value, and zero or two positionals", () => {
    expect(() => parseArgs(["f.json", "--agnet", "1"], ["agent"])).toThrow(/unknown flag --agnet/);
    expect(() => parseArgs(["f.json", "--agent=1985"], ["agent"])).toThrow(/unknown flag --agent=1985/);
    expect(() => parseArgs(["f.json", "--agent"], ["agent"])).toThrow(/--agent needs a value/);
    expect(() => parseArgs(["f.json", "--agent", "--confirm", "x"], ["agent", "confirm"])).toThrow(/--agent needs a value/);
    expect(() => parseArgs([], ["agent"])).toThrow(/one file/);
    expect(() => parseArgs(["a.json", "b.json"], ["agent"])).toThrow(/one file/);
  });
});

describe("confirmation", () => {
  const hash: Hex = "0xf935d1625a09661cd7ac71eeaac67de09df9a9a96be76c3f68b37cec44bc7601";

  it("is the first 8 hex digits, and matches case-insensitively, with or without 0x", () => {
    expect(confirmationCode(hash)).toBe("0xf935d162");
    expect(confirms("0xf935d162", hash)).toBe(true);
    expect(confirms("0XF935D162", hash)).toBe(true);
    expect(confirms("f935d162", hash)).toBe(true);
  });

  it("anything else doesn't confirm", () => {
    expect(confirms(undefined, hash)).toBe(false);
    expect(confirms("0xf935d16", hash)).toBe(false);
    expect(confirms("0xf935d1625a", hash)).toBe(false);
    expect(confirms("0x00000000", hash)).toBe(false);
  });

  it("parseAgentId takes a decimal agent id only", () => {
    expect(parseAgentId("1985")).toBe(1985n);
    for (const bad of ["", "-1", "0x7c1", "1e3", "01", " 1"]) expect(() => parseAgentId(bad), bad).toThrow(/agent id/);
  });
});
