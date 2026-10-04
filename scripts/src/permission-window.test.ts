import { describe, expect, it } from "vitest";
import { isAfter, permissionChangedMessage } from "./permission-window.ts";

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

  it("says how to fix it: approve the same mandate again (a new baseline), or wait", () => {
    expect(message).toContain("approve the same mandate again at https://attest8004.vercel.app/approve");
    expect(message).toContain("pnpm --filter @attest8004/scripts submit-approval <file>");
    expect(message).toContain("or wait until block 68006100");
    // set-mandate is gone: a v2 mandate needs the passkey.
    expect(message).not.toContain("set-mandate");
  });

  it("orders by (block, logIndex), as mandate-v1 does", () => {
    const at = (blockNumber: bigint, logIndex: number) => ({ label: "x", blockNumber, logIndex });
    expect(isAfter(at(10n, 0), at(9n, 5))).toBe(true);
    expect(isAfter(at(10n, 3), at(10n, 2))).toBe(true);
    expect(isAfter(at(10n, 2), at(10n, 2))).toBe(false);
    expect(isAfter(at(9n, 9), at(10n, 0))).toBe(false);
  });
});
