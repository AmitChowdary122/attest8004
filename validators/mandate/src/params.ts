/**
 * `mandate-v1`'s own constants (SPEC §4.5). The tag is the evidence's `validator`, and four of them
 * are recorded in its `params` (`permissionWindowBlocks`, `spendWindowSeconds`,
 * `maxDeadlineAheadSeconds`, `simulationGas`); `consumedCallGas` and `plainTransferSelector` are not
 * recorded, the tag alone fixes them. Recorded or not, `verify` re-runs a verdict with these values, so
 * a change to any of them is a new validator tag, never a silent change in meaning for past verdicts:
 * the `mandate-v1` evidence format is frozen.
 */
export const MANDATE_V1 = {
  tag: "mandate-v1",
  /** The permission-change lookback window, in blocks: about 30 minutes of Monad blocks. */
  permissionWindowBlocks: 6_000n,
  /**
   * The spend window, in seconds, on approval time: 25 h. The registry only records when an
   * action was approved, not when it executed, so the window is widened past 24 h by
   * `maxDeadlineAheadSeconds` (below) to still cover every execution in the last 24 h.
   */
  spendWindowSeconds: 90_000n,
  /**
   * The base's `maxDeadlineAheadSeconds`, fixed here at 1 h so an action always executes within
   * 1 h of being approved, which is what lets a 25 h spend window cover a full 24 h of execution.
   */
  maxDeadlineAheadSeconds: 3_600n,
  /** Gas cap for simulating the action at `P`. */
  simulationGas: 1_000_000n,
  /** Gas cap for each gate `consumed()` read when checking whether a past approval counts toward spend. */
  consumedCallGas: 100_000n,
  /** `0x00000000` in an allowlist means empty `data` only: a plain MON transfer. */
  plainTransferSelector: "0x00000000",
} as const;
