/**
 * End to end on Monad testnet (SPEC §4.4, GAMEPLAN P3): an agent's hot key requests validation
 * through the AgentRequestForwarder, a validator built on the SDK's ValidatorBase answers it, and
 * the action executes through the DemoAgentVault for demo agent 1984.
 *
 *   1. Preflight: the vault (agent 1984, validator A at 100), the forwarder, the owner's approval
 *      and agent 1984's registered hot key, and the hot key's balance.
 *   2. Fund the vault with 0.01 MON if it holds less than the action's value.
 *   3. Build the action (0.001 MON from the vault to the deployer, deadline in 10 minutes).
 *   4. Simulate (never send) two refused requests: the owner, and agent 1985's hot key, calling the
 *      forwarder for agent 1984.
 *   5. Agent 1984's hot key calls Attest8004Client.requestValidation through the forwarder.
 *   6. A StubValidator (the SDK base with a stub check that passes only this run's request) polls
 *      from the request's block and responds once. A second, freshly started one re-reads the same
 *      blocks and must not post.
 *   7. awaitVerdict and isValidated confirm the verdict; the deployer submits execute (permissionless).
 *   8. Check the ActionConsumed event, the vault's balance and consumed(); a replay must be refused.
 *
 * Run: pnpm --filter @attest8004/scripts e2e   (Node loads ../.env into the environment)
 *
 * Keys come from environment variables and are never printed. Every transaction carries a literal
 * gas limit, checked against a fresh estimate before it is sent, and the script reads each sent
 * transaction back to confirm the limit it carried. The response is a smoke test: tag
 * attest8004-e2e-stub, and its evidence says no checks ran.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  parseAbi,
  parseEther,
  parseEventLogs,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  Attest8004Client,
  DEFAULT_GAS,
  MemoryCursorStore,
  agentRequestForwarderAbi,
  attestGateAbi,
  buildAction,
  computeActionHash,
  sendWithGasGuard,
  validationRegistryAbi,
  validationResponseEvent,
  viemValidatorChain,
  writeWithGasGuard,
  type Outcome,
  type ValidatorBase,
  type ValidatorChain,
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
import { DEPLOYMENTS } from "./deployments.ts";
import { STUB_TAG, StubValidator } from "./stub-validator.ts";

/**
 * Explicit gas limits (Monad charges for the limit): Monad testnet eth_estimateGas x 1.2, rounded up
 * to 1k. fund 21,212 and execute 87,626 (P2, and again on 3 Oct 2026 in P3). validationResponse
 * with the stub's evidence: 86,765 (3 Oct 2026; that run used a provisional 140,000). The forwarded
 * request uses the SDK's DEFAULT_GAS.forwarderRequest.
 */
const GAS = {
  fund: 26_000n,
  validationResponse: 105_000n,
  execute: 106_000n,
} as const;

const ACTION_VALUE = parseEther("0.001");
const FUND_VALUE = parseEther("0.01");
const MIN_SCORE = 100;
const TIMEOUT_MS = 120_000;

const identityAbi = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
]);
const vaultAbi = [
  ...attestGateAbi,
  ...parseAbi([
    "struct Action { uint256 agentId; address target; uint256 value; bytes data; uint64 deadline; bytes32 salt; }",
    "function execute(Action action) returns (bytes result)",
    "function agentId() view returns (uint256)",
    "error NotVaultAgent(uint256 vaultAgentId, uint256 actionAgentId)",
    "error CallFailed(bytes returnData)",
    "error ReentrancyGuardReentrantCall()",
  ]),
] as const;

const deployment = DEPLOYMENTS[chain.id];
const registry = getAddress(deployment.validationRegistry);
const forwarder = getAddress(deployment.agentRequestForwarder);
const vault = getAddress(deployment.demoAgentVault);
const identityRegistry = getAddress(deployment.identityRegistry);
const [agentId, otherAgentId] = deployment.demoAgents as readonly [bigint, bigint];

const owner = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);
const hotKey = privateKeyToAccount(requireEnv("DEMO_AGENT_1_HOT_PRIVATE_KEY") as Hex);
const otherHotKey = requireAddress("DEMO_AGENT_2_HOT_ADDRESS");
const validator = privateKeyToAccount(requireEnv("VALIDATOR_A_PRIVATE_KEY") as Hex);
if (requireAddress("DEMO_AGENT_1_HOT_ADDRESS") !== hotKey.address) {
  throw new Error("DEMO_AGENT_1_HOT_ADDRESS does not match DEMO_AGENT_1_HOT_PRIVATE_KEY");
}
if (process.env.VALIDATOR_A_ADDRESS && getAddress(process.env.VALIDATOR_A_ADDRESS) !== validator.address) {
  throw new Error("VALIDATOR_A_ADDRESS does not match VALIDATOR_A_PRIVATE_KEY");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Simulates a call and checks that it reverts with `errorName`. Sends nothing. */
async function expectRevert(
  label: string,
  call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
  account: Address,
  errorName: string,
): Promise<void> {
  try {
    await publicClient.simulateContract({ ...call, account } as never);
  } catch (error) {
    const reverted = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    const name = reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
    check(`${label} reverts ${errorName} (simulated)`, name === errorName, name ?? String(error));
    return;
  }
  throw new Error(`check failed: ${label} (the simulation succeeded)`);
}

/** Confirms a sent transaction carried exactly the explicit limit, and came from `from`. */
async function checkSent(label: string, hash: Hash, from: Address, gasLimit: bigint): Promise<void> {
  const tx = await publicClient.getTransaction({ hash });
  const sender = getAddress(tx.from); // the RPC returns it lower-case
  check(`${label} was sent by ${from} with gas limit ${gasLimit}`, sender === from && tx.gas === gasLimit, `${sender}, ${tx.gas}`);
}

/** Polls `validator` until an outcome for `requestHash` matches, or times out. */
async function pollUntil(validator: ValidatorBase, requestHash: Hex, want: (o: Outcome) => boolean): Promise<Outcome> {
  const giveUpAt = Date.now() + TIMEOUT_MS;
  for (;;) {
    const { outcomes, caughtUp } = await validator.pollOnce();
    const outcome = outcomes.find((o) => o.requestHash === requestHash);
    if (outcome) {
      if (!want(outcome)) throw new Error(`unexpected outcome for ${requestHash}: ${JSON.stringify(outcome)}`);
      return outcome;
    }
    if (Date.now() > giveUpAt) throw new Error(`no outcome for ${requestHash} within ${TIMEOUT_MS} ms`);
    if (caughtUp) await sleep(500);
  }
}

/** Monad's estimate for each response the stub sends, taken with its exact arguments. */
const responseEstimates: bigint[] = [];

function stubValidator(fromBlock: bigint, requestHash: Hex, name: string): StubValidator {
  const port = viemValidatorChain({
    publicClient,
    walletClient: walletFor(validator),
    validationRegistry: registry,
    gasLimit: GAS.validationResponse,
  });
  const measured: ValidatorChain = {
    ...port,
    async respond(response) {
      const { requestHash, response: score, responseURI, responseHash, tag } = response;
      responseEstimates.push(
        await publicClient.estimateContractGas({
          address: registry,
          abi: validationRegistryAbi,
          functionName: "validationResponse",
          args: [requestHash, score, responseURI, responseHash, tag],
          account: validator.address,
        }),
      );
      return port.respond(response);
    },
  };
  return new StubValidator({
    chain: measured,
    tag: STUB_TAG,
    cursor: new MemoryCursorStore(fromBlock - 1n),
    onlyRequestHashes: [requestHash],
    log: (entry) => console.log(`    ${name}: ${JSON.stringify(entry)}`),
  });
}

async function main(): Promise<void> {
  // 1. Preflight.
  await assertChain();
  const read = <const F extends "validationRegistry" | "requirements" | "agentId">(functionName: F) =>
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName });
  const [vaultRegistry, requirements, vaultAgent, forwarderRegistry, approved, agentOwner, agentKey, hotBalance, fees] =
    await Promise.all([
      read("validationRegistry"),
      read("requirements"),
      read("agentId"),
      publicClient.readContract({ address: forwarder, abi: agentRequestForwarderAbi, functionName: "validationRegistry" }),
      publicClient.readContract({
        address: identityRegistry,
        abi: identityAbi,
        functionName: "isApprovedForAll",
        args: [owner.address, forwarder],
      }),
      publicClient.readContract({ address: identityRegistry, abi: identityAbi, functionName: "ownerOf", args: [agentId] }),
      publicClient.readContract({ address: forwarder, abi: agentRequestForwarderAbi, functionName: "agentKeyOf", args: [agentId] }),
      publicClient.getBalance({ address: hotKey.address }),
      publicClient.estimateFeesPerGas(),
    ]);

  console.log(`DemoAgentVault        ${vault} (chain ${chain.id})`);
  console.log(`AgentRequestForwarder ${forwarder}`);
  console.log(`ValidationRegistry    ${registry}`);
  console.log(`agent                 ${agentId}, owner ${owner.address} (deployer), hot key ${hotKey.address}`);
  console.log(`validator             ${validator.address} (validator A, stub check)\n`);
  console.log("preflight");
  check("vault reads the ValidationRegistry", getAddress(vaultRegistry) === registry, vaultRegistry);
  check(`vault is bound to agent ${agentId}`, vaultAgent === agentId, String(vaultAgent));
  const [requirement] = requirements;
  check(
    `vault requires exactly validator A at ${MIN_SCORE}`,
    requirements.length === 1 && requirement?.validator === validator.address && requirement.minScore === MIN_SCORE,
    JSON.stringify(requirements),
  );
  check("forwarder serves the ValidationRegistry", getAddress(forwarderRegistry) === registry, forwarderRegistry);
  check(`agent ${agentId} is owned by the deployer`, agentOwner === owner.address, agentOwner);
  check("the deployer approved the forwarder", approved, String(approved));
  check(
    `agent ${agentId}'s forwarder key is the hot key, set by the deployer`,
    agentKey[0] === hotKey.address && agentKey[1] === owner.address,
    agentKey.join(", "),
  );
  const requestCost = DEFAULT_GAS.forwarderRequest * fees.maxFeePerGas;
  check(`the hot key can pay for a request (${mon(requestCost)})`, hotBalance >= requestCost, mon(hotBalance));

  // 2. Fund the vault if needed.
  const txs: Record<string, Hash> = {};
  const ownerWallet = walletFor(owner);
  if ((await publicClient.getBalance({ address: vault })) < ACTION_VALUE) {
    const sent = await sendWithGasGuard({
      publicClient,
      walletClient: ownerWallet,
      to: vault,
      value: FUND_VALUE,
      gasLimit: GAS.fund,
      label: "fund vault",
    });
    printTx("fund vault", sent);
    txs.fund = sent.hash;
  }
  const balanceBefore = await publicClient.getBalance({ address: vault });

  // 3. The action.
  const latest = await publicClient.getBlock();
  const action = buildAction({ agentId, target: owner.address, value: ACTION_VALUE, deadline: latest.timestamp + 600n });
  const actionHash = computeActionHash({ chainId: chain.id, gate: vault, action });

  // 4. Only the agent's own key may request through the forwarder.
  console.log("\nforwarder refusals");
  const forwarded = (args: readonly unknown[]) =>
    ({ address: forwarder, abi: agentRequestForwarderAbi, functionName: "request", args }) as const;
  const sample = [validator.address, agentId, "data:application/json,{}", actionHash] as const;
  await expectRevert("the owner calling forwarder.request", forwarded(sample), owner.address, "NotAgentKey");
  await expectRevert(`agent ${otherAgentId}'s hot key requesting for agent ${agentId}`, forwarded(sample), otherHotKey, "NotAgentKey");

  // 5. The hot key requests validation through the forwarder.
  console.log("\nrequest (agent hot key -> forwarder -> registry)");
  const client = new Attest8004Client({
    publicClient,
    walletClient: walletFor(hotKey),
    validationRegistry: registry,
    forwarder,
  });
  const [requested] = await client.requestValidation({ gate: vault, validators: [validator.address], action });
  if (!requested) throw new Error("requestValidation returned nothing");
  txs.request = requested.txHash;
  console.log(`forwarder.request      ${requested.txHash}  block ${requested.blockNumber}`);
  const { requestHash } = requested;
  const [onchainRequestHash, status] = await Promise.all([
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "requestHashOf", args: [action, validator.address] }),
    publicClient.readContract({ address: registry, abi: validationRegistryAbi, functionName: "getValidationStatus", args: [requestHash] }),
  ]);
  check("the SDK's requestHash equals the vault's", requestHash === onchainRequestHash, onchainRequestHash);
  check(`the registry recorded validator A and agent ${agentId}`, status[0] === validator.address && status[1] === agentId, `${status[0]}, ${status[1]}`);
  await checkSent("the request", requested.txHash, hotKey.address, DEFAULT_GAS.forwarderRequest);

  // 6. The stub validator answers; a restarted one doesn't answer again.
  console.log("\nvalidator (SDK ValidatorBase, polling eth_getLogs up to the finalized block)");
  const responded = await pollUntil(stubValidator(requested.blockNumber, requestHash, "validator"), requestHash, (o) => o.kind === "responded");
  if (responded.kind !== "responded") throw new Error("unreachable");
  txs.response = responded.txHash;
  await checkSent("the response", responded.txHash, validator.address, GAS.validationResponse);

  console.log("\nrestart (a fresh validator re-reads the same blocks)");
  const again = await pollUntil(stubValidator(requested.blockNumber, requestHash, "restarted"), requestHash, () => true);
  check("the restarted validator skips it: ALREADY_RESPONDED", again.kind === "skipped" && again.reason === "ALREADY_RESPONDED", JSON.stringify(again));
  const head = await publicClient.getBlockNumber();
  const responses = [];
  for (let from = requested.blockNumber; from <= head; from += 100n) {
    responses.push(
      ...(await publicClient.getLogs({
        address: registry,
        event: validationResponseEvent,
        args: { requestHash },
        fromBlock: from,
        toBlock: from + 99n < head ? from + 99n : head,
      })),
    );
  }
  check("exactly one ValidationResponse for the request", responses.length === 1, String(responses.length));

  // 7. The client sees the verdict, then anyone may execute.
  console.log("\nverdict and execute");
  const verdict = await client.awaitVerdict({ requestHash, fromBlock: requested.blockNumber, timeoutMs: 60_000 });
  check(
    `awaitVerdict: 100 from validator A, tag ${STUB_TAG}`,
    verdict.response === 100 && verdict.validator === validator.address && verdict.tag === STUB_TAG,
    JSON.stringify({ response: verdict.response, validator: verdict.validator, tag: verdict.tag }),
  );
  check("isValidated before execute", await client.isValidated({ gate: vault, action }), "false");
  const executed = await writeWithGasGuard({
    publicClient,
    walletClient: ownerWallet,
    address: vault,
    abi: vaultAbi,
    functionName: "execute",
    args: [action],
    gasLimit: GAS.execute,
    label: "execute",
  });
  printTx("execute", executed);
  txs.execute = executed.hash;
  await checkSent("execute", executed.hash, owner.address, GAS.execute);

  // 8. Effects, and a replay.
  const consumedLogs = parseEventLogs({ abi: vaultAbi, eventName: "ActionConsumed", logs: executed.receipt.logs }).filter(
    (log) => getAddress(log.address) === vault,
  );
  check(
    `ActionConsumed(actionHash, ${agentId}) emitted by the vault`,
    consumedLogs.length === 1 && consumedLogs[0]?.args.actionHash === actionHash && consumedLogs[0].args.agentId === agentId,
    `${consumedLogs.length} log(s)`,
  );
  const balanceAfter = await publicClient.getBalance({ address: vault });
  check("vault balance fell by exactly the action's value", balanceBefore - balanceAfter === ACTION_VALUE, `${balanceBefore} -> ${balanceAfter}`);
  const consumed = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "consumed", args: [actionHash] });
  check("consumed(actionHash) is true", consumed, String(consumed));
  await expectRevert("a replay", { address: vault, abi: vaultAbi, functionName: "execute", args: [action] }, owner.address, "ActionAlreadyConsumed");
  check("isValidated after execute is false", !(await client.isValidated({ gate: vault, action })), "true");

  console.log("\ne2e OK");
  console.log(
    JSON.stringify(
      {
        chainId: chain.id,
        vault,
        forwarder,
        validationRegistry: registry,
        agentId: agentId.toString(),
        hotKey: hotKey.address,
        validator: validator.address,
        actionHash,
        requestHash,
        txs,
        gas: {
          forwarderRequest: { limit: DEFAULT_GAS.forwarderRequest.toString() },
          validationResponse: { limit: GAS.validationResponse.toString(), estimate: responseEstimates[0]?.toString() },
          execute: { limit: GAS.execute.toString(), estimate: executed.estimate.toString() },
        },
      },
      null,
      2,
    ),
  );
}

// viem's shortMessage leaves out request details such as the RPC URL.
main().catch((error: unknown) => {
  const short = (error as { shortMessage?: string }).shortMessage;
  console.error(short ?? (error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
