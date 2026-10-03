import {
  Admission,
  buildAction,
  buildEvidence,
  buildRequestJson,
  canonicalJson,
  decodeJsonDataUri,
  DEPLOYMENTS,
  encodeJsonDataUri,
  MAX_REQUEST_URI_BYTES,
  MemoryCursorStore,
  requestHashOfJson,
  type RequestEvent,
  type RequestJsonV1,
  type ValidationStatus,
  type ValidatorChain,
} from "@attest8004/sdk";
import { getAddress, keccak256, stringToBytes, toHex, zeroHash, type Address, type Hash, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreimageCache } from "../src/collect.ts";
import { MANDATE_V1 } from "../src/params.ts";
import type { MandateAddresses, MandateReader } from "../src/reader.ts";
import { runMandateV1 } from "../src/run.ts";
import type { MandateInputs, MandateRecord, PermissionEvent, PinnedBlock, Simulation } from "../src/types.ts";
import { MandateValidator, type MandateValidatorOptions } from "../src/validator.ts";

const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const GATE = getAddress("0x23bfbd12545ccd1501dda1b65a54518fd6212a96");
const OTHER_GATE = getAddress("0x7a5ec388ccbfd3b255cfa94fc2062c0807f2c4cd");
const OWNER = getAddress("0x3efeb3cf2fb54a7d99abe90aab786ce5a831a8cf");
const NEW_OWNER = getAddress("0x00000000000000000000000000000000000000a1");
const UNLISTED = getAddress("0x00000000000000000000000000000000000000b2");
const AGENT = 1_984n;
const CHAIN_ID = 10_143;
const BASE_TS = 1_790_000_000n;
/** One second per block, so every block has its own timestamp. */
const tsOf = (block: bigint): bigint => BASE_TS + block - 1_000n;

const deployment = DEPLOYMENTS[10143];
const ADDRESSES: MandateAddresses = {
  validationRegistry: deployment.validationRegistry,
  identityRegistry: deployment.identityRegistry,
  forwarder: deployment.agentRequestForwarder,
  mandateRegistry: deployment.mandateRegistry,
};

type Response = { requestHash: Hex; response: number; responseURI: string; responseHash: Hex; tag: string };

/** A scripted chain at `latest`: request events, the responses that landed (and where), the cycle head. */
class FakeChain implements ValidatorChain {
  readonly address = VALIDATOR;
  headBlock = { number: 1_004n, timestamp: tsOf(1_004n) };
  readonly events: RequestEvent[] = [];
  readonly landed = new Map<Hex, { block: bigint; status: ValidationStatus }>();
  readonly responses: Response[] = [];
  respondCalls = 0;
  respondBlock = 1_005n;
  gasLimitSent = 84_010n;
  /** Upcoming respond() calls to fail, per requestHash. */
  readonly failures = new Map<Hex, number>();
  /** A failing respond() still lands: the node took it, then the RPC dropped. */
  landThenFail = false;
  onLand: (response: Response) => void = () => {};

  async chainId() {
    return CHAIN_ID;
  }
  async head() {
    return this.headBlock;
  }
  async requestLogs(fromBlock: bigint, toBlock: bigint) {
    return this.events.filter((e) => e.blockNumber >= fromBlock && e.blockNumber <= toBlock);
  }
  async status(requestHash: Hex): Promise<ValidationStatus> {
    return this.landed.get(requestHash)?.status ?? this.pending(requestHash);
  }
  pending(requestHash: Hex): ValidationStatus {
    const event = this.events.find((e) => e.requestHash === requestHash);
    if (!event) throw new Error(`UnknownRequest(${requestHash})`);
    return { validator: event.validator, agentId: event.agentId, response: 0, responseHash: zeroHash, tag: "", lastUpdate: tsOf(event.blockNumber) };
  }
  async respond(response: Response): Promise<{ txHash: Hash; blockNumber: bigint; gasLimit: bigint }> {
    this.respondCalls++;
    const failing = this.failures.get(response.requestHash) ?? 0;
    if (failing > 0) {
      this.failures.set(response.requestHash, failing - 1);
      if (this.landThenFail) this.land(response);
      throw new Error("eth_sendRawTransaction: connection reset");
    }
    this.land(response);
    return { txHash: keccak256(toHex(`tx ${this.responses.length}`)), blockNumber: this.respondBlock, gasLimit: this.gasLimitSent };
  }
  private land(response: Response) {
    this.responses.push(response);
    const agentId = this.events.find((e) => e.requestHash === response.requestHash)?.agentId ?? 0n;
    this.landed.set(response.requestHash, {
      block: this.respondBlock,
      status: {
        validator: this.address,
        agentId,
        response: response.response,
        responseHash: response.responseHash,
        tag: response.tag,
        lastUpdate: tsOf(this.respondBlock),
      },
    });
    this.onLand(response);
  }
}

/** A `MandateReader` over the same fake chain, reading state at the block it is given. */
class FakeReader implements MandateReader {
  readonly chain: FakeChain;
  /** The finalized heads to report, one per call; the last one repeats. */
  heads: bigint[] = [1_004n];
  mandateRecord: MandateRecord | null = mandate();
  owner: Address = OWNER;
  readonly consumedByAction = new Map<Hex, boolean | null>();
  permissionEvents: Array<Omit<PermissionEvent, "afterMandate">> = [
    { block: 500n, logIndex: 0, txHash: keccak256(toHex("MandateSet tx")), emitter: "MandateRegistry", event: "MandateSet" },
  ];
  simulation: Simulation = { ok: true };
  /** Scripted `responseEvidence` answers per requestHash, one per call; the last one repeats. */
  readonly evidence = new Map<Hex, Array<string | null>>();
  readonly evidenceCalls: Hex[] = [];
  readonly calls: Array<{ method: string; at: bigint }> = [];
  simulateCalls = 0;

  constructor(chain: FakeChain) {
    this.chain = chain;
  }

  async chainId() {
    return CHAIN_ID;
  }
  async finalized(): Promise<PinnedBlock> {
    const number = this.heads.length > 1 ? (this.heads.shift() as bigint) : (this.heads[0] as bigint);
    this.calls.push({ method: "finalized", at: number });
    return this.block(number);
  }
  async block(number: bigint): Promise<PinnedBlock> {
    return { number, hash: keccak256(toHex(`block ${number}`)), timestamp: tsOf(number) };
  }
  async mandate(_agentId: bigint, at: bigint) {
    this.calls.push({ method: "mandate", at });
    return this.mandateRecord;
  }
  async ownerOf(_agentId: bigint, at: bigint) {
    this.calls.push({ method: "ownerOf", at });
    return this.owner;
  }
  async agentValidations(agentId: bigint, at: bigint) {
    return this.chain.events.filter((e) => e.agentId === agentId && e.blockNumber <= at).map((e) => e.requestHash);
  }
  async status(requestHash: Hex, at: bigint): Promise<ValidationStatus> {
    this.calls.push({ method: "status", at });
    const landed = this.chain.landed.get(requestHash);
    return landed !== undefined && landed.block <= at ? landed.status : this.chain.pending(requestHash);
  }
  async consumed(_gate: Address, actionHash: Hex) {
    return this.consumedByAction.get(actionHash) ?? false;
  }
  async permissionLogs(fromBlock: bigint, toBlock: bigint) {
    return this.permissionEvents.filter((e) => e.block >= fromBlock && e.block <= toBlock).map((e) => ({ ...e }));
  }
  async simulate() {
    this.simulateCalls++;
    return this.simulation;
  }
  async responseEvidence(requestHash: Hex) {
    this.evidenceCalls.push(requestHash);
    const answers = this.evidence.get(requestHash);
    if (answers === undefined || answers.length === 0) throw new Error(`FakeReader: no evidence scripted for ${requestHash}`);
    return answers.length > 1 ? (answers.shift() as string | null) : (answers[0] as string | null);
  }
  async requestUri(): Promise<string | null> {
    throw new Error("FakeReader: the validator never reads a request URI");
  }
}

function mandate(over: Partial<MandateRecord> = {}): MandateRecord {
  return {
    allowedTargets: [OWNER],
    allowedSelectors: [MANDATE_V1.plainTransferSelector],
    maxValuePerTx: 2_000n,
    maxValuePerDay: 2_500n,
    validUntil: tsOf(1_004n) + 86_400n,
    mandateHash: keccak256(toHex("mandate")),
    owner: OWNER,
    setAtBlock: 500n,
    ...over,
  };
}

let saltCounter = 0;

function requestJson(over: { gate?: Address; target?: Address; value?: bigint; deadline?: bigint } = {}): RequestJsonV1 {
  return buildRequestJson({
    chainId: CHAIN_ID,
    gate: over.gate ?? GATE,
    validator: VALIDATOR,
    action: buildAction({
      agentId: AGENT,
      target: over.target ?? OWNER,
      value: over.value ?? 1_000n,
      deadline: over.deadline ?? tsOf(1_004n) + 600n,
      salt: keccak256(toHex(`salt ${saltCounter++}`)),
    }),
  });
}

/** The request as `runMandateV1` takes it, built independently of the validator's own conversion. */
function mandateRequest(json: RequestJsonV1, block: bigint): MandateInputs["request"] {
  return {
    block,
    requestHash: requestHashOfJson(json),
    chainId: json.chainId,
    gate: json.gate,
    agentId: BigInt(json.agentId),
    target: json.action.target,
    value: BigInt(json.action.value),
    data: json.action.data,
    deadline: BigInt(json.action.deadline),
    salt: json.action.salt,
  };
}

let chain: FakeChain;
let reader: FakeReader;
let admission: Admission;
let logs: Array<Record<string, unknown>>;
const jsons = new Map<Hex, RequestJsonV1>();

beforeEach(() => {
  chain = new FakeChain();
  reader = new FakeReader(chain);
  admission = new Admission({ maxRequestsPerAgent: 20, agentWindowSeconds: 3_600n, dailyGasBudget: 10_000_000n, maxGasPerResponse: 400_000n });
  logs = [];
  jsons.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function addRequest(json: RequestJsonV1, block = 1_000n): RequestEvent {
  const event: RequestEvent = {
    validator: VALIDATOR,
    agentId: BigInt(json.agentId),
    requestURI: encodeJsonDataUri(json).uri,
    requestHash: requestHashOfJson(json),
    blockNumber: block,
    logIndex: chain.events.length,
    txHash: keccak256(toHex(`request tx ${chain.events.length}`)),
  };
  chain.events.push(event);
  jsons.set(event.requestHash, json);
  return event;
}

function validator(over: Partial<MandateValidatorOptions> = {}): MandateValidator {
  return new MandateValidator({
    chain,
    cursor: new MemoryCursorStore(999n),
    reader,
    addresses: ADDRESSES,
    mandateRegistryDeployBlock: 0n,
    gates: [GATE],
    admission,
    retryDelayMs: 0,
    pollIntervalMs: 0,
    pinPollMs: 1,
    log: (entry) => logs.push(entry),
    ...over,
  });
}

/** Parsed evidence JSON, loosely typed for assertions. */
type Doc = Record<string, any>;

/** The response posted for `requestHash`, its evidence text, and that text parsed. */
function posted(requestHash: Hex): { response: Response; text: string; doc: Doc } {
  const response = chain.responses.find((r) => r.requestHash === requestHash);
  if (!response) throw new Error(`no response posted for ${requestHash}`);
  const decoded = decodeJsonDataUri(response.responseURI, 1_000_000);
  if (!decoded.ok) throw new Error(decoded.detail);
  return { response, text: decoded.text, doc: JSON.parse(decoded.text) as Doc };
}

const warnLines = () => logs.filter((entry) => entry.level === "warn");

describe("MandateValidator: verdicts", () => {
  it("posts 100 for a request inside its mandate, with the canonical evidence a re-run at P rebuilds", async () => {
    const e = addRequest(requestJson());

    const { outcomes } = await validator().pollOnce();

    expect(outcomes).toEqual([{ kind: "responded", requestHash: e.requestHash, score: 100, txHash: expect.any(String), blockNumber: 1_005n }]);
    const { response, text, doc } = posted(e.requestHash);
    expect(response).toMatchObject({ response: 100, tag: "mandate-v1" });
    expect(response.responseHash).toBe(keccak256(stringToBytes(text)));

    // What `verify` does: re-run at the evidence's P with an empty cache and rebuild the document.
    const pinned = await reader.block(1_004n);
    const recomputed = await runMandateV1({
      reader,
      addresses: ADDRESSES,
      validator: VALIDATOR,
      request: mandateRequest(jsons.get(e.requestHash) as RequestJsonV1, e.blockNumber),
      pinned,
      cache: new Map(),
    });
    expect(recomputed).toMatchObject({ score: 100, reasons: [] });
    expect(text).toBe(canonicalJson(buildEvidence({ tag: "mandate-v1", requestHash: e.requestHash, result: recomputed })));
    expect(doc.block).toEqual({ number: "1004", hash: pinned.hash, timestamp: pinned.timestamp.toString() });
    expect(doc).toMatchObject({ schema: "attest8004.evidence.v1", validator: "mandate-v1", requestHash: e.requestHash, score: 100, reasons: [] });
  });

  it("posts 0 with its reasons for a request that breaks the mandate", async () => {
    const e = addRequest(requestJson({ target: UNLISTED, value: 2_200n })); // over the tx cap, within the daily cap

    const { outcomes } = await validator().pollOnce();

    expect(outcomes).toEqual([{ kind: "responded", requestHash: e.requestHash, score: 0, txHash: expect.any(String), blockNumber: 1_005n }]);
    const { response, doc } = posted(e.requestHash);
    expect(response.response).toBe(0);
    expect(doc.reasons).toEqual(["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"]);
    expect(doc.request).toMatchObject({ target: UNLISTED, value: "2200" });
  });

  it("re-checks the deadline at P: ACTION_EXPIRED when P's time is past a deadline the cycle head still allowed", async () => {
    const deadline = tsOf(1_004n) + 2n; // >= the cycle head's time, so the base lets it through
    const e = addRequest(requestJson({ deadline }));
    reader.heads = [1_010n]; // P's time is past the deadline

    await validator().pollOnce();

    const { response, doc } = posted(e.requestHash);
    expect(response.response).toBe(0);
    expect(doc.reasons).toEqual(["ACTION_EXPIRED"]);
    expect(doc.block.number).toBe("1010");
  });

  it("always tags mandate-v1 and keeps the deadline horizon at 3,600 s, whatever the options say", async () => {
    const far = addRequest(requestJson({ deadline: tsOf(1_004n) + 3_601n }));
    const near = addRequest(requestJson());

    const { outcomes } = await validator({ tag: "something-else", maxDeadlineAheadSeconds: 86_400n }).pollOnce();

    expect(outcomes).toEqual([
      { kind: "skipped", requestHash: far.requestHash, reason: "DEADLINE_TOO_FAR", detail: expect.stringContaining("3600") },
      expect.objectContaining({ kind: "responded", requestHash: near.requestHash }),
    ]);
    expect(posted(near.requestHash).response.tag).toBe("mandate-v1");
    expect(posted(near.requestHash).doc.validator).toBe("mandate-v1");
  });

  it("keeps the request size limit at the SDK's 16,384 bytes, whatever the options say (verify decodes no larger request)", async () => {
    const big = addRequest(
      buildRequestJson({
        chainId: CHAIN_ID,
        gate: GATE,
        validator: VALIDATOR,
        action: buildAction({
          agentId: AGENT,
          target: OWNER,
          data: `0x${"ab".repeat(9_000)}`,
          deadline: tsOf(1_004n) + 600n,
          salt: keccak256(toHex("a large request")),
        }),
      }),
    );
    expect(big.requestURI.length).toBeGreaterThan(MAX_REQUEST_URI_BYTES);
    expect(big.requestURI.length).toBeLessThan(65_536);

    const { outcomes } = await validator({ maxRequestBytes: 65_536 }).pollOnce();

    expect(outcomes).toEqual([expect.objectContaining({ kind: "skipped", requestHash: big.requestHash, reason: "URI_TOO_LARGE" })]);
    expect(chain.respondCalls).toBe(0);
  });

  it("caches the checked request's parts under its lower-case hash, whatever the score", async () => {
    const cache: PreimageCache = new Map();
    const json = requestJson({ target: UNLISTED });
    const e = addRequest(json);

    await validator({ cache }).pollOnce();

    expect(posted(e.requestHash).response.response).toBe(0);
    expect(cache.get(e.requestHash.toLowerCase() as Hex)).toEqual({
      chainId: CHAIN_ID,
      gate: GATE,
      agentId: AGENT,
      target: UNLISTED,
      value: 1_000n,
      dataHash: keccak256("0x"),
      deadline: BigInt(json.action.deadline),
      salt: json.action.salt,
    });
  });

  it("logs bigints as decimal strings by default, so a landed response is reported once and settled", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const settle = vi.spyOn(admission, "settle");
    const e = addRequest(requestJson());

    const { outcomes } = await validator({ log: undefined }).pollOnce();

    expect(outcomes).toEqual([expect.objectContaining({ kind: "responded", requestHash: e.requestHash })]);
    expect(chain.respondCalls).toBe(1);
    expect(settle).toHaveBeenCalledTimes(1);
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toContainEqual(expect.objectContaining({ msg: "responded", blockNumber: "1005", gasLimit: "84010" }));
  });

  it("logs once each time it catches up with the finalized head", async () => {
    const v = validator();
    await v.pollOnce();
    await v.pollOnce();
    expect(logs.filter((entry) => entry.msg === "caught up")).toEqual([
      expect.objectContaining({ level: "info", validator: "mandate-v1", block: 1_004n }),
    ]);

    chain.headBlock = { number: 1_250n, timestamp: tsOf(1_250n) };
    await v.pollOnce(); // 1,005-1,104
    await v.pollOnce(); // 1,105-1,204
    await v.pollOnce(); // 1,205-1,250
    expect(logs.filter((entry) => entry.msg === "caught up").map((entry) => entry.block)).toEqual([1_004n, 1_250n]);
  });

  it("needs at least one gate", () => {
    expect(() => validator({ gates: [] })).toThrow(/gate/);
  });
});

describe("MandateValidator: accepts()", () => {
  const declines: Array<{ reason: string; setup: () => RequestJsonV1 }> = [
    { reason: "GATE_NOT_SERVED", setup: () => requestJson({ gate: OTHER_GATE }) },
    {
      reason: "NO_MANDATE",
      setup: () => {
        reader.mandateRecord = null;
        return requestJson();
      },
    },
    {
      reason: "MANDATE_EXPIRED",
      setup: () => {
        reader.mandateRecord = mandate({ validUntil: tsOf(1_004n) - 1n });
        return requestJson();
      },
    },
    {
      reason: "MANDATE_STALE",
      setup: () => {
        reader.owner = NEW_OWNER;
        return requestJson();
      },
    },
  ];

  it.each(declines)("$reason: declined with one warn line naming the agent, and nothing sent", async ({ reason, setup }) => {
    const admit = vi.spyOn(admission, "admit");
    const e = addRequest(setup());

    const { outcomes } = await validator().pollOnce();

    expect(outcomes).toEqual([{ kind: "skipped", requestHash: e.requestHash, reason: "DECLINED", detail: expect.stringMatching(new RegExp(`^${reason}: `)) }]);
    expect(warnLines()).toEqual([
      expect.objectContaining({ level: "warn", requestHash: e.requestHash, reason: "DECLINED", detail: expect.stringContaining("agent 1984") }),
    ]);
    expect(warnLines()[0]?.detail).toMatch(new RegExp(`^${reason}: `));
    expect(chain.respondCalls).toBe(0);
    expect(reader.simulateCalls).toBe(0);
    expect(admit).not.toHaveBeenCalled();
  });

  it("serves its gates case-insensitively", async () => {
    const e = addRequest(requestJson());
    const { outcomes } = await validator({ gates: [GATE.toLowerCase() as Address] }).pollOnce();
    expect(outcomes).toEqual([expect.objectContaining({ kind: "responded", requestHash: e.requestHash })]);
  });

  it("checks the gate before reading any mandate", async () => {
    reader.mandateRecord = null;
    addRequest(requestJson({ gate: OTHER_GATE }));
    const { outcomes } = await validator().pollOnce();
    expect(outcomes).toEqual([expect.objectContaining({ reason: "DECLINED", detail: expect.stringMatching(/^GATE_NOT_SERVED: /) })]);
    expect(reader.calls.filter((c) => c.method === "mandate" || c.method === "ownerOf")).toEqual([]);
  });

  it("reports an expired mandate before a stale owner", async () => {
    reader.mandateRecord = mandate({ validUntil: tsOf(1_004n) - 1n });
    reader.owner = NEW_OWNER;
    addRequest(requestJson());
    const { outcomes } = await validator().pollOnce();
    expect(outcomes).toEqual([expect.objectContaining({ reason: "DECLINED", detail: expect.stringMatching(/^MANDATE_EXPIRED: /) })]);
  });

  it("reads the mandate at the reader's finalized head, and admits with the cycle head's time", async () => {
    reader.heads = [1_003n];
    const admit = vi.spyOn(admission, "admit");
    const settle = vi.spyOn(admission, "settle");
    const e = addRequest(requestJson());

    await validator().pollOnce();

    expect(reader.calls.find((c) => c.method === "mandate")).toEqual({ method: "mandate", at: 1_003n });
    expect(admit).toHaveBeenCalledWith({ requestHash: e.requestHash, agentId: AGENT, now: tsOf(1_004n) });
    // settle's clock is the latest P (here 1,003), the gas limit the one actually sent.
    expect(settle).toHaveBeenCalledWith({ requestHash: e.requestHash, gasLimit: 84_010n, now: tsOf(1_003n) });
  });

  it("retries, never declines, while the finalized head is behind the request's block", async () => {
    // A lagging RPC node: at block 1,002 the mandate set just before the request isn't there yet.
    const e = addRequest(requestJson(), 1_003n);
    reader.heads = [1_002n, 1_003n];
    const record = mandate();
    reader.mandate = async (_agentId: bigint, at: bigint) => {
      reader.calls.push({ method: "mandate", at });
      return at >= 1_003n ? record : null;
    };
    const v = validator();

    const cycle1 = await v.pollOnce();
    expect(cycle1.outcomes).toEqual([]);
    expect(cycle1.caughtUp).toBe(false);
    expect(cycle1.retryAfterMs).toBeDefined();
    expect(warnLines()).toEqual([]);
    expect(reader.calls.filter((c) => c.method === "mandate")).toEqual([]);
    expect(logs).toContainEqual(
      expect.objectContaining({ level: "error", requestHash: e.requestHash, error: expect.stringMatching(/behind the request's block 1003/) }),
    );

    const cycle2 = await v.pollOnce();
    expect(cycle2.outcomes).toEqual([expect.objectContaining({ kind: "responded", requestHash: e.requestHash, score: 100 })]);
    expect(posted(e.requestHash).doc.block.number).toBe("1003");
  });

  it("RATE_LIMITED: one warn line with the agent, the reason and the counters; nothing sent", async () => {
    admission = new Admission({ maxRequestsPerAgent: 1, agentWindowSeconds: 3_600n, dailyGasBudget: 10_000_000n, maxGasPerResponse: 400_000n });
    const first = addRequest(requestJson());
    const second = addRequest(requestJson());

    const { outcomes } = await validator().pollOnce();

    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "responded", requestHash: first.requestHash }),
      { kind: "skipped", requestHash: second.requestHash, reason: "DECLINED", detail: "agent 1984 RATE_LIMITED (1/1 requests in the last 3600 s)" },
    ]);
    expect(warnLines()).toEqual([
      expect.objectContaining({ requestHash: second.requestHash, detail: "agent 1984 RATE_LIMITED (1/1 requests in the last 3600 s)" }),
    ]);
    expect(chain.respondCalls).toBe(1);
  });

  it("GAS_BUDGET_EXHAUSTED: one warn line with the counters, after the first response settled to its real gas limit", async () => {
    admission = new Admission({ maxRequestsPerAgent: 20, agentWindowSeconds: 3_600n, dailyGasBudget: 400_000n, maxGasPerResponse: 400_000n });
    const first = addRequest(requestJson());
    const second = addRequest(requestJson());

    const { outcomes } = await validator().pollOnce();

    const detail = "agent 1984 GAS_BUDGET_EXHAUSTED (84,010 + 400,000 > 400,000 gas in the last 24 h)";
    expect(outcomes).toEqual([
      expect.objectContaining({ kind: "responded", requestHash: first.requestHash }),
      { kind: "skipped", requestHash: second.requestHash, reason: "DECLINED", detail },
    ]);
    expect(warnLines()).toEqual([expect.objectContaining({ requestHash: second.requestHash, detail })]);
    expect(chain.respondCalls).toBe(1);
  });
});

describe("MandateValidator: the pinned block", () => {
  it("waits for its own approval to be finalized, then counts it toward the next request's spend (from the cache)", async () => {
    const first = addRequest(requestJson({ value: 1_000n }));
    const second = addRequest(requestJson({ value: 2_000n }));
    chain.onLand = (r) => {
      // The approval lands in 1,005 while the finalized head is still 1,004 for three more reads.
      if (r.requestHash === first.requestHash) reader.heads = [1_004n, 1_004n, 1_004n, 1_005n];
    };

    const { outcomes } = await validator().pollOnce();

    expect(outcomes.map((o) => (o.kind === "responded" ? o.score : o.kind))).toEqual([100, 0]);
    const { doc } = posted(second.requestHash);
    expect(doc.block.number).toBe("1005");
    expect(doc.reasons).toEqual(["DAILY_CAP_EXCEEDED"]);
    expect(doc.spend).toEqual({
      since: (tsOf(1_005n) - MANDATE_V1.spendWindowSeconds).toString(),
      total: "1000",
      entries: [
        {
          requestHash: first.requestHash,
          approvedAt: tsOf(1_005n).toString(),
          gate: GATE,
          value: "1000",
          deadline: jsons.get(first.requestHash)?.action.deadline,
          consumed: false,
          counted: true,
        },
      ],
    });
    expect(reader.heads).toEqual([1_005n]); // every lagging head was read and refused
    expect(reader.evidenceCalls).toEqual([]); // the first request's parts came from the cache
  });

  it("never pins below the block its last response landed in (a rejection, so only the block counts)", async () => {
    const first = addRequest(requestJson({ target: UNLISTED }));
    const second = addRequest(requestJson());
    chain.onLand = (r) => {
      if (r.requestHash === first.requestHash) reader.heads = [1_004n, 1_004n, 1_005n];
    };

    await validator().pollOnce();

    expect(posted(first.requestHash).response.response).toBe(0);
    expect(posted(second.requestHash).doc.block.number).toBe("1005");
    expect(reader.heads).toEqual([1_005n]);
  });

  it("waits for an approval whose send landed but threw (no onResponded) to be answered at P", async () => {
    const first = addRequest(requestJson({ value: 1_000n }));
    const second = addRequest(requestJson({ value: 2_000n }));
    chain.landThenFail = true;
    chain.failures.set(first.requestHash, 1);
    chain.onLand = (r) => {
      if (r.requestHash === first.requestHash) reader.heads = [1_004n, 1_004n, 1_005n];
    };

    const { outcomes } = await validator().pollOnce();

    expect(outcomes).toEqual([
      { kind: "skipped", requestHash: first.requestHash, reason: "ALREADY_RESPONDED" },
      expect.objectContaining({ kind: "responded", requestHash: second.requestHash, score: 0 }),
    ]);
    const { doc } = posted(second.requestHash);
    expect(doc.block.number).toBe("1005");
    expect(doc.reasons).toEqual(["DAILY_CAP_EXCEEDED"]);
    expect(doc.spend.entries.map((entry: Doc) => entry.requestHash)).toEqual([first.requestHash]);
    expect(reader.calls).toContainEqual({ method: "status", at: 1_004n }); // refused: not yet answered there
  });

  it("never pins below the MandateRegistry's deployment block, where the mandate can't be read", async () => {
    const e = addRequest(requestJson());
    reader.heads = [1_004n, 1_005n, 1_006n]; // accepts() reads 1,004; the pin waits through 1,005

    await validator({ mandateRegistryDeployBlock: 1_006n }).pollOnce();

    expect(posted(e.requestHash).doc.block.number).toBe("1006");
    expect(reader.heads).toEqual([1_006n]);
  });

  it("never pins below the request's own block", async () => {
    const e = addRequest(requestJson(), 1_003n);
    // A load-balanced RPC: accepts() reads 1,003, then the pin's first read hits a node at 1,002.
    reader.heads = [1_003n, 1_002n, 1_003n];

    await validator().pollOnce();

    expect(posted(e.requestHash).doc.block.number).toBe("1003");
  });

  it("gives up after pinTimeoutMs without posting, and the base retries the request later", async () => {
    const first = addRequest(requestJson());
    const second = addRequest(requestJson());
    // The finalized head never reaches 1,005, where the first approval landed.
    const v = validator({ pinTimeoutMs: 40 });

    const started = Date.now();
    const result = await v.pollOnce();

    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(result.outcomes).toEqual([expect.objectContaining({ kind: "responded", requestHash: first.requestHash })]);
    expect(result.caughtUp).toBe(false);
    expect(result.retryAfterMs).toBeDefined();
    expect(chain.responses.map((r) => r.requestHash)).toEqual([first.requestHash]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: "error",
        msg: "request failed; retrying next cycle",
        requestHash: second.requestHash,
        error: expect.stringMatching(/finalized head/),
      }),
    );
  });

  it("never throws from onResponded: a failing settle still leaves the response block recorded", async () => {
    vi.spyOn(admission, "settle").mockImplementation(() => {
      throw new Error("settle failed");
    });
    const first = addRequest(requestJson({ target: UNLISTED }));
    const second = addRequest(requestJson());
    chain.onLand = (r) => {
      if (r.requestHash === first.requestHash) reader.heads = [1_004n, 1_004n, 1_005n];
    };

    await validator().pollOnce();

    expect(logs.filter((entry) => typeof entry.msg === "string" && entry.msg.startsWith("onResponded threw"))).toEqual([]);
    expect(posted(second.requestHash).doc.block.number).toBe("1005");
  });
});

describe("MandateValidator: a missing spend log is a retry, never a verdict", () => {
  it("posts nothing while an approval's log can't be found, then the verdict once it can", async () => {
    // A first process approves request A (block 1,005).
    const a = addRequest(requestJson({ value: 1_000n }));
    await validator().pollOnce();
    const aUri = posted(a.requestHash).response.responseURI;

    // A restarted process (empty cache) gets request B; A's log isn't found on the first try.
    const b = addRequest(requestJson({ value: 1_000n }), 1_006n);
    chain.headBlock = { number: 1_006n, timestamp: tsOf(1_006n) };
    reader.heads = [1_006n];
    reader.evidence.set(a.requestHash, [null, aUri]);
    const restarted = validator({ cursor: new MemoryCursorStore(1_005n) });

    const cycle1 = await restarted.pollOnce();
    expect(cycle1.outcomes).toEqual([]);
    expect(cycle1.caughtUp).toBe(false);
    expect(cycle1.retryAfterMs).toBeDefined();
    expect(chain.responses).toHaveLength(1);
    expect(logs).toContainEqual(
      expect.objectContaining({ level: "error", requestHash: b.requestHash, error: expect.stringContaining("no ValidationResponse log") }),
    );

    const cycle2 = await restarted.pollOnce();
    expect(cycle2.outcomes).toEqual([expect.objectContaining({ kind: "responded", requestHash: b.requestHash, score: 100 })]);
    const { doc } = posted(b.requestHash);
    expect(doc.spend).toMatchObject({ total: "1000", entries: [{ requestHash: a.requestHash, value: "1000", counted: true }] });
    expect(reader.evidenceCalls).toEqual([a.requestHash, a.requestHash]);
  });
});
