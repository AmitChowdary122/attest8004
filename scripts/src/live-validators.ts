/**
 * Both reference validators run in-process, exactly as their services run them (P5's e2e harness, shared since P9 by
 * the e2e and `pnpm demo`): validator A (`mandate-v1`) and validator B (`risk-v1`, its model and Prompt Guard paced to
 * the provider's free tier), the gas and admission settings the services use, a poller that waits for every wanted
 * request's outcome, and the helpers the runs check with.
 *
 * Nothing here reads the environment at import (`llmSettingsFromEnv` takes it as an argument) or prints: the caller
 * passes its clients and keys in, and each validator's log entries go to the caller's `log`. Entries never carry keys
 * or URLs.
 */
import { BaseError, ContractFunctionRevertedError, getAddress, type Abi, type Account, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import {
  Admission,
  DEPLOYMENTS,
  MemoryCursorStore,
  OPERATOR_REPORT_GAS_CAP,
  validationRegistryAbi,
  viemInboxPort,
  viemValidatorChain,
  type Outcome,
  type ValidatorBase,
  type ValidatorChain,
} from "@attest8004/sdk";
import { MandateValidator, mandateContractsFor, viemMandateReader } from "@attest8004/validator-mandate";
import {
  RISK_V1,
  RatePacer,
  RiskValidator,
  chatPromptGuard,
  nansenClient,
  openAiCompatibleClient,
  riskContractsFor,
  viemRiskReader,
  type ChatClient,
} from "@attest8004/validator-risk";

/**
 * Explicit gas limits (Monad charges for the limit): Monad testnet eth_estimateGas x 1.2, rounded up to 1k.
 * fund 21,212 (P2, and again on 3 Oct 2026 in P3). execute was 87,626 through the one-requirement P3 vault (P4).
 * This vault also checks each verdict's tag, and reads a second verdict: in forge with Monad gas (cold, 4 Oct 2026)
 * the second requirement added 12,631, so about 100,300, and 121,000 with the headroom. Provisional until this run
 * prints the live estimate. The forwarded requests use the SDK's DEFAULT_GAS.forwarderRequest.
 */
export const GAS = {
  fund: 26_000n,
  execute: 121_000n,
} as const;

/**
 * Validator A's response limit, as its service sends them (validators/mandate/src/main.ts): mandate-v1's evidence
 * varies in size with the mandate and the agent's activity, so each response gets its own estimate x 1.2, capped at
 * 400,000.
 */
export const MANDATE_RESPONSE_GAS = { headroomPercent: 20, max: 400_000n } as const;
/** Validator A's admission defaults (validators/mandate/src/config.ts): 20 requests per agent per hour, 10,000,000 gas a day. */
export const MANDATE_ADMISSION = {
  maxRequestsPerAgent: 20,
  agentWindowSeconds: 3_600n,
  dailyGasBudget: 10_000_000n,
  maxGasPerResponse: MANDATE_RESPONSE_GAS.max,
  maxGasPerReport: OPERATOR_REPORT_GAS_CAP,
} as const;
/**
 * Validator B's response limit, as its service sends them (validators/risk/src/main.ts and config.ts): risk-v1's
 * evidence is bigger (typically 8 to 12 KB), so the estimate x 1.2, capped at 1,000,000.
 */
export const RISK_RESPONSE_GAS = { headroomPercent: 20, max: 1_000_000n } as const;
/** Validator B's admission defaults (validators/risk/src/config.ts): mandate-v1's limits, 1,000,000 gas per response. */
export const RISK_ADMISSION = {
  maxRequestsPerAgent: 20,
  agentWindowSeconds: 3_600n,
  dailyGasBudget: 10_000_000n,
  maxGasPerResponse: RISK_RESPONSE_GAS.max,
  maxGasPerReport: OPERATOR_REPORT_GAS_CAP,
} as const;
/** The main model's free-tier pacing (validators/risk/src/config.ts), unless RISK_V1_LLM_* override it as for the service. */
export const LLM_PACING_DEFAULTS = { requestsPerMinute: 30, tokensPerMinute: 8_000 } as const;
/** Prompt Guard's own pacer (validators/risk/src/main.ts): Groq's free tier for llama-prompt-guard-2-86m. */
export const GUARD_PACING = { requestsPerMinute: 30, tokensPerMinute: 15_000 } as const;
/** JSON-RPC requests each validator's reader keeps in flight at once, as the services do. */
export const READER_CONCURRENCY = 8;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const lower = (hash: Hex) => hash.toLowerCase() as Hex;

/** Validator B's model endpoint and pacing, as its service reads them. Never printed but the host. */
export interface LlmSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  pacing: { requestsPerMinute: number; tokensPerMinute: number };
}

/**
 * The LLM settings from `env`, as validator B's service reads them (validators/risk/src/config.ts): trimmed, blank
 * counts as unset. A value is never echoed in an error, only its name.
 */
export function llmSettingsFromEnv(env: NodeJS.ProcessEnv): LlmSettings {
  const setting = (name: string): string | undefined => env[name]?.trim() || undefined;
  const requiredSetting = (name: string): string => {
    const value = setting(name);
    if (value === undefined) throw new Error(`${name} is not set (expected in .env)`);
    return value;
  };
  /** A positive decimal integer from the environment, or `fallback` when unset; the value itself is never echoed. */
  const positiveEnv = (name: string, fallback: number): number => {
    const value = setting(name);
    if (value === undefined) return fallback;
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be a positive decimal integer`);
    return Number(value);
  };
  const settings: LlmSettings = {
    baseUrl: requiredSetting("LLM_BASE_URL"),
    apiKey: requiredSetting("LLM_API_KEY"),
    model: requiredSetting("LLM_MODEL"),
    pacing: {
      requestsPerMinute: positiveEnv("RISK_V1_LLM_REQUESTS_PER_MINUTE", LLM_PACING_DEFAULTS.requestsPerMinute),
      tokensPerMinute: positiveEnv("RISK_V1_LLM_TOKENS_PER_MINUTE", LLM_PACING_DEFAULTS.tokensPerMinute),
    },
  };
  if (settings.pacing.tokensPerMinute < RISK_V1.maxRequestTokens) {
    throw new Error(`RISK_V1_LLM_TOKENS_PER_MINUTE must be at least ${RISK_V1.maxRequestTokens}, the largest request risk-v1 sends`);
  }
  return settings;
}

/** A chat client's calls (each `complete()`, before it is sent) and what its answers report, for the run's totals. */
export interface ClientStats {
  calls: number;
  servedModels: string[];
  usage: { prompt: number; completion: number; total: number };
}

/** `client`, wrapped only to count its calls and add up the usage its answers report. */
export function counted(client: ChatClient): { client: ChatClient; stats: ClientStats } {
  const stats: ClientStats = { calls: 0, servedModels: [], usage: { prompt: 0, completion: 0, total: 0 } };
  return {
    stats,
    client: {
      host: client.host,
      async complete(request) {
        stats.calls += 1;
        const response = await client.complete(request);
        stats.usage.prompt += response.usage.prompt;
        stats.usage.completion += response.usage.completion;
        stats.usage.total += response.usage.total;
        if (!stats.servedModels.includes(response.servedModel)) stats.servedModels.push(response.servedModel);
        return response;
      },
    },
  };
}

/** One validator to poll, and the requests it must reach an outcome for. */
export interface PollJob {
  name: string;
  validator: Pick<ValidatorBase, "pollOnce">;
  requestHashes: readonly Hex[];
}

/**
 * Polls `job.validator` until it has an outcome for every one of its requests, `giveUpAt` passes (`budget` names it
 * in the error), or `stop` aborts (the other validator failed). Outcomes for other requests (anyone may ask either
 * validator) are left to the validator; a request it gives up on fails the run. `onOutcome` hears each wanted
 * request's outcome once, as soon as it is final.
 */
async function pollUntilAll(
  job: PollJob,
  giveUpAt: number,
  budget: string,
  stop: AbortSignal,
  onOutcome: ((job: string, outcome: Outcome) => void) | undefined,
): Promise<Map<Hex, Outcome>> {
  const { name, validator, requestHashes } = job;
  const wanted = new Set(requestHashes.map(lower));
  const found = new Map<Hex, Outcome>();
  for (;;) {
    if (stop.aborted) throw new Error(`${name}: stopped, since the other validator failed`);
    if (Date.now() > giveUpAt) throw new Error(`${name}: no outcome for every request within ${budget} (${found.size}/${wanted.size})`);
    const { outcomes, caughtUp, retryAfterMs } = await validator.pollOnce();
    for (const outcome of outcomes) {
      const key = lower(outcome.requestHash);
      if (!wanted.has(key)) continue;
      if (outcome.kind === "gave-up") throw new Error(`${name} gave up on ${outcome.requestHash}: ${outcome.error}`);
      // A retry after a failed cycle re-reads from the failed request's block, so a request answered earlier in that
      // block comes back as ALREADY_RESPONDED: the response this run saw is the outcome that counts.
      if (found.get(key)?.kind !== "responded") {
        const first = !found.has(key);
        found.set(key, outcome);
        if (first) onOutcome?.(name, outcome);
      }
    }
    if (found.size === wanted.size) return found;
    if (retryAfterMs !== undefined) await sleep(Math.max(0, Math.min(retryAfterMs, giveUpAt - Date.now() + 1)));
    else if (caughtUp) await sleep(500);
  }
}

/**
 * Polls every validator concurrently until each has an outcome for all of its requests, under one shared deadline.
 * The first failure stops the others at their next cycle (a risk-v1 check already running finishes first).
 */
export async function pollAll(
  jobs: readonly PollJob[],
  timeoutMs: number,
  budget: string,
  onOutcome?: (job: string, outcome: Outcome) => void,
): Promise<Map<Hex, Outcome>> {
  const stop = new AbortController();
  const giveUpAt = Date.now() + timeoutMs;
  const results = await Promise.all(
    jobs.map((job) =>
      pollUntilAll(job, giveUpAt, budget, stop.signal, onOutcome).catch((error: unknown) => {
        stop.abort();
        throw error;
      }),
    ),
  );
  return new Map(results.flatMap((found) => [...found]));
}

export type Call = { address: Address; abi: Abi; functionName: string; args: readonly unknown[] };

/**
 * Simulates a call that must revert, and returns the custom error it reverted with. Sends nothing. Throws if the
 * simulation succeeds. Only viem's short message is kept: the full one can carry the RPC URL.
 */
export async function revertOf(
  publicClient: PublicClient,
  label: string,
  call: Call,
  account: Address,
): Promise<{ name?: string; args: readonly unknown[]; detail: string }> {
  try {
    await publicClient.simulateContract({ ...call, account } as never);
  } catch (error) {
    const reverted = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    if (reverted instanceof ContractFunctionRevertedError && reverted.data) {
      const { errorName, args = [] } = reverted.data;
      return { name: errorName, args, detail: `${errorName}(${args.map(String).join(", ")})` };
    }
    return { args: [], detail: error instanceof BaseError ? error.shortMessage : String(error) };
  }
  throw new Error(`check failed: ${label} (the simulation succeeded)`);
}

/** Both validators for one (gate, agent) pair, plus the model clients and what each response cost. */
export interface LiveValidators {
  /** Validator A from just before `fromBlock`, in memory, logging to `log`. */
  mandate(fromBlock: bigint, log: (entry: Record<string, unknown>) => void): MandateValidator;
  /** Validator B from just before `fromBlock`, in memory, with these (possibly counted) model clients. */
  risk(fromBlock: bigint, clients: { llm: ChatClient; guard: ChatClient }, log: (entry: Record<string, unknown>) => void): RiskValidator;
  /** The main model and Prompt Guard, each through its own free-tier pacer. */
  llm: ChatClient;
  guard: ChatClient;
  nansen: ReturnType<typeof nansenClient>;
  /** Each response's gas: Monad's estimate for its exact arguments, and the limit the validator actually sent. */
  responseGas: Map<Hex, { estimate: bigint; limit: bigint }>;
}

/**
 * Both validators as their services run them, for `vault` and `agentId` only: A (validators/mandate/src/main.ts) and
 * B (validators/risk/src/main.ts) with the evidence-sized response limits, readers at concurrency 8, fresh admission
 * policies with the services' defaults, B's prerequisite validator from DEPLOYMENTS, the main model and Prompt Guard
 * through their own paced clients, and Nansen from `nansenApiKey` (unavailable without it). Each response's gas is
 * recorded: a fresh estimate first, then the service's own send.
 */
export function liveValidators(o: {
  publicClient: PublicClient;
  walletFor: (account: Account) => WalletClient;
  chainId: number;
  validatorA: Account;
  validatorB: Account;
  vault: Address;
  agentId: bigint;
  llm: LlmSettings;
  nansenApiKey?: string;
}): LiveValidators {
  const { publicClient, walletFor, validatorA, validatorB, vault, agentId } = o;
  const deployment = DEPLOYMENTS[o.chainId as keyof typeof DEPLOYMENTS];
  if (!deployment) throw new Error(`no deployment recorded for chain ${o.chainId}`);
  const registry = getAddress(deployment.validationRegistry);
  const contracts = mandateContractsFor(o.chainId);
  const riskContracts = riskContractsFor(o.chainId);
  const responseGas = new Map<Hex, { estimate: bigint; limit: bigint }>();

  /** `port`, wrapped only to record each response's gas: a fresh estimate first, then the service's own send. */
  const measured = (port: ValidatorChain, from: Address): ValidatorChain => ({
    ...port,
    async respond(response) {
      const { requestHash, response: score, responseURI, responseHash, tag } = response;
      const estimate = await publicClient.estimateContractGas({
        address: registry,
        abi: validationRegistryAbi,
        functionName: "validationResponse",
        args: [requestHash, score, responseURI, responseHash, tag],
        account: from,
      });
      const sent = await port.respond(response);
      responseGas.set(lower(requestHash), { estimate, limit: sent.gasLimit });
      return sent;
    },
  });

  const llm = openAiCompatibleClient({ baseUrl: o.llm.baseUrl, apiKey: o.llm.apiKey, pacer: new RatePacer(o.llm.pacing) });
  const guard = openAiCompatibleClient({ baseUrl: o.llm.baseUrl, apiKey: o.llm.apiKey, pacer: new RatePacer(GUARD_PACING) });
  const nansen = nansenClient({ apiKey: o.nansenApiKey?.trim() || undefined });

  return {
    llm,
    guard,
    nansen,
    responseGas,
    mandate(fromBlock, log) {
      const port = viemValidatorChain({ publicClient, walletClient: walletFor(validatorA), validationRegistry: registry, gasLimit: MANDATE_RESPONSE_GAS });
      return new MandateValidator({
        chain: measured(port, validatorA.address),
        cursor: new MemoryCursorStore(fromBlock - 1n),
        reader: viemMandateReader({ publicClient, contracts, concurrency: READER_CONCURRENCY }),
        contracts,
        gates: [{ gate: vault, agentId }],
        admission: new Admission(MANDATE_ADMISSION),
        inbox: viemInboxPort({ publicClient, walletClient: walletFor(validatorA), deployment }),
        log,
      });
    },
    risk(fromBlock, clients, log) {
      const port = viemValidatorChain({ publicClient, walletClient: walletFor(validatorB), validationRegistry: registry, gasLimit: RISK_RESPONSE_GAS });
      return new RiskValidator({
        chain: measured(port, validatorB.address),
        cursor: new MemoryCursorStore(fromBlock - 1n),
        reader: viemRiskReader({ publicClient, contracts: riskContracts, concurrency: READER_CONCURRENCY }),
        contracts: riskContracts,
        mandateValidator: getAddress(deployment.validators.mandateV1),
        gates: [{ gate: vault, agentId }],
        admission: new Admission(RISK_ADMISSION),
        inbox: viemInboxPort({ publicClient, walletClient: walletFor(validatorB), deployment }),
        llm: clients.llm,
        guard: chatPromptGuard(clients.guard, RISK_V1.guardModel),
        nansen,
        model: o.llm.model,
        log,
      });
    },
  };
}
