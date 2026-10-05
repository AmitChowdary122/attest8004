// Measures the CRE mock forwarder's own gas for validator C's reports (P11), read-only: eth_estimateGas of
// MockKeystoneForwarder.report(C, header ‖ payload, context, []) at four evidence sizes, for a requestHash nobody made,
// so CreValidator.onReport reverts fast (UnknownRequest) and the forwarder swallows it. What's left is intrinsic gas,
// calldata and the forwarder's routing: fitted as outerBase + outerPerByte × raw report bytes, the constants in
// cre/validator-c/config.monad-testnet.json's "gas". Nothing is sent.
//
//   pnpm --filter @attest8004/scripts cre-gas-probe
import { DEPLOYMENTS } from "@attest8004/sdk";
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, sha256, size, stringToBytes, stringToHex, toHex, type Hex } from "viem";
import { assertChain, publicClient, requireAddress } from "./common.ts";
import { fitOuterGas } from "./cre-demo-plan.ts";

const testnet = DEPLOYMENTS[10143];
const forwarderAbi = parseAbi(["function report(address receiver, bytes rawReport, bytes reportContext, bytes[] signatures)"]);
const EVIDENCE_SIZES = [1_024, 4_096, 8_192, 16_384];
const SIM_OWNER: Hex = `0x${"aa".repeat(20)}`;
/** bytes10 of the first 10 hex characters of sha256(workflow name), as CRE writes it (cre/validator-c/src/config.ts). */
const WORKFLOW_NAME_BYTES10 = stringToHex(sha256(stringToBytes("attest8004-validator-c")).slice(2, 12));

/** The 109-byte header the CRE simulator writes (P11 spike), then the payload. */
function rawReport(payload: Hex): Hex {
  const header = [
    "0x01",
    keccak256(toHex("attest8004.cre-gas-probe")).slice(2),
    "00000064",
    "00000001",
    "00000001",
    "11".repeat(32),
    WORKFLOW_NAME_BYTES10.slice(2),
    SIM_OWNER.slice(2),
    "0001",
  ].join("");
  return `${header}${payload.slice(2)}` as Hex;
}

async function main(): Promise<void> {
  await assertChain();
  const from = requireAddress("CRE_BROADCAST_ADDRESS");
  const c = testnet.validators.creMandateV1;
  const unknownRequest = keccak256(toHex(`attest8004.cre-gas-probe.unknown.${Date.now()}`));
  const samples: { rawReportBytes: number; gas: bigint }[] = [];
  for (const evidenceBytes of EVIDENCE_SIZES) {
    const evidence = "x".repeat(evidenceBytes);
    const uri = `data:application/json;base64,${Buffer.from(evidence).toString("base64")}`;
    const payload = encodeAbiParameters(parseAbiParameters("bytes32, uint8, string, bytes32"), [unknownRequest, 100, uri, keccak256(stringToBytes(evidence))]);
    const raw = rawReport(payload);
    const data = encodeFunctionData({ abi: forwarderAbi, functionName: "report", args: [c, raw, `0x${"00".repeat(96)}`, []] });
    const gas = await publicClient.estimateGas({ account: from, to: testnet.creForwarder, data });
    samples.push({ rawReportBytes: size(raw), gas });
    console.log(`evidence ${String(evidenceBytes).padStart(6)} B  raw report ${String(size(raw)).padStart(6)} B  outer eth_estimateGas ${gas}`);
  }
  const fit = fitOuterGas(samples);
  console.log(`\nfit: outerBase ${fit.outerBase}, outerPerByte ${fit.outerPerByte}`);
  console.log(`config gas: ${JSON.stringify({ outerBase: fit.outerBase, outerPerByte: fit.outerPerByte })}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message.split("\n")[0] : String(error));
  process.exitCode = 1;
});
