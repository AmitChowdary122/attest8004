import type { Address, Hex } from "viem";
import { MANDATE_V1 } from "./params.ts";
import type { MandateInputs } from "./types.ts";

/** Why `evaluate()` scored an action 0. Order matters: `evaluate()` always reports them in this order. */
export type MandateReason =
  | "MANDATE_MISSING"
  | "MANDATE_OWNER_CHANGED"
  | "MANDATE_EXPIRED"
  | "ACTION_EXPIRED"
  | "DEADLINE_AFTER_MANDATE"
  | "TARGET_NOT_ALLOWED"
  | "SELECTOR_NOT_ALLOWED"
  | "VALUE_OVER_TX_CAP"
  | "DAILY_CAP_EXCEEDED"
  | "SPEND_HISTORY_UNREADABLE"
  | "PERMISSION_CHANGED_AFTER_MANDATE"
  | "SIMULATION_FAILED";

const EVEN_HEX = /^0x([0-9a-fA-F]{2})*$/;

/**
 * The 4-byte selector of `data`, lower-case.
 *
 * - `"0x"` (empty data, a plain MON transfer) returns {@link MANDATE_V1.plainTransferSelector}
 *   (`"0x00000000"`).
 * - 1-3 bytes of data are too short to hold a selector: `null`.
 * - Non-empty data whose first 4 bytes are `0x00000000` also returns `null`, so `0x00000000` in an
 *   allowlist means an empty-data transfer only, never a call to selector zero or a bare fallback
 *   with arguments.
 * - Otherwise, the first 4 bytes, lower-cased.
 */
export function selectorOf(data: Hex): Hex | null {
  if (!EVEN_HEX.test(data)) {
    throw new TypeError(`selectorOf: data must be 0x-prefixed hex with whole bytes, got "${data}"`);
  }
  const byteLength = (data.length - 2) / 2;
  if (byteLength === 0) return MANDATE_V1.plainTransferSelector;
  if (byteLength < 4) return null;
  const selector = `0x${data.slice(2, 10).toLowerCase()}` as Hex;
  return selector === MANDATE_V1.plainTransferSelector ? null : selector;
}

/** Case-insensitive address membership, for the mandate's `allowedTargets`. */
function isTargetAllowed(allowedTargets: Address[], target: Address): boolean {
  const normalized = target.toLowerCase();
  return allowedTargets.some((allowed) => allowed.toLowerCase() === normalized);
}

/** Case-insensitive selector membership, for the mandate's `allowedSelectors`. `null` never matches. */
function isSelectorAllowed(allowedSelectors: Hex[], data: Hex): boolean {
  const selector = selectorOf(data);
  if (selector === null) return false;
  return allowedSelectors.some((allowed) => allowed.toLowerCase() === selector);
}

/**
 * The pure `mandate-v1` verdict (SPEC §4.5): every rule evaluated, reasons reported in
 * {@link MandateReason}'s declared order, score 100 iff there are no reasons.
 *
 * With no mandate, only the mandate-independent rules run — `ACTION_EXPIRED`,
 * `PERMISSION_CHANGED_AFTER_MANDATE`, `SIMULATION_FAILED` — alongside `MANDATE_MISSING`; every rule
 * that reads a mandate field (`MANDATE_OWNER_CHANGED`, `MANDATE_EXPIRED`, `DEADLINE_AFTER_MANDATE`,
 * `TARGET_NOT_ALLOWED`, `SELECTOR_NOT_ALLOWED`, `VALUE_OVER_TX_CAP`, `DAILY_CAP_EXCEEDED`,
 * `SPEND_HISTORY_UNREADABLE`) is skipped, since there is nothing to check it against.
 */
export function evaluate(inputs: MandateInputs): { score: 0 | 100; reasons: MandateReason[] } {
  const { pinned, owner, request, mandate, spend, permissions, simulation } = inputs;
  const reasons: MandateReason[] = [];

  if (mandate === null) {
    reasons.push("MANDATE_MISSING");
  } else {
    if (mandate.owner !== owner) reasons.push("MANDATE_OWNER_CHANGED");
    if (mandate.validUntil < pinned.timestamp) reasons.push("MANDATE_EXPIRED");
  }

  // Mandate-independent: still checked when there's no mandate.
  if (request.deadline < pinned.timestamp) reasons.push("ACTION_EXPIRED");

  if (mandate !== null) {
    if (request.deadline > mandate.validUntil) reasons.push("DEADLINE_AFTER_MANDATE");
    if (!isTargetAllowed(mandate.allowedTargets, request.target)) reasons.push("TARGET_NOT_ALLOWED");
    if (!isSelectorAllowed(mandate.allowedSelectors, request.data)) reasons.push("SELECTOR_NOT_ALLOWED");
    if (request.value > mandate.maxValuePerTx) reasons.push("VALUE_OVER_TX_CAP");
    if (spend !== null) {
      if ("unreadable" in spend) {
        reasons.push("SPEND_HISTORY_UNREADABLE");
      } else if (spend.total + request.value > mandate.maxValuePerDay) {
        reasons.push("DAILY_CAP_EXCEEDED");
      }
    }
  }

  // Mandate-independent: still checked when there's no mandate.
  if (permissions.events.some((event) => event.afterMandate)) reasons.push("PERMISSION_CHANGED_AFTER_MANDATE");
  if (!simulation.ok) reasons.push("SIMULATION_FAILED");

  return { score: reasons.length === 0 ? 100 : 0, reasons };
}
