import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MANDATE_V1 } from "../src/params.ts";
import { evaluate, selectorOf, type MandateReason } from "../src/rules.ts";
import type { MandateInputs, PermissionEvent } from "../src/types.ts";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const OTHER_OWNER = "0x2222222222222222222222222222222222222222" as Address;
// Lower-case hex letters so a flipped-case copy actually exercises case-insensitivity.
const TARGET_LOWER = "0xabcdefabcdefabcdefabcdefabcdefabcdef1234" as Address;
const TARGET_UPPER = "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEF1234" as Address;
const OTHER_TARGET = "0x4444444444444444444444444444444444444444" as Address;
const GATE = "0x5555555555555555555555555555555555555555" as Address;
const REQUEST_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;
const MANDATE_HASH = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Hex;
const SALT = "0xccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as Hex;

const PINNED_TS = 1_700_000_000n;
const PINNED_BLOCK = 1_000_000n;

/** A fully-passing fixture, sitting exactly on every boundary that passes rather than fails. */
function baseInputs(): MandateInputs {
  return {
    pinned: { number: PINNED_BLOCK, hash: REQUEST_HASH, timestamp: PINNED_TS },
    owner: OWNER,
    request: {
      block: PINNED_BLOCK,
      requestHash: REQUEST_HASH,
      chainId: 10_143,
      gate: GATE,
      agentId: 1_984n,
      target: TARGET_LOWER,
      value: 1_000n,
      data: "0x",
      deadline: PINNED_TS, // boundary: deadline == P.ts passes
      salt: SALT,
    },
    mandate: {
      allowedTargets: [TARGET_LOWER],
      allowedSelectors: [MANDATE_V1.plainTransferSelector],
      maxValuePerTx: 1_000n, // boundary: value == maxValuePerTx passes
      maxValuePerDay: 2_000n,
      validUntil: PINNED_TS + 1_000n,
      mandateHash: MANDATE_HASH,
      owner: OWNER,
      setAtBlock: PINNED_BLOCK - 1_000n,
    },
    spend: { since: PINNED_TS - MANDATE_V1.spendWindowSeconds, entries: [], total: 1_000n }, // total + value == maxValuePerDay passes
    permissions: { fromBlock: PINNED_BLOCK - MANDATE_V1.permissionWindowBlocks, toBlock: PINNED_BLOCK, events: [] },
    simulation: { ok: true },
  };
}

function afterMandateEvent(): PermissionEvent {
  return {
    block: PINNED_BLOCK - 10n,
    logIndex: 0,
    txHash: REQUEST_HASH,
    emitter: "IdentityRegistry",
    event: "Transfer",
    afterMandate: true,
  };
}

describe("evaluate: base fixture", () => {
  it("passes with score 100 and no reasons", () => {
    expect(evaluate(baseInputs())).toEqual({ score: 100, reasons: [] });
  });
});

describe("evaluate: MANDATE_MISSING", () => {
  it("passes when a mandate is present", () => {
    expect(evaluate(baseInputs())).toEqual({ score: 100, reasons: [] });
  });

  it("fails alone when there is no mandate and nothing mandate-independent is wrong", () => {
    const inputs = baseInputs();
    inputs.mandate = null;
    inputs.spend = null; // spend is null exactly when there's no mandate
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["MANDATE_MISSING"] });
  });

  it("skips every mandate-field rule but still runs ACTION_EXPIRED, PERMISSION_CHANGED_AFTER_MANDATE and SIMULATION_FAILED", () => {
    const inputs = baseInputs();
    inputs.mandate = null;
    inputs.spend = null;
    inputs.request.deadline = PINNED_TS - 1n; // would be ACTION_EXPIRED
    inputs.permissions.events = [afterMandateEvent()];
    inputs.simulation = { ok: false, error: "REVERTED", revertSelector: null };
    expect(evaluate(inputs)).toEqual({
      score: 0,
      reasons: ["MANDATE_MISSING", "ACTION_EXPIRED", "PERMISSION_CHANGED_AFTER_MANDATE", "SIMULATION_FAILED"],
    });
  });
});

describe("evaluate: MANDATE_OWNER_CHANGED", () => {
  it("passes when the mandate's owner still owns the agent", () => {
    expect(evaluate(baseInputs())).toEqual({ score: 100, reasons: [] });
  });

  it("fails when the agent was transferred after the mandate was set", () => {
    const inputs = baseInputs();
    inputs.owner = OTHER_OWNER;
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["MANDATE_OWNER_CHANGED"] });
  });
});

describe("evaluate: MANDATE_EXPIRED", () => {
  it("passes on the boundary: validUntil == P.ts", () => {
    const inputs = baseInputs();
    inputs.mandate!.validUntil = PINNED_TS;
    inputs.request.deadline = PINNED_TS; // keep deadline <= validUntil
    expect(evaluate(inputs)).toEqual({ score: 100, reasons: [] });
  });

  it("fails one second past validUntil", () => {
    const inputs = baseInputs();
    inputs.mandate!.validUntil = PINNED_TS - 1n;
    inputs.request.deadline = PINNED_TS - 1n; // avoid also tripping DEADLINE_AFTER_MANDATE
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["MANDATE_EXPIRED", "ACTION_EXPIRED"] });
  });
});

describe("evaluate: ACTION_EXPIRED", () => {
  it("passes on the boundary: deadline == P.ts", () => {
    expect(evaluate(baseInputs())).toEqual({ score: 100, reasons: [] });
  });

  it("fails one second past P.ts", () => {
    const inputs = baseInputs();
    inputs.request.deadline = PINNED_TS - 1n;
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["ACTION_EXPIRED"] });
  });
});

describe("evaluate: DEADLINE_AFTER_MANDATE", () => {
  it("passes on the boundary: deadline == validUntil", () => {
    const inputs = baseInputs();
    inputs.mandate!.validUntil = PINNED_TS; // deadline (PINNED_TS) == validUntil
    expect(evaluate(inputs)).toEqual({ score: 100, reasons: [] });
  });

  it("fails when the action's deadline reaches past the mandate's validUntil", () => {
    const inputs = baseInputs();
    inputs.mandate!.validUntil = PINNED_TS; // deadline (PINNED_TS) would now be > validUntil - 1
    inputs.request.deadline = PINNED_TS + 1n;
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["DEADLINE_AFTER_MANDATE"] });
  });
});

describe("evaluate: TARGET_NOT_ALLOWED", () => {
  it("passes when the target is allowlisted", () => {
    expect(evaluate(baseInputs())).toEqual({ score: 100, reasons: [] });
  });

  it("matches a mixed-case allowlist entry against a differently-cased target", () => {
    const inputs = baseInputs();
    inputs.mandate!.allowedTargets = [TARGET_UPPER];
    inputs.request.target = TARGET_LOWER;
    expect(evaluate(inputs)).toEqual({ score: 100, reasons: [] });
  });

  it("fails when the target is not in the allowlist", () => {
    const inputs = baseInputs();
    inputs.request.target = OTHER_TARGET;
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["TARGET_NOT_ALLOWED"] });
  });

  it("fails every target when the allowlist is empty", () => {
    const inputs = baseInputs();
    inputs.mandate!.allowedTargets = [];
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["TARGET_NOT_ALLOWED"] });
  });
});

describe("evaluate: SELECTOR_NOT_ALLOWED", () => {
  it('passes: "0x" (empty data) with the plain-transfer selector allowlisted', () => {
    expect(evaluate(baseInputs())).toEqual({ score: 100, reasons: [] });
  });

  it('fails: "0x" without the plain-transfer selector allowlisted', () => {
    const inputs = baseInputs();
    inputs.mandate!.allowedSelectors = ["0xa9059cbb" as Hex];
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["SELECTOR_NOT_ALLOWED"] });
  });

  it('fails: "0xa9" (1 byte, too short for a selector), even when its "selector" is allowlisted', () => {
    const inputs = baseInputs();
    inputs.request.data = "0xa9" as Hex;
    inputs.mandate!.allowedSelectors = [MANDATE_V1.plainTransferSelector, "0xa9" as Hex];
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["SELECTOR_NOT_ALLOWED"] });
  });

  it("matches a mixed-case allowlist entry against a differently-cased selector", () => {
    const inputs = baseInputs();
    inputs.request.data = "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001" as Hex;
    inputs.mandate!.allowedSelectors = ["0xA9059CBB" as Hex];
    expect(evaluate(inputs)).toEqual({ score: 100, reasons: [] });
  });

  it("fails when the selector is simply not allowlisted", () => {
    const inputs = baseInputs();
    inputs.request.data = "0xdeadbeef" as Hex;
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["SELECTOR_NOT_ALLOWED"] });
  });

  it("test_SelectorZero_NonEmptyData_FailsEvenWhenAllowlisted", () => {
    const inputs = baseInputs();
    inputs.mandate!.allowedSelectors = [MANDATE_V1.plainTransferSelector];

    const bareSelectorZero = { ...inputs, request: { ...inputs.request, data: "0x00000000" as Hex } };
    expect(evaluate(bareSelectorZero)).toEqual({ score: 0, reasons: ["SELECTOR_NOT_ALLOWED"] });

    const selectorZeroWithArgs = {
      ...inputs,
      request: {
        ...inputs.request,
        data: ("0x00000000" + "00".repeat(32)) as Hex,
      },
    };
    expect(evaluate(selectorZeroWithArgs)).toEqual({ score: 0, reasons: ["SELECTOR_NOT_ALLOWED"] });

    // The same mandate still passes a genuine plain transfer (empty data).
    const emptyData = { ...inputs, request: { ...inputs.request, data: "0x" as Hex } };
    expect(evaluate(emptyData)).toEqual({ score: 100, reasons: [] });
  });
});

describe("evaluate: VALUE_OVER_TX_CAP", () => {
  it("passes on the boundary: value == maxValuePerTx", () => {
    expect(evaluate(baseInputs())).toEqual({ score: 100, reasons: [] });
  });

  it("fails one unit over maxValuePerTx", () => {
    const inputs = baseInputs();
    const spend = inputs.spend;
    if (!spend || !("entries" in spend)) throw new Error("unreachable: base fixture's spend has entries");
    inputs.request.value = inputs.mandate!.maxValuePerTx + 1n;
    // Keep the daily cap from also tripping, to isolate this reason.
    inputs.mandate!.maxValuePerDay = spend.total + inputs.request.value;
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["VALUE_OVER_TX_CAP"] });
  });
});

describe("evaluate: DAILY_CAP_EXCEEDED", () => {
  it("passes on the boundary: total + value == maxValuePerDay", () => {
    expect(evaluate(baseInputs())).toEqual({ score: 100, reasons: [] });
  });

  it("fails one unit over maxValuePerDay", () => {
    const inputs = baseInputs();
    const spend = inputs.spend;
    if (!spend || !("entries" in spend)) throw new Error("unreachable: base fixture's spend has entries");
    inputs.spend = { ...spend, total: spend.total + 1n };
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["DAILY_CAP_EXCEEDED"] });
  });
});

describe("evaluate: SPEND_HISTORY_UNREADABLE", () => {
  it("passes when spend history is a readable total under the cap", () => {
    expect(evaluate(baseInputs())).toEqual({ score: 100, reasons: [] });
  });

  it("fails when the spend evidence failed its checks, regardless of the (absent) total", () => {
    const inputs = baseInputs();
    inputs.spend = { unreadable: "keccak256(evidence) != responseHash for 0xaaaa..." };
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["SPEND_HISTORY_UNREADABLE"] });
  });
});

describe("evaluate: PERMISSION_CHANGED_AFTER_MANDATE", () => {
  it("passes when no permission event happened after the mandate was set", () => {
    expect(evaluate(baseInputs())).toEqual({ score: 100, reasons: [] });
  });

  it("fails when any event in the window happened after the mandate was set", () => {
    const inputs = baseInputs();
    inputs.permissions.events = [afterMandateEvent()];
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["PERMISSION_CHANGED_AFTER_MANDATE"] });
  });

  it("passes when events in the window all predate the mandate", () => {
    const inputs = baseInputs();
    inputs.permissions.events = [{ ...afterMandateEvent(), afterMandate: false }];
    expect(evaluate(inputs)).toEqual({ score: 100, reasons: [] });
  });
});

describe("evaluate: SIMULATION_FAILED", () => {
  it("passes when the simulation succeeds", () => {
    expect(evaluate(baseInputs())).toEqual({ score: 100, reasons: [] });
  });

  it("fails when the simulation reverts", () => {
    const inputs = baseInputs();
    inputs.simulation = { ok: false, error: "REVERTED", revertSelector: "0x08c379a0" as Hex };
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: ["SIMULATION_FAILED"] });
  });

  it("fails on insufficient funds and out-of-gas too", () => {
    const insufficientFunds = baseInputs();
    insufficientFunds.simulation = { ok: false, error: "INSUFFICIENT_FUNDS", revertSelector: null };
    expect(evaluate(insufficientFunds)).toEqual({ score: 0, reasons: ["SIMULATION_FAILED"] });

    const outOfGas = baseInputs();
    outOfGas.simulation = { ok: false, error: "OUT_OF_GAS", revertSelector: null };
    expect(evaluate(outOfGas)).toEqual({ score: 0, reasons: ["SIMULATION_FAILED"] });
  });
});

describe("evaluate: score", () => {
  it("is 100 iff there are no reasons, 0 otherwise", () => {
    expect(evaluate(baseInputs()).score).toBe(100);
    const broken = baseInputs();
    broken.simulation = { ok: false, error: "REVERTED", revertSelector: null };
    expect(evaluate(broken).score).toBe(0);
  });
});

describe("evaluate: everything that can go wrong at once, in the exact reason order", () => {
  it("returns every applicable reason in MandateReason's declared order", () => {
    const inputs = baseInputs();
    // MANDATE_OWNER_CHANGED
    inputs.owner = OTHER_OWNER;
    // MANDATE_EXPIRED: validUntil < P.ts
    inputs.mandate!.validUntil = 1_650_000_000n;
    // ACTION_EXPIRED (deadline < P.ts) and DEADLINE_AFTER_MANDATE (deadline > validUntil) together:
    // validUntil (1,650,000,000) < deadline (1,660,000,000) < P.ts (1,700,000,000)
    inputs.request.deadline = 1_660_000_000n;
    // TARGET_NOT_ALLOWED
    inputs.request.target = OTHER_TARGET;
    // SELECTOR_NOT_ALLOWED
    inputs.request.data = "0xdeadbeef" as Hex;
    // VALUE_OVER_TX_CAP
    inputs.request.value = inputs.mandate!.maxValuePerTx + 1n;
    // DAILY_CAP_EXCEEDED (not SPEND_HISTORY_UNREADABLE: the two can't both apply to one spend shape)
    inputs.mandate!.maxValuePerDay = inputs.request.value; // total (1,000) + value > maxValuePerDay
    // PERMISSION_CHANGED_AFTER_MANDATE
    inputs.permissions.events = [afterMandateEvent()];
    // SIMULATION_FAILED
    inputs.simulation = { ok: false, error: "REVERTED", revertSelector: null };

    const expectedOrder: MandateReason[] = [
      "MANDATE_OWNER_CHANGED",
      "MANDATE_EXPIRED",
      "ACTION_EXPIRED",
      "DEADLINE_AFTER_MANDATE",
      "TARGET_NOT_ALLOWED",
      "SELECTOR_NOT_ALLOWED",
      "VALUE_OVER_TX_CAP",
      "DAILY_CAP_EXCEEDED",
      "PERMISSION_CHANGED_AFTER_MANDATE",
      "SIMULATION_FAILED",
    ];
    expect(evaluate(inputs)).toEqual({ score: 0, reasons: expectedOrder });
  });
});

describe("selectorOf", () => {
  it('returns the plain-transfer selector for "0x" (empty data)', () => {
    expect(selectorOf("0x" as Hex)).toBe("0x00000000");
  });

  it("returns null for 1-3 bytes of data", () => {
    expect(selectorOf("0xa9" as Hex)).toBeNull();
    expect(selectorOf("0xa905" as Hex)).toBeNull();
    expect(selectorOf("0xa90512" as Hex)).toBeNull();
  });

  it("returns null for non-empty data whose first 4 bytes are 0x00000000, with or without trailing args", () => {
    expect(selectorOf("0x00000000" as Hex)).toBeNull();
    expect(selectorOf(("0x00000000" + "00".repeat(32)) as Hex)).toBeNull();
    // Even when the trailing bytes are non-zero, only the first 4 bytes decide this.
    expect(selectorOf(("0x00000000" + "ff".repeat(32)) as Hex)).toBeNull();
  });

  it("returns the first 4 bytes, lower-cased, for any other selector", () => {
    expect(selectorOf("0xa9059cbb" as Hex)).toBe("0xa9059cbb");
    expect(selectorOf("0xA9059CBB" as Hex)).toBe("0xa9059cbb");
    expect(selectorOf(("0xa9059cbb" + "00".repeat(32)) as Hex)).toBe("0xa9059cbb");
  });
});
