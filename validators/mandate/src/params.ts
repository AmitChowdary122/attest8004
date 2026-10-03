/**
 * `mandate-v1`'s own constants (SPEC §4.5). Recorded in the evidence, so a later change to any of
 * these is a new validator tag, not a silent change in meaning for past verdicts.
 */
export const MANDATE_V1 = {
  tag: "mandate-v1",
  /** N: the permission-change lookback window, in blocks (Decision 2). */
  permissionWindowBlocks: 6_000n,
  /** The spend window, in seconds, on approval time (Decision 3): 25 h. */
  spendWindowSeconds: 90_000n,
  /** The base's `maxDeadlineAheadSeconds`, fixed here so Decision 3's 25 h math holds. */
  maxDeadlineAheadSeconds: 3_600n,
  /** Gas cap for simulating the action at `P`. */
  simulationGas: 1_000_000n,
  /** Gas cap for each gate `consumed()` read (Decision 1, amendment 3). */
  consumedCallGas: 100_000n,
  /** `0x00000000` in an allowlist means empty `data` only (amendment 2). */
  plainTransferSelector: "0x00000000",
} as const;
