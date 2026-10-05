import { describe, expect, test } from "bun:test";
import { keccak256, stringToBytes, type Hex } from "viem";
import { parseRequestUri } from "../../../packages/sdk/src/request.ts";
import { checkEvidence, parseEvaluateBody, type EvaluateBody } from "../src/evidence.ts";
import { decodeValidationRequest } from "../src/trigger.ts";
import aEvidence from "./fixtures/a-evidence.json";
import { REAL, realTriggerLog } from "./helpers.ts";

// Validator A's real evidence for the real request (fixtures/a-evidence.json): A pinned block 68,438,287, two blocks
// after the request's block. checkEvidence takes the pin and the request block separately, so it checks A's real
// document here exactly as it checks C's (whose pin is the request's own block).
const json = (() => {
  const parsed = parseRequestUri(decodeValidationRequest(realTriggerLog()).requestURI);
  if (!parsed.ok) throw new Error(parsed.detail);
  return parsed.json;
})();
const PIN = { number: 68_438_287n, hash: "0xfb7ba9b1683ad50d4f962d06db0806461af50cbe5fb56f7d8cd60461b4ee91eb" as Hex, timestamp: 1_791_214_459n };
const expectA = { requestHash: REAL.requestHash, requestBlock: REAL.block, json, pin: PIN, maxBytes: 16_384 };
const done = (over: Partial<Extract<EvaluateBody, { status: "done" }>> = {}): Extract<EvaluateBody, { status: "done" }> => ({
  status: "done",
  score: 100,
  reasons: [],
  evidence: aEvidence.evidence,
  evidenceHash: aEvidence.responseHash as Hex,
  ...over,
});
/** The same document with one field changed, re-hashed so only that field is wrong. */
function edited(edit: (doc: Record<string, any>) => void): Extract<EvaluateBody, { status: "done" }> {
  const doc = JSON.parse(aEvidence.evidence);
  edit(doc);
  const keys = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(keys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, keys((v as any)[k])])) : v;
  const text = JSON.stringify(keys(doc));
  return done({ evidence: text, evidenceHash: keccak256(stringToBytes(text)), score: doc.score, reasons: doc.reasons });
}

describe("checkEvidence: /evaluate's answer against the workflow's own facts", () => {
  test("accepts validator A's real evidence, and rebuilds the exact on-chain responseURI and responseHash", () => {
    const out = checkEvidence(done(), expectA);
    expect(out).toEqual({
      score: 100,
      responseURI: `data:application/json;base64,${btoa(aEvidence.evidence)}`,
      responseHash: "0xdbfc2fecabecba97f29501f7433a06e60aa1219990d938f05e8f8318467736c7",
    });
  });

  test("NOT_CANONICAL: the same JSON with whitespace", () => {
    const text = aEvidence.evidence.replace('{"block":', '{ "block":');
    expect(checkEvidence(done({ evidence: text, evidenceHash: keccak256(stringToBytes(text)) }), expectA)).toEqual({ problem: "NOT_CANONICAL" });
  });

  test("HASH_CLAIM_MISMATCH: the service's evidenceHash isn't the hash of its evidence", () => {
    expect(checkEvidence(done({ evidenceHash: `0x${"00".repeat(32)}` }), expectA)).toEqual({ problem: "HASH_CLAIM_MISMATCH" });
  });

  test("EVIDENCE_TOO_LARGE: above the configured cap", () => {
    expect(checkEvidence(done(), { ...expectA, maxBytes: 3_000 })).toEqual({ problem: "EVIDENCE_TOO_LARGE" });
  });

  test("BODY_MISMATCH: the wrapper's score, or the document's requestHash, disagrees", () => {
    expect(checkEvidence(done({ score: 0 }), expectA)).toEqual({ problem: "BODY_MISMATCH:score" });
    expect(checkEvidence(done(), { ...expectA, requestHash: `0x${"11".repeat(32)}` })).toEqual({ problem: "BODY_MISMATCH:requestHash" });
  });

  test("PIN_MISMATCH: the pinned block's number, hash or time isn't the one the workflow read", () => {
    expect(checkEvidence(done(), { ...expectA, pin: { ...PIN, hash: `0x${"22".repeat(32)}` } })).toEqual({ problem: "PIN_MISMATCH:hash" });
    expect(checkEvidence(done(), { ...expectA, pin: { ...PIN, number: PIN.number + 1n } })).toEqual({ problem: "PIN_MISMATCH:number" });
    expect(checkEvidence(done(), { ...expectA, pin: { ...PIN, timestamp: PIN.timestamp + 1n } })).toEqual({ problem: "PIN_MISMATCH:timestamp" });
  });

  test("REQUEST_MISMATCH: the evaluated request isn't the one the trigger carried", () => {
    expect(checkEvidence(done(), { ...expectA, requestBlock: REAL.block + 1n })).toEqual({ problem: "REQUEST_MISMATCH:block" });
    const otherTarget = { ...json, action: { ...json.action, target: REAL.vault } };
    expect(checkEvidence(done(), { ...expectA, json: otherTarget })).toEqual({ problem: "REQUEST_MISMATCH:target" });
    expect(checkEvidence(edited((d) => (d.request.dataHash = `0x${"33".repeat(32)}`)), expectA)).toEqual({ problem: "REQUEST_MISMATCH:dataHash" });
  });

  test("BODY_MISMATCH:schema for a document that isn't mandate-v1 evidence", () => {
    expect(checkEvidence(edited((d) => (d.validator = "risk-v1")), expectA)).toEqual({ problem: "BODY_MISMATCH:validator" });
  });
});

describe("parseEvaluateBody", () => {
  const body = (v: unknown) => JSON.stringify(v);

  test("200 bodies: done, pending, declined", () => {
    expect(parseEvaluateBody(200, body(done()))).toEqual(done());
    expect(parseEvaluateBody(200, '{"status":"pending"}')).toEqual({ status: "pending" });
    expect(parseEvaluateBody(200, body({ code: "GATE_NOT_SERVED", detail: "x", status: "declined" }))).toEqual({
      status: "declined",
      code: "GATE_NOT_SERVED",
      detail: "x",
    });
  });

  test("503 (unavailable or busy) is a retry; any other status is an error", () => {
    expect(parseEvaluateBody(503, '{"status":"unavailable"}')).toEqual({ retry: true });
    expect(parseEvaluateBody(400, '{"status":"bad-request"}')).toMatchObject({ error: expect.stringContaining("400") });
  });

  test("a 200 that isn't one of the three shapes is an error", () => {
    expect(parseEvaluateBody(200, "not json")).toMatchObject({ error: expect.any(String) });
    expect(parseEvaluateBody(200, body(done({ score: 101 })))).toMatchObject({ error: expect.any(String) });
    expect(parseEvaluateBody(200, body({ ...done(), extra: 1 }))).toMatchObject({ error: expect.any(String) });
  });
});
