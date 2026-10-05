import type { WorkflowConfig } from "./config.ts";
import type { Decline } from "./request.ts";

/**
 * The write's gas limit (Monad charges the limit, not the gas used): the inner estimate (`estimateGas` of
 * CreValidator.onReport as the forwarder calls it), plus the forwarder's own cost, fitted from live `eth_estimateGas`
 * probes as `outerBase + outerPerByte × raw report bytes` (scripts/src/cre-gas-probe.ts), times (1 + headroom),
 * rounded up. Above `max` it is a decline, never a write.
 */
export function gasLimitFor(o: { innerGas: bigint; rawReportBytes: number; gas: WorkflowConfig["gas"] }): { limit: bigint } | Decline {
  const { innerGas, rawReportBytes, gas } = o;
  const base = innerGas + BigInt(gas.outerBase) + BigInt(gas.outerPerByte) * BigInt(rawReportBytes);
  const limit = (base * BigInt(100 + gas.headroomPercent) + 99n) / 100n;
  if (limit > BigInt(gas.max)) return { decline: "GAS_OVER_CAP", detail: `the write needs a ${limit} gas limit; the cap is ${gas.max}` };
  return { limit };
}
