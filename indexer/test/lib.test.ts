import { readFileSync } from "node:fs";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
// The SDK's own source, imported for parity only (tests run locally and in CI, never on Envio Cloud).
import {
  buildRequestJson,
  computeActionHash,
  computeRequestHash,
  encodeCanonicalJsonDataUri,
  encodeJsonDataUri,
  toBase64,
  type Action,
} from "../../packages/sdk/src/index.ts";
import { bytes4, decodeEvidence, decodeRequest, MAX_EVIDENCE_BYTES } from "../src/lib/decode.ts";
import { inEpoch, MANDATE_EPOCHS } from "../src/lib/epochs.ts";
import { scoreBucket } from "../src/lib/stats.ts";

interface Vector {
  name: string;
  chainId: string;
  gate: Address;
  validator: Address;
  action: { agentId: string; target: Address; value: string; data: Hex; deadline: string; salt: Hex };
}
const vectors = (JSON.parse(readFileSync(new URL("../../packages/sdk/test/vectors.json", import.meta.url), "utf8")) as { vectors: Vector[] }).vectors;

const toAction = (v: Vector): Action => ({
  agentId: BigInt(v.action.agentId),
  target: v.action.target,
  value: BigInt(v.action.value),
  data: v.action.data,
  deadline: BigInt(v.action.deadline),
  salt: v.action.salt,
});

const REQUEST = "0x" + "ab".repeat(32);
const evidence = (over: Record<string, unknown> = {}) =>
  encodeCanonicalJsonDataUri({ schema: "attest8004.evidence.v1", validator: "mandate-v1", requestHash: REQUEST, score: 0, reasons: ["DAILY_CAP_EXCEEDED"], ...over });

describe("decodeEvidence", () => {
  it("reads the reasons of an inline v1 document whose hash matches", () => {
    const { uri, hash } = evidence({ reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"] });
    expect(decodeEvidence(uri, hash)).toEqual({ status: "VERIFIED", reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"] });
  });

  it("matches the hash case-insensitively", () => {
    const { uri, hash } = evidence();
    expect(decodeEvidence(uri, hash.toUpperCase().replace("0X", "0x")).status).toBe("VERIFIED");
  });

  it("drops reasons that aren't codes and keeps at most 16", () => {
    const codes = Array.from({ length: 20 }, (_, i) => `CODE_${i}`);
    const { uri, hash } = evidence({ reasons: ["lower_case", "<b>X</b>", "javascript:alert(1)", "A".repeat(65), 7, "OK_CODE", ...codes] });
    const out = decodeEvidence(uri, hash);
    expect(out.status).toBe("VERIFIED");
    expect(out.reasons).toEqual(["OK_CODE", ...codes.slice(0, 15)]);
  });

  it("gives no reasons for a document that isn't attest8004.evidence.v1", () => {
    const { uri, hash } = evidence({ schema: "someone.else.v9" });
    expect(decodeEvidence(uri, hash)).toEqual({ status: "VERIFIED", reasons: null });
    const notArray = evidence({ reasons: "DAILY_CAP_EXCEEDED" });
    expect(decodeEvidence(notArray.uri, notArray.hash)).toEqual({ status: "VERIFIED", reasons: null });
  });

  it("is HASH_MISMATCH when one byte differs", () => {
    const { uri, hash } = evidence();
    const other = evidence({ score: 100 });
    expect(decodeEvidence(other.uri, hash)).toEqual({ status: "HASH_MISMATCH", reasons: null });
    expect(decodeEvidence(uri, other.hash)).toEqual({ status: "HASH_MISMATCH", reasons: null });
  });

  it("is NOT_INLINE for any other URI", () => {
    const { hash } = evidence();
    expect(decodeEvidence("https://example.com/evidence.json", hash)).toEqual({ status: "NOT_INLINE", reasons: null });
    expect(decodeEvidence("", hash)).toEqual({ status: "NOT_INLINE", reasons: null });
    expect(decodeEvidence("ipfs://bafy", hash)).toEqual({ status: "NOT_INLINE", reasons: null });
  });

  it("is UNREADABLE for bad base64, bad JSON or an oversized document", () => {
    expect(decodeEvidence("data:application/json;base64,@@@@", keccak256("0x")).status).toBe("UNREADABLE");
    const notJson = stringToBytes("{not json");
    expect(decodeEvidence(`data:application/json;base64,${toBase64(notJson)}`, keccak256(notJson)).status).toBe("UNREADABLE");
    const big = stringToBytes(JSON.stringify({ schema: "attest8004.evidence.v1", reasons: [], pad: "x".repeat(MAX_EVIDENCE_BYTES) }));
    expect(decodeEvidence(`data:application/json;base64,${toBase64(big)}`, keccak256(big)).status).toBe("UNREADABLE");
  });
});

describe("decodeRequest", () => {
  it("matches the SDK on every shared vector: the requestHash, then the actionHash it stores", () => {
    expect(vectors.length).toBeGreaterThan(0);
    for (const v of vectors) {
      const chainId = Number(v.chainId);
      const action = toAction(v);
      const json = buildRequestJson({ chainId, gate: v.gate, validator: v.validator, action });
      const { uri } = encodeJsonDataUri(json);
      const requestHash = computeRequestHash({ chainId, gate: v.gate, validator: v.validator, action });
      expect(decodeRequest(uri, requestHash, chainId, { validator: v.validator, agentId: BigInt(v.action.agentId) }), v.name).toEqual({
        status: "VERIFIED",
        gate: v.gate.toLowerCase(),
        target: v.action.target.toLowerCase(),
        value: v.action.value,
        deadline: BigInt(v.action.deadline),
        actionHash: computeActionHash({ chainId, gate: v.gate, action }).toLowerCase(),
      });
    }
  });

  it("accepts the percent-encoded form the validators accept", () => {
    const v = vectors[0] as Vector;
    const chainId = Number(v.chainId);
    const json = buildRequestJson({ chainId, gate: v.gate, validator: v.validator, action: toAction(v) });
    const uri = `data:application/json,${encodeURIComponent(JSON.stringify(json))}`;
    const requestHash = computeRequestHash({ chainId, gate: v.gate, validator: v.validator, action: toAction(v) });
    expect(decodeRequest(uri, requestHash, chainId, { validator: v.validator, agentId: BigInt(v.action.agentId) }).status).toBe("VERIFIED");
  });

  it("is HASH_MISMATCH on another chain or another hash", () => {
    const v = vectors[0] as Vector;
    const chainId = Number(v.chainId);
    const json = buildRequestJson({ chainId, gate: v.gate, validator: v.validator, action: toAction(v) });
    const { uri } = encodeJsonDataUri(json);
    const requestHash = computeRequestHash({ chainId, gate: v.gate, validator: v.validator, action: toAction(v) });
    const event = { validator: v.validator, agentId: BigInt(v.action.agentId) };
    expect(decodeRequest(uri, requestHash, 143, event)).toEqual({ status: "HASH_MISMATCH" });
    expect(decodeRequest(uri, keccak256("0x01"), chainId, event)).toEqual({ status: "HASH_MISMATCH" });
    // The validators refuse a request whose JSON names another validator or agent than its event (WRONG_VALIDATOR, AGENT_MISMATCH).
    expect(decodeRequest(uri, requestHash, chainId, { ...event, validator: "0x00000000000000000000000000000000000057a1" })).toEqual({ status: "HASH_MISMATCH" });
    expect(decodeRequest(uri, requestHash, chainId, { ...event, agentId: event.agentId + 1n })).toEqual({ status: "HASH_MISMATCH" });
  });

  it("is UNREADABLE for an oversized URI, a wrong schema or unknown keys", () => {
    const v = vectors[0] as Vector;
    const chainId = Number(v.chainId);
    const json = buildRequestJson({ chainId, gate: v.gate, validator: v.validator, action: toAction(v) });
    const requestHash = computeRequestHash({ chainId, gate: v.gate, validator: v.validator, action: toAction(v) });
    const padded = encodeJsonDataUri({ ...json, action: { ...json.action, data: `0x${"00".repeat(9_000)}` } });
    const event = { validator: v.validator, agentId: BigInt(v.action.agentId) };
    expect(decodeRequest(padded.uri, requestHash, chainId, event)).toEqual({ status: "UNREADABLE" });
    expect(decodeRequest(encodeJsonDataUri({ ...json, schema: "attest8004.request.v2" }).uri, requestHash, chainId, event)).toEqual({ status: "UNREADABLE" });
    expect(decodeRequest(encodeJsonDataUri({ ...json, extra: 1 }).uri, requestHash, chainId, event)).toEqual({ status: "UNREADABLE" });
    expect(decodeRequest(encodeJsonDataUri({ ...json, agentId: "01984" }).uri, requestHash, chainId, event)).toEqual({ status: "UNREADABLE" });
  });

  it("is NOT_INLINE for any other URI", () => {
    expect(decodeRequest("https://example.com/request.json", keccak256("0x"), 10143, { validator: "0x00000000000000000000000000000000000057a1", agentId: 1n })).toEqual({ status: "NOT_INLINE" });
  });
});

describe("scoreBucket", () => {
  it("puts each score in one of five buckets", () => {
    expect([0, 1, 39, 40, 79, 80, 99, 100].map(scoreBucket)).toEqual([
      "score0",
      "score1to39",
      "score1to39",
      "score40to79",
      "score40to79",
      "score80to99",
      "score80to99",
      "score100",
    ]);
  });
});

describe("MandateRegistry epochs", () => {
  const [v1, v2] = MANDATE_EPOCHS;
  it("are P4's registry until v2's deploy block, then v2 for good", () => {
    expect(v1?.registry).toBe("0x2523197373ef813e19b5b14ef2984130868cd17c");
    expect(v2?.registry).toBe("0x2ee5f78149762de630c6bff8cd81166010d0454b");
    expect(inEpoch(v1?.registry ?? "", 68_196_461n)).toBe(true);
    expect(inEpoch(v1?.registry ?? "", 68_196_462n)).toBe(false);
    expect(inEpoch(v1?.registry ?? "", 67_842_486n)).toBe(false);
    expect(inEpoch(v2?.registry ?? "", 68_196_462n)).toBe(true);
    expect(inEpoch(v2?.registry ?? "", 99_999_999n)).toBe(true);
    expect(inEpoch("0x0000000000000000000000000000000000000001", 68_196_462n)).toBe(false);
  });

  it("take checksummed addresses too", () => {
    expect(inEpoch("0x2Ee5f78149762DE630c6bFF8CD81166010D0454B", 68_196_462n)).toBe(true);
  });
});

describe("bytes4", () => {
  // HyperSync hands a bytes4 array element over as a full 32-byte ABI word (seen live: agent 1984's 0x00000000).
  it("takes a selector from a 32-byte word, left- or right-aligned, or as given", () => {
    expect(bytes4("0x" + "00".repeat(32))).toBe("0x00000000");
    expect(bytes4("0xA9059CBB" + "00".repeat(28))).toBe("0xa9059cbb");
    expect(bytes4("0x" + "00".repeat(28) + "a9059cbb")).toBe("0xa9059cbb");
    expect(bytes4("0xa9059cbb")).toBe("0xa9059cbb");
  });
});
