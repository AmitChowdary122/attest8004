import { Admission, decodeJsonDataUri, MemoryCursorStore, MAX_REQUEST_URI_BYTES, type InboxPort, type Outcome } from "@attest8004/sdk";
import { PIN_LAG_BLOCKS } from "@attest8004/validator-mandate";
import { getAddress, keccak256, stringToBytes, toHex, zeroHash, type Address, type Hash, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseRiskEvidence, type RiskEvidence } from "../src/evidence.ts";
import { RISK_V1 } from "../src/params.ts";
import type { RiskContracts } from "../src/reader.ts";
import { riskReport } from "../src/report.ts";
import { RiskValidator } from "../src/validator.ts";
import {
  AGENT,
  chatResponse,
  CONTRACTS,
  contractsWith,
  FakeChain,
  fakeAction,
  fakeGuard,
  FakeRiskReader,
  findingsJson,
  GATE,
  landMandateVerdict,
  MODEL,
  NO_FINDINGS,
  OTHER_GATE,
  P4_REGISTRY,
  requestPair,
  scriptedLlm,
  SINK,
  toolCall,
  transient429,
  tsOf,
  unavailableNansen,
  V2_REGISTRY,
  VALIDATOR_A,
  VALIDATOR_B,
  type Step,
} from "./helpers/risk-fakes.ts";

// The real report builder, wrapped so one test can make it throw.
vi.mock("../src/report.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/report.ts")>();
  return { ...real, riskReport: vi.fn(real.riskReport) };
});

let chain: FakeChain;
let reader: FakeRiskReader;
let logs: Record<string, unknown>[];

beforeEach(() => {
  chain = new FakeChain();
  reader = new FakeRiskReader(chain);
  logs = [];
});

/** A model run that traces the action, looks at the sink and reports the forward: score 0. */
function riskyRun(): Step[] {
  return [
    chatResponse({ toolCalls: [toolCall("simulate_action")] }),
    chatResponse({ toolCalls: [toolCall("counterparty_onchain", { address: SINK })] }),
    chatResponse({ content: "Enough." }),
    chatResponse({
      content: findingsJson([
        { code: "FUNDS_FORWARDED", severity: "high", explanation: "The target forwards all of it to the sink.", sources: ["simulate_action"] },
      ]),
    }),
  ];
}

function makeValidator(o: {
  llm?: ReturnType<typeof scriptedLlm>;
  guard?: ReturnType<typeof fakeGuard>;
  admission?: Admission;
  gates?: Array<{ gate: Address; agentId: bigint }>;
  pinTimeoutMs?: number;
  retryDelayMs?: number;
  cursor?: MemoryCursorStore;
  contracts?: RiskContracts;
  /** Options a caller might pass that RiskValidator must ignore. */
  ignored?: Record<string, unknown>;
  inbox?: InboxPort | null;
} = {}) {
  const llm = o.llm ?? scriptedLlm(riskyRun());
  const guard = o.guard ?? fakeGuard();
  const validator = new RiskValidator({
    chain,
    cursor: o.cursor ?? new MemoryCursorStore(999n),
    reader,
    contracts: o.contracts ?? CONTRACTS,
    mandateValidator: VALIDATOR_A,
    gates: o.gates ?? [{ gate: GATE, agentId: AGENT }],
    admission: o.admission ?? new Admission({ maxRequestsPerAgent: 20, agentWindowSeconds: 3_600n, dailyGasBudget: 10_000_000n, maxGasPerResponse: 1_000_000n }),
    llm: llm.client,
    guard,
    nansen: unavailableNansen(),
    model: MODEL,
    ...(o.inbox === undefined ? {} : { inbox: o.inbox }),
    pinTimeoutMs: o.pinTimeoutMs ?? 2_000,
    pinPollMs: 1,
    pollIntervalMs: 0,
    ...(o.retryDelayMs === undefined ? {} : { retryDelayMs: o.retryDelayMs }),
    log: (entry) => logs.push(entry),
    ...o.ignored,
  });
  return { validator, llm, guard };
}

/** A request to B for a fresh action in `block`, with A's request made in the same block. */
function addAction(o: { block?: bigint; gate?: Address; agentId?: bigint; deadline?: bigint } = {}) {
  const block = o.block ?? 1_000n;
  const pair = requestPair(fakeAction({ agentId: o.agentId, deadline: o.deadline }), o.gate ?? GATE);
  chain.addRequest(pair.jsonA, block);
  const event = chain.addRequest(pair.jsonB, block);
  return { ...pair, event, block };
}

function answerA(pair: ReturnType<typeof addAction>, o: { block?: bigint; score?: number; reasons?: string[]; tag?: string } = {}) {
  return landMandateVerdict(chain, {
    jsonA: pair.jsonA,
    requestBlock: pair.block,
    block: o.block ?? pair.block + 1n,
    score: o.score ?? 100,
    reasons: o.reasons ?? [],
    tag: o.tag,
  });
}

/** The evidence of B's `index`-th response, decoded and strictly parsed, plus its size in bytes. */
function sentEvidence(index = 0): { doc: RiskEvidence; bytes: number } {
  const sent = chain.sent[index];
  if (!sent) throw new Error(`no response ${index}`);
  const decoded = decodeJsonDataUri(sent.responseURI, 131_072);
  if (!decoded.ok) throw new Error(decoded.detail);
  expect(keccak256(stringToBytes(decoded.text))).toBe(sent.responseHash);
  const parsed = parseRiskEvidence(decoded.text);
  if (!parsed.ok) throw new Error(parsed.error);
  return { doc: parsed.doc, bytes: stringToBytes(decoded.text).length };
}

function declined(outcomes: Outcome[]): string[] {
  return outcomes.map((o) => (o.kind === "skipped" ? `${o.reason}${o.detail ? `: ${o.detail}` : ""}` : o.kind));
}

describe("RiskValidator: options", () => {
  it("needs at least one gate", () => {
    expect(() => makeValidator({ gates: [] })).toThrow(/at least one gate/);
  });

  it("always tags risk-v1, keeps the SDK's 16 KB request limit and a 3,600 s horizon, whatever the options say", async () => {
    const far = addAction({ deadline: tsOf(1_004n) + 3_601n });
    answerA(far);
    // Calldata whose request URI is over 16 KB (base64 of ~25,000 hex characters).
    const big = requestPair(fakeAction({ data: `0x${"ab".repeat(9_000)}` }));
    chain.addRequest(big.jsonA, 1_000n);
    chain.addRequest(big.jsonB, 1_000n);
    const ok = addAction();
    answerA(ok);
    const { validator } = makeValidator({ ignored: { tag: "other-v9", maxDeadlineAheadSeconds: 99_999n, maxRequestBytes: 1_000_000 } });

    const { outcomes } = await validator.pollOnce();
    expect(outcomes.map((o) => (o.kind === "skipped" ? o.reason : o.kind))).toEqual(["DEADLINE_TOO_FAR", "URI_TOO_LARGE", "responded"]);
    expect(chain.sent.map((s) => s.tag)).toEqual(["risk-v1"]);
    expect(MAX_REQUEST_URI_BYTES).toBe(16_384);
  });
});

describe("RiskValidator: caught up", () => {
  it("logs once each time it catches up with the head (the service's smoke test looks for it)", async () => {
    const { validator } = makeValidator();
    await validator.pollOnce();
    await validator.pollOnce();
    expect(logs.filter((entry) => entry.msg === "caught up")).toEqual([expect.objectContaining({ level: "info", validator: "risk-v1", block: 1_004n })]);

    chain.headBlock = { number: 1_250n, timestamp: tsOf(1_250n) };
    await validator.pollOnce(); // 1,005-1,104
    await validator.pollOnce(); // 1,105-1,204
    await validator.pollOnce(); // 1,205-1,250
    expect(logs.filter((entry) => entry.msg === "caught up").map((entry) => entry.block)).toEqual([1_004n, 1_250n]);
  });
});

describe("RiskValidator: accepts()", () => {
  it("GATE_NOT_SERVED: declined before any read or model call, and before admission", async () => {
    addAction({ gate: OTHER_GATE });
    const admission = new Admission({ maxRequestsPerAgent: 20, agentWindowSeconds: 3_600n, dailyGasBudget: 10_000_000n, maxGasPerResponse: 1_000_000n });
    const admit = vi.spyOn(admission, "admit");
    const { validator, llm, guard } = makeValidator({ admission });
    const { outcomes } = await validator.pollOnce();
    expect(admit).not.toHaveBeenCalled();
    expect(declined(outcomes)).toEqual([expect.stringMatching(/^DECLINED: GATE_NOT_SERVED: agent 1984 requested through gate 0x0+E1/i)]);
    expect(reader.calls).toEqual([]);
    expect(llm.requests).toEqual([]);
    expect(guard.texts).toEqual([]);
    expect(chain.sent).toEqual([]);
  });

  it("GATE_NOT_FOR_AGENT: declined before any read or model call, and before admission", async () => {
    addAction({ agentId: 7n });
    const admission = new Admission({ maxRequestsPerAgent: 20, agentWindowSeconds: 3_600n, dailyGasBudget: 10_000_000n, maxGasPerResponse: 1_000_000n });
    const admit = vi.spyOn(admission, "admit");
    const { validator, llm } = makeValidator({ admission });
    const { outcomes } = await validator.pollOnce();
    expect(admit).not.toHaveBeenCalled();
    expect(declined(outcomes)).toEqual([`DECLINED: GATE_NOT_FOR_AGENT: gate ${GATE} serves agent 1984, not 7`]);
    expect(reader.calls).toEqual([]);
    expect(llm.requests).toEqual([]);
  });

  it("RATE_LIMITED from an Admission of 1 request an hour: the second request gets no read and no model call", async () => {
    const first = addAction();
    answerA(first);
    const second = addAction();
    answerA(second);
    const { validator, llm } = makeValidator({
      admission: new Admission({ maxRequestsPerAgent: 1, agentWindowSeconds: 3_600n, dailyGasBudget: 10_000_000n, maxGasPerResponse: 1_000_000n }),
    });
    const { outcomes } = await validator.pollOnce();
    expect(declined(outcomes)).toEqual(["responded", "DECLINED: agent 1984 RATE_LIMITED (1/1 requests in the last 3600 s)"]);
    expect(llm.requests).toHaveLength(4); // the first request's run only
    expect(reader.statusReads.filter(([hash]) => hash === second.rhA)).toEqual([]);
    expect(chain.sent).toHaveLength(1);
  });
});

describe("RiskValidator: admission release (final review A3)", () => {
  /** Room for exactly one response's reservation at a time. */
  const oneAtATime = () => new Admission({ maxRequestsPerAgent: 20, agentWindowSeconds: 3_600n, dailyGasBudget: 1_000_000n, maxGasPerResponse: 1_000_000n });

  it("a check() decline (MANDATE_V1_VERDICT_INVALID) frees its reservation: the next request is admitted with the budget full", async () => {
    const first = addAction();
    answerA(first, { tag: "mandate-v2" });
    const second = addAction();
    answerA(second);
    const admission = oneAtATime();
    const release = vi.spyOn(admission, "release");
    const { validator } = makeValidator({ admission });

    const { outcomes } = await validator.pollOnce();
    expect(declined(outcomes)).toEqual([expect.stringMatching(/^DECLINED: MANDATE_V1_VERDICT_INVALID: /), "responded"]);
    expect(release).toHaveBeenCalledWith(first.rhB);
    expect(release).toHaveBeenCalledTimes(1);
    expect(chain.sent.map((s) => s.requestHash)).toEqual([second.rhB]);
  });

  it("a decline from runRiskV1 (MODEL_OUTPUT_INVALID) frees its reservation too", async () => {
    const first = addAction();
    answerA(first);
    const second = addAction();
    answerA(second);
    const llm = scriptedLlm([
      chatResponse({ content: "Done." }),
      chatResponse({ content: "no" }),
      chatResponse({ content: "no" }),
      chatResponse({ content: "no" }),
      ...riskyRun(),
    ]);
    const { validator } = makeValidator({ llm, admission: oneAtATime() });

    const { outcomes } = await validator.pollOnce();
    expect(declined(outcomes)).toEqual(["DECLINED: MODEL_OUTPUT_INVALID: not JSON", "responded"]);
    expect(chain.sent.map((s) => s.requestHash)).toEqual([second.rhB]);
  });

  it("a given-up request frees its reservation: once A never answers the first, the second is admitted", async () => {
    const first = addAction();
    const second = addAction();
    answerA(second);
    const admission = oneAtATime();
    const release = vi.spyOn(admission, "release");
    const { validator } = makeValidator({ admission, pinTimeoutMs: 20 });

    let outcomes: Outcome[] = [];
    for (let cycle = 1; cycle <= 6; cycle++) outcomes = (await validator.pollOnce()).outcomes;
    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "gave-up", requestHash: first.rhB }),
      expect.objectContaining({ kind: "responded", requestHash: second.rhB }),
    ]);
    expect(release).toHaveBeenCalledWith(first.rhB);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a response keeps its reservation (settled, never released)", async () => {
    const pair = addAction();
    answerA(pair);
    const admission = oneAtATime();
    const release = vi.spyOn(admission, "release");
    await makeValidator({ admission }).validator.pollOnce();
    expect(chain.sent).toHaveLength(1);
    expect(release).not.toHaveBeenCalled();
  });
});

describe("RiskValidator: waiting for mandate-v1", () => {
  it("no verdict from A: no model call, no response; check throws after pinTimeoutMs, the base retries, then gives up after 6 cycles", async () => {
    const pair = addAction();
    const { validator, llm, guard } = makeValidator({ pinTimeoutMs: 20 });

    const waits: Array<number | undefined> = [];
    let last: Outcome[] = [];
    for (let cycle = 1; cycle <= 6; cycle++) {
      const result = await validator.pollOnce();
      waits.push(result.retryAfterMs);
      last = result.outcomes;
    }

    expect(waits.slice(0, 5)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000]); // retryDelayMs 15,000, doubling
    expect(last).toEqual([expect.objectContaining({ kind: "gave-up", requestHash: pair.rhB, error: expect.stringMatching(/mandate-v1/) })]);
    expect(llm.requests).toEqual([]);
    expect(guard.texts).toEqual([]);
    expect(chain.sent).toEqual([]);
    // It only ever read A's status at pins it could accept, never below the request's block.
    expect(reader.statusReads.every(([, at]) => at >= pair.block)).toBe(true);
  });

  it("A answers later → B responds once with tag risk-v1 and a 24 KiB-bounded data: URI", async () => {
    const pair = addAction();
    reader.onFinalized = (reads) => {
      if (reads === 4) {
        answerA(pair, { block: 1_010n });
        chain.finalized = 1_010n + PIN_LAG_BLOCKS;
      }
    };
    const { validator, llm } = makeValidator();

    const { outcomes } = await validator.pollOnce();
    expect(declined(outcomes)).toEqual(["responded"]);
    expect(llm.requests.length).toBe(4);
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]?.tag).toBe("risk-v1");
    expect(chain.sent[0]?.response).toBe(0);
    const { doc, bytes } = sentEvidence();
    expect(bytes).toBeLessThanOrEqual(RISK_V1.maxEvidenceBytes);
    expect(doc.validator).toBe("risk-v1");
    expect(doc.block.number).toBe(1_010n);
    expect(doc.prerequisite).toMatchObject({ validator: VALIDATOR_A, requestHash: pair.rhA, score: 100, tag: "mandate-v1" });
    expect(doc.reasons).toEqual(["FUNDS_FORWARDED"]);
    expect(logs).toContainEqual(expect.objectContaining({ level: "info", msg: "waiting for mandate-v1's verdict", requestHash: pair.rhB }));

    // Once: a later cycle has nothing left to answer.
    await validator.pollOnce();
    expect(chain.sent).toHaveLength(1);
  });

  it("B's evidence records the MandateRegistry valid at its pin: P4's before the switch, v2's at it", async () => {
    for (const [switchBlock, expected] of [
      [1_005n, P4_REGISTRY],
      [1_004n, V2_REGISTRY],
    ] as const) {
      chain = new FakeChain();
      reader = new FakeRiskReader(chain);
      answerA(addAction());
      const contracts = contractsWith([
        { address: P4_REGISTRY, fromBlock: 950n },
        { address: V2_REGISTRY, fromBlock: switchBlock },
      ]);
      const { validator } = makeValidator({ contracts });

      await validator.pollOnce();

      const { doc } = sentEvidence();
      expect(doc.block.number, `switch at ${switchBlock}`).toBe(1_004n);
      expect(doc.params.contracts.mandateRegistry, `switch at ${switchBlock}`).toBe(expected);
    }
  });

  it("A answered with another tag → decline MANDATE_V1_VERDICT_INVALID, no model call, no response, not retried", async () => {
    const pair = addAction();
    answerA(pair, { tag: "mandate-v2" });
    const { validator, llm, guard } = makeValidator();

    const { outcomes } = await validator.pollOnce();
    expect(declined(outcomes)).toEqual([expect.stringMatching(/^DECLINED: MANDATE_V1_VERDICT_INVALID: .*"mandate-v2"/)]);
    expect(llm.requests).toEqual([]);
    expect(guard.texts).toEqual([]);
    await validator.pollOnce();
    expect(chain.sent).toEqual([]);
  });

  it("A's 0 still runs B, and A's reasons reach the evidence", async () => {
    const pair = addAction();
    answerA(pair, { score: 0, reasons: ["TARGET_NOT_ALLOWED"] });
    const { validator, llm } = makeValidator();
    await validator.pollOnce();
    expect(llm.requests[0]?.messages[1]?.content).toContain('{"reasons":["TARGET_NOT_ALLOWED"],"score":0}');
    expect(sentEvidence().doc.prerequisite).toMatchObject({ score: 0, reasons: ["TARGET_NOT_ALLOWED"] });
  });
});

describe("RiskValidator: the pin", () => {
  it("P ≥ the request's block: it waits for the finalized head", async () => {
    chain.finalized = 1_002n; // P would be 997, below the request's block
    const pair = addAction();
    answerA(pair);
    reader.onFinalized = (reads) => {
      if (reads === 5) chain.finalized = 1_010n;
    };
    const { validator } = makeValidator();
    await validator.pollOnce();
    expect(sentEvidence().doc.block.number).toBe(1_005n);
    expect(reader.statusReads.every(([, at]) => at >= pair.block)).toBe(true);
  });

  it("P ≥ the block of this process's last response", async () => {
    chain.advanceOnRespond = false;
    const first = addAction();
    answerA(first);
    const second = addAction({ block: 1_001n });
    answerA(second);
    let respondedAt = 0n;
    reader.onFinalized = () => {
      if (chain.sent.length === 1 && respondedAt === 0n) respondedAt = chain.sent[0]?.block ?? 0n;
      if (respondedAt > 0n) chain.finalized++; // the chain moves on slowly after B's first response
    };
    const { validator } = makeValidator({ llm: scriptedLlm((_, i) => riskyRun()[i % 4] as ReturnType<typeof chatResponse>) });

    const { outcomes } = await validator.pollOnce();
    expect(declined(outcomes)).toEqual(["responded", "responded"]);
    const firstBlock = chain.sent[0]?.block ?? 0n;
    expect(firstBlock).toBe(1_010n);
    expect(sentEvidence(0).doc.block.number).toBe(1_004n);
    expect(sentEvidence(1).doc.block.number).toBeGreaterThanOrEqual(firstBlock);
  });

  it("P's time is within 3,600 s of the deadline: it waits for that too", async () => {
    chain.headBlock = { number: 1_004n, timestamp: tsOf(1_008n) };
    const deadline = tsOf(1_008n) + 3_600n; // so P must be at least block 1,008
    const pair = addAction({ deadline });
    answerA(pair);
    reader.onFinalized = () => {
      chain.finalized++;
    };
    const { validator } = makeValidator();
    await validator.pollOnce();
    const { doc } = sentEvidence();
    expect(doc.block.timestamp).toBeGreaterThanOrEqual(deadline - 3_600n);
    expect(doc.block.number).toBe(1_008n);
  });
});

describe("RiskValidator: failures", () => {
  it("provider 429 throughout: never responds, gives up", async () => {
    const pair = addAction();
    answerA(pair);
    const llm = scriptedLlm(() => transient429());
    const { validator } = makeValidator({ llm });
    let last: Outcome[] = [];
    for (let cycle = 1; cycle <= 6; cycle++) last = (await validator.pollOnce()).outcomes;
    expect(last).toEqual([expect.objectContaining({ kind: "gave-up", requestHash: pair.rhB, error: "provider error (status 429)" })]);
    expect(llm.requests).toHaveLength(6); // one attempt per cycle, each from scratch
    expect(chain.sent).toEqual([]);
  });

  it("restarted validator skips ALREADY_RESPONDED with no model call", async () => {
    const pair = addAction();
    answerA(pair);
    await makeValidator().validator.pollOnce();
    expect(chain.sent).toHaveLength(1);

    const restarted = makeValidator({ llm: scriptedLlm(riskyRun()) });
    const { outcomes } = await restarted.validator.pollOnce();
    expect(declined(outcomes)).toEqual(["ALREADY_RESPONDED"]);
    expect(restarted.llm.requests).toEqual([]);
    expect(chain.sent).toHaveLength(1);
  });

  it("model output invalid three times → DECLINED, no response, not retried", async () => {
    const pair = addAction();
    answerA(pair);
    const llm = scriptedLlm([chatResponse({ content: "Done." }), chatResponse({ content: "no" }), chatResponse({ content: "no" }), chatResponse({ content: "no" })]);
    const { validator } = makeValidator({ llm });

    const { outcomes } = await validator.pollOnce();
    expect(declined(outcomes)).toEqual(["DECLINED: MODEL_OUTPUT_INVALID: not JSON"]);
    expect(logs).toContainEqual(expect.objectContaining({ level: "warn", requestHash: pair.rhB, reason: "DECLINED", detail: "MODEL_OUTPUT_INVALID: not JSON" }));
    await validator.pollOnce();
    expect(llm.requests).toHaveLength(4);
    expect(chain.sent).toEqual([]);
  });

  it("oversized evidence → DECLINED EVIDENCE_TOO_LARGE, nothing sent", async () => {
    const pair = addAction();
    answerA(pair);
    const findings = Array.from({ length: 8 }, () => ({ code: "OTHER", severity: "low", explanation: "e".repeat(400), sources: ["request"] }));
    const llm = scriptedLlm([
      chatResponse({ content: "q".repeat(4_000) }),
      chatResponse({ content: "x".repeat(6_000) }),
      chatResponse({ content: "y".repeat(6_000) }),
      chatResponse({ content: findingsJson(findings) }),
    ]);
    const { validator } = makeValidator({ llm });
    const { outcomes } = await validator.pollOnce();
    expect(declined(outcomes)).toEqual([expect.stringMatching(/^DECLINED: EVIDENCE_TOO_LARGE: \d+ bytes$/)]);
    expect(chain.sent).toEqual([]);
  });

  it("logs never carry the LLM host, a URL or the key", async () => {
    const pair = addAction();
    answerA(pair);
    await makeValidator().validator.pollOnce();
    const text = JSON.stringify(logs, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
    expect(text).not.toContain("api.groq.com");
    expect(text).not.toMatch(/https?:\/\//);
  });

  it("a clean action scores 100 with no findings", async () => {
    const pair = addAction();
    answerA(pair);
    const llm = scriptedLlm([chatResponse({ content: "Fine." }), chatResponse({ content: NO_FINDINGS })]);
    await makeValidator({ llm }).validator.pollOnce();
    expect(chain.sent[0]?.response).toBe(100);
    expect(sentEvidence().doc.findings).toEqual([]);
  });
});

/** An InboxPort that records reads and posts; the agent's inbox key is `inboxKey` (zero: none). */
class FakeInbox implements InboxPort {
  readonly chainId = 10_143;
  readonly validator: Address = VALIDATOR_B;
  readonly findingsBoard: Address = getAddress("0xa7d52b3b08fab0cd0527c6242ca678f9feee6a1c");
  readonly validationRegistry: Address = CONTRACTS.validationRegistry;
  inboxKey: Hex = "0x8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
  readFails: Error | null = null;
  postFails: Error | null = null;
  readonly reads: bigint[] = [];
  readonly posts: { requestHash: Hex; agentId: bigint; envelope: Hex; responsesBefore: number }[] = [];

  async inboxKeyOf(agentId: bigint): Promise<Hex> {
    this.reads.push(agentId);
    if (this.readFails) throw this.readFails;
    return this.inboxKey;
  }
  async post(p: { requestHash: Hex; agentId: bigint; envelope: Hex }) {
    this.posts.push({ ...p, responsesBefore: chain.sent.length });
    if (this.postFails) throw this.postFails;
    return { txHash: keccak256(toHex(`report ${this.posts.length}`)) as Hash, blockNumber: 1_020n, gasLimit: 88_000n };
  }
}

describe("RiskValidator: operator reports (P7)", () => {
  const reportAdmission = () =>
    new Admission({ maxRequestsPerAgent: 20, agentWindowSeconds: 3_600n, dailyGasBudget: 10_000_000n, maxGasPerResponse: 1_000_000n, maxGasPerReport: 420_000n });
  const reportErrors = () => logs.filter((l) => l.level === "error" && l.msg === "operator report failed; its gas reservation stays");

  it("posts one report after the response lands, with the response's requestHash and agent", async () => {
    const pair = addAction();
    answerA(pair);
    const inbox = new FakeInbox();

    const { outcomes } = await makeValidator({ inbox }).validator.pollOnce();

    expect(declined(outcomes)).toEqual(["responded"]);
    expect(inbox.reads).toEqual([AGENT]);
    expect(inbox.posts).toHaveLength(1);
    expect(inbox.posts[0]).toMatchObject({ requestHash: pair.rhB, agentId: AGENT, responsesBefore: 1 });
    expect(logs).toContainEqual(expect.objectContaining({ level: "info", msg: "operator report posted", requestHash: pair.rhB, gasLimit: 88_000n }));
  });

  it("settles admission's report part to the post's gas limit", async () => {
    const pair = addAction();
    answerA(pair);
    const admission = reportAdmission();
    const settleReport = vi.spyOn(admission, "settleReport");

    await makeValidator({ inbox: new FakeInbox(), admission }).validator.pollOnce();

    expect(settleReport).toHaveBeenCalledWith(expect.objectContaining({ requestHash: pair.rhB, gasLimit: 88_000n }));
  });

  it("no inbox key → no post; report reservation settled to 0", async () => {
    const pair = addAction();
    answerA(pair);
    const inbox = new FakeInbox();
    inbox.inboxKey = zeroHash;
    const admission = reportAdmission();
    const settleReport = vi.spyOn(admission, "settleReport");

    await makeValidator({ inbox, admission }).validator.pollOnce();

    expect(inbox.posts).toHaveLength(0);
    expect(settleReport).toHaveBeenCalledWith(expect.objectContaining({ requestHash: pair.rhB, gasLimit: 0n }));
  });

  it("post fails → outcome responded, one error log, reservation kept", async () => {
    const pair = addAction();
    answerA(pair);
    const inbox = new FakeInbox();
    inbox.postFails = new Error("RPC Request failed.");
    const admission = reportAdmission();
    const settleReport = vi.spyOn(admission, "settleReport");

    const { outcomes } = await makeValidator({ inbox, admission }).validator.pollOnce();

    expect(declined(outcomes)).toEqual(["responded"]);
    expect(chain.sent).toHaveLength(1);
    expect(settleReport).not.toHaveBeenCalled();
    expect(reportErrors()).toHaveLength(1);
  });

  it("inboxKeyOf throws → same", async () => {
    const pair = addAction();
    answerA(pair);
    const inbox = new FakeInbox();
    inbox.readFails = new Error("eth_call: upstream unavailable");

    const { outcomes } = await makeValidator({ inbox }).validator.pollOnce();

    expect(declined(outcomes)).toEqual(["responded"]);
    expect(inbox.posts).toHaveLength(0);
    expect(reportErrors()).toHaveLength(1);
  });

  it("report builder throws → same", async () => {
    vi.mocked(riskReport).mockImplementationOnce(() => {
      throw new Error("evidence without findings");
    });
    const pair = addAction();
    answerA(pair);
    const inbox = new FakeInbox();

    const { outcomes } = await makeValidator({ inbox }).validator.pollOnce();

    expect(declined(outcomes)).toEqual(["responded"]);
    expect(inbox.posts).toHaveLength(0);
    expect(reportErrors()).toEqual([expect.objectContaining({ error: "evidence without findings" })]);
  });

  it("no inbox port → no inbox read at all", async () => {
    const pair = addAction();
    answerA(pair);
    const admission = reportAdmission();
    const settleReport = vi.spyOn(admission, "settleReport");

    const { outcomes } = await makeValidator({ inbox: null, admission }).validator.pollOnce();

    expect(declined(outcomes)).toEqual(["responded"]);
    expect(settleReport).not.toHaveBeenCalled();
    expect(logs.some((l) => String(l.msg).startsWith("operator report"))).toBe(false);
  });

  it("a restart that finds ALREADY_RESPONDED posts nothing", async () => {
    const pair = addAction();
    answerA(pair);
    const inbox = new FakeInbox();
    await makeValidator({ inbox }).validator.pollOnce();
    expect(inbox.posts).toHaveLength(1);

    const restarted = makeValidator({ inbox, llm: scriptedLlm(riskyRun()) });
    const { outcomes } = await restarted.validator.pollOnce();

    expect(declined(outcomes)).toEqual(["ALREADY_RESPONDED"]);
    expect(inbox.posts).toHaveLength(1);
  });
});
