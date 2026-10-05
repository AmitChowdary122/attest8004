// The e2e's preflight and timing decisions (scripts/src/e2e.ts), kept free of env and RPC so they can be unit
// tested: what the deployer must hold, how long the restart check may take before execute(S) runs out of time,
// whether agent 1984's mandate is old enough for risk-v1's permission window, and a zero-token check of the LLM
// endpoint. Messages are our own fixed text: never a URL, a key or a library's message.
import { OPERATOR_REPORT_GAS_CAP, type FindingsBoardDeployment } from "@attest8004/sdk";
import { formatEther, type Hex } from "viem";

const mon = (wei: bigint): string => `${formatEther(wei)} MON`;

/**
 * What the deployer pays for in a run, at `maxFeePerGas`: the vault's top-up to `fundTarget` when it holds less than
 * `fundBelow` (the value, plus `fundGas`), and execute(S) (`executeGas`). Both gas costs get `marginPercent` on top,
 * rounded up, in case the fee rises before they're sent; the top-up's value is exact.
 */
export function deployerNeed(o: {
  vaultBalance: bigint;
  fundBelow: bigint;
  fundTarget: bigint;
  fundGas: bigint;
  executeGas: bigint;
  maxFeePerGas: bigint;
  marginPercent: number;
}): { topUp: bigint; gasWithMargin: bigint; total: bigint } {
  const topUp = o.vaultBalance < o.fundBelow ? o.fundTarget - o.vaultBalance : 0n;
  const gas = (topUp > 0n ? o.fundGas : 0n) + o.executeGas;
  const scaled = gas * o.maxFeePerGas * (100n + BigInt(o.marginPercent));
  const gasWithMargin = (scaled + 99n) / 100n;
  return { topUp, gasWithMargin, total: topUp + gasWithMargin };
}

/**
 * Whether this run's verdicts get encrypted operator reports (P7): only when agent 1984 has an inbox key and a
 * FindingsBoard is recorded. The line is what the preflight prints.
 */
export function reportsExpected(o: { inboxKey: Hex; findingsBoard: FindingsBoardDeployment | null }): { expected: boolean; line: string } {
  if (o.findingsBoard === null) return { expected: false, line: "operator reports: off (no FindingsBoard recorded for this chain)" };
  if (BigInt(o.inboxKey) === 0n) return { expected: false, line: "operator reports: off (agent 1984 has no inbox key: no report will be posted)" };
  return { expected: true, line: `operator reports: on (inbox key ${o.inboxKey}, FindingsBoard ${o.findingsBoard.address})` };
}

/**
 * The least a validator must hold before the run: its `floor`, plus, when reports are on, its three reports at
 * `OPERATOR_REPORT_GAS_CAP` and the current max fee (each validator answers three requests, so six reports across A
 * and B), so a validator short of report gas stops the run before any request is sent.
 */
export function validatorNeed(o: { floor: bigint; reports: boolean; maxFeePerGas: bigint }): bigint {
  return o.floor + (o.reports ? 3n * OPERATOR_REPORT_GAS_CAP * o.maxFeePerGas : 0n);
}

/** Why the deployer can't pay for the run (`held` below `need.total`), or `null` when it can. */
export function deployerShortfall(o: { held: bigint; need: ReturnType<typeof deployerNeed>; marginPercent: number }): string | null {
  const { held, need } = o;
  if (held >= need.total) return null;
  return (
    `the deployer holds ${mon(held)} but needs at least ${mon(need.total)}: the vault top-up (${mon(need.topUp)}) plus gas ` +
    `for it and execute(S) at the current max fee, with a ${o.marginPercent}% margin (${mon(need.gasWithMargin)}); top the deployer up first`
  );
}

/**
 * How long the restart check may wait: `maxMs`, capped so that `executeMarginSeconds` still remain before S's
 * `deadline` (chain time, seconds) for execute(S); or why there is no time for it at all.
 */
export function restartBudget(o: {
  deadline: bigint;
  now: bigint;
  executeMarginSeconds: bigint;
  maxMs: number;
}): { ok: true; ms: number } | { ok: false; message: string } {
  const left = o.deadline > o.now ? o.deadline - o.now : 0n;
  const spare = left - o.executeMarginSeconds;
  if (spare <= 0n) {
    return {
      ok: false,
      message:
        `only ${left} s remain before S's deadline (${o.deadline}), and execute(S) needs ${o.executeMarginSeconds} s of them: ` +
        "there is no time for the restart check, so the run stops without executing S",
    };
  }
  const spareMs = Number(spare) * 1000;
  return { ok: true, ms: spareMs < o.maxMs ? spareMs : o.maxMs };
}

/** Why execute(S) must not be sent (fewer than `minSeconds` before S's `deadline`, chain time), or `null`. */
export function executeTimeLeft(o: { deadline: bigint; now: bigint; minSeconds: bigint }): string | null {
  const left = o.deadline > o.now ? o.deadline - o.now : 0n;
  if (left >= o.minSeconds) return null;
  return `only ${left} s remain before S's deadline (${o.deadline}), less than the ${o.minSeconds} s execute(S) needs: not sending it`;
}

/**
 * Why the run must wait (the mandate was set fewer than `windowBlocks` blocks before `latestBlock`), or `null`.
 * risk-v1's `recent_permission_events` reads `(P - windowBlocks, P]` at its pin `P`, which is after every request,
 * so a MandateSet at least a window old at the preflight is outside it. `msPerBlock` only estimates the minutes.
 */
export function permissionWindowWait(o: {
  agentId: bigint;
  latestBlock: bigint;
  setAtBlock: bigint;
  windowBlocks: bigint;
  msPerBlock: bigint;
}): string | null {
  const age = o.latestBlock > o.setAtBlock ? o.latestBlock - o.setAtBlock : 0n;
  if (age >= o.windowBlocks) return null;
  const wait = o.windowBlocks - age;
  const minutes = (wait * o.msPerBlock + 59_999n) / 60_000n;
  return (
    `agent ${o.agentId}'s mandate was set at block ${o.setAtBlock}, only ${age} blocks ago: risk-v1's recent_permission_events ` +
    `reads the last ${o.windowBlocks} blocks at its pin, so it would show that MandateSet. Wait ${wait} more blocks ` +
    `(about ${minutes} minutes) before running the e2e`
  );
}

/** `body.data[].id` of an OpenAI-compatible model listing, or `null` if the body isn't one. */
function listedIds(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null || !Array.isArray((body as { data?: unknown }).data)) return null;
  const ids: string[] = [];
  for (const entry of (body as { data: unknown[] }).data) {
    if (typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string") ids.push((entry as { id: string }).id);
  }
  return ids;
}

/**
 * A zero-token check of validator B's LLM endpoint before anything is sent: one `GET <baseUrl>/models` with the
 * Bearer key (OpenAI-compatible; no completion, so no tokens). A network error, a timeout or a non-2xx answer
 * refuses. A well-formed listing must include every one of `models`; a 2xx answer that isn't a listing is accepted
 * with `listed: false` (the key and the endpoint answered, the models weren't checked).
 */
export async function checkModelsEndpoint(o: {
  baseUrl: string;
  apiKey: string;
  models: readonly string[];
  fetch: typeof fetch;
  timeoutMs: number;
}): Promise<{ ok: true; listed: boolean } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await o.fetch(`${o.baseUrl.replace(/\/+$/, "")}/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${o.apiKey}` },
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  } catch {
    return { ok: false, message: "LLM endpoint preflight: GET /models failed (network error or timeout)" };
  }
  if (response.status < 200 || response.status > 299) {
    return { ok: false, message: `LLM endpoint preflight: GET /models answered HTTP ${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: true, listed: false };
  }
  const ids = listedIds(body);
  if (ids === null) return { ok: true, listed: false };
  const missing = o.models.filter((model) => !ids.includes(model));
  if (missing.length > 0) return { ok: false, message: `LLM endpoint preflight: GET /models doesn't list ${missing.join(", ")}` };
  return { ok: true, listed: true };
}
