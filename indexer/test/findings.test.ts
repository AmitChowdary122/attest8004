import { createTestIndexer } from "envio";
import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { B, BOARD, FORWARDER, HOT_KEY, OWNER, STRANGER, VALIDATOR_A, at, request, requestEvent, responseEvent, txHash } from "./helpers.ts";

// FindingsPosted (plan Task 4, decision 15): every post is stored; `trusted` is SPEC §4.7's rule applied to the
// indexed request (it names this validator and this agent), re-evaluated when a post arrives before its request.

const run = (indexer: ReturnType<typeof createTestIndexer>, simulate: unknown[]) => indexer.process({ chains: { 10143: { simulate: simulate as never } } });

const ENVELOPE: Hex = `0x01${"ab".repeat(80)}`;
const post = (o: { requestHash: Hex; validator: Address; agentId?: bigint; block: number; logIndex?: number }) => ({
  contract: "FindingsBoard",
  event: "FindingsPosted",
  srcAddress: BOARD,
  params: { requestHash: o.requestHash, agentId: o.agentId ?? 1984n, validator: o.validator, envelope: ENVELOPE },
  ...at(o.block, o.logIndex),
});
const agentKey = (block: number) => ({
  contract: "AgentRequestForwarder",
  event: "AgentKeySet",
  srcAddress: FORWARDER,
  params: { agentId: 1984n, owner: OWNER, key: HOT_KEY },
  ...at(block),
});
const onlyPost = async (indexer: ReturnType<typeof createTestIndexer>) => {
  const posts = await indexer.FindingsPost.getAll();
  expect(posts).toHaveLength(1);
  return posts[0];
};

describe("FindingsBoard", () => {
  it("a post by the requested validator for its agent is trusted", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [
      requestEvent(r, { validator: VALIDATOR_A, block: B }),
      responseEvent({ validator: VALIDATOR_A, requestHash: r.requestHash, score: 100, block: B + 5 }),
      post({ requestHash: r.requestHash, validator: VALIDATOR_A, block: B + 6 }),
    ]);
    expect(await onlyPost(indexer)).toMatchObject({
      id: `${txHash(B + 6)}-0`,
      requestHash: r.requestHash,
      agentId: "1984",
      validator: VALIDATOR_A,
      envelope: ENVELOPE,
      envelopeBytes: 81,
      trusted: true,
      trustProblem: undefined,
      counted: true,
      tx: txHash(B + 6),
    });
    expect(await indexer.AgentTrustSummary.getOrThrow("1984")).toMatchObject({ trustedReports: 1, untrustedReports: 0 });
  });

  it("a stranger's post is stored untrusted", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [requestEvent(r, { validator: VALIDATOR_A, block: B }), post({ requestHash: r.requestHash, validator: STRANGER, block: B + 6 })]);
    expect(await onlyPost(indexer)).toMatchObject({ validator: STRANGER, trusted: false, trustProblem: "WRONG_VALIDATOR" });
    expect(await indexer.AgentTrustSummary.getOrThrow("1984")).toMatchObject({ trustedReports: 0, untrustedReports: 1 });
  });

  it("a post naming another agent is WRONG_AGENT", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [requestEvent(r, { validator: VALIDATOR_A, block: B }), post({ requestHash: r.requestHash, validator: VALIDATOR_A, agentId: 1985n, block: B + 6 })]);
    expect(await onlyPost(indexer)).toMatchObject({ agentId: "1985", trusted: false, trustProblem: "WRONG_AGENT", counted: false });
    expect(await indexer.Agent.get("1985")).toBeUndefined();
    expect((await indexer.AgentTrustSummary.getOrThrow("1984")).untrustedReports).toBe(0);
  });

  it("a post before its request is re-evaluated (agent first seen with the request)", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [post({ requestHash: r.requestHash, validator: VALIDATOR_A, block: B }), requestEvent(r, { validator: VALIDATOR_A, block: B + 5 })]);
    expect(await onlyPost(indexer)).toMatchObject({ trusted: true, trustProblem: undefined, counted: true });
    expect(await indexer.AgentTrustSummary.getOrThrow("1984")).toMatchObject({ trustedReports: 1, untrustedReports: 0 });
  });

  it("a post before its request is re-evaluated (agent already known: its count moves)", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [agentKey(B - 10), post({ requestHash: r.requestHash, validator: VALIDATOR_A, block: B }), requestEvent(r, { validator: VALIDATOR_A, block: B + 5 })]);
    expect(await onlyPost(indexer)).toMatchObject({ trusted: true, counted: true });
    expect(await indexer.AgentTrustSummary.getOrThrow("1984")).toMatchObject({ trustedReports: 1, untrustedReports: 0 });
  });

  it("a stranger's post before the request stays untrusted, now WRONG_VALIDATOR", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A });
    await run(indexer, [agentKey(B - 10), post({ requestHash: r.requestHash, validator: STRANGER, block: B }), requestEvent(r, { validator: VALIDATOR_A, block: B + 5 })]);
    expect(await onlyPost(indexer)).toMatchObject({ trusted: false, trustProblem: "WRONG_VALIDATOR", counted: true });
    expect(await indexer.AgentTrustSummary.getOrThrow("1984")).toMatchObject({ trustedReports: 0, untrustedReports: 1 });
  });

  it("a post naming an unknown agent with no request creates no Agent", async () => {
    const indexer = createTestIndexer();
    const r = request({ validator: VALIDATOR_A, agentId: 777n });
    await run(indexer, [post({ requestHash: r.requestHash, validator: STRANGER, agentId: 777n, block: B })]);
    expect(await onlyPost(indexer)).toMatchObject({ agentId: "777", trusted: false, trustProblem: "NO_REQUEST", counted: false });
    expect(await indexer.Agent.get("777")).toBeUndefined();
    expect(await indexer.AgentTrustSummary.get("777")).toBeUndefined();
  });
});
