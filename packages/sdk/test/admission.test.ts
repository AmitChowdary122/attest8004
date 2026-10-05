import { keccak256, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { Admission, type AdmissionOptions } from "../src/index.ts";

const hashOf = (label: string): Hex => keccak256(toHex(label));
const AGENT_A = 1984n;
const AGENT_B = 1985n;

// Generous enough that rate-limit tests never trip the gas budget, and vice versa.
const defaults: AdmissionOptions = {
  maxRequestsPerAgent: 20,
  agentWindowSeconds: 3_600n,
  dailyGasBudget: 1_000_000_000n,
  maxGasPerResponse: 400_000n,
};

describe("Admission: constructor validation", () => {
  it("rejects a non-positive maxRequestsPerAgent", () => {
    expect(() => new Admission({ ...defaults, maxRequestsPerAgent: 0 })).toThrow(RangeError);
    expect(() => new Admission({ ...defaults, maxRequestsPerAgent: -1 })).toThrow(RangeError);
    expect(() => new Admission({ ...defaults, maxRequestsPerAgent: 1.5 })).toThrow(RangeError);
  });

  it("rejects a negative agentWindowSeconds", () => {
    expect(() => new Admission({ ...defaults, agentWindowSeconds: -1n })).toThrow(RangeError);
  });

  it("rejects a negative dailyGasBudget", () => {
    expect(() => new Admission({ ...defaults, dailyGasBudget: -1n })).toThrow(RangeError);
  });

  it("rejects a negative maxGasPerResponse", () => {
    expect(() => new Admission({ ...defaults, maxGasPerResponse: -1n })).toThrow(RangeError);
  });

  it("rejects maxGasPerResponse above dailyGasBudget", () => {
    expect(() => new Admission({ ...defaults, dailyGasBudget: 100n, maxGasPerResponse: 101n })).toThrow(RangeError);
  });

  it("accepts maxGasPerResponse exactly equal to dailyGasBudget", () => {
    expect(() => new Admission({ ...defaults, dailyGasBudget: 400_000n, maxGasPerResponse: 400_000n })).not.toThrow();
  });
});

describe("Admission: per-agent rate limit", () => {
  it("admits up to the limit, rate-limits the next one with the exact detail string, and leaves other agents unaffected", () => {
    const admission = new Admission(defaults);
    const now = 1_700_000_000n;

    for (let i = 0; i < 20; i++) {
      const result = admission.admit({ requestHash: hashOf(`a-${i}`), agentId: AGENT_A, now });
      expect(result).toEqual({ ok: true });
    }

    const blocked = admission.admit({ requestHash: hashOf("a-20"), agentId: AGENT_A, now });
    expect(blocked).toEqual({
      ok: false,
      reason: "RATE_LIMITED",
      detail: "agent 1984 RATE_LIMITED (20/20 requests in the last 3600 s)",
    });

    // A different agent is not affected by agent A's count.
    const otherAgent = admission.admit({ requestHash: hashOf("b-0"), agentId: AGENT_B, now });
    expect(otherAgent).toEqual({ ok: true });
  });

  it("admits again once the window has fully elapsed", () => {
    const admission = new Admission(defaults);
    const now = 1_700_000_000n;

    for (let i = 0; i < 20; i++) {
      admission.admit({ requestHash: hashOf(`a-${i}`), agentId: AGENT_A, now });
    }
    expect(admission.admit({ requestHash: hashOf("a-20"), agentId: AGENT_A, now }).ok).toBe(false);

    const later = now + 3_600n;
    const result = admission.admit({ requestHash: hashOf("a-21"), agentId: AGENT_A, now: later });
    expect(result).toEqual({ ok: true });
  });

  it("does not count a retried (same-hash) admission against the rate limit", () => {
    const admission = new Admission({ ...defaults, maxRequestsPerAgent: 1 });
    const now = 1_700_000_000n;
    const requestHash = hashOf("retry-me");

    expect(admission.admit({ requestHash, agentId: AGENT_A, now })).toEqual({ ok: true });
    // Re-admitting the same hash must not consume the one slot of room left.
    expect(admission.admit({ requestHash, agentId: AGENT_A, now })).toEqual({ ok: true });
    expect(admission.admit({ requestHash, agentId: AGENT_A, now: now + 1n })).toEqual({ ok: true });

    // A genuinely new request now finds the agent's one slot already taken.
    const blocked = admission.admit({ requestHash: hashOf("new-request"), agentId: AGENT_A, now });
    expect(blocked.ok).toBe(false);
  });
});

describe("Admission: daily gas budget", () => {
  it("reserves maxGasPerResponse per admission, exhausts at the budget with the exact detail string, and recovers after settle", () => {
    const admission = new Admission({
      maxRequestsPerAgent: 20,
      agentWindowSeconds: 3_600n,
      dailyGasBudget: 1_000_000n,
      maxGasPerResponse: 400_000n,
    });
    const now = 1_700_000_000n;

    expect(admission.admit({ requestHash: hashOf("g-0"), agentId: AGENT_A, now })).toEqual({ ok: true });
    expect(admission.admit({ requestHash: hashOf("g-1"), agentId: AGENT_A, now })).toEqual({ ok: true });

    const thirdHash = hashOf("g-2");
    const exhausted = admission.admit({ requestHash: thirdHash, agentId: AGENT_A, now });
    expect(exhausted).toEqual({
      ok: false,
      reason: "GAS_BUDGET_EXHAUSTED",
      detail: "agent 1984 GAS_BUDGET_EXHAUSTED (800,000 + 400,000 > 1,000,000 gas in the last 24 h)",
    });

    // Settling the first two down to their actual (smaller) limits frees enough room.
    admission.settle({ requestHash: hashOf("g-0"), gasLimit: 150_000n, now });
    admission.settle({ requestHash: hashOf("g-1"), gasLimit: 150_000n, now });

    expect(admission.admit({ requestHash: thirdHash, agentId: AGENT_A, now })).toEqual({ ok: true });
  });

  it("matches the brief's own worked example of the detail string", () => {
    const admission = new Admission({
      maxRequestsPerAgent: 20,
      agentWindowSeconds: 3_600n,
      dailyGasBudget: 10_000_000n,
      maxGasPerResponse: 400_000n,
    });
    const now = 1_700_000_000n;

    // Drive the reserved sum up to exactly 9,800,000 (24 admissions * 400,000 + ... simplest:
    // reserve 24 requests at 400,000 then settle them down to total 9,800,000 isn't needed —
    // instead settle one admission's reservation up to make the running sum land on 9,800,000).
    admission.admit({ requestHash: hashOf("w-0"), agentId: AGENT_A, now });
    admission.settle({ requestHash: hashOf("w-0"), gasLimit: 9_800_000n, now });

    const blocked = admission.admit({ requestHash: hashOf("w-1"), agentId: AGENT_A, now });
    expect(blocked).toEqual({
      ok: false,
      reason: "GAS_BUDGET_EXHAUSTED",
      detail: "agent 1984 GAS_BUDGET_EXHAUSTED (9,800,000 + 400,000 > 10,000,000 gas in the last 24 h)",
    });
  });

  it("releases reservations older than 86,400 s from the budget", () => {
    const admission = new Admission({
      maxRequestsPerAgent: 20,
      agentWindowSeconds: 3_600n,
      dailyGasBudget: 1_000_000n,
      maxGasPerResponse: 400_000n,
    });
    const now = 1_700_000_000n;

    admission.admit({ requestHash: hashOf("old-0"), agentId: AGENT_A, now });
    admission.admit({ requestHash: hashOf("old-1"), agentId: AGENT_A, now });
    // A third would be exhausted right now.
    expect(admission.admit({ requestHash: hashOf("old-2"), agentId: AGENT_A, now }).ok).toBe(false);

    // Just past the 24 h window, both old reservations have aged out of the budget sum.
    const later = now + 86_400n + 1n;
    expect(admission.admit({ requestHash: hashOf("new-0"), agentId: AGENT_A, now: later })).toEqual({ ok: true });
    expect(admission.admit({ requestHash: hashOf("new-1"), agentId: AGENT_A, now: later })).toEqual({ ok: true });
  });

  it("does not count a retried (same-hash) admission against the budget", () => {
    const admission = new Admission({
      maxRequestsPerAgent: 20,
      agentWindowSeconds: 3_600n,
      dailyGasBudget: 400_000n,
      maxGasPerResponse: 400_000n,
    });
    const now = 1_700_000_000n;
    const requestHash = hashOf("only-one-fits");

    expect(admission.admit({ requestHash, agentId: AGENT_A, now })).toEqual({ ok: true });
    // Re-admitting must not reserve a second 400,000 against a 400,000 budget.
    expect(admission.admit({ requestHash, agentId: AGENT_A, now })).toEqual({ ok: true });
  });
});

describe("Admission: settle", () => {
  it("is a no-op for an unknown requestHash", () => {
    const admission = new Admission({
      maxRequestsPerAgent: 20,
      agentWindowSeconds: 3_600n,
      dailyGasBudget: 400_000n,
      maxGasPerResponse: 400_000n,
    });
    const now = 1_700_000_000n;

    expect(() => admission.settle({ requestHash: hashOf("never-admitted"), gasLimit: 1n, now })).not.toThrow();

    // The budget (one slot of 400,000 out of 400,000) is unaffected by the no-op settle above.
    expect(admission.admit({ requestHash: hashOf("fits"), agentId: AGENT_A, now })).toEqual({ ok: true });
    expect(admission.admit({ requestHash: hashOf("does-not-fit"), agentId: AGENT_A, now }).ok).toBe(false);
  });

  it("keeps the original admission time for both windows, rather than resetting it to settle's now", () => {
    // A budget tight enough that even a 1-gas leftover blocks the next admission, so this test
    // actually distinguishes "aged out" from "wrongly kept alive by settle's own now".
    const admission = new Admission({
      maxRequestsPerAgent: 20,
      agentWindowSeconds: 3_600n,
      dailyGasBudget: 400_000n,
      maxGasPerResponse: 400_000n,
    });
    const now = 1_700_000_000n;
    const requestHash = hashOf("settled-late");

    admission.admit({ requestHash, agentId: AGENT_A, now });
    // Settle well after admission (as the real validator does once a response lands), down to a
    // tiny leftover reservation.
    admission.settle({ requestHash, gasLimit: 1n, now: now + 10n });

    // Just past the *original* admission's 24 h window — but still well inside 24 h of the settle
    // call above. If settle had reset the entry's time, this leftover 1 gas would still count and
    // push the next admission's 400,001 over the 400,000 budget.
    const later = now + 86_400n + 1n;
    expect(admission.admit({ requestHash: hashOf("after-expiry"), agentId: AGENT_A, now: later })).toEqual({
      ok: true,
    });
  });
});

describe("Admission: release (final review A3)", () => {
  const tight: AdmissionOptions = { maxRequestsPerAgent: 2, agentWindowSeconds: 3_600n, dailyGasBudget: 800_000n, maxGasPerResponse: 400_000n };
  const now = 1_700_000_000n;

  it("drops the request's gas reservation: with the budget full, the next request is admitted", () => {
    const admission = new Admission({ ...tight, maxRequestsPerAgent: 20 });
    admission.admit({ requestHash: hashOf("r-0"), agentId: AGENT_A, now });
    admission.admit({ requestHash: hashOf("r-1"), agentId: AGENT_A, now });
    expect(admission.admit({ requestHash: hashOf("r-2"), agentId: AGENT_B, now })).toMatchObject({ ok: false, reason: "GAS_BUDGET_EXHAUSTED" });

    admission.release(hashOf("r-0"));
    expect(admission.admit({ requestHash: hashOf("r-2"), agentId: AGENT_B, now })).toEqual({ ok: true });
    // Only one reservation was dropped.
    expect(admission.admit({ requestHash: hashOf("r-3"), agentId: AGENT_B, now })).toMatchObject({ ok: false, reason: "GAS_BUDGET_EXHAUSTED" });
  });

  it("is a no-op for an unknown requestHash", () => {
    const admission = new Admission(tight);
    admission.admit({ requestHash: hashOf("k-0"), agentId: AGENT_A, now });
    admission.admit({ requestHash: hashOf("k-1"), agentId: AGENT_B, now });
    admission.release(hashOf("never-admitted"));
    expect(admission.admit({ requestHash: hashOf("k-2"), agentId: AGENT_B, now })).toMatchObject({ ok: false, reason: "GAS_BUDGET_EXHAUSTED" });
  });

  it("leaves the agent's rate-limit count alone: a released request still counts in its window, and ages out as before", () => {
    const admission = new Admission({ ...tight, dailyGasBudget: 10_000_000n });
    admission.admit({ requestHash: hashOf("c-0"), agentId: AGENT_A, now });
    admission.admit({ requestHash: hashOf("c-1"), agentId: AGENT_A, now: now + 10n });
    admission.release(hashOf("c-0"));
    expect(admission.admit({ requestHash: hashOf("c-2"), agentId: AGENT_A, now: now + 20n })).toMatchObject({ ok: false, reason: "RATE_LIMITED" });
    // c-0 leaves the window at now + 3,600; c-1 is still in it.
    expect(admission.admit({ requestHash: hashOf("c-2"), agentId: AGENT_A, now: now + 3_600n })).toEqual({ ok: true });
    expect(admission.admit({ requestHash: hashOf("c-3"), agentId: AGENT_A, now: now + 3_600n })).toMatchObject({ ok: false, reason: "RATE_LIMITED" });
  });

  it("leaves other entries' reservations and windows alone, and a released hash is still idempotent", () => {
    const admission = new Admission({ ...tight, maxRequestsPerAgent: 20, dailyGasBudget: 1_200_000n });
    admission.admit({ requestHash: hashOf("o-0"), agentId: AGENT_A, now });
    admission.admit({ requestHash: hashOf("o-1"), agentId: AGENT_B, now: now + 100n });
    admission.settle({ requestHash: hashOf("o-1"), gasLimit: 300_000n, now: now + 100n });
    admission.release(hashOf("o-0"));
    // o-1's settled 300,000 still counts: 300,000 + 400,000 + 400,000 fits 1,200,000, a third doesn't.
    expect(admission.admit({ requestHash: hashOf("o-2"), agentId: AGENT_B, now: now + 200n })).toEqual({ ok: true });
    expect(admission.admit({ requestHash: hashOf("o-3"), agentId: AGENT_B, now: now + 200n })).toEqual({ ok: true });
    expect(admission.admit({ requestHash: hashOf("o-4"), agentId: AGENT_B, now: now + 200n })).toMatchObject({ ok: false, reason: "GAS_BUDGET_EXHAUSTED" });
    // Re-admitting the released hash reserves nothing and counts nothing.
    expect(admission.admit({ requestHash: hashOf("o-0"), agentId: AGENT_A, now: now + 200n })).toEqual({ ok: true });
    expect(admission.admit({ requestHash: hashOf("o-4"), agentId: AGENT_B, now: now + 200n })).toMatchObject({ ok: false, reason: "GAS_BUDGET_EXHAUSTED" });
    // o-1 ages out of the budget 24 h after its own admission, as before.
    expect(admission.admit({ requestHash: hashOf("o-4"), agentId: AGENT_B, now: now + 100n + 86_400n })).toEqual({ ok: true });
  });
});

describe("Admission: report gas (P7)", () => {
  const withReports: AdmissionOptions = {
    maxRequestsPerAgent: 20,
    agentWindowSeconds: 3_600n,
    dailyGasBudget: 1_000_000n,
    maxGasPerResponse: 400_000n,
    maxGasPerReport: 100_000n,
  };
  const now = 1_700_000_000n;

  it("reserves response + report gas", () => {
    // 1,200,000 holds three response-only reservations (3 × 400,000) but only two with reports (2 × 500,000).
    const admission = new Admission({ ...withReports, dailyGasBudget: 1_200_000n });
    expect(admission.admit({ requestHash: hashOf("r-0"), agentId: AGENT_A, now })).toEqual({ ok: true });
    expect(admission.admit({ requestHash: hashOf("r-1"), agentId: AGENT_A, now })).toEqual({ ok: true });
    const third = admission.admit({ requestHash: hashOf("r-2"), agentId: AGENT_A, now });
    expect(third).toMatchObject({ ok: false, reason: "GAS_BUDGET_EXHAUSTED" });
    expect(third.ok === false && third.detail).toContain("1,000,000 + 500,000 > 1,200,000");
  });

  it("settle keeps the report reservation", () => {
    const admission = new Admission(withReports);
    admission.admit({ requestHash: hashOf("r-0"), agentId: AGENT_A, now });
    admission.settle({ requestHash: hashOf("r-0"), gasLimit: 0n, now });
    // 100,000 still reserved for r-0's report: 100,000 + 500,000 + 500,000 > 1,000,000.
    expect(admission.admit({ requestHash: hashOf("r-1"), agentId: AGENT_A, now })).toEqual({ ok: true });
    expect(admission.admit({ requestHash: hashOf("r-2"), agentId: AGENT_A, now })).toMatchObject({ ok: false, reason: "GAS_BUDGET_EXHAUSTED" });
  });

  it("settleReport replaces it; 0n when nothing was sent", () => {
    const admission = new Admission(withReports);
    admission.admit({ requestHash: hashOf("r-0"), agentId: AGENT_A, now });
    admission.settle({ requestHash: hashOf("r-0"), gasLimit: 0n, now });
    admission.settleReport({ requestHash: hashOf("r-0"), gasLimit: 0n, now });
    expect(admission.admit({ requestHash: hashOf("r-1"), agentId: AGENT_A, now })).toEqual({ ok: true });
    expect(admission.admit({ requestHash: hashOf("r-2"), agentId: AGENT_A, now })).toEqual({ ok: true });
    // An unknown hash is a no-op.
    expect(() => admission.settleReport({ requestHash: hashOf("never"), gasLimit: 1n, now })).not.toThrow();
  });

  it("release zeroes both", () => {
    const admission = new Admission(withReports);
    admission.admit({ requestHash: hashOf("r-0"), agentId: AGENT_A, now });
    admission.admit({ requestHash: hashOf("r-1"), agentId: AGENT_A, now });
    admission.release(hashOf("r-0"));
    expect(admission.admit({ requestHash: hashOf("r-2"), agentId: AGENT_A, now })).toEqual({ ok: true });
  });

  it("budget check uses the per-request sum", () => {
    const admission = new Admission({ ...withReports, dailyGasBudget: 499_999n, maxGasPerReport: 99_999n });
    expect(admission.admit({ requestHash: hashOf("r-0"), agentId: AGENT_A, now })).toEqual({ ok: true });
    expect(admission.admit({ requestHash: hashOf("r-1"), agentId: AGENT_A, now })).toMatchObject({ ok: false, reason: "GAS_BUDGET_EXHAUSTED" });
  });

  it("constructor refuses maxGasPerResponse + maxGasPerReport > budget, and a negative report cap", () => {
    expect(() => new Admission({ ...withReports, dailyGasBudget: 499_999n })).toThrow(RangeError);
    expect(() => new Admission({ ...withReports, dailyGasBudget: 500_000n })).not.toThrow();
    expect(() => new Admission({ ...withReports, maxGasPerReport: -1n })).toThrow(RangeError);
  });
});
