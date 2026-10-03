import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, keccak256, stringToBytes, toHex, zeroHash, type Address, type Hash, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryCursorStore,
  ValidatorBase,
  buildAction,
  buildRequestJson,
  decodeJsonDataUri,
  encodeJsonDataUri,
  requestHashOfJson,
  type CheckResult,
  type CursorStore,
  type Outcome,
  type RequestEvent,
  type RequestJsonV1,
  type ValidationStatus,
  type ValidatorChain,
  type ValidatorOptions,
  type VerifiedRequest,
} from "../src/index.ts";
import { FileCursorStore } from "../src/node.ts";

const VALIDATOR_A = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const VALIDATOR_B = getAddress("0x00000000000000000000000000000000000000b0");
const GATE = getAddress("0x7a5ec388ccbfd3b255cfa94fc2062c0807f2c4cd");
const HEAD_TS = 1_790_000_000n;

type Response = { requestHash: Hex; response: number; responseURI: string; responseHash: Hex; tag: string };

/** A scripted chain: request events, the registry's status per hash, and the responses posted. */
class FakeChain implements ValidatorChain {
  readonly address = VALIDATOR_A;
  chain = 10143;
  headBlock = { number: 1_000n, timestamp: HEAD_TS };
  readonly events: RequestEvent[] = [];
  readonly statuses = new Map<Hex, ValidationStatus>();
  readonly responses: Response[] = [];
  readonly logRanges: Array<[bigint, bigint]> = [];
  respondCalls = 0;
  /** Number of upcoming respond() calls to fail, per requestHash. */
  readonly failures = new Map<Hex, number>();
  /** When set, a failing respond() still lands (the node accepted it, then the RPC dropped). */
  landThenFail = false;
  failLogs = false;

  async chainId() {
    return this.chain;
  }
  async head() {
    return this.headBlock;
  }
  async requestLogs(fromBlock: bigint, toBlock: bigint) {
    if (this.failLogs) throw new Error("eth_getLogs: upstream unavailable");
    this.logRanges.push([fromBlock, toBlock]);
    return this.events.filter((e) => e.blockNumber >= fromBlock && e.blockNumber <= toBlock);
  }
  async status(requestHash: Hex): Promise<ValidationStatus> {
    const stored = this.statuses.get(requestHash);
    if (stored) return stored;
    const event = this.events.find((e) => e.requestHash === requestHash);
    if (!event) throw new Error(`UnknownRequest(${requestHash})`);
    return { validator: event.validator, agentId: event.agentId, response: 0, responseHash: zeroHash, tag: "", lastUpdate: 1n };
  }
  async respond(response: Response): Promise<Hash> {
    this.respondCalls++;
    const failing = this.failures.get(response.requestHash) ?? 0;
    if (failing > 0) {
      this.failures.set(response.requestHash, failing - 1);
      if (this.landThenFail) this.land(response);
      throw new Error("eth_sendRawTransaction: connection reset");
    }
    this.land(response);
    return keccak256(toHex(`tx${this.responses.length}`));
  }
  private land(response: Response) {
    this.responses.push(response);
    const event = this.events.find((e) => e.requestHash === response.requestHash);
    this.statuses.set(response.requestHash, {
      validator: this.address,
      agentId: event?.agentId ?? 0n,
      response: response.response,
      responseHash: response.responseHash,
      tag: response.tag,
      lastUpdate: 2n,
    });
  }
}

class TestValidator extends ValidatorBase {
  readonly checked: VerifiedRequest[] = [];
  result: () => CheckResult = () => ({ score: 100, reasons: ["OK"] });
  protected override async check(request: VerifiedRequest): Promise<CheckResult> {
    this.checked.push(request);
    return this.result();
  }
}

function request(over: Partial<{ deadline: bigint; validator: Address; chainId: number; salt: Hex }> = {}): RequestJsonV1 {
  return buildRequestJson({
    chainId: over.chainId ?? 10143,
    gate: GATE,
    validator: over.validator ?? VALIDATOR_A,
    action: buildAction({
      agentId: 7n,
      target: getAddress("0x3efeb3cf2fb54a7d99abe90aab786ce5a831a8cf"),
      value: 1_000n,
      deadline: over.deadline ?? HEAD_TS + 600n,
      salt: over.salt ?? `0x${"11".repeat(32)}`,
    }),
  });
}

function event({ json: given, ...over }: Partial<RequestEvent> & { json?: RequestJsonV1 } = {}): RequestEvent {
  const json = given ?? request();
  return {
    validator: VALIDATOR_A,
    agentId: BigInt(json.agentId),
    requestURI: encodeJsonDataUri(json).uri,
    requestHash: requestHashOfJson(json),
    blockNumber: 1_000n,
    logIndex: 0,
    txHash: keccak256(toHex("request")),
    ...over,
  };
}

let chain: FakeChain;
let logs: Array<Record<string, unknown>>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  chain = new FakeChain();
  logs = [];
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function validator(over: Partial<ValidatorOptions> = {}): TestValidator {
  return new TestValidator({
    chain,
    tag: "test-v1",
    cursor: new MemoryCursorStore(999n),
    retryDelayMs: 0,
    pollIntervalMs: 0,
    log: (entry) => logs.push(entry),
    ...over,
  });
}

const skipped = (outcomes: Outcome[]) =>
  outcomes.map((o) => (o.kind === "skipped" ? o.reason : o.kind));

describe("ValidatorBase", () => {
  it("throws on an empty tag", () => {
    expect(() => validator({ tag: "" })).toThrow(/tag/);
  });

  it("verifies the request, runs check() and responds once with the evidence hash", async () => {
    const e = event();
    chain.events.push(e);
    const v = validator();

    const { outcomes, caughtUp } = await v.pollOnce();

    expect(outcomes).toEqual([{ kind: "responded", requestHash: e.requestHash, score: 100, txHash: expect.any(String) }]);
    expect(caughtUp).toBe(true);
    expect(v.checked).toHaveLength(1);
    expect(v.checked[0]).toMatchObject({ gate: GATE, chainId: 10143, headTimestamp: HEAD_TS, event: e });
    expect(v.checked[0]?.action.agentId).toBe(7n);

    expect(chain.responses).toHaveLength(1);
    const [posted] = chain.responses;
    expect(posted).toMatchObject({ requestHash: e.requestHash, response: 100, tag: "test-v1" });
    const decoded = decodeJsonDataUri(posted?.responseURI ?? "");
    if (!decoded.ok) throw new Error(decoded.detail);
    expect(posted?.responseHash).toBe(keccak256(stringToBytes(decoded.text)));
    expect(JSON.parse(decoded.text)).toEqual({
      schema: "attest8004.evidence.v1",
      validator: "test-v1",
      requestHash: e.requestHash,
      score: 100,
      reasons: ["OK"],
    });
  });

  describe("never responds (and logs the reason) when", () => {
    const tooLarge = `data:application/json,${" ".repeat(16_385)}`;
    const cases: Array<[string, () => RequestEvent]> = [
      ["URI_NOT_DATA", () => event({ requestURI: "https://evil.example/request.json" })],
      ["URI_NOT_DATA", () => event({ requestURI: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" })],
      ["URI_TOO_LARGE", () => event({ requestURI: tooLarge })],
      ["URI_MALFORMED", () => event({ requestURI: "data:application/json;base64,!!!!" })],
      ["JSON_INVALID", () => event({ requestURI: "data:application/json,not%20json" })],
      [
        "SCHEMA_INVALID",
        () => {
          const json = request();
          const old = { ...json, action: { ...json.action, deadline: Number(json.action.deadline) } };
          return event({ requestURI: encodeJsonDataUri(old).uri });
        },
      ],
      ["HASH_MISMATCH", () => event({ requestHash: requestHashOfJson(request({ salt: `0x${"22".repeat(32)}` })) })],
      ["WRONG_VALIDATOR", () => event({ json: request({ validator: VALIDATOR_B }) })],
      ["WRONG_VALIDATOR", () => event({ validator: VALIDATOR_B })],
      ["AGENT_MISMATCH", () => event({ agentId: 8n })],
      ["WRONG_CHAIN", () => event({ json: request({ chainId: 143 }) })],
      ["DEADLINE_PASSED", () => event({ json: request({ deadline: HEAD_TS - 1n }) })],
      ["DEADLINE_TOO_FAR", () => event({ json: request({ deadline: HEAD_TS + 3_601n }) })],
    ];
    for (const [reason, make] of cases) {
      it(`${reason}: ${make().requestURI.slice(0, 40)}…`, async () => {
        const e = make();
        chain.events.push(e);
        const v = validator();

        const { outcomes } = await v.pollOnce();

        expect(skipped(outcomes)).toEqual([reason]);
        expect(v.checked).toHaveLength(0);
        expect(chain.respondCalls).toBe(0);
        expect(logs.some((l) => l.reason === reason && l.requestHash === e.requestHash)).toBe(true);
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }
  });

  it("accepts a deadline exactly at the head's time and exactly the maximum ahead", async () => {
    chain.events.push(event({ json: request({ deadline: HEAD_TS }) }));
    chain.events.push(event({ json: request({ deadline: HEAD_TS + 3_600n, salt: `0x${"33".repeat(32)}` }) }));
    expect(skipped((await validator().pollOnce()).outcomes)).toEqual(["responded", "responded"]);
  });

  it("takes the maximum deadline window from its options", async () => {
    chain.events.push(event({ json: request({ deadline: HEAD_TS + 61n }) }));
    chain.events.push(event({ json: request({ deadline: HEAD_TS + 60n, salt: `0x${"33".repeat(32)}` }) }));
    const { outcomes } = await validator({ maxDeadlineAheadSeconds: 60n }).pollOnce();
    expect(skipped(outcomes)).toEqual(["DEADLINE_TOO_FAR", "responded"]);
  });

  it("logs a short preview, never a whole attacker-sized URI", async () => {
    chain.events.push(event({ requestURI: `data:text/plain,${"x".repeat(10_000)}` }));
    await validator().pollOnce();
    expect(JSON.stringify(logs).length).toBeLessThan(2_000);
  });

  describe("restart safety", () => {
    it("a restarted validator re-reads the same blocks and never posts twice", async () => {
      const e = event();
      chain.events.push(e);
      await validator().pollOnce();

      const restarted = validator();
      const { outcomes } = await restarted.pollOnce();

      expect(skipped(outcomes)).toEqual(["ALREADY_RESPONDED"]);
      expect(restarted.checked).toHaveLength(0);
      expect(chain.responses).toHaveLength(1);
    });

    it("the response landed but saving the cursor failed: still no second response", async () => {
      chain.events.push(event());
      const cursor = new MemoryCursorStore(999n);
      const failingOnce: CursorStore = {
        load: () => cursor.load(),
        save: vi.fn().mockRejectedValueOnce(new Error("disk full")).mockImplementation((b: bigint) => cursor.save(b)),
      };
      const v = validator({ cursor: failingOnce });
      await expect(v.pollOnce()).rejects.toThrow(/disk full/);

      const { outcomes } = await validator({ cursor: failingOnce }).pollOnce();
      expect(skipped(outcomes)).toEqual(["ALREADY_RESPONDED"]);
      expect(chain.responses).toHaveLength(1);
    });
  });

  describe("polling", () => {
    it("reads at most 100 blocks per eth_getLogs, from the saved cursor, and saves after each window", async () => {
      chain.headBlock = { number: 1_250n, timestamp: HEAD_TS };
      chain.events.push(event({ blockNumber: 1_050n }));
      chain.events.push(event({ blockNumber: 1_220n, json: request({ salt: `0x${"44".repeat(32)}` }) }));
      const cursor = new MemoryCursorStore(999n);
      const v = validator({ cursor });

      const first = await v.pollOnce();
      expect(chain.logRanges).toEqual([[1_000n, 1_099n]]);
      expect(await cursor.load()).toBe(1_099n);
      expect(first.caughtUp).toBe(false);
      expect(skipped(first.outcomes)).toEqual(["responded"]);

      expect((await v.pollOnce()).caughtUp).toBe(false);
      const third = await v.pollOnce();
      expect(chain.logRanges).toEqual([
        [1_000n, 1_099n],
        [1_100n, 1_199n],
        [1_200n, 1_250n],
      ]);
      expect(third.caughtUp).toBe(true);
      expect(skipped(third.outcomes)).toEqual(["responded"]);
      expect(await cursor.load()).toBe(1_250n);

      expect((await v.pollOnce()).outcomes).toEqual([]);
      expect(chain.logRanges).toHaveLength(3);
    });

    it("starts at the head when there is no cursor and no startBlock", async () => {
      chain.events.push(event({ blockNumber: 999n }));
      chain.events.push(event({ blockNumber: 1_000n, json: request({ salt: `0x${"55".repeat(32)}` }) }));
      const v = validator({ cursor: new MemoryCursorStore() });
      const { outcomes } = await v.pollOnce();
      expect(chain.logRanges).toEqual([[1_000n, 1_000n]]);
      expect(outcomes).toHaveLength(1);
    });

    it("starts at startBlock when there is no cursor", async () => {
      await validator({ cursor: new MemoryCursorStore(), startBlock: 990n }).pollOnce();
      expect(chain.logRanges[0]).toEqual([990n, 1_000n]);
    });

    it("an eth_getLogs failure throws and leaves the cursor where it was", async () => {
      chain.failLogs = true;
      const cursor = new MemoryCursorStore(999n);
      await expect(validator({ cursor }).pollOnce()).rejects.toThrow(/eth_getLogs/);
      expect(await cursor.load()).toBe(999n);
    });

    it("a failed response saves the cursor before its block; the next cycle retries it, not the earlier one", async () => {
      const e1 = event({ blockNumber: 1_010n });
      const e2 = event({ blockNumber: 1_012n, json: request({ salt: `0x${"66".repeat(32)}` }) });
      chain.headBlock = { number: 1_020n, timestamp: HEAD_TS };
      chain.events.push(e1, e2);
      chain.failures.set(e2.requestHash, 3);
      const cursor = new MemoryCursorStore(999n);
      const v = validator({ cursor, sendAttempts: 3 });

      const first = await v.pollOnce();
      expect(skipped(first.outcomes)).toEqual(["responded"]);
      expect(await cursor.load()).toBe(1_011n);

      const second = await v.pollOnce();
      expect(second.outcomes).toEqual([expect.objectContaining({ kind: "responded", requestHash: e2.requestHash })]);
      expect(chain.responses.map((r) => r.requestHash)).toEqual([e1.requestHash, e2.requestHash]);
      expect(await cursor.load()).toBe(1_020n);
    });

    it("gives up on a request after maxFailedCycles and moves on", async () => {
      chain.events.push(event());
      const cursor = new MemoryCursorStore(999n);
      const v = validator({ cursor, maxFailedCycles: 3 });
      v.result = () => {
        throw new Error("model timeout");
      };

      expect((await v.pollOnce()).outcomes).toEqual([]);
      expect((await v.pollOnce()).outcomes).toEqual([]);
      const third = await v.pollOnce();
      expect(third.outcomes).toEqual([expect.objectContaining({ kind: "gave-up", error: expect.stringMatching(/model timeout/) })]);
      expect(await cursor.load()).toBe(1_000n);
      expect(chain.respondCalls).toBe(0);
    });

    it("never posts a score outside 0..100, a fractional score, or evidence overriding a reserved key", async () => {
      for (const result of [
        { score: 101, reasons: [] },
        { score: -1, reasons: [] },
        { score: 99.5, reasons: [] },
        { score: 100, reasons: [], evidence: { score: 0 } },
      ]) {
        chain = new FakeChain();
        chain.events.push(event());
        const v = validator({ maxFailedCycles: 1 });
        v.result = () => result;
        const { outcomes } = await v.pollOnce();
        expect(outcomes[0]?.kind).toBe("gave-up");
        expect(chain.respondCalls).toBe(0);
      }
    });

    it("retries a failed send", async () => {
      const e = event();
      chain.events.push(e);
      chain.failures.set(e.requestHash, 1);
      const { outcomes } = await validator({ sendAttempts: 3 }).pollOnce();
      expect(skipped(outcomes)).toEqual(["responded"]);
      expect(chain.respondCalls).toBe(2);
      expect(chain.responses).toHaveLength(1);
    });

    it("checks the status before retrying, so a send that landed despite an error isn't sent again", async () => {
      const e = event();
      chain.events.push(e);
      chain.failures.set(e.requestHash, 1);
      chain.landThenFail = true;
      const { outcomes } = await validator({ sendAttempts: 3 }).pollOnce();
      expect(skipped(outcomes)).toEqual(["ALREADY_RESPONDED"]);
      expect(chain.respondCalls).toBe(1);
      expect(chain.responses).toHaveLength(1);
    });

    it("run() polls until aborted", async () => {
      const controller = new AbortController();
      chain.events.push(event());
      const v = validator({ pollIntervalMs: 1 });
      const running = v.run(controller.signal);
      await vi.waitFor(() => expect(chain.responses).toHaveLength(1));
      controller.abort();
      await running;
      expect(chain.responses).toHaveLength(1);
    });
  });
});

describe("FileCursorStore", () => {
  it("round-trips the cursor through a JSON file, and refuses a corrupt one", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "attest8004-cursor-")), "cursor.json");
    const store = new FileCursorStore(path);
    expect(await store.load()).toBeUndefined();
    await store.save(67_779_694n);
    expect(await store.load()).toBe(67_779_694n);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ block: "67779694" });

    await writeFile(path, '{"block":12}');
    await expect(store.load()).rejects.toThrow(/cursor/);
  });
});
