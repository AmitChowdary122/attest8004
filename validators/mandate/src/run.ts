import type { CheckResult, RequestJsonV1 } from "@attest8004/sdk";
import type { Address } from "viem";
import { collectInputs, type PreimageCache } from "./collect.ts";
import { mandateEvidence } from "./evidence.ts";
import type { MandateAddresses, MandateReader } from "./reader.ts";
import { evaluate } from "./rules.ts";
import type { MandateInputs, PinnedBlock } from "./types.ts";

/**
 * One `mandate-v1` verdict at the pinned block `P`: collect every input at `P`, evaluate the rules,
 * and describe the inputs as evidence. A pure function of its arguments and the chain at `P` (the
 * cache only saves evidence lookups; a hit and a miss give the same entry), so the validator and a
 * later `verify` reach the same `CheckResult` and, through `buildEvidence`, the same bytes.
 *
 * Rejects whenever an input can't be read (an RPC failure, or an approval's log not found yet): that
 * is never a verdict, and the validator base retries the request later.
 */
export async function runMandateV1(o: {
  reader: MandateReader;
  addresses: MandateAddresses;
  /** The validator the request is addressed to (its own approvals count toward spend). */
  validator: Address;
  request: MandateInputs["request"];
  pinned: PinnedBlock;
  cache: PreimageCache;
}): Promise<CheckResult> {
  const { reader, addresses, validator, request, pinned, cache } = o;
  const inputs = await collectInputs({ reader, validator, request, pinned, cache });
  const { score, reasons } = evaluate(inputs);
  return { score, reasons: [...reasons], evidence: mandateEvidence(inputs, addresses) };
}

/** A verified request JSON, made in block `block`, as `runMandateV1` takes it. */
export function mandateRequestOf(json: RequestJsonV1, requestHash: MandateInputs["request"]["requestHash"], block: bigint): MandateInputs["request"] {
  return {
    block,
    requestHash,
    chainId: json.chainId,
    gate: json.gate,
    agentId: BigInt(json.agentId),
    target: json.action.target,
    value: BigInt(json.action.value),
    data: json.action.data,
    deadline: BigInt(json.action.deadline),
    salt: json.action.salt,
  };
}
