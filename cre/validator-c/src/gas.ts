import type { WorkflowConfig } from "./config.ts";
import type { Decline } from "./request.ts";

/**
 * The write's gas limit (Monad charges the limit, not the gas used). Monad prices calldata with EIP-7623's floor, which
 * covers the whole transaction (total = max(floor, standard)), so the write needs the larger of:
 *
 * - **execution:** the inner estimate (`estimateGas` of CreValidator.onReport as the forwarder calls it, which already
 *   includes intrinsic gas and that calldata) plus `routing`, the forwarder's own work and its extra calldata;
 * - **the floor:** `outerBase + outerPerByte × raw report bytes`, fitted from live `eth_estimateGas` of the forwarder's
 *   report() with an onReport that fails fast (scripts/src/cre-gas-probe.ts).
 *
 * Times (1 + headroom), rounded up. Above `max` it is a decline, never a write.
 */
export function gasLimitFor(o: { innerGas: bigint; rawReportBytes: number; gas: WorkflowConfig["gas"] }): { limit: bigint } | Decline {
  const { innerGas, rawReportBytes, gas } = o;
  const execution = innerGas + BigInt(gas.routing);
  const floor = BigInt(gas.outerBase) + BigInt(gas.outerPerByte) * BigInt(rawReportBytes);
  const needed = execution > floor ? execution : floor;
  const limit = (needed * BigInt(100 + gas.headroomPercent) + 99n) / 100n;
  if (limit > BigInt(gas.max)) return { decline: "GAS_OVER_CAP", detail: `the write needs a ${limit} gas limit; the cap is ${gas.max}` };
  return { limit };
}
