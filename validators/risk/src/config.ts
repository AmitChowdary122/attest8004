import { DEPLOYMENTS, OPERATOR_REPORT_GAS_CAP, parseRequestsPerSecond } from "@attest8004/sdk";
import type { ServedGate } from "@attest8004/validator-mandate";
import { isAbsolute, resolve } from "node:path";
import { getAddress, isAddress, type Hex } from "viem";
import { RISK_V1 } from "./params.ts";

/** The `risk-v1` service's settings, from the environment (see `.env.example`). */
export interface RiskServiceConfig {
  /** Validator B's key. Never logged. */
  privateKey: Hex;
  /** Never logged: it can carry an API key. */
  rpcUrl: string;
  /** The RPC URL's host, the most of it the service logs. */
  rpcHost: string;
  /** The OpenAI-compatible endpoint (`LLM_BASE_URL`). Never logged: it can carry a token. */
  llmBaseUrl: string;
  /** The LLM endpoint's host, the most of it the service logs. */
  llmHost: string;
  /** Never logged. */
  llmApiKey: string;
  /** The model requested (`LLM_MODEL`). */
  llmModel: string;
  /** Optional: without it both Nansen tools answer "unavailable". Never logged. */
  nansenApiKey: string | undefined;
  /** The (gate, agent) pairs the validator answers for. */
  gates: ServedGate[];
  /** Absolute. */
  cursorPath: string;
  maxRequestsPerAgentPerHour: number;
  dailyGasBudget: bigint;
  maxResponseGas: bigint;
  /** The service's RPC client stays at or below this many requests a second (the public RPC refuses more than 15 per IP). */
  rpcRequestsPerSecond: number;
  /** The main model's client-side pacing (the guard has its own fixed pacer). */
  llmRequestsPerMinute: number;
  llmTokensPerMinute: number;
}

/** The defaults for the optional `RISK_V1_*` settings. */
export const RISK_SERVICE_DEFAULTS = {
  /** Relative to the repo root. */
  cursor: "validators/risk/.state/cursor.json",
  maxRequestsPerAgentPerHour: 20,
  dailyGasBudget: 10_000_000n,
  maxResponseGas: 1_000_000n,
  /** 7, so validator A and validator B on one IP together stay under the public RPC's 15 a second. */
  rpcRequestsPerSecond: 7,
  /** Groq's free tier for `openai/gpt-oss-120b` (the P5 plan's Decision 5). */
  llmRequestsPerMinute: 30,
  llmTokensPerMinute: 8_000,
} as const;

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const UINT256_LIMIT = 2n ** 256n;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;

/** Whether an http(s) URL's host is this machine (127.0.0.0/8, localhost, ::1): plain http stays on the box. */
function isLoopbackHost(value: string): boolean {
  const host = URL.parse(value)?.hostname ?? "";
  return host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** The URL's host when it is an http(s) URL with one, else `null`. Never echoes the input. */
function httpHost(value: string): string | null {
  const url = URL.parse(value);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:") || url.host === "") return null;
  return url.host;
}

/**
 * Reads and checks the service's environment, reporting every problem at once. An error never echoes
 * the private key, `LLM_API_KEY`, `NANSEN_API_KEY` or either URL. Blank values count as unset. A
 * relative `RISK_V1_CURSOR` is resolved from `repoRoot`, where `.env` lives. `RISK_V1_GATES` has
 * `MANDATE_V1_GATES`' format (`<gate address>:<agentId>,…`) and the same default, the demo vault for
 * agent 1984.
 */
export function parseRiskServiceConfig(env: Record<string, string | undefined>, repoRoot: string): RiskServiceConfig {
  const problems: string[] = [];
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };
  const required = (name: string): string | undefined => {
    const value = read(name);
    if (value === undefined) problems.push(`${name} is not set`);
    return value;
  };

  const privateKey = required("VALIDATOR_B_PRIVATE_KEY");
  if (privateKey !== undefined && !PRIVATE_KEY.test(privateKey)) problems.push("VALIDATOR_B_PRIVATE_KEY must be 0x followed by 64 hex digits");

  const rpcUrl = required("MONAD_TESTNET_RPC_URL");
  let rpcHost = "";
  if (rpcUrl !== undefined) {
    const host = httpHost(rpcUrl);
    if (host === null) problems.push("MONAD_TESTNET_RPC_URL must be an http(s) URL");
    else rpcHost = host;
  }

  const llmBaseUrl = required("LLM_BASE_URL");
  let llmHost = "";
  if (llmBaseUrl !== undefined) {
    const host = httpHost(llmBaseUrl);
    if (host === null) problems.push("LLM_BASE_URL must be an http(s) URL");
    else if (URL.parse(llmBaseUrl)?.protocol === "http:" && !isLoopbackHost(llmBaseUrl)) {
      // P12, AUD-15: the Bearer LLM_API_KEY rides on every request.
      problems.push("LLM_BASE_URL must be https (plain http only for a loopback host)");
    } else llmHost = host;
  }
  const llmApiKey = required("LLM_API_KEY");
  const llmModel = required("LLM_MODEL");
  const nansenApiKey = read("NANSEN_API_KEY");

  const testnet = DEPLOYMENTS[10143];
  const gates: ServedGate[] = [];
  const gateList = read("RISK_V1_GATES");
  if (gateList === undefined) {
    gates.push({ gate: testnet.demoAgentVault, agentId: testnet.demoAgents[0] as bigint });
  } else {
    for (const item of gateList.split(",").map((s) => s.trim())) {
      if (item === "") {
        problems.push("RISK_V1_GATES has an empty item");
        continue;
      }
      const parts = item.split(":").map((s) => s.trim());
      if (parts.length !== 2) {
        problems.push(`RISK_V1_GATES: "${item}" must be <gate address>:<agentId>, e.g. ${testnet.demoAgentVault}:${testnet.demoAgents[0]}`);
        continue;
      }
      const [gate, agentId] = parts as [string, string];
      if (!isAddress(gate, { strict: true })) {
        problems.push(`RISK_V1_GATES: "${gate}" is not an address`);
      } else if (!DECIMAL.test(agentId) || BigInt(agentId) >= UINT256_LIMIT) {
        problems.push(`RISK_V1_GATES: agentId "${agentId}" for gate ${getAddress(gate)} must be a decimal integer below 2^256`);
      } else {
        gates.push({ gate: getAddress(gate), agentId: BigInt(agentId) });
      }
    }
  }

  const cursor = read("RISK_V1_CURSOR") ?? RISK_SERVICE_DEFAULTS.cursor;
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
  /** A positive decimal that must also fit a JS number (a count, not gas). */
  const count = (name: string, fallback: number): number => {
    const value = positive(name, BigInt(fallback));
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      problems.push(`${name} is too large`);
      return fallback;
    }
    return Number(value);
  };

  const maxRequestsPerAgentPerHour = count("RISK_V1_MAX_REQUESTS_PER_AGENT_PER_HOUR", RISK_SERVICE_DEFAULTS.maxRequestsPerAgentPerHour);
  const dailyGasBudget = positive("RISK_V1_DAILY_GAS_BUDGET", RISK_SERVICE_DEFAULTS.dailyGasBudget);
  const maxResponseGas = positive("RISK_V1_MAX_RESPONSE_GAS", RISK_SERVICE_DEFAULTS.maxResponseGas);
  if (dailyGasBudget < maxResponseGas + OPERATOR_REPORT_GAS_CAP) {
    problems.push(
      `RISK_V1_DAILY_GAS_BUDGET (${dailyGasBudget}) must be at least RISK_V1_MAX_RESPONSE_GAS (${maxResponseGas}) plus the operator report cap (${OPERATOR_REPORT_GAS_CAP})`,
    );
  }
  let rpcRequestsPerSecond: number = RISK_SERVICE_DEFAULTS.rpcRequestsPerSecond;
  const rps = read("RISK_V1_RPC_REQUESTS_PER_SECOND");
  if (rps !== undefined) {
    const parsed = parseRequestsPerSecond(rps, "RISK_V1_RPC_REQUESTS_PER_SECOND");
    if (parsed.ok) rpcRequestsPerSecond = parsed.value;
    else problems.push(parsed.problem);
  }
  const llmRequestsPerMinute = count("RISK_V1_LLM_REQUESTS_PER_MINUTE", RISK_SERVICE_DEFAULTS.llmRequestsPerMinute);
  const llmTokensPerMinute = count("RISK_V1_LLM_TOKENS_PER_MINUTE", RISK_SERVICE_DEFAULTS.llmTokensPerMinute);
  // The pacer refuses (transient, forever) any request estimated over the per-minute budget.
  if (llmTokensPerMinute < RISK_V1.maxRequestTokens) {
    problems.push(
      `RISK_V1_LLM_TOKENS_PER_MINUTE (${llmTokensPerMinute}) must be at least ${RISK_V1.maxRequestTokens}, the largest request risk-v1 sends`,
    );
  }

  if (problems.length > 0) throw new Error(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
  return {
    privateKey: privateKey as Hex,
    rpcUrl: rpcUrl as string,
    rpcHost,
    llmBaseUrl: llmBaseUrl as string,
    llmHost,
    llmApiKey: llmApiKey as string,
    llmModel: llmModel as string,
    nansenApiKey,
    gates,
    cursorPath,
    maxRequestsPerAgentPerHour,
    dailyGasBudget,
    maxResponseGas,
    rpcRequestsPerSecond,
    llmRequestsPerMinute,
    llmTokensPerMinute,
  };
}
