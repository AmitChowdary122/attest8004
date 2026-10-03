import { DEPLOYMENTS } from "@attest8004/sdk";
import { isAbsolute, resolve } from "node:path";
import { getAddress, isAddress, type Address, type Hex } from "viem";

/** The `mandate-v1` service's settings, from the environment (see `.env.example`). */
export interface ServiceConfig {
  /** Validator A's key. Never logged. */
  privateKey: Hex;
  /** Never logged: it can carry an API key. */
  rpcUrl: string;
  /** The RPC URL's host, the most of it the service logs. */
  rpcHost: string;
  gates: Address[];
  /** Absolute. */
  cursorPath: string;
  maxRequestsPerAgentPerHour: number;
  dailyGasBudget: bigint;
  maxResponseGas: bigint;
}

/** The defaults for the optional `MANDATE_V1_*` settings. */
export const SERVICE_DEFAULTS = {
  /** Relative to the repo root. */
  cursor: "validators/mandate/.state/cursor.json",
  maxRequestsPerAgentPerHour: 20,
  dailyGasBudget: 10_000_000n,
  maxResponseGas: 400_000n,
} as const;

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;

/**
 * Reads and checks the service's environment, reporting every problem at once. An error never
 * echoes the key or the RPC URL. Blank values count as unset. A relative `MANDATE_V1_CURSOR` is
 * resolved from `repoRoot`, where `.env` lives.
 */
export function parseServiceConfig(env: Record<string, string | undefined>, repoRoot: string): ServiceConfig {
  const problems: string[] = [];
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };

  const privateKey = read("VALIDATOR_A_PRIVATE_KEY");
  if (privateKey === undefined) problems.push("VALIDATOR_A_PRIVATE_KEY is not set");
  else if (!PRIVATE_KEY.test(privateKey)) problems.push("VALIDATOR_A_PRIVATE_KEY must be 0x followed by 64 hex digits");

  const rpcUrl = read("MONAD_TESTNET_RPC_URL");
  let rpcHost = "";
  if (rpcUrl === undefined) {
    problems.push("MONAD_TESTNET_RPC_URL is not set");
  } else {
    const url = URL.parse(rpcUrl);
    if (url === null || (url.protocol !== "https:" && url.protocol !== "http:") || url.host === "") {
      problems.push("MONAD_TESTNET_RPC_URL must be an http(s) URL");
    } else {
      rpcHost = url.host;
    }
  }

  const gates: Address[] = [];
  const gateList = read("MANDATE_V1_GATES");
  if (gateList === undefined) {
    gates.push(DEPLOYMENTS[10143].demoAgentVault);
  } else {
    for (const item of gateList.split(",").map((s) => s.trim())) {
      if (item === "") problems.push("MANDATE_V1_GATES has an empty item");
      else if (!isAddress(item, { strict: true })) problems.push(`MANDATE_V1_GATES: "${item}" is not an address`);
      else gates.push(getAddress(item));
    }
  }

  const cursor = read("MANDATE_V1_CURSOR") ?? SERVICE_DEFAULTS.cursor;
  const cursorPath = isAbsolute(cursor) ? cursor : resolve(repoRoot, cursor);

  const positive = (name: string, fallback: bigint): bigint => {
    const value = read(name);
    if (value === undefined) return fallback;
    if (!POSITIVE_DECIMAL.test(value)) {
      problems.push(`${name} must be a positive decimal integer, got "${value}"`);
      return fallback;
    }
    return BigInt(value);
  };
  const maxRequests = positive("MANDATE_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR", BigInt(SERVICE_DEFAULTS.maxRequestsPerAgentPerHour));
  const dailyGasBudget = positive("MANDATE_V1_DAILY_GAS_BUDGET", SERVICE_DEFAULTS.dailyGasBudget);
  const maxResponseGas = positive("MANDATE_V1_MAX_RESPONSE_GAS", SERVICE_DEFAULTS.maxResponseGas);
  if (maxRequests > BigInt(Number.MAX_SAFE_INTEGER)) {
    problems.push("MANDATE_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR is too large");
  }
  if (dailyGasBudget < maxResponseGas) {
    problems.push(
      `MANDATE_V1_DAILY_GAS_BUDGET (${dailyGasBudget}) must be at least MANDATE_V1_MAX_RESPONSE_GAS (${maxResponseGas})`,
    );
  }

  if (problems.length > 0) throw new Error(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
  return {
    privateKey: privateKey as Hex,
    rpcUrl: rpcUrl as string,
    rpcHost,
    gates,
    cursorPath,
    maxRequestsPerAgentPerHour: Number(maxRequests),
    dailyGasBudget,
    maxResponseGas,
  };
}
