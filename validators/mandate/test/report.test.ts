import { buildEvidence, computeRequestHashFromParts, DEPLOYMENTS, encodeReport, MAX_REPORT_PLAINTEXT_BYTES, operatorReportSchema } from "@attest8004/sdk";
import { getAddress, keccak256, parseEther, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { mandateEvidence } from "../src/evidence.ts";
import { MANDATE_V1 } from "../src/params.ts";
import type { MandateAddresses } from "../src/reader.ts";
import { MANDATE_REASON_TEXT, mandateReport } from "../src/report.ts";
import { MANDATE_REASONS, type MandateReason } from "../src/rules.ts";
import type { MandateInputs, PinnedBlock } from "../src/types.ts";

const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const GATE = getAddress("0x12fab3e3ca810cc44bd9f537613a230a2be8d614");
const OWNER = getAddress("0x3efeb3cf2fb54a7d99abe90aab786ce5a831a8cf");
const STRANGER = getAddress("0x00000000000000000000000000000000000000b2");
const P: PinnedBlock = { number: 70_000_000n, hash: keccak256(toHex("block P")), timestamp: 1_790_000_000n };
const RESPONSE_HASH = keccak256(toHex("evidence"));
const deployment = DEPLOYMENTS[10143];
const ADDRESSES: MandateAddresses = {
  validationRegistry: deployment.validationRegistry,
  identityRegistry: deployment.identityRegistry,
  forwarder: deployment.agentRequestForwarder,
  mandateRegistry: deployment.mandateRegistries[1].address,
};

function inputs(o: { target?: Hex; value?: bigint; total?: bigint; mandate?: boolean; events?: MandateInputs["permissions"]["events"] } = {}): MandateInputs {
  const target = getAddress(o.target ?? OWNER);
  const value = o.value ?? parseEther("0.001");
  const deadline = P.timestamp + 600n;
  const salt = keccak256(toHex("salt"));
  const parts = { chainId: 10143, gate: GATE, agentId: 1984n, target, value, dataHash: keccak256("0x"), deadline, salt };
  return {
    pinned: P,
    owner: OWNER,
    request: { block: P.number - 3n, requestHash: computeRequestHashFromParts({ ...parts, validator: VALIDATOR }), ...parts, data: "0x" },
    mandate:
      o.mandate === false
        ? null
        : {
            allowedTargets: [OWNER],
            allowedSelectors: [MANDATE_V1.plainTransferSelector],
            maxValuePerTx: parseEther("0.002"),
            maxValuePerDay: parseEther("0.005"),
            validUntil: 1_793_404_800n,
            mandateHash: keccak256(toHex("mandate")),
            owner: OWNER,
            setAtBlock: P.number - 10_000n,
          },
    spend:
      o.mandate === false
        ? null
        : {
            since: P.timestamp - MANDATE_V1.spendWindowSeconds,
            total: o.total ?? parseEther("0.002"),
            entries: [
              { requestHash: keccak256(toHex("a1")), approvedAt: P.timestamp - 100n, gate: GATE, value: parseEther("0.001"), deadline: P.timestamp + 500n, consumed: true, counted: true },
              { requestHash: keccak256(toHex("a2")), approvedAt: P.timestamp - 90n, gate: GATE, value: parseEther("0.001"), deadline: P.timestamp + 510n, consumed: false, counted: true },
              { requestHash: keccak256(toHex("a3")), approvedAt: P.timestamp - 80_000n, gate: GATE, value: parseEther("0.001"), deadline: P.timestamp - 70_000n, consumed: false, counted: false },
            ],
          },
    permissions: { fromBlock: P.number - MANDATE_V1.permissionWindowBlocks + 1n, toBlock: P.number, events: o.events ?? [] },
    simulation: { ok: true },
  };
}

/** The evidence document the base publishes (bigints and all), as `onResponded` receives it. */
function evidenceOf(i: MandateInputs, score: number, reasons: MandateReason[]): Record<string, unknown> {
  return buildEvidence({ tag: MANDATE_V1.tag, requestHash: i.request.requestHash, result: { score, reasons, evidence: mandateEvidence(i, ADDRESSES) } });
}

describe("mandateReport", () => {
  it("an approval (score 100): Approved summary, no items, the spend note with the counted total", () => {
    const i = inputs();
    const report = mandateReport({ evidence: evidenceOf(i, 100, []), responseHash: RESPONSE_HASH });
    expect(report).toMatchObject({
      schema: "attest8004.report.v1",
      tag: "mandate-v1",
      requestHash: i.request.requestHash,
      agentId: "1984",
      score: 100,
      responseHash: RESPONSE_HASH,
      summary: "Approved: agent 1984's action is inside its mandate (score 100).",
      items: [],
    });
    expect(report.notes).toEqual([
      "Daily spend: 0.002 MON already counted against the 0.005 MON cap (2 approval(s) in the last 25 h); this action asks for 0.001 MON.",
    ]);
  });

  it("O's refusal: items TARGET_NOT_ALLOWED, VALUE_OVER_TX_CAP, DAILY_CAP_EXCEEDED in reason order, each text naming the MON amounts", () => {
    const i = inputs({ target: STRANGER, value: parseEther("0.003"), total: parseEther("0.003") });
    const report = mandateReport({ evidence: evidenceOf(i, 0, ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP", "DAILY_CAP_EXCEEDED"]), responseHash: RESPONSE_HASH });
    expect(report.summary).toBe("Refused: 3 mandate rule(s) failed (score 0).");
    expect(report.items.map((it) => it.code)).toEqual(["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP", "DAILY_CAP_EXCEEDED"]);
    expect(report.items[0]).toEqual({
      code: "TARGET_NOT_ALLOWED",
      severity: null,
      text: `The action sends to ${STRANGER}, which the mandate doesn't allow.`,
      action: "Don't execute it. If the target is legitimate, approve a mandate that lists it on /approve.",
    });
    expect(report.items[1]?.text).toBe("The action moves 0.003 MON; the mandate allows at most 0.002 MON per transaction.");
    expect(report.items[2]?.text).toBe("With this action the agent would spend 0.006 MON in 24 h; the mandate's daily cap is 0.005 MON.");
    expect(report.notes[0]).toContain("this action asks for 0.003 MON");
  });

  it("every MANDATE_REASONS entry has a text and an action", () => {
    for (const reason of MANDATE_REASONS) {
      const entry = MANDATE_REASON_TEXT[reason];
      expect(entry, reason).toBeDefined();
      expect(entry.action.length, reason).toBeGreaterThan(10);
    }
    // And each builds a schema-valid item from real evidence.
    const report = mandateReport({ evidence: evidenceOf(inputs(), 0, [...MANDATE_REASONS]), responseHash: RESPONSE_HASH });
    expect(report.items.map((it) => it.code)).toEqual([...MANDATE_REASONS]);
    for (const item of report.items) expect(item.text.length, item.code).toBeGreaterThan(10);
  });

  it("PERMISSION_CHANGED_AFTER_MANDATE lists only events after the mandate", () => {
    const events: MandateInputs["permissions"]["events"] = [
      { block: P.number - 9_999n, logIndex: 0, txHash: keccak256(toHex("e0")), emitter: "MandateRegistry", event: "MandateSet", afterMandate: false },
      { block: P.number - 20n, logIndex: 3, txHash: keccak256(toHex("e1")), emitter: "IdentityRegistry", event: "Approval", afterMandate: true },
      { block: P.number - 10n, logIndex: 1, txHash: keccak256(toHex("e2")), emitter: "AgentRequestForwarder", event: "AgentKeySet", afterMandate: true },
    ];
    const report = mandateReport({ evidence: evidenceOf(inputs({ events }), 0, ["PERMISSION_CHANGED_AFTER_MANDATE"]), responseHash: RESPONSE_HASH });
    expect(report.items[0]?.text).toBe(
      `2 permission change(s) after the current mandate was set: Approval at block ${P.number - 20n}; AgentKeySet at block ${P.number - 10n}.`,
    );
    expect(report.items[0]?.action).toBe(
      "If you didn't make this change, revoke the mandate now (owner only, no passkey) and investigate; if you did, approve the mandate again to accept it.",
    );
  });

  it("no mandate → the no-mandate spend note", () => {
    const report = mandateReport({ evidence: evidenceOf(inputs({ mandate: false }), 0, ["MANDATE_MISSING"]), responseHash: RESPONSE_HASH });
    expect(report.notes).toEqual(["Daily spend: no mandate, so nothing is capped."]);
    expect(report.items[0]?.text).toBe("Agent 1984 has no mandate (never set, or revoked).");
  });

  it("the report passes operatorReportSchema and encodes under 8,131 bytes at 12 reasons", () => {
    const events = Array.from({ length: 40 }, (_, k) => ({
      block: P.number - BigInt(100 + k),
      logIndex: k,
      txHash: keccak256(toHex(`e${k}`)),
      emitter: "IdentityRegistry" as const,
      event: "ApprovalForAll" as const,
      afterMandate: true,
    }));
    const report = mandateReport({ evidence: evidenceOf(inputs({ target: STRANGER, events }), 0, [...MANDATE_REASONS]), responseHash: RESPONSE_HASH });
    expect(operatorReportSchema.safeParse(report).success).toBe(true);
    expect(encodeReport(report).length).toBeLessThanOrEqual(MAX_REPORT_PLAINTEXT_BYTES);
  });
});
