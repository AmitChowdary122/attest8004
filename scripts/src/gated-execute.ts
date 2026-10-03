/**
 * One validated execute on Monad testnet through the deployed DemoAgentVault (SPEC §4.3, GAMEPLAN P2):
 *
 *   1. Preflight: the chain, the vault's registry, agent and requirements, and agent 1982's owner.
 *   2. Fund the vault with 0.01 MON if it holds less than the action's value.
 *   3. Build an action (0.001 MON from the vault to the deployer) and check that the SDK's
 *      actionHash and requestHash equal the vault's own (eth_call).
 *   4. The agent's owner (the deployer) calls validationRequest, naming validator A, with the
 *      request JSON v1 as a data: URI. Validator A responds 100.
 *   5. execute(action), then check the ActionConsumed event, the vault balance and consumed().
 *
 * Along the way it shows, by simulation only, that the gate refuses the action before validation,
 * while the request is pending, for a different action, and on replay. Reverted transactions are
 * never sent: Monad charges the full gas limit even when a transaction reverts.
 *
 * Run: pnpm --filter @attest8004/scripts gated-execute   (Node loads ../.env into the environment)
 *
 * Keys come from environment variables and are never printed. Every transaction carries a literal
 * gas limit and is checked against a fresh estimate before it is sent. The response is a smoke
 * test of the gate, not a mandate-v1 verdict: no checks run, and the evidence says so.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  parseEther,
  parseEventLogs,
  toHex,
  type Account,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import {
  buildRequestJson,
  computeActionHash,
  computeRequestHash,
  encodeJsonDataUri,
  type Action,
} from "@attest8004/sdk";
import { DEPLOYMENTS } from "./deployments.ts";

/**
 * Explicit gas limits (Monad charges for the limit): Monad testnet eth_estimateGas on 3 Oct 2026
 * x 1.2, rounded up to 1k. Estimates: fund 21,212; validationRequest 202,643; validationResponse
 * 84,514; execute 87,626 (measured in the first run, which used provisional limits of 30,000,
 * 400,000, 165,000 and 250,000). The script's estimate guard re-checks each limit before sending.
 */
const GAS = {
  fund: 26_000n,
  validationRequest: 244_000n,
  validationResponse: 102_000n,
  execute: 106_000n,
} as const;

const AGENT_ID = 1982n;
const MIN_SCORE = 100;
const SCORE = 100;
const TAG = "attest8004-gate-smoke";
const ACTION_VALUE = parseEther("0.001");
const FUND_VALUE = parseEther("0.01");

const identityAbi = parseAbi(["function ownerOf(uint256 agentId) view returns (address)"]);

const validationAbi = parseAbi([
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
  "error RequestExists(bytes32 requestHash)",
  "error NotAgentOwnerOrOperator(uint256 agentId, address caller)",
  "error UnknownRequest(bytes32 requestHash)",
  "error NotRequestedValidator(bytes32 requestHash, address caller)",
]);

const vaultAbi = parseAbi([
  "struct Action { uint256 agentId; address target; uint256 value; bytes data; uint64 deadline; bytes32 salt; }",
  "struct Requirement { address validator; uint8 minScore; }",
  "function execute(Action action) returns (bytes result)",
  "function actionHashOf(Action action) view returns (bytes32)",
  "function requestHashOf(Action action, address validator) view returns (bytes32)",
  "function consumed(bytes32 actionHash) view returns (bool)",
  "function agentId() view returns (uint256)",
  "function validationRegistry() view returns (address)",
  "function requirements() view returns (Requirement[])",
  "event ActionConsumed(bytes32 indexed actionHash, uint256 indexed agentId)",
  "error ActionExpired(uint64 deadline, uint256 timestamp)",
  "error ActionAlreadyConsumed(bytes32 actionHash)",
  "error ValidationNotFound(address validator, bytes32 requestHash)",
  "error ValidatorMismatch(bytes32 requestHash, address expected, address actual)",
  "error AgentMismatch(bytes32 requestHash, uint256 expected, uint256 actual)",
  "error ScoreTooLow(address validator, bytes32 requestHash, uint8 response, uint8 minScore)",
  "error NotVaultAgent(uint256 vaultAgentId, uint256 actionAgentId)",
  "error CallFailed(bytes returnData)",
  "error ReentrancyGuardReentrantCall()",
]);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (expected in .env)`);
  return value;
}

function check(label: string, ok: boolean, detail: string): void {
  if (!ok) throw new Error(`check failed: ${label} (${detail})`);
  console.log(`  ok  ${label}`);
}

const chain = monadTestnet;
const rpcUrl = requireEnv("MONAD_TESTNET_RPC_URL");
const deployment = DEPLOYMENTS[chain.id];
const identityRegistry = deployment.identityRegistry;
const validationRegistry = getAddress(process.env.VALIDATION_REGISTRY || deployment.validationRegistry);
const vault = getAddress(process.env.DEMO_AGENT_VAULT || deployment.demoAgentVault);

const owner = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);
const validator = privateKeyToAccount(requireEnv("VALIDATOR_A_PRIVATE_KEY") as Hex);
const expectedValidator = process.env.VALIDATOR_A_ADDRESS;
if (expectedValidator && getAddress(expectedValidator) !== validator.address) {
  throw new Error("VALIDATOR_A_ADDRESS does not match VALIDATOR_A_PRIVATE_KEY");
}

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletFor = (account: Account) => createWalletClient({ account, chain, transport: http(rpcUrl) });

/** Aborts before sending if the node's current estimate is above the explicit limit. */
function guardGas(label: keyof typeof GAS, estimate: bigint): bigint {
  const limit = GAS[label];
  if (estimate > limit) {
    throw new Error(`${label}: estimate ${estimate} is above the explicit gas limit ${limit}; raise GAS.${label}`);
  }
  return limit;
}

async function confirm(label: string, hash: Hash, limit: bigint, estimate: bigint) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label}: transaction ${hash} reverted`);
  console.log(`${label.padEnd(19)} ${hash}  block ${receipt.blockNumber}, gas limit ${limit} (estimate ${estimate})`);
  return receipt;
}

/** Simulates `execute(action)` and checks that the gate reverts with `errorName`. Sends nothing. */
async function expectGateRevert(label: string, action: Action, errorName: string): Promise<void> {
  try {
    await publicClient.simulateContract({
      address: vault,
      abi: vaultAbi,
      functionName: "execute",
      args: [action],
      account: owner,
    });
  } catch (error) {
    const reverted =
      error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    const name = reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
    const detail = name ?? (error instanceof BaseError ? error.shortMessage : String(error));
    check(`${label} reverts ${errorName} (simulated)`, name === errorName, detail);
    return;
  }
  throw new Error(`check failed: ${label} (the simulated execute succeeded)`);
}

async function main(): Promise<void> {
  // 1. Preflight.
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== chain.id) throw new Error(`RPC is on chain ${rpcChainId}, expected ${chain.id}`);
  const read = <const F extends "validationRegistry" | "agentId" | "requirements">(functionName: F) =>
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName });
  const [vaultRegistry, vaultAgentId, requirements, agentOwner] = await Promise.all([
    read("validationRegistry"),
    read("agentId"),
    read("requirements"),
    publicClient.readContract({
      address: identityRegistry,
      abi: identityAbi,
      functionName: "ownerOf",
      args: [AGENT_ID],
    }),
  ]);

  console.log(`DemoAgentVault     ${vault} (chain ${chain.id})`);
  console.log(`ValidationRegistry ${validationRegistry}`);
  console.log(`agent              ${AGENT_ID}, owner ${owner.address} (deployer)`);
  console.log(`validator          ${validator.address} (validator A)\n`);
  console.log("preflight");
  check("vault reads the ValidationRegistry", getAddress(vaultRegistry) === validationRegistry, vaultRegistry);
  check(`vault is bound to agent ${AGENT_ID}`, vaultAgentId === AGENT_ID, String(vaultAgentId));
  const [requirement] = requirements;
  check(
    `vault requires exactly validator A at ${MIN_SCORE}`,
    requirements.length === 1 && requirement?.validator === validator.address && requirement.minScore === MIN_SCORE,
    JSON.stringify(requirements),
  );
  check(`agent ${AGENT_ID} is owned by the deployer`, agentOwner === owner.address, agentOwner);

  // 2. Fund the vault if needed.
  const txs: Record<string, Hash> = {};
  if ((await publicClient.getBalance({ address: vault })) < ACTION_VALUE) {
    const estimate = await publicClient.estimateGas({ account: owner, to: vault, value: FUND_VALUE });
    const gas = guardGas("fund", estimate);
    txs.fund = await walletFor(owner).sendTransaction({ to: vault, value: FUND_VALUE, gas });
    await confirm("fund vault", txs.fund, gas, estimate);
  }
  const balanceBefore = await publicClient.getBalance({ address: vault });

  // 3. The action, and the SDK's hashes checked against the vault's.
  const latest = await publicClient.getBlock();
  const action: Action = {
    agentId: AGENT_ID,
    target: owner.address,
    value: ACTION_VALUE,
    data: "0x",
    deadline: latest.timestamp + 3600n,
    salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const actionHash = computeActionHash({ chainId: chain.id, gate: vault, action });
  const requestHash = computeRequestHash({ chainId: chain.id, gate: vault, validator: validator.address, action });
  const [onchainActionHash, onchainRequestHash] = await Promise.all([
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "actionHashOf", args: [action] }),
    publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "requestHashOf",
      args: [action, validator.address],
    }),
  ]);
  check("SDK actionHash equals the vault's", actionHash === onchainActionHash, onchainActionHash);
  check("SDK requestHash equals the vault's", requestHash === onchainRequestHash, onchainRequestHash);
  await expectGateRevert("unvalidated action", action, "ValidationNotFound");

  // 4. Request validation from validator A, with the request JSON v1 (ARCHITECTURE §6).
  const request = encodeJsonDataUri(
    buildRequestJson({ chainId: chain.id, gate: vault, validator: validator.address, action }),
  );
  const requestCall = {
    address: validationRegistry,
    abi: validationAbi,
    functionName: "validationRequest",
    args: [validator.address, action.agentId, request.uri, requestHash],
  } as const;
  const { request: requestRequest } = await publicClient.simulateContract({ ...requestCall, account: owner });
  const requestEstimate = await publicClient.estimateContractGas({ ...requestCall, account: owner });
  const requestGas = guardGas("validationRequest", requestEstimate);
  txs.validationRequest = await walletFor(owner).writeContract({ ...requestRequest, gas: requestGas });
  await confirm("validationRequest", txs.validationRequest, requestGas, requestEstimate);
  await expectGateRevert("pending request", action, "ScoreTooLow");

  const evidence = encodeJsonDataUri({
    schema: "attest8004.gate-smoke-evidence.v0",
    requestHash,
    score: SCORE,
    note: "P2 smoke test of AttestGate on testnet. No mandate or risk checks were run; this is not a validation verdict.",
  });
  const responseCall = {
    address: validationRegistry,
    abi: validationAbi,
    functionName: "validationResponse",
    args: [requestHash, SCORE, evidence.uri, evidence.hash, TAG],
  } as const;
  const { request: responseRequest } = await publicClient.simulateContract({ ...responseCall, account: validator });
  const responseEstimate = await publicClient.estimateContractGas({ ...responseCall, account: validator });
  const responseGas = guardGas("validationResponse", responseEstimate);
  txs.validationResponse = await walletFor(validator).writeContract({ ...responseRequest, gas: responseGas });
  await confirm("validationResponse", txs.validationResponse, responseGas, responseEstimate);
  const different = { ...action, value: action.value + 1n };
  await expectGateRevert("a different action (value + 1 wei)", different, "ValidationNotFound");

  // 5. Execute.
  const executeCall = { address: vault, abi: vaultAbi, functionName: "execute", args: [action] } as const;
  const { request: executeRequest } = await publicClient.simulateContract({ ...executeCall, account: owner });
  const executeEstimate = await publicClient.estimateContractGas({ ...executeCall, account: owner });
  const executeGas = guardGas("execute", executeEstimate);
  txs.execute = await walletFor(owner).writeContract({ ...executeRequest, gas: executeGas });
  const executeReceipt = await confirm("execute", txs.execute, executeGas, executeEstimate);

  console.log("\nchecks");
  const consumedLogs = parseEventLogs({
    abi: vaultAbi,
    eventName: "ActionConsumed",
    logs: executeReceipt.logs,
  }).filter((log) => getAddress(log.address) === vault);
  const [consumedLog] = consumedLogs;
  check(
    `ActionConsumed(actionHash, ${AGENT_ID}) emitted by the vault`,
    consumedLogs.length === 1 && consumedLog?.args.actionHash === actionHash && consumedLog.args.agentId === AGENT_ID,
    `${consumedLogs.length} log(s), first: ${consumedLog?.args.actionHash}`,
  );
  const balanceAfter = await publicClient.getBalance({ address: vault });
  check(
    "vault balance fell by exactly the action's value",
    balanceBefore - balanceAfter === ACTION_VALUE,
    `${balanceBefore} -> ${balanceAfter}`,
  );
  const consumed = await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: "consumed",
    args: [actionHash],
  });
  check("consumed(actionHash) is true", consumed, String(consumed));
  await expectGateRevert("replay", action, "ActionAlreadyConsumed");

  console.log("\ngated execute OK");
  console.log(
    JSON.stringify(
      {
        chainId: chain.id,
        vault,
        validationRegistry,
        agentId: AGENT_ID.toString(),
        validator: validator.address,
        actionHash,
        requestHash,
        txs,
        gas: {
          validationRequest: { limit: requestGas.toString(), estimate: requestEstimate.toString() },
          validationResponse: { limit: responseGas.toString(), estimate: responseEstimate.toString() },
          execute: { limit: executeGas.toString(), estimate: executeEstimate.toString() },
        },
      },
      null,
      2,
    ),
  );
}

// viem's shortMessage leaves out request details such as the RPC URL.
main().catch((error: unknown) => {
  console.error(error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
