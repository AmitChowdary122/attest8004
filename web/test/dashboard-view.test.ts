import { DEPLOYMENTS, type IndexedVerdict, type ValidatorStats } from "@attest8004/sdk/browser";
import { getAddress, keccak256, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { agentLabel, mandateInForce, offlineView, utcTime, validatorLabel, validatorRow, verdictRow } from "../src/dashboard/view.ts";

// /dashboard's view model (plan Task 8): every indexed value becomes a plain string, every link comes from the
// explorer builders, and our own validators and demo agents are labelled as ours, so our e2e traffic is never shown
// as anyone else's.

const testnet = DEPLOYMENTS[10143];
const A = getAddress(testnet.validators.mandateV1);
const B = getAddress(testnet.validators.riskV1);
const STRANGER = getAddress("0x00000000000000000000000000000000000057a1");
const hash = (label: string): Hex => keccak256(toHex(label));

function verdict(over: Partial<IndexedVerdict> = {}): IndexedVerdict {
  return {
    requestHash: hash("request"),
    agentId: 1984n,
    validator: A,
    requestBlock: 68_300_000n,
    requestTime: 1_791_173_000n,
    requestTx: hash("request tx"),
    requestStatus: "VERIFIED",
    gate: getAddress(testnet.demoAgentVault),
    target: getAddress("0x00000000000000000000000000000000000000d4"),
    value: 3_000_000_000_000_000n,
    deadline: 1_791_174_845n,
    actionHash: hash("action"),
    responses: 1,
    score: 0,
    tag: "mandate-v1",
    responseHash: hash("evidence"),
    reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"],
    evidenceStatus: "VERIFIED",
    responseBlock: 68_300_025n,
    responseTime: 1_791_173_115n,
    responseTx: hash("response tx"),
    firstResponseBlock: 68_300_025n,
    executedTx: null,
    executedBlock: null,
    ...over,
  };
}

describe("the SDK under test", () => {
  it("is the source, not a stale build", () => {
    expect(testnet.trustApi).toBeNull();
    expect(testnet.findingsBoard).not.toBeNull();
  });
});

describe("labels", () => {
  it("name our validators and agents as ours, anyone else by address or number", () => {
    expect(validatorLabel(A, testnet)).toBe("ours (A · mandate-v1)");
    expect(validatorLabel(B, testnet)).toBe("ours (B · risk-v1)");
    expect(validatorLabel(STRANGER, testnet)).toBe(STRANGER);
    expect(agentLabel(1984n, testnet)).toBe("1984 (demo agent, ours)");
    expect(agentLabel(1985n, testnet)).toBe("1985 (demo agent, ours)");
    expect(agentLabel(1982n, testnet)).toBe("1982 (test agent, ours)");
    expect(agentLabel(7n, testnet)).toBe("7");
  });

  it("show block times in UTC", () => {
    expect(utcTime(1_791_173_115n)).toBe("2026-10-05 04:05:15 UTC");
    expect(utcTime(null)).toBe("—");
  });
});

describe("verdictRow", () => {
  it("turns an answered verdict into plain strings with its verify line and explorer link", () => {
    const row = verdictRow(verdict(), testnet);
    expect(row).toMatchObject({
      time: "2026-10-05 04:05:15 UTC",
      agent: "1984 (demo agent, ours)",
      validator: "ours (A · mandate-v1)",
      tag: "mandate-v1",
      score: "0",
      reasons: "TARGET_NOT_ALLOWED, VALUE_OVER_TX_CAP",
      evidence: "inline evidence, hash matches",
      executed: "not executed",
      verifyLine: `pnpm attest8004 verify ${hash("request")}`,
      txUrl: `https://monad-testnet.socialscan.io/tx/${hash("response tx")}`,
      pending: false,
    });
  });

  it("marks a pending request and an executed action", () => {
    const pending = verdictRow(verdict({ responses: 0, score: null, tag: null, responseHash: null, reasons: null, evidenceStatus: null, responseBlock: null, responseTime: null, responseTx: null }), testnet);
    expect(pending).toMatchObject({ score: "pending", tag: "—", reasons: "", txUrl: null, pending: true, time: "2026-10-05 04:03:20 UTC" });
    expect(verdictRow(verdict({ score: 100, reasons: [], executedTx: hash("exec") }), testnet)).toMatchObject({ executed: "executed", reasons: "none" });
  });

  it("never links a malformed hash", () => {
    expect(verdictRow(verdict({ responseTx: "0x1234" as Hex }), testnet).txUrl).toBeNull();
  });

  it("says what it couldn't read", () => {
    expect(verdictRow(verdict({ evidenceStatus: "HASH_MISMATCH", reasons: null }), testnet).evidence).toBe("evidence doesn't match its hash");
    expect(verdictRow(verdict({ evidenceStatus: "NOT_INLINE", reasons: null }), testnet).evidence).toBe("evidence elsewhere (not read)");
    expect(verdictRow(verdict({ evidenceStatus: "UNREADABLE", reasons: null }), testnet).evidence).toBe("evidence unreadable");
  });
});

describe("validatorRow", () => {
  it("formats counts, buckets and averages", () => {
    const stats: ValidatorStats = {
      validator: A,
      requests: 21,
      answered: 20,
      responseEvents: 20,
      scoreSum: 1400n,
      avgScore: 70,
      buckets: { score0: 6, score1to39: 0, score40to79: 0, score80to99: 0, score100: 14 },
      latencyBlocksSum: 1831n,
      latencyCount: 20,
      avgLatencyBlocks: 91.56,
      tags: ["mandate-v1"],
      firstSeenBlock: 67_605_700n,
      lastActivityBlock: 68_300_025n,
    };
    expect(validatorRow(stats, testnet)).toEqual({
      validator: "ours (A · mandate-v1)",
      address: A,
      addressUrl: `https://monad-testnet.socialscan.io/address/${A.toLowerCase()}`,
      tags: "mandate-v1",
      requests: "21",
      answered: "20",
      avgScore: "70.0",
      buckets: ["6", "0", "0", "0", "14"],
      avgLatency: "91.6 blocks (~28 s)",
    });
    expect(validatorRow({ ...stats, avgScore: null, avgLatencyBlocks: null, answered: 0 }, testnet)).toMatchObject({ avgScore: "—", avgLatency: "—" });
  });
});

describe("mandateInForce", () => {
  const mandate = { active: true, validUntil: 1_800_000_000n, owner: getAddress("0x3efeb3cf2fb54a7d99abe90aab786ce5a831a8cf") };
  it("needs an active, unexpired mandate set by the current owner", () => {
    expect(mandateInForce(mandate, mandate.owner, 1_790_000_000n)).toBe("in force");
    expect(mandateInForce({ ...mandate, active: false }, mandate.owner, 1_790_000_000n)).toBe("revoked");
    expect(mandateInForce(mandate, mandate.owner, 1_800_000_001n)).toBe("expired");
    expect(mandateInForce(mandate, STRANGER, 1_790_000_000n)).toBe("stale: set by a previous owner");
  });
});

describe("offlineView", () => {
  it("names the reason and gives the onchain way to check", () => {
    const view = offlineView(testnet, "NETWORK");
    expect(view.reason).toBe("The Envio indexer can't be reached right now.");
    expect(offlineView(testnet, "NOT_CONFIGURED").reason).toBe("The Envio indexer isn't deployed yet.");
    expect(offlineView(testnet, "RATE_LIMITED").reason).toContain("rate-limited");
    expect(view.contracts.map((c) => c.label)).toEqual([
      "ValidationRegistry",
      "MandateRegistry (current)",
      "FindingsBoard",
      "AgentRequestForwarder",
      "DemoAgentVault",
      "Validator A (mandate-v1)",
      "Validator B (risk-v1)",
    ]);
    for (const c of view.contracts) expect(c.url, c.label).toBe(`https://monad-testnet.socialscan.io/address/${c.address.toLowerCase()}`);
    expect(view.contracts[1]?.address).toBe(getAddress(testnet.mandateRegistries[1]?.address ?? ""));
    expect(view.verifyLine).toBe("pnpm attest8004 verify <requestHash>");
    expect(view.inbox).toContain("/inbox still finds reports from the chain");
  });

  it("has a sentence for every kind", () => {
    for (const kind of ["NOT_CONFIGURED", "NETWORK", "HTTP", "RATE_LIMITED", "TIMEOUT", "GRAPHQL", "SHAPE"] as const) {
      expect(offlineView(testnet, kind).reason.length, kind).toBeGreaterThan(10);
    }
  });
});
