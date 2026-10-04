/**
 * Sets a demo agent's passkey on the current MandateRegistry (v2, SPEC §4.2): the one-time owner transaction that binds
 * the public key of a passkey created on https://attest8004.vercel.app/approve to the agent. From then on every
 * mandate change needs the owner's transaction AND an assertion from this passkey.
 *
 *   1. Reads the registration file (`attest8004.passkey.v1`, the page's "Download registration") and refuses it if it
 *      can't serve the agent: another rpId, not ES256, PRF not enabled, UV or UP missing, the wrong rpIdHash, a key
 *      off the curve, or a key or credential id that isn't the one attested in its authenticatorData
 *      (`registrationProblems`).
 *   2. Checks the chain: the registry is the recorded one and binds rpIdHash = sha256("attest8004.vercel.app"), the
 *      deployer owns the agent, and the agent has no passkey yet (the same key again is a no-op; another key stops:
 *      rotation needs the current passkey).
 *   3. Without --confirm, stops there: it prints the key it would bind and the code to confirm it with. With
 *      `--confirm <first 8 hex digits of qx>`, sends setPasskey(agentId, qx, qy) from the deployer with an explicit gas
 *      limit (the SDK's estimate guard), then reads passkeyOf back. There is no undo short of rotatePasskey, which
 *      needs this passkey, so the confirmation repeats the key.
 *
 * Run: pnpm --filter @attest8004/scripts set-passkey <registration.json> [--agent 1984] [--confirm 0x12345678]
 * A relative path is resolved against the directory you ran pnpm in. Needs DEPLOYER_PRIVATE_KEY (.env).
 */
import { readFileSync } from "node:fs";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEPLOYMENTS,
  RP_ID_HASH,
  currentMandateRegistry,
  identityRegistryAbi,
  mandateRegistryAbi,
  registrationProblems,
  registrationSchema,
  writeWithGasGuard,
} from "@attest8004/sdk";
import { assertChain, chain, check, printTx, publicClient, requireEnv, walletFor } from "./common.ts";
import { SET_PASSKEY_GAS_CAP, confirmationCode, confirms, parseAgentId, parseArgs, resolveInputPath } from "./approval-plan.ts";

/** The limit sent is the live estimate × 1.2, never above the cap (how the cap was measured: `SET_PASSKEY_GAS_CAP`). */
const GAS = { setPasskey: { headroomPercent: 20, max: SET_PASSKEY_GAS_CAP } } as const;

const ZERO32: Hex = `0x${"00".repeat(32)}`;

const deployment = DEPLOYMENTS[chain.id];
const registry = getAddress(currentMandateRegistry(deployment).address);
const owner = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);

function cliArgs(argv: string[]): { file: string; agentId: bigint; confirm: string | undefined } {
  const { file, flags } = parseArgs(argv, ["agent", "confirm"]);
  const agentId = flags.agent === undefined ? (deployment.demoAgents[0] as bigint) : parseAgentId(flags.agent);
  return { file: resolveInputPath(file, process.env), agentId, confirm: flags.confirm };
}

async function main(): Promise<void> {
  const { file, agentId, confirm } = cliArgs(process.argv.slice(2));
  await assertChain();
  console.log(`MandateRegistry ${registry} (chain ${chain.id})`);
  console.log(`owner           ${owner.address} (deployer)`);
  console.log(`agent           ${agentId}`);
  console.log(`registration    ${file}`);

  // 1. The file.
  const registration = registrationSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const problems = registrationProblems(registration);
  check("the registration can serve as the agent's passkey", problems.length === 0, problems.join(", "));
  console.log(`passkey         qx ${registration.qx}\n                qy ${registration.qy}\n                credential ${registration.credentialId}`);

  // 2. The chain.
  const code = await publicClient.getCode({ address: registry });
  check("the MandateRegistry has code", code !== undefined && code !== "0x", code ?? "no code");
  const rpIdHash = await publicClient.readContract({ address: registry, abi: mandateRegistryAbi, functionName: "rpIdHash" });
  check("the registry binds rpIdHash = sha256(\"attest8004.vercel.app\")", rpIdHash === RP_ID_HASH, rpIdHash);
  const agentOwner = await publicClient.readContract({
    address: getAddress(deployment.identityRegistry),
    abi: identityRegistryAbi,
    functionName: "ownerOf",
    args: [agentId],
  });
  check(`the deployer owns agent ${agentId}`, getAddress(agentOwner) === owner.address, agentOwner);
  const [qx, qy] = await publicClient.readContract({ address: registry, abi: mandateRegistryAbi, functionName: "passkeyOf", args: [agentId] });
  const sameKey = qx.toLowerCase() === registration.qx.toLowerCase() && qy.toLowerCase() === registration.qy.toLowerCase();
  if (sameKey) {
    console.log(`\nagent ${agentId} already has this passkey; nothing to send`);
  } else {
    check(`agent ${agentId} has no passkey yet (another key needs rotatePasskey with the current passkey)`, qx === ZERO32 && qy === ZERO32, `${qx} ${qy}`);
    if (!confirms(confirm, registration.qx)) {
      console.log(
        `\nnot sent: this binds the key above to agent ${agentId} for good (no recovery; rotation needs this passkey).\n` +
          `To send, re-run with --confirm ${confirmationCode(registration.qx)}`,
      );
      return;
    }
    // 3. Send.
    const sent = await writeWithGasGuard({
      publicClient,
      walletClient: walletFor(owner),
      address: registry,
      abi: mandateRegistryAbi,
      functionName: "setPasskey",
      args: [agentId, registration.qx, registration.qy],
      gasLimit: GAS.setPasskey,
      label: `setPasskey ${agentId}`,
    });
    printTx(`setPasskey ${agentId}`, sent);
  }

  const [storedQx, storedQy] = await publicClient.readContract({ address: registry, abi: mandateRegistryAbi, functionName: "passkeyOf", args: [agentId] });
  check("passkeyOf reads back the registration's key", storedQx.toLowerCase() === registration.qx.toLowerCase() && storedQy.toLowerCase() === registration.qy.toLowerCase(), `${storedQx} ${storedQy}`);
  const nonce = await publicClient.readContract({ address: registry, abi: mandateRegistryAbi, functionName: "nonceOf", args: [agentId] });
  console.log(`nonceOf         ${nonce}`);
  console.log("\nset-passkey OK");
}

// viem's shortMessage leaves out request details such as the RPC URL.
main().catch((error: unknown) => {
  const short = (error as { shortMessage?: string }).shortMessage;
  console.error(short ?? (error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
