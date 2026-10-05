import { buildEvidence, canonicalJson } from "@attest8004/sdk";
import { keccak256, stringToBytes, type Address, type Hex } from "viem";
import { servedGateDecline, servedGateMap } from "./gates.ts";
import { MANDATE_V1 } from "./params.ts";
import { firstMandateRegistryBlock, mandateAddressesAt, type VerifyReader } from "./reader.ts";
import { mandateRequestOf, runMandateV1 } from "./run.ts";
import type { ServedGate } from "./validator.ts";
import { requestAt, statusOrUnknown, type VerifyContext } from "./verify.ts";

/**
 * The largest evidence `/evaluate` returns (P11). Validator C's workflow passes it through CRE's consensus, whose
 * observation limit is 25 kB, as a JSON string inside the response body (escaping adds up to ~20 %). Not to be
 * confused with collect.ts's `MAX_EVIDENCE_URI_BYTES` (131,072), the largest approval evidence a spend read decodes.
 */
export const CRE_MAX_EVIDENCE_BYTES = 16_384;

/** Why `/evaluate` gives no verdict for a request. Each is final for that (requestHash, pin); none is a read failure. */
export type EvaluateDecline =
  | "PIN_BEFORE_FIRST_REGISTRY"
  | "REQUEST_NOT_FOUND"
  | "NOT_THIS_VALIDATOR"
  | "PIN_NOT_REQUEST_BLOCK"
  | "REQUEST_INVALID"
  | "GATE_NOT_SERVED"
  | "GATE_NOT_FOR_AGENT"
  | "EVIDENCE_TOO_LARGE";

export type EvaluateOutcome =
  | {
      status: "done";
      score: number;
      reasons: string[];
      /** The canonical evidence document's exact text: what the response's URI carries and its hash commits to. */
      evidence: string;
      /** keccak256 of `evidence`'s UTF-8 bytes: the response's `responseHash`. */
      evidenceHash: Hex;
    }
  | { status: "declined"; code: EvaluateDecline; detail: string };

/**
 * `mandate-v1`'s verdict for `requestHash` at the pin `P`, for validator C's CRE workflow (P11), read-only. It runs
 * exactly what `verify` re-runs: `requestAt` (verify's own request checks), then `runMandateV1` at `P` with an empty
 * cache, `buildEvidence` and canonical JSON. So an answer posted by C re-verifies to a match, byte for byte.
 *
 * C's pin rule is that `P` is the request's own block (the trigger log's block, identical on every CRE node). In order:
 * a pin before the first MandateRegistry (`PIN_BEFORE_FIRST_REGISTRY`); no request at `P` (`REQUEST_NOT_FOUND`); one
 * naming another validator (`NOT_THIS_VALIDATOR`); `P` isn't the request's block (`PIN_NOT_REQUEST_BLOCK`); a request
 * verify would reject (`REQUEST_INVALID`: bad JSON or hash, wrong agent or chain, a deadline more than 3,600 s after
 * `P`'s time); a (gate, agent) pair the allowlist doesn't serve (`GATE_NOT_SERVED`, `GATE_NOT_FOR_AGENT`, validator
 * A's own texts); evidence over {@link CRE_MAX_EVIDENCE_BYTES} (`EVIDENCE_TOO_LARGE`). Every `detail` is built from
 * fixed text, numbers, addresses and hashes, so the same inputs give the same bytes on every call.
 *
 * Rejects, never declines, when a read fails or the request's log isn't returned for a block state confirms (lag):
 * a failed read is never a verdict. The caller waits for `finalized ≥ P + PIN_LAG_BLOCKS` before calling.
 */
export async function evaluateAtPin(o: {
  reader: VerifyReader;
  context: VerifyContext;
  validator: Address;
  gates: readonly ServedGate[];
  requestHash: Hex;
  pinnedBlock: bigint;
}): Promise<EvaluateOutcome> {
  const { reader, context, validator, pinnedBlock } = o;
  const { contracts, validationRegistryDeployBlock } = context;
  const requestHash = o.requestHash.toLowerCase() as Hex;
  const declined = (code: EvaluateDecline, detail: string): EvaluateOutcome => ({ status: "declined", code, detail });

  const firstRegistry = firstMandateRegistryBlock(contracts);
  if (pinnedBlock < firstRegistry) {
    return declined("PIN_BEFORE_FIRST_REGISTRY", `block ${pinnedBlock} is before the first MandateRegistry (block ${firstRegistry})`);
  }
  const status = await statusOrUnknown(reader, requestHash, pinnedBlock);
  if (status === null) return declined("REQUEST_NOT_FOUND", `the registry has no request ${requestHash} at block ${pinnedBlock}`);
  if (status.validator.toLowerCase() !== validator.toLowerCase()) {
    return declined("NOT_THIS_VALIDATOR", `request ${requestHash} names validator ${status.validator}, not ${validator}`);
  }

  const pinned = await reader.block(pinnedBlock);
  const request = await requestAt(reader, requestHash, pinnedBlock, validationRegistryDeployBlock, status, pinned);
  if ("problem" in request) {
    if (request.problem === "REQUEST_BLOCK_WRONG") {
      return declined("PIN_NOT_REQUEST_BLOCK", `request ${requestHash} wasn't made in block ${pinnedBlock}`);
    }
    if (request.problem === "REQUEST_INVALID") {
      return declined("REQUEST_INVALID", `request ${requestHash} is one mandate-v1 must not answer at block ${pinnedBlock}`);
    }
    // REQUEST_NOT_FOUND: state confirms the block but the log wasn't returned (RPC lag). Retry, never a verdict.
    throw new Error(`REQUEST_NOT_FOUND: request ${requestHash}'s log wasn't returned for block ${pinnedBlock}; retry later`);
  }
  const { json } = request;
  const notServed = servedGateDecline(servedGateMap(o.gates), json.gate, status.agentId);
  if (notServed !== null) return declined(notServed.startsWith("GATE_NOT_SERVED") ? "GATE_NOT_SERVED" : "GATE_NOT_FOR_AGENT", notServed);

  const result = await runMandateV1({
    reader,
    addresses: mandateAddressesAt(contracts, pinnedBlock),
    validator: status.validator,
    request: mandateRequestOf(json, requestHash, pinnedBlock),
    pinned,
    cache: new Map(),
  });
  const evidence = canonicalJson(buildEvidence({ tag: MANDATE_V1.tag, requestHash, result }));
  const bytes = stringToBytes(evidence);
  if (bytes.length > CRE_MAX_EVIDENCE_BYTES) {
    return declined("EVIDENCE_TOO_LARGE", `the evidence is ${bytes.length} bytes; CRE's consensus takes at most ${CRE_MAX_EVIDENCE_BYTES}`);
  }
  return { status: "done", score: result.score, reasons: [...result.reasons], evidence, evidenceHash: keccak256(bytes) };
}
