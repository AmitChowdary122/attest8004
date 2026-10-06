// Pure helpers for validator C's CRE tooling (P11): the outer-gas fit (cre-gas-probe.ts) and `pnpm cre:demo`'s plan.
import type { ValidationStatus } from "@attest8004/sdk";
import type { VerifyReport } from "@attest8004/validator-mandate";
import { encodeEventTopics, parseAbi, zeroHash, type Address, type Hex } from "viem";

/**
 * The forwarder's own gas (intrinsic, calldata, its routing) as `outerBase + outerPerByte × raw report bytes`, from
 * live `eth_estimateGas` samples of MockKeystoneForwarder.report at several sizes. The slope is the least-squares one
 * rounded up to a whole gas per byte; the base is then raised (to the next 1,000) until the line covers every sample.
 */
export function fitOuterGas(samples: ReadonlyArray<{ rawReportBytes: number; gas: bigint }>): { outerBase: number; outerPerByte: number } {
  if (new Set(samples.map((s) => s.rawReportBytes)).size < 2) throw new Error("fitOuterGas needs samples at two sizes at least");
  const n = samples.length;
  const xs = samples.map((s) => s.rawReportBytes);
  const ys = samples.map((s) => Number(s.gas));
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < n; i++) {
    cov += ((xs[i] as number) - meanX) * ((ys[i] as number) - meanY);
    varX += ((xs[i] as number) - meanX) ** 2;
  }
  const outerPerByte = Math.max(0, Math.ceil(cov / varX - 1e-9));
  const needed = Math.max(...samples.map((s) => Number(s.gas) - outerPerByte * s.rawReportBytes));
  const outerBase = Math.max(0, Math.ceil(needed / 1_000) * 1_000);
  return { outerBase, outerPerByte };
}

// ---------- pnpm cre:demo ----------

/** The workflow folder, its CLI target, and where the CLI runs (the CRE project root). */
export const CRE_WORKFLOW = { folder: "validator-c", target: "monad-testnet-sim", projectDir: "cre" } as const;

/** The CRE CLI's arguments for one simulation of the request log at `eventIndex` of `txHash` (after the binary). */
export function simulateArgv(o: { txHash: Hex; eventIndex: number; wasm?: string; broadcast: boolean }): string[] {
  return [
    "workflow",
    "simulate",
    CRE_WORKFLOW.folder,
    "--target",
    CRE_WORKFLOW.target,
    "--non-interactive",
    ...(o.broadcast ? ["--broadcast"] : []),
    ...(o.wasm !== undefined ? ["--wasm", o.wasm] : []),
    "--trigger-index",
    "0",
    "--evm-tx-hash",
    o.txHash,
    "--evm-event-index",
    String(o.eventIndex),
  ];
}

/** The command a viewer can run by hand: where the key comes from, never its value. */
export function printableCommand(argv: readonly string[]): string {
  return `cd ${CRE_WORKFLOW.projectDir} && CRE_ETH_PRIVATE_KEY=<from .env> mise exec -- cre ${argv.join(" ")}`;
}

/**
 * The CRE CLI's whole environment: PATH and HOME (for mise, Bun and the CLI's login in ~/.cre) and the broadcast key.
 * Nothing else from .env reaches the CLI. The CLI takes the key 0x-prefixed or not (P11 spike).
 */
export function childEnv(env: Record<string, string | undefined>): { PATH: string; HOME: string; CRE_ETH_PRIVATE_KEY: string } {
  const key = env.CRE_ETH_PRIVATE_KEY?.trim();
  if (!key) throw new Error("CRE_ETH_PRIVATE_KEY is not set in .env");
  return { PATH: env.PATH ?? "", HOME: env.HOME ?? "", CRE_ETH_PRIVATE_KEY: key };
}

/** The CRE CLI: `CRE_CLI` if set, else `cre` on PATH, else the installer's `~/.cre/bin/cre`. */
export function findCreCli(env: Record<string, string | undefined>, exists: (path: string) => boolean): string {
  const explicit = env.CRE_CLI?.trim();
  if (explicit && exists(explicit)) return explicit;
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    if (exists(`${dir}/cre`)) return `${dir}/cre`;
  }
  const installed = `${env.HOME ?? ""}/.cre/bin/cre`;
  if (exists(installed)) return installed;
  throw new Error("the CRE CLI wasn't found: install it (docs.chain.link/cre), or set CRE_CLI to its path");
}

const VALIDATION_REQUEST_TOPIC = encodeEventTopics({
  abi: parseAbi(["event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)"]),
  eventName: "ValidationRequest",
})[0] as Hex;

/** `--evm-event-index`: the position, in the request transaction's receipt, of the registry's ValidationRequest for `requestHash`. */
export function requestLogIndex(logs: ReadonlyArray<{ address: Address; topics: readonly Hex[] }>, registry: Address, requestHash: Hex): number {
  const index = logs.findIndex(
    (log) =>
      log.address.toLowerCase() === registry.toLowerCase() &&
      log.topics[0]?.toLowerCase() === VALIDATION_REQUEST_TOPIC &&
      log.topics[3]?.toLowerCase() === requestHash.toLowerCase(),
  );
  if (index < 0) throw new Error(`no ValidationRequest for ${requestHash} in the transaction's receipt`);
  return index;
}

/**
 * Whether C's verdict landed: the forwarder's ReportProcessed says `result=true` (it swallows onReport's revert, and
 * the simulator reports success from the receipt alone), and the registry shows C's mandate-v1 verdict with the
 * expected responseHash (when known).
 */
export function landedVerdict(o: {
  reportProcessed: { result: boolean } | null;
  status: Pick<ValidationStatus, "validator" | "response" | "responseHash" | "tag">;
  expectedHash: Hex | null;
  creValidator: Address;
}): { landed: true; score: number } | { landed: false; why: string } {
  const { reportProcessed, status, expectedHash, creValidator } = o;
  if (reportProcessed === null) return { landed: false, why: "the report transaction has no ReportProcessed log from the forwarder" };
  if (!reportProcessed.result) return { landed: false, why: "the forwarder reports result=false: CreValidator.onReport reverted (and was swallowed)" };
  if (status.validator.toLowerCase() !== creValidator.toLowerCase()) return { landed: false, why: `the request names ${status.validator}, not C` };
  if (status.responseHash === zeroHash || status.tag !== "mandate-v1") return { landed: false, why: "the registry shows no mandate-v1 verdict for the request" };
  if (expectedHash !== null && status.responseHash.toLowerCase() !== expectedHash.toLowerCase()) {
    return { landed: false, why: `another verdict (${status.responseHash}) is in C's slot` };
  }
  return { landed: true, score: status.response };
}

/** Takes the broadcast key can pay for: two reports a take, each at `reportGas` × the max fee (Monad charges the limit). */
export function creBudget(o: { balance: bigint; reportGas: bigint; maxFeePerGas: bigint }): { perReport: bigint; takesLeft: bigint } {
  const perReport = o.reportGas * o.maxFeePerGas;
  return { perReport, takesLeft: perReport === 0n ? 0n : o.balance / (2n * perReport) };
}

/** NO GATE MAY REQUIRE C: true when none of the vault's requirements names validator C. */
export function creExcludedFromVault(requirements: ReadonlyArray<{ validator: string }>, creValidator: Address): boolean {
  return requirements.every((r) => r.validator.toLowerCase() !== creValidator.toLowerCase());
}

/** A request with a verdict already is never simulated: C is write-once, so a broadcast would only spend gas. */
export function simulationDecision(status: { responseHash: Hex; tag: string }): { simulate: true } | { simulate: false; reason: string } {
  return status.responseHash === zeroHash && status.tag === "" ? { simulate: true } : { simulate: false, reason: "C already answered this request" };
}

/**
 * What the demo prints for a request C already answered: verify's re-execution of the existing verdict. A match pinned
 * at the request's block is C's own earlier verdict (C's workflow always pins there). A match at another block is a
 * valid mandate-v1 verdict someone else delivered: verify accepts any pin between the request and the response. A
 * MISMATCH means someone filled C's slot with a forged verdict; "could not verify" usually means an undecodable URI.
 */
export function alreadyAnsweredLines(report: Pick<VerifyReport, "verdict" | "pinnedBlock" | "posted" | "problems">, requestBlock: bigint): string[] {
  const problems = report.problems.join(", ");
  let line: string;
  if (report.verdict === "match" && report.pinnedBlock === requestBlock) {
    line = `  match: re-running mandate-v1 at block ${report.pinnedBlock} gives the posted score ${report.posted.score} and responseHash (C's own verdict: pinned at the request's block)`;
  } else if (report.verdict === "match") {
    line = `  match at block ${report.pinnedBlock}, but C pins the request's block ${requestBlock}: a valid mandate-v1 verdict someone else delivered through the mock forwarder's open route(), not C's workflow's`;
  } else if (report.verdict === "mismatch") {
    line = `  MISMATCH (${problems}): the posted verdict doesn't reproduce: someone filled C's slot through the mock forwarder's open route()`;
  } else {
    line = `  could not verify (${problems}): nothing is proven either way; C's workflow always posts an inline data: URI verify decodes`;
  }
  return ["C already answered this request; verify re-executes that verdict:", line];
}

/**
 * Runs `verify` once the report's block is `lag` (default 5, mandate-v1's PIN_LAG_BLOCKS) under the finalized head:
 * verify reads the request's status and the response log at the finalized head, so before that it can only answer
 * "could not verify". Throws if the block doesn't finalize within `timeoutMs`; `verify` is never called then.
 */
export async function verifyWhenFinal<R>(o: {
  reportBlock: bigint;
  finalized: () => Promise<bigint>;
  verify: () => Promise<R>;
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
  lag?: bigint;
  pollMs?: number;
  now?: () => number;
}): Promise<R> {
  const now = o.now ?? Date.now;
  const lag = o.lag ?? 5n;
  const giveUpAt = now() + o.timeoutMs;
  for (;;) {
    if ((await o.finalized()) >= o.reportBlock + lag) return o.verify();
    if (now() >= giveUpAt) throw new Error(`block ${o.reportBlock} didn't finalize within ${o.timeoutMs / 1000} s; verify not run`);
    await o.sleep(o.pollMs ?? 500);
  }
}

/**
 * The simulator's result line, a JSON string literal holding the workflow's own JSON; null for a malformed line or
 * anything else (P12: parsed inside the stream handler, where a throw would be uncaught).
 */
export function parseResultLine(line: string): string | null {
  try {
    const value: unknown = JSON.parse(line.trim());
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Why a simulation exited non-zero: the workflow's own `NOT_LANDED` throw, by its detail, or a plain failure (P12). */
export function simulationFailure(tail: readonly string[]): { kind: "NOT_LANDED"; detail: string } | { kind: "FAILED" } {
  for (const line of tail) {
    const match = /NOT_LANDED: (.*)$/.exec(line);
    if (match) return { kind: "NOT_LANDED", detail: (match[1] as string).trim() };
  }
  return { kind: "FAILED" };
}
