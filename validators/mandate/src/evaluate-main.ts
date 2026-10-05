// The read-only /evaluate service for validator C's CRE workflow (P11): `pnpm --filter @attest8004/validator-mandate
// evaluate`. Reads MONAD_TESTNET_RPC_URL, MANDATE_V1_GATES and CRE_EVALUATE_* from the repo's .env, holds no key and
// sends no transaction, listens on 127.0.0.1 only. Logs are JSON lines; the RPC URL is never logged.
import { DEPLOYMENTS, jsonLineLog, rateLimitedFetch } from "@attest8004/sdk";
import { BaseError, createPublicClient, http, type PublicClient } from "viem";
import { monadTestnet } from "viem/chains";
import { parseEvaluateConfig } from "./evaluate-config.ts";
import { startEvaluateService } from "./evaluate-service.ts";
import { mandateContractsFor } from "./reader.ts";
import { startupChecks } from "./startup.ts";

const log = (level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) =>
  jsonLineLog({ level, msg, service: "mandate-v1 /evaluate", ...fields });

async function main(): Promise<void> {
  const config = parseEvaluateConfig(process.env);
  const chain = monadTestnet;
  const transport = http(config.rpcUrl, {
    fetchFn: rateLimitedFetch({ requestsPerSecond: config.rpcRequestsPerSecond, retries: 6, retryDelayMs: 1_000 }),
  });
  const publicClient: PublicClient = createPublicClient({ chain, transport });
  const contracts = mandateContractsFor(chain.id);
  const checked = await startupChecks(publicClient, chain.id, contracts);
  const validator = DEPLOYMENTS[chain.id].validators.creMandateV1;
  const code = await publicClient.getCode({ address: validator });
  if (code === undefined || code === "0x") throw new Error(`validator C (CreValidator ${validator}) has no code on chain ${chain.id}`);

  const service = await startEvaluateService({
    publicClient,
    chainId: chain.id,
    gates: config.gates,
    port: config.port,
    log: (entry) => jsonLineLog({ service: "mandate-v1 /evaluate", ...entry }),
  });
  log("info", "listening", {
    url: `http://${service.host}:${service.port}/evaluate`,
    validator: service.validator,
    gates: config.gates,
    rpcHost: config.rpcHost,
    rpcRequestsPerSecond: config.rpcRequestsPerSecond,
    identityRegistry: checked.identityRegistry,
    mandateRegistry: checked.mandateRegistry,
  });

  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => resolve());
  });
  log("info", "stopping");
  await service.close();
}

main().catch((error: unknown) => {
  // viem's short message only: the full one can include the RPC URL.
  const message = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error);
  log("error", "fatal", { error: message });
  process.exitCode = 1;
});
