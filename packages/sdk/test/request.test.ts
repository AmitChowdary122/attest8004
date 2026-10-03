import { readFileSync } from "node:fs";
import { getAddress, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  MAX_REQUEST_URI_BYTES,
  buildAction,
  buildRequestJson,
  computeRequestHash,
  decodeJsonDataUri,
  encodeJsonDataUri,
  parseRequestUri,
  requestHashOfJson,
  requestJsonToAction,
  type Action,
  type RequestJsonV1,
} from "../src/index.ts";

interface Vector {
  name: string;
  chainId: string;
  gate: Address;
  validator: Address;
  action: { agentId: string; target: Address; value: string; data: Hex; deadline: string; salt: Hex };
  requestHash: Hex;
}
const { vectors } = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8")) as {
  vectors: Vector[];
};

const GATE = getAddress("0x7a5ec388ccbfd3b255cfa94fc2062c0807f2c4cd");
const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const ACTION: Action = {
  agentId: 1982n,
  target: getAddress("0x3efeb3cf2fb54a7d99abe90aab786ce5a831a8cf"),
  value: 1_000_000_000_000_000n,
  data: "0xa9059cbb",
  deadline: 1_791_000_000n,
  salt: `0x${"ab".repeat(32)}`,
};
const json: RequestJsonV1 = buildRequestJson({ chainId: 10143, gate: GATE, validator: VALIDATOR, action: ACTION });

/** The request JSON as a base64 data: URI, with any fields replaced (for building bad requests). */
function uriOf(doc: unknown): string {
  return `data:application/json;base64,${Buffer.from(JSON.stringify(doc), "utf8").toString("base64")}`;
}
function rejection(uri: string) {
  const parsed = parseRequestUri(uri);
  if (parsed.ok) throw new Error("expected a rejection");
  return parsed.reason;
}
const withAction = (patch: Record<string, unknown>) => ({ ...json, action: { ...json.action, ...patch } });

describe("request JSON v1", () => {
  it("has the documented shape, with agentId, value and deadline as decimal strings", () => {
    expect(json).toEqual({
      schema: "attest8004.request.v1",
      chainId: 10143,
      gate: GATE,
      validator: VALIDATOR,
      agentId: "1982",
      action: {
        target: ACTION.target,
        value: "1000000000000000",
        data: "0xa9059cbb",
        deadline: "1791000000",
        salt: ACTION.salt,
      },
    });
  });

  it("round-trips through a data: URI and hashes like computeRequestHash", () => {
    const { uri } = encodeJsonDataUri(json);
    const parsed = parseRequestUri(uri);
    expect(parsed).toEqual({ ok: true, json });
    if (!parsed.ok) return;
    expect(requestJsonToAction(parsed.json)).toEqual(ACTION);
    expect(requestHashOfJson(parsed.json)).toBe(
      computeRequestHash({ chainId: 10143, gate: GATE, validator: VALIDATOR, action: ACTION }),
    );
  });

  it("hashes to every shared vector's requestHash", () => {
    for (const v of vectors) {
      const request = buildRequestJson({
        chainId: Number(v.chainId),
        gate: v.gate,
        validator: v.validator,
        action: {
          agentId: BigInt(v.action.agentId),
          target: v.action.target,
          value: BigInt(v.action.value),
          data: v.action.data,
          deadline: BigInt(v.action.deadline),
          salt: v.action.salt,
        },
      });
      const parsed = parseRequestUri(encodeJsonDataUri(request).uri);
      expect(parsed.ok, v.name).toBe(true);
      if (parsed.ok) expect(requestHashOfJson(parsed.json), v.name).toBe(v.requestHash);
    }
  });

  it("encodeJsonDataUri commits to the exact JSON bytes", () => {
    const { uri, hash } = encodeJsonDataUri({ a: 1 });
    expect(uri).toBe("data:application/json;base64,eyJhIjoxfQ==");
    expect(hash).toBe(keccak256(stringToBytes('{"a":1}')));
    const decoded = decodeJsonDataUri(uri);
    expect(decoded).toEqual({ ok: true, text: '{"a":1}' });
  });

  describe("accepts", () => {
    it("lower-case addresses, normalised to checksum", () => {
      const lower = { ...json, gate: GATE.toLowerCase(), action: { ...json.action, target: ACTION.target.toLowerCase() } };
      const parsed = parseRequestUri(uriOf(lower));
      expect(parsed).toEqual({ ok: true, json });
    });

    it("a percent-encoded data: URI", () => {
      const uri = `data:application/json,${encodeURIComponent(JSON.stringify(json))}`;
      expect(parseRequestUri(uri)).toEqual({ ok: true, json });
    });

    it("a charset parameter before ;base64", () => {
      const uri = uriOf(json).replace("data:application/json;base64,", "data:application/json;charset=utf-8;base64,");
      expect(parseRequestUri(uri)).toEqual({ ok: true, json });
    });
  });

  describe("rejects as SCHEMA_INVALID", () => {
    const cases: Array<[string, unknown]> = [
      ["a numeric deadline (the pre-P3 format)", withAction({ deadline: 1_791_000_000 })],
      ["a decimal with a leading zero", { ...json, agentId: "01982" }],
      ["a negative decimal", withAction({ value: "-1" })],
      ["an agentId above uint256", { ...json, agentId: (2n ** 256n).toString() }],
      ["a deadline above uint64", withAction({ deadline: (2n ** 64n).toString() })],
      ["an address with a bad checksum", { ...json, gate: "0x7A5EC388CCbfD3B255CFa94fc2062c0807F2C4Cd" }],
      ["odd-length data", withAction({ data: "0x123" })],
      ["a 31-byte salt", withAction({ salt: `0x${"ab".repeat(31)}` })],
      ["a missing validator", { ...json, validator: undefined }],
      ["an extra top-level key", { ...json, note: "hi" }],
      ["an extra action key", withAction({ gas: "1" })],
      ["another schema version", { ...json, schema: "attest8004.request.v2" }],
      ["a chainId that isn't a safe integer", { ...json, chainId: 2 ** 53 }],
      ["a chainId given as a string", { ...json, chainId: "10143" }],
      ["a JSON array", [json]],
    ];
    for (const [label, doc] of cases) {
      it(label, () => expect(rejection(uriOf(doc))).toBe("SCHEMA_INVALID"));
    }

    it("a __proto__ key (JSON.parse makes it an own property)", () => {
      const text = JSON.stringify(json).replace('{"schema"', '{"__proto__":{"x":1},"schema"');
      expect(rejection(`data:application/json,${encodeURIComponent(text)}`)).toBe("SCHEMA_INVALID");
    });
  });

  describe("rejects the URI itself", () => {
    it("anything but a JSON data: URI (no fetching)", () => {
      expect(rejection("https://example.com/request.json")).toBe("URI_NOT_DATA");
      expect(rejection("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")).toBe("URI_NOT_DATA");
      expect(rejection("data:text/plain,hello")).toBe("URI_NOT_DATA");
      expect(rejection("")).toBe("URI_NOT_DATA");
    });

    it("a URI longer than 16 KB", () => {
      expect(MAX_REQUEST_URI_BYTES).toBe(16_384);
      const prefix = "data:application/json,";
      const atLimit = prefix + " ".repeat(MAX_REQUEST_URI_BYTES - prefix.length);
      expect(decodeJsonDataUri(atLimit).ok).toBe(true);
      expect(rejection(`${atLimit} `)).toBe("URI_TOO_LARGE");
    });

    it("malformed base64, invalid UTF-8, non-ASCII characters and bad percent escapes", () => {
      expect(rejection("data:application/json;base64,!!!!")).toBe("URI_MALFORMED");
      expect(rejection("data:application/json;base64,e30")).toBe("URI_MALFORMED");
      expect(rejection("data:application/json;base64,/w==")).toBe("URI_MALFORMED");
      expect(rejection("data:application/json,{\"é\":1}")).toBe("URI_MALFORMED");
      expect(rejection("data:application/json,%zz")).toBe("URI_MALFORMED");
    });

    it("text that isn't JSON", () => {
      expect(rejection("data:application/json,not%20json")).toBe("JSON_INVALID");
    });
  });
});

describe("buildAction", () => {
  const base = { agentId: 1n, target: ACTION.target, deadline: 1_791_000_000n };

  it("defaults to value 0, empty data and a random 32-byte salt", () => {
    const a = buildAction(base);
    const b = buildAction(base);
    expect(a.value).toBe(0n);
    expect(a.data).toBe("0x");
    expect(a.salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a.salt).not.toBe(b.salt);
  });

  it("checksums the target", () => {
    expect(buildAction({ ...base, target: ACTION.target.toLowerCase() as Address }).target).toBe(ACTION.target);
  });

  it("rejects what the contract would see differently", () => {
    expect(() => buildAction({ ...base, data: "0x1" })).toThrow(/action\.data/);
    expect(() => buildAction({ ...base, value: -1n })).toThrow(/action\.value/);
    expect(() => buildAction({ ...base, deadline: 2n ** 64n })).toThrow(/action\.deadline/);
    expect(() => buildAction({ ...base, salt: "0x01" })).toThrow(/action\.salt/);
  });
});
