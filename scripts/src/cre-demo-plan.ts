// Pure helpers for validator C's CRE tooling (P11): the outer-gas fit (cre-gas-probe.ts) and `pnpm cre:demo`'s plan.

/**
 * The forwarder's own gas (intrinsic, calldata, its routing) as `outerBase + outerPerByte × raw report bytes`, from
 * live `eth_estimateGas` samples of MockKeystoneForwarder.report at several sizes. The slope is the least-squares one
 * rounded up to a whole gas per byte; the base is then raised (to the next 1,000) until the line covers every sample.
 */
export function fitOuterGas(samples: ReadonlyArray<{ rawReportBytes: number; gas: bigint }>): { outerBase: number; outerPerByte: number } {
  if (new Set(samples.map((s) => s.rawReportBytes)).size < 2) throw new Error("fitOuterGas needs samples at two sizes at least");
  const n = samples.length;
  const xs = samples.map((s) => s.rawReportBytes);
  const ys = samples.map((s) => Number(s.gas));
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i++) {
    cov += ((xs[i] as number) - meanX) * ((ys[i] as number) - meanY);
    varX += ((xs[i] as number) - meanX) ** 2;
  }
  const outerPerByte = Math.max(0, Math.ceil(cov / varX - 1e-9));
  const needed = Math.max(...samples.map((s) => Number(s.gas) - outerPerByte * s.rawReportBytes));
  const outerBase = Math.max(0, Math.ceil(needed / 1_000) * 1_000);
  return { outerBase, outerPerByte };
}
