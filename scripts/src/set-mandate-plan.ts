// set-mandate's decisions (scripts/src/set-mandate.ts), kept free of env and RPC so they can be unit tested.
import type { Hex } from "viem";

/**
 * Whether set-mandate sends `setMandate`: when the stored mandate's hash differs from the one it would set, or
 * always with `--force`, which sets the same mandate again. That gives the mandate a new `MandateSet` log (and
 * `setAtBlock`), the baseline `mandate-v1` orders permission events against.
 */
export function shouldSendMandate(o: { storedHash: Hex; mandateHash: Hex; force: boolean }): boolean {
  return o.force || o.storedHash.toLowerCase() !== o.mandateHash.toLowerCase();
}

/**
 * The error when a permission event for the agent landed after the stored mandate's own `MandateSet` log within
 * `mandate-v1`'s permission window, so every action would fail `PERMISSION_CHANGED_AFTER_MANDATE` until the last
 * such event leaves the window.
 */
export function permissionChangedMessage(o: {
  violations: ReadonlyArray<{ label: string; blockNumber: bigint; logIndex: number }>;
  setAtBlock: bigint;
  baselineLogIndex: number;
  windowBlocks: bigint;
}): string {
  const last = o.violations.reduce((a, b) => (b.blockNumber > a.blockNumber || (b.blockNumber === a.blockNumber && b.logIndex > a.logIndex) ? b : a));
  const until = last.blockNumber + o.windowBlocks;
  return (
    `mandate-v1 would score PERMISSION_CHANGED_AFTER_MANDATE until block ${until}: found ` +
    `${o.violations.map((v) => `${v.label} at block ${v.blockNumber} (logIndex ${v.logIndex})`).join(", ")}, ` +
    `after this mandate's own MandateSet at block ${o.setAtBlock} (logIndex ${o.baselineLogIndex}). ` +
    "If the owner meant those changes, set the same mandate again with " +
    "`pnpm --filter @attest8004/scripts set-mandate -- --force` (its new MandateSet log becomes the baseline), " +
    `or wait until block ${until}.`
  );
}
