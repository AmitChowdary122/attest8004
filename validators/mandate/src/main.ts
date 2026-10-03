// The mandate-v1 validator service (validator A): `pnpm --filter @attest8004/validator-mandate start`.
// Reads its settings from the repo's .env (see .env.example), checks the chain and the contracts it
// reads, then polls until SIGINT or SIGTERM. Run one process per validator key: the pin relies on
// knowing this key's last response. Logs are JSON lines; the key and the RPC URL are never logged.
import { Admission, deploymentsFor, mandateRegistryAbi, validationRegistryAbi, viemValidatorChain } from "@attest8004/sdk";
import { FileCursorStore } from "@attest8004/sdk/node";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseError, createPublicClient, createWalletClient, getAddress, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { parseServiceConfig } from "./config.ts";
import { MANDATE_V1 } from "./params.ts";
import type { MandateAddresses } from "./reader.ts";
import { viemMandateReader } from "./reader.ts";
import { jsonLineLog, MandateValidator } from "./validator.ts";

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
  const deployment = deploymentsFor(chain.id);
  const addresses: MandateAddresses = {
    validationRegistry: deployment.validationRegistry,
    identityRegistry: deployment.identityRegistry,
    forwarder: deployment.agentRequestForwarder,
    mandateRegistry: deployment.mandateRegistry,
  };
  const account = privateKeyToAccount(config.privateKey);
  const transport = http(config.rpcUrl);
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
  });

  await startupChecks(publicClient, chain.id, addresses);
  await mkdir(dirname(config.cursorPath), { recursive: true });

  const validator = new MandateValidator({
    chain: viemValidatorChain({
      publicClient,
      walletClient,
      validationRegistry: addresses.validationRegistry,
      gasLimit: { headroomPercent: RESPONSE_HEADROOM_PERCENT, max: config.maxResponseGas },
    }),
    cursor: new FileCursorStore(config.cursorPath),
    reader: viemMandateReader({ publicClient, addresses, concurrency: READER_CONCURRENCY }),
    addresses,
    gates: config.gates,
    admission: new Admission({
      maxRequestsPerAgent: config.maxRequestsPerAgentPerHour,
      agentWindowSeconds: AGENT_WINDOW_SECONDS,
      dailyGasBudget: config.dailyGasBudget,
      maxGasPerResponse: config.maxResponseGas,
    }),
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
 * Registry, the one the reader uses for owners and permission events.
 */
async function startupChecks(publicClient: PublicClient, chainId: number, addresses: MandateAddresses): Promise<void> {
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
    identityRegistry: expected,
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
