import { keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { permissionChangedMessage, shouldSendMandate } from "./set-mandate-plan.ts";

const HASH = keccak256(toHex("the e2e mandate"));
const OTHER = keccak256(toHex("another mandate"));

describe("shouldSendMandate", () => {
  it("skips a mandate that is already stored, unless --force asks to set it again", () => {
    expect(shouldSendMandate({ storedHash: HASH, mandateHash: HASH, force: false })).toBe(false);
    expect(shouldSendMandate({ storedHash: HASH, mandateHash: HASH, force: true })).toBe(true);
  });

  it("sends when the stored mandate differs (or none is stored), with or without --force", () => {
    expect(shouldSendMandate({ storedHash: OTHER, mandateHash: HASH, force: false })).toBe(true);
    expect(shouldSendMandate({ storedHash: `0x${"00".repeat(32)}`, mandateHash: HASH, force: true })).toBe(true);
  });

  it("compares hashes case-insensitively", () => {
    expect(shouldSendMandate({ storedHash: HASH.toUpperCase().replace("0X", "0x") as `0x${string}`, mandateHash: HASH, force: false })).toBe(false);
  });
});

describe("permissionChangedMessage", () => {
  const message = permissionChangedMessage({
    violations: [{ label: "AgentKeySet", blockNumber: 68_000_100n, logIndex: 2 }],
    setAtBlock: 67_890_013n,
    baselineLogIndex: 0,
    windowBlocks: 6_000n,
  });

  it("names the event, the baseline and the block until which mandate-v1 would fail", () => {
    expect(message).toContain("mandate-v1 would score PERMISSION_CHANGED_AFTER_MANDATE until block 68006100");
    expect(message).toContain("AgentKeySet at block 68000100 (logIndex 2)");
    expect(message).toContain("after this mandate's own MandateSet at block 67890013 (logIndex 0)");
  });

  it("says how to fix it: set the same mandate again with --force (a new baseline), or wait", () => {
    expect(message).toContain("pnpm --filter @attest8004/scripts set-mandate -- --force");
    expect(message).toContain("or wait until block 68006100");
    // The old text sent the operator in a circle: re-running without --force sends nothing for a stored mandate.
    expect(message).not.toContain("Re-run set-mandate after a new mandate is set");
  });
});
