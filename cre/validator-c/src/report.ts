import { bytesToHex, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, type Hex } from "viem";

/** The 109-byte header CRE puts before every report's payload; the forwarder passes bytes 45-109 as `metadata`. */
export const RAW_REPORT_HEADER_BYTES = 109;
const METADATA_START = 45;

export const receiverAbi = parseAbi(["function onReport(bytes metadata, bytes report)"]);

/** The report CreValidator decodes: abi.encode(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash). */
export function reportPayload(o: { requestHash: Hex; score: number; responseURI: string; responseHash: Hex }): Hex {
  return encodeAbiParameters(parseAbiParameters("bytes32, uint8, string, bytes32"), [o.requestHash, o.score, o.responseURI, o.responseHash]);
}

/** rawReport[45:109]: workflowId ‖ workflowName ‖ workflowOwner ‖ reportId, exactly what the forwarder hands onReport. */
export function metadataOf(rawReport: Uint8Array): Hex {
  if (rawReport.length < RAW_REPORT_HEADER_BYTES) throw new Error(`a raw report is at least ${RAW_REPORT_HEADER_BYTES} bytes, got ${rawReport.length}`);
  return bytesToHex(rawReport.slice(METADATA_START, RAW_REPORT_HEADER_BYTES));
}

/** IReceiver.onReport(metadata, report): the call the forwarder makes, which the workflow estimates as the forwarder. */
export function onReportCalldata(metadata: Hex, payload: Hex): Hex {
  return encodeFunctionData({ abi: receiverAbi, functionName: "onReport", args: [metadata, payload] });
}
