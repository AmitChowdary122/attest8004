/**
 * One ERC-8004 validation round trip on Monad testnet against the deployed ValidationRegistry
 * (SPEC §4.1, "Done when"):
 *
 *   1. The deployer wallet registers a test agent in the canonical Identity Registry.
 *   2. As the agent's owner, it calls validationRequest, naming validator A.
 *   3. Validator A calls validationResponse(requestHash, 100, …).
 *   4. The script reads getValidationStatus and getSummary back and checks them.
 *
 * Run: pnpm --filter @attest8004/scripts roundtrip   (Node loads ../.env into the environment)
 *
 * Keys come from environment variables and are never printed. Every transaction carries a
 * literal gas limit, because Monad charges for the gas limit rather than the gas used; before
 * sending, the script estimates again and aborts if the estimate is above the limit.
 * The response is a smoke test of the registry, not a real validation: the evidence says so.
 */
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseEventLogs,
  stringToBytes,
  toHex,
  type Account,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { DEPLOYMENTS } from "@attest8004/sdk";
import { printableError } from "./demo-text.ts";

/**
 * Explicit gas limits (Monad charges for the limit): Monad testnet eth_estimateGas on 2 Oct 2026
 * x 1.2, rounded up to 1k. Estimates: register 410,457; validationRequest 235,881;
 * validationResponse 84,212 (measured in the first round trip, which ran with a provisional
 * 165,000). The script's estimate guard re-checks each limit before sending.
 */
const GAS = {
  register: 493_000n,
  validationRequest: 284_000n,
  validationResponse: 102_000n,
} as const;

const TAG = "attest8004-roundtrip";
const SCORE = 100;

const identityAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
  "error ERC721NonexistentToken(uint256 tokenId)",
]);

const validationAbi = parseAbi([
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)",
  "function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)",
  "function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)",
  "function getSummary(uint256 agentId, address[] validatorAddresses, string tag) view returns (uint64 count, uint8 averageResponse)",
  "function getIdentityRegistry() view returns (address)",
  "error ZeroValidator()",
  "error RequestExists(bytes32 requestHash)",
  "error NotAgentOwnerOrOperator(uint256 agentId, address caller)",
  "error UnknownRequest(bytes32 requestHash)",
  "error NotRequestedValidator(bytes32 requestHash, address caller)",
  "error ResponseOutOfRange(uint8 response)",
]);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (expected in .env)`);
  return value;
}

/** A JSON document as a base64 data: URI, plus keccak256 of its exact bytes (the EIP's commitment). */
function jsonDataUri(doc: unknown): { uri: string; hash: Hex } {
  const text = JSON.stringify(doc);
  return {
    uri: `data:application/json;base64,${Buffer.from(text, "utf8").toString("base64")}`,
    hash: keccak256(stringToBytes(text)),
  };
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

async function main(): Promise<void> {
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== chain.id) throw new Error(`RPC is on chain ${rpcChainId}, expected ${chain.id}`);
  const configuredIdentity = await publicClient.readContract({
    address: validationRegistry,
    abi: validationAbi,
    functionName: "getIdentityRegistry",
  });
  if (getAddress(configuredIdentity) !== getAddress(identityRegistry)) {
    throw new Error(`${validationRegistry} points at Identity Registry ${configuredIdentity}, expected ${identityRegistry}`);
  }

  console.log(`ValidationRegistry ${validationRegistry} (chain ${chain.id})`);
  console.log(`agent owner        ${owner.address} (deployer)`);
  console.log(`validator          ${validator.address} (validator A)\n`);

  // 1. Register a test agent. agentId comes from the Registered event, not from a simulation,
  //    because other teams register agents in the same shared registry.
  const agentFile = jsonDataUri({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "attest8004-p1-roundtrip",
    description: "Attest8004 P1 test agent, used only to exercise the ValidationRegistry round trip. Not a real agent.",
    services: [],
    active: false,
  });
  const registerCall = {
    address: identityRegistry,
    abi: identityAbi,
    functionName: "register",
    args: [agentFile.uri],
  } as const;
  const { request: registerRequest } = await publicClient.simulateContract({ ...registerCall, account: owner });
  const registerEstimate = await publicClient.estimateContractGas({ ...registerCall, account: owner });
  const registerGas = guardGas("register", registerEstimate);
  const registerTx = await walletFor(owner).writeContract({ ...registerRequest, gas: registerGas });
  const registerReceipt = await confirm("register", registerTx, registerGas, registerEstimate);
  const [registered] = parseEventLogs({ abi: identityAbi, eventName: "Registered", logs: registerReceipt.logs });
  if (!registered) throw new Error("no Registered event in the register receipt");
  const agentId = registered.args.agentId;

  // 2. Request validation from validator A. requestHash = keccak256 of the request payload (EIP-8004).
  const request = jsonDataUri({
    schema: "attest8004.roundtrip.v0",
    purpose: "P1 smoke test of validationRequest -> validationResponse",
    chainId: chain.id,
    validationRegistry,
    agentId: agentId.toString(),
    validator: validator.address,
    nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
  });
  const requestCall = {
    address: validationRegistry,
    abi: validationAbi,
    functionName: "validationRequest",
    args: [validator.address, agentId, request.uri, request.hash],
  } as const;
  const { request: requestRequest } = await publicClient.simulateContract({ ...requestCall, account: owner });
  const requestEstimate = await publicClient.estimateContractGas({ ...requestCall, account: owner });
  const requestGas = guardGas("validationRequest", requestEstimate);
  const requestTx = await walletFor(owner).writeContract({ ...requestRequest, gas: requestGas });
  await confirm("validationRequest", requestTx, requestGas, requestEstimate);

  // 3. Validator A responds.
  const evidence = jsonDataUri({
    schema: "attest8004.roundtrip-evidence.v0",
    requestHash: request.hash,
    score: SCORE,
    note: "Round-trip smoke test of the registry. No checks were run; this is not a validation verdict.",
  });
  const responseCall = {
    address: validationRegistry,
    abi: validationAbi,
    functionName: "validationResponse",
    args: [request.hash, SCORE, evidence.uri, evidence.hash, TAG],
  } as const;
  const { request: responseRequest } = await publicClient.simulateContract({ ...responseCall, account: validator });
  const responseEstimate = await publicClient.estimateContractGas({ ...responseCall, account: validator });
  const responseGas = guardGas("validationResponse", responseEstimate);
  const responseTx = await walletFor(validator).writeContract({ ...responseRequest, gas: responseGas });
  await confirm("validationResponse", responseTx, responseGas, responseEstimate);

  // 4. Read back and check.
  console.log("\nchecks");
  const [statusValidator, statusAgentId, statusResponse, statusResponseHash, statusTag] =
    await publicClient.readContract({
      address: validationRegistry,
      abi: validationAbi,
      functionName: "getValidationStatus",
      args: [request.hash],
    });
  check("status.validatorAddress is validator A", statusValidator === validator.address, statusValidator);
  check("status.agentId is the new agent", statusAgentId === agentId, statusAgentId.toString());
  check(`status.response is ${SCORE}`, statusResponse === SCORE, String(statusResponse));
  check("status.responseHash commits to the evidence", statusResponseHash === evidence.hash, statusResponseHash);
  check(`status.tag is "${TAG}"`, statusTag === TAG, statusTag);

  const [count, averageResponse] = await publicClient.readContract({
    address: validationRegistry,
    abi: validationAbi,
    functionName: "getSummary",
    args: [agentId, [validator.address], TAG],
  });
  check(`getSummary is (1, ${SCORE})`, count === 1n && averageResponse === SCORE, `${count}, ${averageResponse}`);

  console.log("\nround trip OK");
  console.log(
    JSON.stringify(
      {
        chainId: chain.id,
        validationRegistry,
        agentId: agentId.toString(),
        requestHash: request.hash,
        txs: { register: registerTx, validationRequest: requestTx, validationResponse: responseTx },
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  // viem's full message carries the request's URL, which may hold a key (P12, AUD-15): the short, redacted form only.
  console.error(printableError(error));
  process.exitCode = 1;
});
