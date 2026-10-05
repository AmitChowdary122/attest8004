import { getAddress, keccak256, toHex, zeroHash, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { compareAgent, compareValidator, type ChainAgentView, type ChainValidatorView, type IndexedAgentView } from "./indexer-compare.ts";

// indexer-check's comparisons (plan Task 7): the indexer against the chain, agent by agent and validator by
// validator. Each difference is one named mismatch; identical views give none.

const A = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const B = getAddress("0x780df855b48aec7a3907433b0b5984a2fe5dca5e");
const hash = (label: string): Hex => keccak256(toHex(label));

function views(): { chain: ChainAgentView; indexed: IndexedAgentView } {
  const statuses = [
    { requestHash: hash("one"), validator: A, agentId: 1984n, response: 100, responseHash: hash("ev one"), tag: "mandate-v1" },
    { requestHash: hash("two"), validator: B, agentId: 1984n, response: 0, responseHash: hash("ev two"), tag: "risk-v1" },
    { requestHash: hash("pending"), validator: A, agentId: 1984n, response: 0, responseHash: zeroHash, tag: "" },
  ];
  return {
    chain: { agentId: 1984n, statuses, trustedReports: [{ txHash: hash("post one"), logIndex: 2 }] },
    indexed: {
      agentId: 1984n,
      verdicts: statuses.map((s) => ({
        requestHash: s.requestHash,
        validator: s.validator,
        agentId: s.agentId,
        responses: s.tag === "" ? 0 : 1,
        score: s.tag === "" ? null : s.response,
        responseHash: s.tag === "" ? null : s.responseHash,
        tag: s.tag === "" ? null : s.tag,
      })),
      trustedReports: [{ txHash: hash("post one"), logIndex: 2 }],
    },
  };
}

describe("compareAgent", () => {
  it("finds nothing when the views agree", () => {
    const { chain, indexed } = views();
    expect(compareAgent(chain, indexed)).toEqual([]);
  });

  it("names a request missing from the indexer", () => {
    const { chain, indexed } = views();
    indexed.verdicts.pop();
    expect(compareAgent(chain, indexed).map((m) => m.what)).toEqual([`agent 1984: request ${hash("pending")} missing from the indexer`]);
  });

  it("names a request the chain doesn't list", () => {
    const { chain, indexed } = views();
    chain.statuses.pop();
    expect(compareAgent(chain, indexed).map((m) => m.what)).toEqual([`agent 1984: request ${hash("pending")} not on chain`]);
  });

  it("names another score, responseHash, tag or validator", () => {
    for (const [field, value, label] of [
      ["score", 40, "score"],
      ["responseHash", hash("other"), "responseHash"],
      ["tag", "risk-v0", "tag"],
      ["validator", A, "validator"],
    ] as const) {
      const { chain, indexed } = views();
      const second = indexed.verdicts[1];
      if (!second) throw new Error("fixture");
      (second as Record<string, unknown>)[field] = value;
      const found = compareAgent(chain, indexed);
      expect(found, label).toHaveLength(1);
      expect(found[0]?.what, label).toBe(`agent 1984: request ${hash("two")} ${label}`);
    }
  });

  it("names an indexed answer to a request still pending on chain", () => {
    const { chain, indexed } = views();
    const pending = indexed.verdicts[2];
    if (!pending) throw new Error("fixture");
    Object.assign(pending, { responses: 1, score: 0, responseHash: hash("x"), tag: "mandate-v1" });
    expect(compareAgent(chain, indexed).map((m) => m.what)).toEqual([`agent 1984: request ${hash("pending")} answered`]);
  });

  it("names a trusted report set that differs", () => {
    const { chain, indexed } = views();
    indexed.trustedReports = [{ txHash: hash("post one"), logIndex: 3 }];
    expect(compareAgent(chain, indexed).map((m) => m.what)).toEqual([
      `agent 1984: report ${hash("post one")}#2 missing from the indexer`,
    ]);
  });
});

describe("compareValidator", () => {
  const chain: ChainValidatorView = { validator: A, requests: 21, answered: 20, buckets: { score0: 6, score1to39: 0, score40to79: 0, score80to99: 0, score100: 14 } };
  const indexed = { validator: A, requests: 21, answered: 20, buckets: { score0: 6, score1to39: 0, score40to79: 0, score80to99: 0, score100: 14 } };

  it("finds nothing when the views agree", () => {
    expect(compareValidator(chain, indexed)).toEqual([]);
  });

  it("names a bucket off by one", () => {
    const found = compareValidator(chain, { ...indexed, buckets: { ...indexed.buckets, score0: 5 } });
    expect(found).toEqual([{ what: `validator ${A}: score0`, chain: "6", indexer: "5" }]);
  });

  it("names a missing validator", () => {
    expect(compareValidator(chain, null)).toEqual([{ what: `validator ${A}: missing from the indexer`, chain: "21 requests", indexer: "none" }]);
  });
});
