/**
 * The two demo agents and their hot keys on Monad testnet (SPEC §4.4):
 *
 *   1. If DEPLOYMENTS has no demo agents yet, the deployer registers two agents in the canonical
 *      Identity Registry by calling register(string) directly: agent0-sdk 1.7.1 has no defaults
 *      for chain 10143. Record the printed agentIds in packages/sdk/src/deployments.ts.
 *   2. Least privilege (ARCHITECTURE §7): for each agent, the deployer approves the
 *      AgentRequestForwarder for that token only (approve(forwarder, agentId)), read back with
 *      getApproved; then, if the deployer still holds a blanket setApprovalForAll(forwarder, true)
 *      from an earlier run, it's revoked (setApprovalForAll(forwarder, false)), read back with
 *      isApprovedForAll.
 *   3. For each agent, the deployer registers its hot key: forwarder.setAgentKey(agentId, hotKey).
 *   4. Estimates forwarder.request from each hot key (a representative request JSON v1) and checks
 *      it against DEFAULT_GAS.forwarderRequest.
 *   5. Only with --fund: tops each hot key up to FUNDED_REQUESTS requests at the current max fee.
 *   6. Only with --fund-validator: tops validator A up to VALIDATOR_FUND_TARGET.
 *
 * Run: pnpm --filter @attest8004/scripts setup-demo-agents [-- --fund --fund-validator]
 *
 * Every step is skipped when already done, so it can be re-run. Needs DEPLOYER_PRIVATE_KEY and the
 * hot keys' addresses (DEMO_AGENT_<n>_HOT_ADDRESS from the hot-keys script); never a hot key itself.
 * Every transaction has a literal gas limit and goes through the SDK's estimate guard.
 */
import { getAddress, parseAbi, parseEther, parseEventLogs, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  DEFAULT_GAS,
  DEPLOYMENTS,
  agentRequestForwarderAbi,
  buildAction,
  buildRequestJson,
  encodeJsonDataUri,
  identityRegistryAbi,
  requestHashOfJson,
  sendWithGasGuard,
  writeWithGasGuard,
} from "@attest8004/sdk";
import {
  assertChain,
  chain,
  check,
  mon,
  printTx,
  publicClient,
  requireAddress,
  requireEnv,
  walletFor,
} from "./common.ts";

/**
 * Explicit gas limits: Monad testnet eth_estimateGas on 3 Oct 2026 x 1.2, rounded up to 1k.
 * Estimates: register 411,546; approve(forwarder, 1984) 79,523; setApprovalForAll(forwarder, false)
 * 54,444; setAgentKey 107,670 before the first run and 118,742 / 107,899 in it (the first run sent
 * with 130,000); a MON transfer to an EOA 21,000.
 */
const GAS = {
  register: 494_000n,
  approve: 96_000n,
  revokeApprovalForAll: 66_000n,
  setAgentKey: 143_000n,
  fund: 26_000n,
} as const;

/** Each hot key holds enough MON for this many forwarded requests, at the current max fee. */
const FUNDED_REQUESTS = 4n;

/** Validator A is topped up to about this much (only with --fund-validator), through sendWithGasGuard. */
const VALIDATOR_FUND_TARGET = parseEther("2");

// register/Registered aren't in the SDK's identityRegistryAbi (approve, getApproved,
// setApprovalForAll, isApprovedForAll, ownerOf, the ERC721 events/errors); this script needs both.
const identityAbi = [
  ...identityRegistryAbi,
  ...parseAbi([
    "function register(string agentURI) returns (uint256 agentId)",
    "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  ]),
] as const;

const deployment = DEPLOYMENTS[chain.id];
const identityRegistry = getAddress(deployment.identityRegistry);
const forwarder = getAddress(deployment.agentRequestForwarder);
const owner = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);
const ownerWallet = walletFor(owner);
const hotKeys = [requireAddress("DEMO_AGENT_1_HOT_ADDRESS"), requireAddress("DEMO_AGENT_2_HOT_ADDRESS")] as const;
const validatorA = requireAddress("VALIDATOR_A_ADDRESS");
const fund = process.argv.includes("--fund");
const fundValidator = process.argv.includes("--fund-validator");

async function registerAgents(): Promise<readonly bigint[]> {
  if (deployment.demoAgents.length > 0) return deployment.demoAgents;
  const ids: bigint[] = [];
  for (const n of [1, 2]) {
    const agentFile = encodeJsonDataUri({
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: `attest8004-demo-agent-${n}`,
      description: `Attest8004 demo agent ${n} on Monad testnet. Its hot key requests validations through the AgentRequestForwarder. Not a real agent.`,
      services: [],
      active: false,
    });
    const sent = await writeWithGasGuard({
      publicClient,
      walletClient: ownerWallet,
      address: identityRegistry,
      abi: identityAbi,
      functionName: "register",
      args: [agentFile.uri],
      gasLimit: GAS.register,
      label: `register agent ${n}`,
    });
    printTx(`register agent ${n}`, sent);
    const [registered] = parseEventLogs({ abi: identityAbi, eventName: "Registered", logs: sent.receipt.logs }).filter(
      (log) => getAddress(log.address) === identityRegistry,
    );
    if (!registered) throw new Error("no Registered event from the Identity Registry in the receipt");
    ids.push(registered.args.agentId);
  }
  console.log(`\nregistered demo agents ${ids.join(", ")}: record them as demoAgents in packages/sdk/src/deployments.ts\n`);
  return ids;
}

async function main(): Promise<void> {
  await assertChain();
  const [forwarderRegistry, forwarderIdentity] = await Promise.all([
    publicClient.readContract({ address: forwarder, abi: agentRequestForwarderAbi, functionName: "validationRegistry" }),
    publicClient.readContract({ address: forwarder, abi: agentRequestForwarderAbi, functionName: "identityRegistry" }),
  ]);
  console.log(`AgentRequestForwarder ${forwarder} (chain ${chain.id})`);
  console.log(`owner                 ${owner.address} (deployer)`);
  console.log("preflight");
  const registry = getAddress(deployment.validationRegistry);
  check("forwarder serves the ValidationRegistry", getAddress(forwarderRegistry) === registry, forwarderRegistry);
  check("forwarder reads the canonical Identity Registry", getAddress(forwarderIdentity) === identityRegistry, forwarderIdentity);

  // 1. Agents.
  const agents = await registerAgents();
  if (agents.length !== 2) throw new Error(`expected 2 demo agents, have ${agents.length}`);
  for (const id of agents) {
    const agentOwner = await publicClient.readContract({
      address: identityRegistry,
      abi: identityAbi,
      functionName: "ownerOf",
      args: [id],
    });
    check(`agent ${id} is owned by the deployer`, agentOwner === owner.address, agentOwner);
  }

  // 2. Least privilege: approve the forwarder per token, then revoke any blanket approval.
  for (const id of agents) {
    const approvedSpender = () =>
      publicClient.readContract({
        address: identityRegistry,
        abi: identityAbi,
        functionName: "getApproved",
        args: [id],
      });
    if ((await approvedSpender()) !== forwarder) {
      const sent = await writeWithGasGuard({
        publicClient,
        walletClient: ownerWallet,
        address: identityRegistry,
        abi: identityAbi,
        functionName: "approve",
        args: [forwarder, id],
        gasLimit: GAS.approve,
        label: `approve ${id}`,
      });
      printTx(`approve ${id}`, sent);
    }
    const spender = await approvedSpender();
    check(`agent ${id} approves only the forwarder (per-token)`, spender === forwarder, spender);
  }
  const blanketApproval = () =>
    publicClient.readContract({
      address: identityRegistry,
      abi: identityAbi,
      functionName: "isApprovedForAll",
      args: [owner.address, forwarder],
    });
  if (await blanketApproval()) {
    const sent = await writeWithGasGuard({
      publicClient,
      walletClient: ownerWallet,
      address: identityRegistry,
      abi: identityAbi,
      functionName: "setApprovalForAll",
      args: [forwarder, false],
      gasLimit: GAS.revokeApprovalForAll,
      label: "revoke setApprovalForAll",
    });
    printTx("revoke setApprovalForAll", sent);
  }
  const stillBlanket = await blanketApproval();
  check("the deployer's blanket approval for the forwarder is revoked", !stillBlanket, String(stillBlanket));

  // 3. Each agent's hot key, then 4. what a forwarded request costs from it.
  const latest = await publicClient.getBlock();
  for (const [i, id] of agents.entries()) {
    const hotKey = hotKeys[i] as Address;
    const keyOf = async () => {
      const [key, keyOwner] = await publicClient.readContract({
        address: forwarder,
        abi: agentRequestForwarderAbi,
        functionName: "agentKeyOf",
        args: [id],
      });
      return getAddress(key) === hotKey && getAddress(keyOwner) === owner.address;
    };
    if (!(await keyOf())) {
      const sent = await writeWithGasGuard({
        publicClient,
        walletClient: ownerWallet,
        address: forwarder,
        abi: agentRequestForwarderAbi,
        functionName: "setAgentKey",
        args: [id, hotKey],
        gasLimit: GAS.setAgentKey,
        label: `setAgentKey ${id}`,
      });
      printTx(`setAgentKey ${id}`, sent);
    }
    const keySet = await keyOf();
    check(`agent ${id}'s key is ${hotKey}, set by the deployer`, keySet, String(keySet));

    const request = buildRequestJson({
      chainId: chain.id,
      gate: getAddress(deployment.demoAgentVault),
      validator: validatorA,
      action: buildAction({ agentId: id, target: owner.address, value: 10n ** 15n, deadline: latest.timestamp + 600n }),
    });
    const estimate = await publicClient.estimateContractGas({
      address: forwarder,
      abi: agentRequestForwarderAbi,
      functionName: "request",
      args: [validatorA, id, encodeJsonDataUri(request).uri, requestHashOfJson(request)],
      account: hotKey,
    });
    console.log(`  forwarder.request from agent ${id}'s key: estimate ${estimate}, limit ${DEFAULT_GAS.forwarderRequest}`);
    if (estimate > DEFAULT_GAS.forwarderRequest) {
      throw new Error(`forwarder.request estimate ${estimate} is above DEFAULT_GAS.forwarderRequest`);
    }
  }

  // 5. Fund the hot keys for a few requests only.
  if (fund) {
    const { maxFeePerGas } = await publicClient.estimateFeesPerGas();
    const target = FUNDED_REQUESTS * DEFAULT_GAS.forwarderRequest * maxFeePerGas;
    for (const hotKey of hotKeys) {
      const balance = await publicClient.getBalance({ address: hotKey });
      if (balance >= target) {
        console.log(`  ${hotKey} holds ${mon(balance)} (target ${mon(target)})`);
        continue;
      }
      const sent = await sendWithGasGuard({
        publicClient,
        walletClient: ownerWallet,
        to: hotKey,
        value: target - balance,
        gasLimit: GAS.fund,
        label: `fund ${hotKey}`,
      });
      printTx(`fund ${hotKey.slice(0, 10)}…`, sent);
      console.log(`  ${hotKey} funded with ${mon(target - balance)} (now ${mon(target)}: ${FUNDED_REQUESTS} requests)`);
    }
  } else {
    console.log("\nhot keys not funded (re-run with --fund)");
  }

  // 6. Top up validator A so it can afford its gas budget.
  if (fundValidator) {
    const balance = await publicClient.getBalance({ address: validatorA });
    if (balance >= VALIDATOR_FUND_TARGET) {
      console.log(`  validator A ${validatorA} holds ${mon(balance)} (target ${mon(VALIDATOR_FUND_TARGET)})`);
    } else {
      const sent = await sendWithGasGuard({
        publicClient,
        walletClient: ownerWallet,
        to: validatorA,
        value: VALIDATOR_FUND_TARGET - balance,
        gasLimit: GAS.fund,
        label: "fund validator A",
      });
      printTx("fund validator A", sent);
      console.log(
        `  validator A funded with ${mon(VALIDATOR_FUND_TARGET - balance)} (now ${mon(VALIDATOR_FUND_TARGET)})`,
      );
    }
  } else {
    console.log("validator A not funded (re-run with --fund-validator)");
  }

  console.log("\nsetup OK");
}

// viem's shortMessage leaves out request details such as the RPC URL.
main().catch((error: unknown) => {
  const short = (error as { shortMessage?: string }).shortMessage;
  console.error(short ?? (error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
