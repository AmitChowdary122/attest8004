// The risk-v1 validator service (validator B): `pnpm --filter @attest8004/validator-risk start`.
// Reads its settings from the repo's .env (see .env.example), checks the chain, the contracts it reads
// and that its key is the recorded validator B, then polls until SIGINT or SIGTERM. Run one process
// per validator key: the pin relies on knowing this key's last response. Logs are JSON lines; the
// keys and URLs are never logged (only the RPC's and the LLM endpoint's hosts, and the model).
import {
  Admission,
  deploymentsFor,
  jsonLineLog,
  mandateRegistryAbi,
  validationRegistryAbi,
  viemValidatorChain,
} from "@attest8004/sdk";
import { FileCursorStore } from "@attest8004/sdk/node";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseError, createPublicClient, createWalletClient, getAddress, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { parseRiskServiceConfig } from "./config.ts";
import { chatPromptGuard } from "./guard.ts";
import { openAiCompatibleClient } from "./llm.ts";
import { nansenClient } from "./nansen.ts";
import { RatePacer } from "./pacer.ts";
import { RISK_V1 } from "./params.ts";
import { riskAddressesFor, viemRiskReader, type RiskAddresses } from "./reader.ts";
import { RiskValidator } from "./validator.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** The rate limit's window: the "per hour" in RISK_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR. */
const AGENT_WINDOW_SECONDS = 3_600n;
/** The evidence-sized response limit: the estimate plus this much headroom, capped at RISK_V1_MAX_RESPONSE_GAS. */
const RESPONSE_HEADROOM_PERCENT = 20;
/** JSON-RPC requests the risk reader keeps in flight at once. */
const READER_CONCURRENCY = 8;
/** Prompt Guard's own pacer: Groq's free tier for `llama-prompt-guard-2-86m` (the P5 plan's Decision 5). */
const GUARD_PACING = { requestsPerMinute: 30, tokensPerMinute: 15_000 } as const;

const log = (level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) =>
  jsonLineLog({ level, msg, validator: RISK_V1.tag, ...fields });

async function main(): Promise<void> {
  const config = parseRiskServiceConfig(process.env, REPO_ROOT);
  const chain = monadTestnet;
  const addresses = riskAddressesFor(chain.id);
  const deployment = deploymentsFor(chain.id);
  const account = privateKeyToAccount(config.privateKey);
  const transport = http(config.rpcUrl);
  const publicClient: PublicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });
  const nansen = nansenClient({ apiKey: config.nansenApiKey });

  log("info", "starting", {
    address: account.address,
    chainId: chain.id,
    rpcHost: config.rpcHost,
    llmHost: config.llmHost,
    model: config.llmModel,
    guardModel: RISK_V1.guardModel,
    nansen: nansen.available,
    gates: config.gates,
    cursor: config.cursorPath,
    maxRequestsPerAgentPerHour: config.maxRequestsPerAgentPerHour,
    dailyGasBudget: config.dailyGasBudget,
    maxResponseGas: config.maxResponseGas,
    llmRequestsPerMinute: config.llmRequestsPerMinute,
    llmTokensPerMinute: config.llmTokensPerMinute,
  });

  await startupChecks(publicClient, chain.id, addresses, account.address, deployment.validators.riskV1);
  await mkdir(dirname(config.cursorPath), { recursive: true });

  // Two clients, each with its own free-tier pacer: the main model and Prompt Guard have separate limits.
  const llm = openAiCompatibleClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    pacer: new RatePacer({ requestsPerMinute: config.llmRequestsPerMinute, tokensPerMinute: config.llmTokensPerMinute }),
  });
  const guardClient = openAiCompatibleClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    pacer: new RatePacer(GUARD_PACING),
  });

  const validator = new RiskValidator({
    chain: viemValidatorChain({
      publicClient,
      walletClient,
      validationRegistry: addresses.validationRegistry,
      gasLimit: { headroomPercent: RESPONSE_HEADROOM_PERCENT, max: config.maxResponseGas },
    }),
    cursor: new FileCursorStore(config.cursorPath),
    reader: viemRiskReader({ publicClient, addresses, concurrency: READER_CONCURRENCY }),
    addresses,
    mandateValidator: deployment.validators.mandateV1,
    gates: config.gates,
    admission: new Admission({
      maxRequestsPerAgent: config.maxRequestsPerAgentPerHour,
      agentWindowSeconds: AGENT_WINDOW_SECONDS,
      dailyGasBudget: config.dailyGasBudget,
      maxGasPerResponse: config.maxResponseGas,
    }),
    llm,
    guard: chatPromptGuard(guardClient, RISK_V1.guardModel),
    nansen,
    model: config.llmModel,
    log: jsonLineLog,
  });

  const stop = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log("info", "stopping", { signal });
      stop.abort();
    });
  }
  await validator.run(stop.signal);
  log("info", "stopped");
}

/**
 * Refuses to start unless this key is the recorded validator B (requests name that address, and the
 * vault requires `risk-v1` from it), the RPC is on the expected chain, and the contracts agree on one
 * Identity Registry, the one the reader uses for owners and permission events.
 */
async function startupChecks(
  publicClient: PublicClient,
  chainId: number,
  addresses: RiskAddresses,
  address: Address,
  expectedValidator: Address,
): Promise<void> {
  if (getAddress(address) !== getAddress(expectedValidator)) {
    throw new Error(`VALIDATOR_B_PRIVATE_KEY is for ${getAddress(address)}, but the deployment records validator B (risk-v1) as ${getAddress(expectedValidator)}`);
  }
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== chainId) throw new Error(`the RPC is on chain ${rpcChainId}, expected ${chainId}`);
  const [fromMandateRegistry, fromValidationRegistry] = await Promise.all([
    publicClient.readContract({ address: addresses.mandateRegistry, abi: mandateRegistryAbi, functionName: "identityRegistry" }),
    publicClient.readContract({ address: addresses.validationRegistry, abi: validationRegistryAbi, functionName: "getIdentityRegistry" }),
  ]);
  const expected = getAddress(addresses.identityRegistry);
  if (getAddress(fromMandateRegistry) !== getAddress(fromValidationRegistry)) {
    throw new Error(
      `MandateRegistry.identityRegistry() is ${fromMandateRegistry}, but ValidationRegistry.getIdentityRegistry() is ${fromValidationRegistry}`,
    );
  }
  if (getAddress(fromValidationRegistry) !== expected) {
    throw new Error(`the registries use Identity Registry ${fromValidationRegistry}, but the deployment records ${expected}`);
  }
  log("info", "startup checks passed", {
    chainId: rpcChainId,
    address: getAddress(address),
    identityRegistry: expected,
    reputationRegistry: addresses.reputationRegistry,
    validationRegistry: addresses.validationRegistry,
    mandateRegistry: addresses.mandateRegistry,
    forwarder: addresses.forwarder,
  });
}

main().catch((error: unknown) => {
  // viem's short message only: the full one can include the RPC URL.
  const message = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error);
  log("error", "fatal", { error: message });
  process.exitCode = 1;
});
