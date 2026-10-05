// The mandate-v1 validator service (validator A): `pnpm --filter @attest8004/validator-mandate start`.
// Reads its settings from the repo's .env (see .env.example), checks the chain and the contracts it
// reads, then polls until SIGINT or SIGTERM. Run one process per validator key: the pin relies on
// knowing this key's last response. Logs are JSON lines; the key and the RPC URL are never logged.
import {
  Admission,
  currentMandateRegistry,
  DEPLOYMENTS,
  jsonLineLog,
  mandateRegistryAbi,
  OPERATOR_REPORT_GAS_CAP,
  rateLimitedFetch,
  validationRegistryAbi,
  viemInboxPort,
  viemValidatorChain,
} from "@attest8004/sdk";
import { FileCursorStore } from "@attest8004/sdk/node";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseError, createPublicClient, createWalletClient, getAddress, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { parseServiceConfig } from "./config.ts";
import { MANDATE_V1 } from "./params.ts";
import { mandateContractsFor, viemMandateReader, type MandateContracts } from "./reader.ts";
import { MandateValidator } from "./validator.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** The rate limit's window: the "per hour" in MANDATE_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR. */
const AGENT_WINDOW_SECONDS = 3_600n;
/** The evidence-sized response limit: the estimate plus this much headroom, capped at MANDATE_V1_MAX_RESPONSE_GAS. */
const RESPONSE_HEADROOM_PERCENT = 20;
/** JSON-RPC requests the mandate reader keeps in flight at once. */
const READER_CONCURRENCY = 8;

const log = (level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) =>
  jsonLineLog({ level, msg, validator: MANDATE_V1.tag, ...fields });

async function main(): Promise<void> {
  const config = parseServiceConfig(process.env, REPO_ROOT);
  const chain = monadTestnet;
  const contracts = mandateContractsFor(chain.id);
  const account = privateKeyToAccount(config.privateKey);
  // The public RPC refuses more than 15 requests a second per IP; both services may run on one host.
  const transport = http(config.rpcUrl, {
    fetchFn: rateLimitedFetch({ requestsPerSecond: config.rpcRequestsPerSecond, retries: 6, retryDelayMs: 1_000 }),
  });
  const publicClient: PublicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  log("info", "starting", {
    address: account.address,
    chainId: chain.id,
    rpcHost: config.rpcHost,
    gates: config.gates,
    cursor: config.cursorPath,
    maxRequestsPerAgentPerHour: config.maxRequestsPerAgentPerHour,
    dailyGasBudget: config.dailyGasBudget,
    maxResponseGas: config.maxResponseGas,
    rpcRequestsPerSecond: config.rpcRequestsPerSecond,
  });

  // Operator reports (P7) go to the FindingsBoard, when one is recorded for this chain.
  const inbox = viemInboxPort({ publicClient, walletClient, deployment: DEPLOYMENTS[chain.id] });
  if (inbox === null) log("info", "operator reports off: no FindingsBoard recorded");
  else log("info", "operator reports on", { findingsBoard: inbox.findingsBoard, maxReportGas: OPERATOR_REPORT_GAS_CAP });

  await startupChecks(publicClient, chain.id, contracts);
  await mkdir(dirname(config.cursorPath), { recursive: true });

  const validator = new MandateValidator({
    chain: viemValidatorChain({
      publicClient,
      walletClient,
      validationRegistry: contracts.validationRegistry,
      gasLimit: { headroomPercent: RESPONSE_HEADROOM_PERCENT, max: config.maxResponseGas },
    }),
    cursor: new FileCursorStore(config.cursorPath),
    reader: viemMandateReader({ publicClient, contracts, concurrency: READER_CONCURRENCY }),
    contracts,
    gates: config.gates,
    admission: new Admission({
      maxRequestsPerAgent: config.maxRequestsPerAgentPerHour,
      agentWindowSeconds: AGENT_WINDOW_SECONDS,
      dailyGasBudget: config.dailyGasBudget,
      maxGasPerResponse: config.maxResponseGas,
      maxGasPerReport: inbox === null ? 0n : OPERATOR_REPORT_GAS_CAP,
    }),
    inbox,
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
 * Refuses to start unless the RPC is on the expected chain and the contracts agree on one Identity
 * Registry, the one the reader uses for owners and permission events. The MandateRegistry checked is
 * the current one (the history's last): the one new mandates are set on.
 */
async function startupChecks(publicClient: PublicClient, chainId: number, contracts: MandateContracts): Promise<void> {
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== chainId) throw new Error(`the RPC is on chain ${rpcChainId}, expected ${chainId}`);
  const mandateRegistry = currentMandateRegistry(contracts).address;
  const [fromMandateRegistry, fromValidationRegistry] = await Promise.all([
    publicClient.readContract({ address: mandateRegistry, abi: mandateRegistryAbi, functionName: "identityRegistry" }),
    publicClient.readContract({ address: contracts.validationRegistry, abi: validationRegistryAbi, functionName: "getIdentityRegistry" }),
  ]);
  const expected = getAddress(contracts.identityRegistry);
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
    identityRegistry: expected,
    validationRegistry: contracts.validationRegistry,
    mandateRegistry,
    forwarder: contracts.forwarder,
  });
}

main().catch((error: unknown) => {
  // viem's short message only: the full one can include the RPC URL.
  const message = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error);
  log("error", "fatal", { error: message });
  process.exitCode = 1;
});
