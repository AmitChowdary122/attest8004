import { describe, expect, it } from "vitest";
import { MAX_LAG_BLOCKS, keepAliveVerdict } from "./indexer-keepalive.ts";

// The daily keep-alive (plan addition 1): one query to the hosted indexer, failing loudly when it is gone or more than
// a day behind the chain.
describe("keepAliveVerdict", () => {
  const meta = (progressBlock: number) => [{ chainId: 10143, progressBlock }];

  it("is ok within a day of the head", () => {
    expect(MAX_LAG_BLOCKS).toBe(283_000n);
    expect(keepAliveVerdict({ url: "https://x/v1/graphql", meta: meta(68_000_000), head: 68_283_000n })).toEqual({ ok: true, progressBlock: 68_000_000n, lag: 283_000n });
    expect(keepAliveVerdict({ url: "https://x/v1/graphql", meta: meta(68_000_010), head: 68_000_000n })).toEqual({ ok: true, progressBlock: 68_000_010n, lag: 0n });
  });

  it("names each problem", () => {
    expect(keepAliveVerdict({ url: null, meta: null, head: null })).toMatchObject({ ok: false, problem: "NO_INDEXER_RECORDED" });
    expect(keepAliveVerdict({ url: "https://x/v1/graphql", meta: null, head: 68_000_000n })).toMatchObject({ ok: false, problem: "UNREACHABLE" });
    expect(keepAliveVerdict({ url: "https://x/v1/graphql", meta: [{ chainId: 1, progressBlock: 5 }], head: 68_000_000n })).toMatchObject({ ok: false, problem: "NO_CHAIN" });
    expect(keepAliveVerdict({ url: "https://x/v1/graphql", meta: meta(68_000_000), head: 68_283_001n })).toMatchObject({ ok: false, problem: "BEHIND" });
    expect(keepAliveVerdict({ url: "https://x/v1/graphql", meta: meta(68_000_000), head: null })).toMatchObject({ ok: false, problem: "NO_HEAD" });
  });
});
