import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, decodeFunctionData, hexToBytes, parseAbi, parseAbiParameters } from "viem";
import { metadataOf, onReportCalldata, reportPayload } from "../src/report.ts";

const H = `0x${"cc".repeat(32)}` as const;
const R = `0x${"dd".repeat(32)}` as const;

describe("reportPayload: abi.encode(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash)", () => {
  test("round-trips through the ABI CreValidator decodes", () => {
    const payload = reportPayload({ requestHash: H, score: 100, responseURI: "data:application/json;base64,e30=", responseHash: R });
    expect(payload.slice(0, 66)).toBe(H);
    expect(decodeAbiParameters(parseAbiParameters("bytes32, uint8, string, bytes32"), payload)).toEqual([
      H,
      100,
      "data:application/json;base64,e30=",
      R,
    ]);
  });
});

describe("metadataOf: rawReport[45:109], what the forwarder hands onReport", () => {
  // The 109-byte header the CRE simulator signed in the P11 spike (sim6.log): version 1, execution id, time 100,
  // DON 1, config 1, workflowId 0x11…, name "7aadfc402a", owner 0xaa…, reportId 0x0001.
  const HEADER =
    "0x0133c7a353be2b0fb5e39033ff8804c354d479939f6b2af4d2a1f0ad17b2479c93000000640000000100000001" +
    "1111111111111111111111111111111111111111111111111111111111111111" +
    "37616164666334303261" +
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" +
    "0001";

  test("extracts workflowId ‖ name ‖ owner ‖ reportId from the simulator's real header", () => {
    const raw = new Uint8Array([...hexToBytes(HEADER as `0x${string}`), 1, 2, 3]);
    expect(metadataOf(raw)).toBe(`0x${"11".repeat(32)}37616164666334303261${"aa".repeat(20)}0001`);
  });

  test("throws on a raw report shorter than the 109-byte header", () => {
    expect(() => metadataOf(new Uint8Array(108))).toThrow();
  });
});

describe("onReportCalldata", () => {
  test("is IReceiver.onReport(metadata, report)", () => {
    const data = onReportCalldata("0x1234", "0xabcd");
    expect(data.slice(0, 10)).toBe("0x805f2132");
    expect(decodeFunctionData({ abi: parseAbi(["function onReport(bytes metadata, bytes report)"]), data }).args).toEqual(["0x1234", "0xabcd"]);
  });
});
