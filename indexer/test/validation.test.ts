import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";
import { B, REGISTRY, VALIDATOR_A, VALIDATOR_B, at, request, requestEvent, responseEvent, timeOf, txHash } from "./helpers.ts";

// ValidationRegistry handlers (plan Task 2): one ValidationRequest row per requestHash carrying its latest response,
// every response event kept, and the validator, agent and agent-tag summaries the dashboard and getAgentTrust read.

const run = (indexer: ReturnType<typeof createTestIndexer>, simulate: unknown[]) =>
  // The simulate items are built by the helpers with literal contract and event names.
  indexer.process({ chains: { 10143: { simulate: simulate as never } } });

describe("ValidationRegistry handlers", () => {
  it("a request creates its row, the agent, and counts", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [requestEvent(r, { validator: VALIDATOR_A, block: B })]);

    const row = await indexer.ValidationRequest.getOrThrow(r.requestHash);
    expect(row).toMatchObject({
      agentId: "1984",
      validator: VALIDATOR_A,
      requestBlock: BigInt(B),
      requestTime: timeOf(B),
      requestTx: txHash(B),
      requestStatus: "VERIFIED",
      actionHash: r.actionHash,
      value: "1000000000000000",
      deadline: 1_790_100_000n,
      responses: 0,
    });
    expect(row.score).toBeUndefined();
    expect(row.gate).toBe("0x12fab3e3ca810cc44bd9f537613a230a2be8d614");
    expect((await indexer.Agent.getOrThrow("1984")).firstSeenBlock).toBe(BigInt(B));
    expect((await indexer.Validator.getOrThrow(VALIDATOR_A)).requests).toBe(1);
    expect((await indexer.AgentTrustSummary.getOrThrow("1984")).requests).toBe(1);
  });

  it("a response records score, tag, reasons and latency", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [
      requestEvent(r, { validator: VALIDATOR_A, block: B }),
      responseEvent({ validator: VALIDATOR_A, requestHash: r.requestHash, score: 0, reasons: ["DAILY_CAP_EXCEEDED"], block: B + 25 }),
    ]);

    const row = await indexer.ValidationRequest.getOrThrow(r.requestHash);
    expect(row).toMatchObject({
      responses: 1,
      score: 0,
      tag: "mandate-v1",
      reasons: ["DAILY_CAP_EXCEEDED"],
      evidenceStatus: "VERIFIED",
      responseBlock: BigInt(B + 25),
      responseTime: timeOf(B + 25),
      responseTx: txHash(B + 25),
      firstResponseBlock: BigInt(B + 25),
    });
    const validator = await indexer.Validator.getOrThrow(VALIDATOR_A);
    expect(validator).toMatchObject({ answered: 1, responseEvents: 1, score0: 1, score100: 0, scoreSum: 0n, avgScore: 0, latencyBlocksSum: 25n, latencyCount: 1, avgLatencyBlocks: 25, tags: ["mandate-v1"] });
    expect(await indexer.AgentTagSummary.getOrThrow("1984-mandate-v1")).toMatchObject({ agentId: "1984", tag: "mandate-v1", verdicts: 1, zeroScores: 1, fullScores: 0, lastScore: 0, lastRequestHash: r.requestHash });
    expect((await indexer.AgentTrustSummary.getOrThrow("1984")).answered).toBe(1);
    const responses = await indexer.ValidationResponse.getAll();
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ id: `${txHash(B + 25)}-0`, requestHash: r.requestHash, score: 0, evidenceStatus: "VERIFIED", reasons: ["DAILY_CAP_EXCEEDED"] });
  });

  it("a second response moves the request between buckets", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [
      requestEvent(r, { validator: VALIDATOR_A, block: B }),
      responseEvent({ validator: VALIDATOR_A, requestHash: r.requestHash, score: 0, block: B + 10 }),
      responseEvent({ validator: VALIDATOR_A, requestHash: r.requestHash, score: 100, block: B + 40 }),
    ]);

    const validator = await indexer.Validator.getOrThrow(VALIDATOR_A);
    expect(validator).toMatchObject({ answered: 1, responseEvents: 2, score0: 0, score100: 1, scoreSum: 100n, avgScore: 100, latencyBlocksSum: 10n, latencyCount: 1 });
    expect(await indexer.ValidationRequest.getOrThrow(r.requestHash)).toMatchObject({ responses: 2, score: 100, firstResponseBlock: BigInt(B + 10), responseBlock: BigInt(B + 40) });
    expect(await indexer.AgentTagSummary.getOrThrow("1984-mandate-v1")).toMatchObject({ verdicts: 1, zeroScores: 0, fullScores: 1, scoreSum: 100n, avgScore: 100, lastScore: 100 });
    expect((await indexer.AgentTrustSummary.getOrThrow("1984")).answered).toBe(1);
    expect(await indexer.ValidationResponse.getAll()).toHaveLength(2);
  });

  it("a re-answer under another tag moves the tag summary", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_B });
    await run(indexer, [
      requestEvent(r, { validator: VALIDATOR_B, block: B }),
      responseEvent({ validator: VALIDATOR_B, requestHash: r.requestHash, score: 80, tag: "risk-v0", block: B + 10 }),
      responseEvent({ validator: VALIDATOR_B, requestHash: r.requestHash, score: 40, tag: "risk-v1", block: B + 20 }),
    ]);

    expect(await indexer.AgentTagSummary.getOrThrow("1984-risk-v0")).toMatchObject({ verdicts: 0, scoreSum: 0n });
    expect((await indexer.AgentTagSummary.getOrThrow("1984-risk-v0")).avgScore).toBeUndefined();
    expect(await indexer.AgentTagSummary.getOrThrow("1984-risk-v1")).toMatchObject({ verdicts: 1, scoreSum: 40n, avgScore: 40, lastScore: 40 });
    expect(await indexer.Validator.getOrThrow(VALIDATOR_B)).toMatchObject({ score80to99: 0, score40to79: 1, tags: ["risk-v0", "risk-v1"] });
  });

  it("a response with no indexed request is stored and counts nothing", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [responseEvent({ validator: VALIDATOR_A, requestHash: r.requestHash, score: 100, block: B })]);

    expect(await indexer.ValidationResponse.getAll()).toHaveLength(1);
    expect(await indexer.ValidationRequest.get(r.requestHash)).toBeUndefined();
    expect(await indexer.Validator.get(VALIDATOR_A)).toBeUndefined();
    expect(await indexer.AgentTrustSummary.get("1984")).toBeUndefined();
  });

  it("a request with an https URI is NOT_INLINE with no actionHash", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [
      {
        contract: "ValidationRegistry",
        event: "ValidationRequest",
        srcAddress: REGISTRY,
        params: { validatorAddress: VALIDATOR_A, agentId: 1984n, requestURI: "https://example.com/r.json", requestHash: r.requestHash },
        ...at(B),
      },
    ]);
    const row = await indexer.ValidationRequest.getOrThrow(r.requestHash);
    expect(row.requestStatus).toBe("NOT_INLINE");
    expect(row.actionHash).toBeUndefined();
    expect(row.gate).toBeUndefined();
  });
});

describe("review fixes", () => {
  it("keeps at most 16 of a validator's tags (a stranger's 20 re-answers can't grow the list)", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [
      requestEvent(r, { validator: VALIDATOR_A, block: B }),
      ...Array.from({ length: 20 }, (_, i) => responseEvent({ validator: VALIDATOR_A, requestHash: r.requestHash, score: 100, tag: `tag-${i}`, block: B + 1 + i })),
    ]);
    const v = await indexer.Validator.getOrThrow(VALIDATOR_A);
    expect(v.tags).toEqual(Array.from({ length: 16 }, (_, i) => `tag-${i}`));
    expect(v.responseEvents).toBe(20);
  });

  it("a request whose JSON names another validator or agent than its event is not VERIFIED, and never marked executed", async () => {
    const indexer = createTestIndexer();
    // A stranger copies agent 1984's action into a request JSON naming validator A, then requests it as their own
    // agent 777 from validator B: the hash matches the JSON, but the JSON doesn't describe this request.
    const copied = request({ validator: VALIDATOR_A, salt: "copied" });
    await run(indexer, [
      requestEvent(copied, { validator: VALIDATOR_B, agentId: 777n, block: B }),
      { contract: "DemoAgentVault", event: "ActionConsumed", srcAddress: "0x12fab3e3ca810cc44bd9f537613a230a2be8d614", params: { actionHash: copied.actionHash, agentId: 1984n }, ...at(B + 5) },
    ]);
    const row = await indexer.ValidationRequest.getOrThrow(copied.requestHash);
    expect(row.requestStatus).toBe("HASH_MISMATCH");
    expect(row.actionHash).toBeUndefined();
    expect(row.executedTx).toBeUndefined();
  });
});
