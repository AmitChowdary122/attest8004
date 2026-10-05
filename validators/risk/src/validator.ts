import {
  computeRequestHash,
  jsonLineLog,
  MAX_REQUEST_URI_BYTES,
  sendOperatorReport,
  ValidatorBase,
  type Admission,
  type CheckResult,
  type CursorStore,
  type InboxPort,
  type RespondedResponse,
  type ValidatorOptions,
  type VerifiedRequest,
} from "@attest8004/sdk";
import { mandateRequestOf, PIN_LAG_BLOCKS, type PinnedBlock, type ServedGate } from "@attest8004/validator-mandate";
import { BaseError, type Address, type Hex } from "viem";
import type { PromptGuard } from "./guard.ts";
import type { ChatClient } from "./llm.ts";
import type { NansenClient } from "./nansen.ts";
import { RISK_V1 } from "./params.ts";
import { riskAddressesAt, type RiskContracts, type RiskReader } from "./reader.ts";
import { riskReport } from "./report.ts";
import { readPrerequisite, runRiskV1 } from "./run.ts";
import type { Prerequisite } from "./types.ts";

/** How long `check()` waits for validator A's verdict at a pinned block before it throws (and the base retries). */
export const DEFAULT_RISK_PIN_TIMEOUT_MS = 120_000;
/** How often `check()` re-reads the finalized head and A's status while it waits. */
export const DEFAULT_RISK_PIN_POLL_MS = 500;
/** The base's wait after a failed cycle (doubling each time): provider failures are transient (Decision 6). */
export const DEFAULT_RISK_RETRY_DELAY_MS = 15_000;
/** Failed cycles before a request is given up: with the doubling wait, about 8 minutes (Decision 6). */
export const DEFAULT_RISK_MAX_FAILED_CYCLES = 6;

export type RiskValidatorOptions = Omit<ValidatorOptions, "tag" | "maxDeadlineAheadSeconds" | "maxRequestBytes"> & {
  reader: RiskReader;
  /**
   * The contracts, with the MandateRegistry history (`riskContractsFor(chainId)`). A check pinned at `P`
   * records the addresses valid at `P` (`riskAddressesAt`).
   */
  contracts: RiskContracts;
  /** Validator A, whose `mandate-v1` verdict on the same action must be answered first (`DEPLOYMENTS[chainId].validators.mandateV1`). */
  mandateValidator: Address;
  /** The (gate, agent) pairs whose requests this validator answers (`RISK_V1_GATES`); as `mandate-v1`'s. */
  gates: ServedGate[];
  /** The per-agent rate limit and daily gas budget, checked last in `accepts()`. */
  admission: Admission;
  llm: ChatClient;
  guard: PromptGuard;
  nansen: NansenClient;
  /** The model requested from `llm` (`LLM_MODEL`). */
  model: string;
  /** Default {@link DEFAULT_RISK_PIN_TIMEOUT_MS} (120,000 ms). */
  pinTimeoutMs?: number;
  /** Default {@link DEFAULT_RISK_PIN_POLL_MS} (500 ms). */
  pinPollMs?: number;
  /**
   * Where operator reports go (P7): after each response lands, a report is sealed to the agent's inbox key and posted
   * to the FindingsBoard, if the agent has one. `null` or absent: no reports, and no inbox reads.
   */
  inbox?: InboxPort | null;
};

/**
 * Validator B, `risk-v1` (SPEC §4.6): the SDK's `ValidatorBase` polling, request checks and canonical
 * evidence, around an agentic check that runs only once validator A (`mandate-v1`) has answered the
 * same action.
 *
 * - **`accepts()`**, in order, declining with one `warn` line: a gate it doesn't serve
 *   (`GATE_NOT_SERVED`) or serves only for other agents (`GATE_NOT_FOR_AGENT`), both before any RPC,
 *   exactly as `mandate-v1` does; then the admission policy (`RATE_LIMITED`, `GAS_BUDGET_EXHAUSTED`),
 *   admitted at the cycle head's time.
 * - **`check()`** pins `P` and waits there for A's verdict on the same action (`requestHash` for
 *   validator A, read with {@link readPrerequisite}); **no guard or model call happens before that**.
 *   The evidence records the contracts valid at `P` (the MandateRegistry among them).
 *   A verdict from another validator, or under another tag, declines `MANDATE_V1_VERDICT_INVALID:
 *   <reason>`. A score of 0 from A still runs B. Then it runs {@link runRiskV1} at `P`, which may
 *   itself decline (`PROMPT_TOO_LARGE`, `MODEL_OUTPUT_INVALID`, `EVIDENCE_TOO_LARGE`).
 * - **The pin.** `P` is `PIN_LAG_BLOCKS` (5) below the finalized head, never below the request's own
 *   block or the block this process's last response landed in; `P`'s time must be no more than
 *   3,600 s before the action's deadline (`verify` checks that at `P`); and A's verdict must be
 *   answered at `P`. Until all three hold it re-reads every `pinPollMs`; after `pinTimeoutMs` it
 *   throws: nothing is posted, and the base retries the request later (every `retryDelayMs`, doubling,
 *   up to `maxFailedCycles`, then gives up with no response). This assumes one process per key.
 * - **`onResponded()`** records the response's block for the pin and settles the admission
 *   reservation to the gas limit actually sent. Then, with an `inbox`, it posts the operator report
 *   (`riskReport`: each finding with a recommended action from code, sealed to the agent's inbox key, an
 *   explicit gas limit) and settles the report's reservation; a report that fails is logged and keeps its
 *   reservation. It never throws: the verdict has already landed.
 * - **Releases.** A decline from `check()` (any reason) and a request the base gives up on
 *   (`onGaveUp()`) release the request's admission reservation (`Admission.release`): no response
 *   will be sent for it, so its gas no longer counts against the daily budget (it still counts toward
 *   the agent's rate limit).
 * - **`pollOnce()`** is the base's, plus one `info` line (`caught up`, with the cursor's block) each
 *   time it catches up with the head, as `mandate-v1` logs.
 *
 * The tag is always `risk-v1`, the deadline horizon always 3,600 s and the request size limit always
 * the SDK's 16,384 bytes, whatever the options say. Defaults: `retryDelayMs` 15,000 and
 * `maxFailedCycles` 6. Logs are JSON lines through the base's logger (`jsonLineLog` by default). They
 * carry the LLM endpoint's host at most (the service's `starting` line in `main.ts`; this class logs
 * none of it), never its URL or the key.
 */
export class RiskValidator extends ValidatorBase {
  private readonly reader: RiskReader;
  private readonly contracts: RiskContracts;
  private readonly mandateValidator: Address;
  /** The agents each served gate (lower-case) is answered for. */
  private readonly gates: ReadonlyMap<string, ReadonlySet<bigint>>;
  private readonly admission: Admission;
  private readonly llm: ChatClient;
  private readonly guard: PromptGuard;
  private readonly nansen: NansenClient;
  private readonly model: string;
  private readonly pinTimeoutMs: number;
  private readonly pinPollMs: number;
  private readonly emit: (entry: Record<string, unknown>) => void;
  private readonly cursorStore: CursorStore;
  private readonly inbox: InboxPort | null;
  private caughtUp = false;
  /** The highest block one of this process's responses landed in. */
  private lastResponseBlock: bigint | undefined;
  /** The latest `P`'s timestamp: the clock `admission.settle` runs on. */
  private lastPinTimestamp = 0n;

  constructor(options: RiskValidatorOptions) {
    const { reader, contracts, mandateValidator, gates, admission, llm, guard, nansen, model, pinTimeoutMs, pinPollMs, inbox, ...base } = options;
    const log = options.log ?? jsonLineLog;
    super({
      ...base,
      log,
      retryDelayMs: options.retryDelayMs ?? DEFAULT_RISK_RETRY_DELAY_MS,
      maxFailedCycles: options.maxFailedCycles ?? DEFAULT_RISK_MAX_FAILED_CYCLES,
      tag: RISK_V1.tag,
      maxDeadlineAheadSeconds: RISK_V1.maxDeadlineAheadSeconds,
      maxRequestBytes: MAX_REQUEST_URI_BYTES,
    });
    if (gates.length === 0) throw new Error("a RiskValidator needs at least one gate to serve");
    this.reader = reader;
    this.contracts = contracts;
    this.mandateValidator = mandateValidator;
    const served = new Map<string, Set<bigint>>();
    for (const { gate, agentId } of gates) {
      const key = gate.toLowerCase();
      const agents = served.get(key) ?? new Set<bigint>();
      agents.add(agentId);
      served.set(key, agents);
    }
    this.gates = served;
    this.admission = admission;
    this.llm = llm;
    this.guard = guard;
    this.nansen = nansen;
    this.model = model;
    this.pinTimeoutMs = pinTimeoutMs ?? DEFAULT_RISK_PIN_TIMEOUT_MS;
    this.pinPollMs = pinPollMs ?? DEFAULT_RISK_PIN_POLL_MS;
    this.emit = log;
    this.cursorStore = options.cursor;
    this.inbox = inbox ?? null;
  }

  /** The base's poll, plus one `info` line each time it catches up with the head. */
  override async pollOnce(): ReturnType<ValidatorBase["pollOnce"]> {
    const result = await super.pollOnce();
    if (result.caughtUp && !this.caughtUp) {
      const block = await this.cursorStore.load().catch(() => undefined);
      this.logLine("info", "caught up", { block });
    }
    this.caughtUp = result.caughtUp;
    return result;
  }

  protected override async accepts(request: VerifiedRequest): Promise<boolean | { decline: string }> {
    const agentId = request.action.agentId;
    const agents = this.gates.get(request.gate.toLowerCase());
    if (agents === undefined) {
      return { decline: `GATE_NOT_SERVED: agent ${agentId} requested through gate ${request.gate}, which this validator doesn't serve` };
    }
    if (!agents.has(agentId)) {
      const listed = [...agents].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const served = listed.length === 1 ? `agent ${listed[0]}` : `agents ${listed.join(", ")}`;
      return { decline: `GATE_NOT_FOR_AGENT: gate ${request.gate} serves ${served}, not ${agentId}` };
    }
    const admitted = this.admission.admit({ requestHash: request.event.requestHash, agentId, now: request.headTimestamp });
    return admitted.ok ? true : { decline: admitted.detail };
  }

  /** `verdict()`, releasing the admission reservation on a decline (any reason): no response will be sent for it. */
  protected override async check(request: VerifiedRequest): Promise<CheckResult | { decline: string }> {
    const result = await this.verdict(request);
    if ("decline" in result) this.admission.release(request.event.requestHash);
    return result;
  }

  /** Releases the admission reservation of a request the base gave up on: no response will be sent for it. */
  protected override onGaveUp(requestHash: Hex): void {
    this.admission.release(requestHash);
  }

  private async verdict(request: VerifiedRequest): Promise<CheckResult | { decline: string }> {
    const { requestHash, blockNumber } = request.event;
    const requestHashA = computeRequestHash({ chainId: request.chainId, gate: request.gate, validator: this.mandateValidator, action: request.action });
    const pin = await this.pin(request, requestHashA);
    if ("invalid" in pin) return { decline: `MANDATE_V1_VERDICT_INVALID: ${pin.invalid}` };
    const { pinned, prerequisite } = pin;
    if (pinned.timestamp > this.lastPinTimestamp) this.lastPinTimestamp = pinned.timestamp;

    const result = await runRiskV1({
      reader: this.reader,
      llm: this.llm,
      guard: this.guard,
      nansen: this.nansen,
      model: this.model,
      addresses: riskAddressesAt(this.contracts, pinned.number),
      mandateValidator: this.mandateValidator,
      request: mandateRequestOf(request.json, requestHash, blockNumber),
      pinned,
      prerequisite,
    });
    if (!("decline" in result)) {
      this.logLine("info", "verdict ready", { requestHash, pin: pinned.number, prerequisiteScore: prerequisite.score, score: result.score, reasons: result.reasons });
    }
    return result;
  }

  protected override async onResponded(response: RespondedResponse): Promise<void> {
    const { requestHash, blockNumber, gasLimit } = response;
    if (this.lastResponseBlock === undefined || blockNumber > this.lastResponseBlock) this.lastResponseBlock = blockNumber;
    try {
      this.admission.settle({ requestHash, gasLimit, now: this.lastPinTimestamp });
    } catch (error) {
      try {
        this.logLine("error", "admission settle failed; the reservation stays at the maximum", { requestHash, error: errorMessage(error) });
      } catch {
        // The response already landed; nothing here may throw.
      }
    }
    if (this.inbox) await this.postReport(this.inbox, response);
  }

  /** Posts the operator report for a landed response and settles its gas reservation. Never throws. */
  private async postReport(inbox: InboxPort, response: RespondedResponse): Promise<void> {
    const { requestHash } = response;
    try {
      const outcome = await sendOperatorReport(inbox, { report: riskReport({ evidence: response.evidence, responseHash: response.responseHash }) });
      if (outcome.kind === "posted") {
        this.admission.settleReport({ requestHash, gasLimit: outcome.gasLimit, now: this.lastPinTimestamp });
        const { txHash, blockNumber, gasLimit, envelopeBytes } = outcome;
        this.logLine("info", "operator report posted", { requestHash, txHash, blockNumber, gasLimit, envelopeBytes });
      } else if (outcome.kind === "skipped") {
        this.admission.settleReport({ requestHash, gasLimit: 0n, now: this.lastPinTimestamp });
        this.logLine("info", "operator report skipped", { requestHash, reason: outcome.reason });
      } else {
        this.logLine("error", "operator report failed; its gas reservation stays", { requestHash, error: outcome.error });
      }
    } catch (error) {
      try {
        this.logLine("error", "operator report failed; its gas reservation stays", { requestHash, error: errorMessage(error) });
      } catch {
        // The response already landed; nothing here may throw.
      }
    }
  }

  /**
   * `P` for one check (see the class doc), with validator A's verdict there; or `{ invalid }` when A's
   * answer at `P` is one `risk-v1` must not run on. Throws after `pinTimeoutMs`.
   */
  private async pin(request: VerifiedRequest, requestHashA: Hex): Promise<{ pinned: PinnedBlock; prerequisite: Prerequisite } | { invalid: string }> {
    const { requestHash, blockNumber } = request.event;
    let floor = blockNumber;
    if (this.lastResponseBlock !== undefined && this.lastResponseBlock > floor) floor = this.lastResponseBlock;
    // The base checked the deadline horizon at the cycle head, which can be later than P: P's own time
    // must allow it too, as `verify` checks.
    const earliestTime = request.action.deadline - RISK_V1.maxDeadlineAheadSeconds;
    const giveUpAt = Date.now() + this.pinTimeoutMs;
    let waiting = false;
    for (;;) {
      const head = await this.reader.finalized();
      const at = head.number - PIN_LAG_BLOCKS;
      if (at >= floor) {
        const pinned = await this.reader.block(at);
        if (pinned.timestamp >= earliestTime) {
          const prerequisite = await readPrerequisite(this.reader, { mandateValidator: this.mandateValidator, requestHashA, pinned });
          if (prerequisite !== "PENDING") return "invalid" in prerequisite ? prerequisite : { pinned, prerequisite };
        }
      }
      if (Date.now() >= giveUpAt) {
        throw new Error(
          `mandate-v1's verdict ${requestHashA} wasn't answered at a pinned block (the finalized head minus ${PIN_LAG_BLOCKS}, ` +
            `at or after block ${floor}, at a time no earlier than ${earliestTime}) within ${this.pinTimeoutMs} ms; retry later`,
        );
      }
      if (!waiting) {
        waiting = true;
        this.logLine("info", "waiting for mandate-v1's verdict", { requestHash, mandateRequestHash: requestHashA, head: head.number, pin: at, floor, earliestTime });
      }
      await sleep(this.pinPollMs);
    }
  }

  private logLine(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown>): void {
    const entry: Record<string, unknown> = { level, msg, validator: RISK_V1.tag };
    for (const [key, value] of Object.entries(fields)) if (value !== undefined) entry[key] = value;
    try {
      this.emit(entry);
    } catch {
      // A logger that throws never changes what the validator does.
    }
  }
}

/** viem's short message, never its full one (which can carry the RPC URL). */
function errorMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
