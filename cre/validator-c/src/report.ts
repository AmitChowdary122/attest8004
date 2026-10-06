import { bytesToHex, decodeEventLog, encodeAbiParameters, encodeFunctionData, getAddress, parseAbi, parseAbiItem, parseAbiParameters, type Address, type Hex } from "viem";

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

const reportProcessedEvent = parseAbiItem(
  "event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)",
);

/**
 * Whether a write's receipt shows `receiver`'s `onReport` succeeding (P12; a P11 deferred minor). Both Keystone
 * forwarders swallow a receiver's revert: the transaction succeeds, and only the forwarder's
 * `ReportProcessed(receiver, workflowExecutionId, reportId, result)` says how `onReport` went. Only that event from
 * `forwarder` naming `receiver` counts; the same event from any other address, or naming another receiver, is ignored.
 */
export function landedFromReceipt(o: {
  logs: readonly { address: Hex; topics: readonly Hex[]; data: Hex }[];
  forwarder: Address;
  receiver: Address;
}): "LANDED" | "RECEIVER_REVERTED" | "NO_REPORT_EVENT" {
  for (const log of o.logs) {
    if (getAddress(log.address) !== getAddress(o.forwarder)) continue;
    let decoded;
    try {
      decoded = decodeEventLog({ abi: [reportProcessedEvent], topics: log.topics as [Hex, ...Hex[]], data: log.data });
    } catch {
      continue;
    }
    if (getAddress(decoded.args.receiver) !== getAddress(o.receiver)) continue;
    return decoded.args.result ? "LANDED" : "RECEIVER_REVERTED";
  }
  return "NO_REPORT_EVENT";
}
