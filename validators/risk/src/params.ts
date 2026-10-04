/**
 * `risk-v1`'s own constants (P5 plan, "`RISK_V1`"). The tag is the evidence's `validator`. Recorded
 * or not, `verify` re-runs a verdict with these values, so a change to any of them is a new validator
 * tag, never a silent change in meaning for past verdicts: **the format freezes once the first live
 * verdict exists**, exactly as `mandate-v1`'s did.
 */
export const RISK_V1 = {
  tag: "risk-v1",
  promptVersion: "risk-v1/1",
  maxToolCalls: 8,
  invalidOutputRetries: 2,
  reasoningEffort: "low",
  temperature: 0.2,
  seed: 8004,
  toolTurnMaxCompletionTokens: 1_024,
  finalMaxCompletionTokens: 1_536,
  maxRequestTokens: 7_000,
  maxCheckTokens: 36_000,
  guardModel: "meta-llama/llama-prompt-guard-2-86m",
  guardThreshold: 0.5,
  guardChunkChars: 400,
  guardChunkOverlap: 40,
  toolOutputMaxBytes: 1_536,
  maxEvidenceBytes: 24_576,
  simulationGas: 1_000_000n,
  maxTraceCalls: 16,
  maxRevertReasonChars: 256,
  ageProbeBlocks: [1_000n, 10_000n, 100_000n, 1_000_000n, 2_000_000n],
  reputationMaxClients: 16,
  nansenWindowSeconds: 2_592_000n,
  nansenMaxLabels: 20,
  nansenMaxCounterparties: 10,
  maxFindings: 8,
  maxExplanationChars: 400,
  maxSourcesPerFinding: 4,
  calldataTextMinChars: 8,
  // 512, not 2,000 (Task 10 fix round 1): the initial messages must leave room for 3 tool answers.
  calldataTextMaxChars: 512,
  calldataHeadBytes: 132,
  maxDeadlineAheadSeconds: 3_600n,
  scores: { none: 100, low: 80, medium: 40, high: 0 },
} as const;
