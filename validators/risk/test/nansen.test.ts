import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { nansenClient } from "../src/nansen.ts";
import { RISK_V1 } from "../src/params.ts";

const ADDRESS = getAddress("0xeeebba55620afc42e9c88b5d962476367b8da338");

function fakeFetch(responses: Response[]): { fn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = responses[i];
    i++;
    if (response === undefined) throw new Error("fakeFetch: ran out of canned responses");
    return response;
  }) as typeof fetch;
  return { fn, calls };
}

function throwingFetch(): typeof fetch {
  return (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.nansen.ai");
  }) as typeof fetch;
}

function fakeSleep(): { fn: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    fn: async (ms: number) => {
      calls.push(ms);
    },
    calls,
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("nansenClient: no key", () => {
  it("available is false, reason is NANSEN_API_KEY is not set", () => {
    const client = nansenClient({});
    expect(client.available).toBe(false);
    expect(client.reason).toBe("NANSEN_API_KEY is not set");
  });

  it("an empty-string key is treated the same as no key", () => {
    const client = nansenClient({ apiKey: "" });
    expect(client.available).toBe(false);
  });

  it("profile() returns {available:false, reason} without ever calling fetch", async () => {
    const { fn, calls } = fakeFetch([]);
    const client = nansenClient({ fetch: fn });
    const result = await client.profile(ADDRESS);
    expect(result).toEqual({ available: false, reason: "NANSEN_API_KEY is not set" });
    expect(calls).toHaveLength(0);
  });

  it("flows() returns {available:false, reason} without ever calling fetch", async () => {
    const { fn, calls } = fakeFetch([]);
    const client = nansenClient({ fetch: fn });
    const result = await client.flows(ADDRESS, 1_000n, 2_000n);
    expect(result).toEqual({ available: false, reason: "NANSEN_API_KEY is not set" });
    expect(calls).toHaveLength(0);
  });
});

describe("nansenClient: profile()", () => {
  it("POSTs labels then first-funder with the exact bodies and apikey header, and normalises the response", async () => {
    const labelsBody = { data: [{ label: "Exchange", category: "CEX", kind: ["Hot Wallet"] }] };
    const firstFunderBody = {
      data: [
        {
          wallet_address: ADDRESS,
          first_funder_address: "0x1234567890123456789012345678901234567890",
          first_funder_name: "Binance",
          transaction_hash: "0xabc",
          block_timestamp: "2026-01-01T00:00:00Z",
          chain: "ethereum",
        },
      ],
    };
    const { fn, calls } = fakeFetch([jsonResponse(200, labelsBody), jsonResponse(200, firstFunderBody)]);
    const client = nansenClient({ apiKey: "nansen-key-123", fetch: fn, sleep: fakeSleep().fn });

    const result = await client.profile(ADDRESS);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://api.nansen.ai/api/v1/profiler/address/labels");
    expect(calls[1]?.url).toBe("https://api.nansen.ai/api/v1/profiler/address/first-funder");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      address: ADDRESS,
      chain: "all",
      pagination: { page: 1, per_page: 100 },
    });
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({ address: ADDRESS, chain: "all" });
    for (const call of calls) {
      const headers = new Headers(call.init.headers as Record<string, string>);
      expect(headers.get("apikey")).toBe("nansen-key-123");
    }

    expect(result).toEqual({
      available: true,
      labels: [{ label: "Exchange", category: "CEX", kind: ["Hot Wallet"] }],
      firstFunder: {
        address: getAddress("0x1234567890123456789012345678901234567890"),
        name: "Binance",
        chain: "ethereum",
        time: "2026-01-01T00:00:00Z",
      },
    });
  });

  it("firstFunder is null when the first-funder endpoint's data is empty (unknown funder)", async () => {
    const { fn } = fakeFetch([jsonResponse(200, { data: [] }), jsonResponse(200, { data: [] })]);
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: fakeSleep().fn });
    const result = await client.profile(ADDRESS);
    expect(result).toEqual({ available: true, labels: [], firstFunder: null });
  });

  it("caps labels at RISK_V1.nansenMaxLabels entries", async () => {
    const data = Array.from({ length: 25 }, (_, i) => ({ label: `label-${i}`, category: "x", kind: [] }));
    const { fn } = fakeFetch([jsonResponse(200, { data }), jsonResponse(200, { data: [] })]);
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: fakeSleep().fn });
    const result = (await client.profile(ADDRESS)) as { labels: unknown[] };
    expect(result.labels).toHaveLength(RISK_V1.nansenMaxLabels);
  });

  it("caps a label string at 64 characters, dropping a trailing lone surrogate, in both the label itself and first_funder_name", async () => {
    const longLabel = "a".repeat(63) + "\u{1F600}"; // 65 UTF-16 units; the cut at 64 lands inside the emoji
    const { fn } = fakeFetch([
      jsonResponse(200, { data: [{ label: longLabel, category: "x", kind: [] }] }),
      jsonResponse(200, { data: [{ first_funder_address: ADDRESS, first_funder_name: longLabel, chain: "ethereum", block_timestamp: "1" }] }),
    ]);
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: fakeSleep().fn });
    const result = (await client.profile(ADDRESS)) as {
      labels: { label: string }[];
      firstFunder: { name: string } | null;
    };
    expect(result.labels[0]?.label.length).toBeLessThanOrEqual(64);
    expect(/[\uD800-\uDFFF]/.test(result.labels[0]?.label ?? "")).toBe(false);
    expect(result.firstFunder?.name.length).toBeLessThanOrEqual(64);
    expect(/[\uD800-\uDFFF]/.test(result.firstFunder?.name ?? "")).toBe(false);
  });

  it("fix round 1, finding 1: a malformed first_funder_address (not 40 hex chars) becomes null, never the raw string", async () => {
    const { fn } = fakeFetch([
      jsonResponse(200, { data: [] }),
      jsonResponse(200, { data: [{ first_funder_address: "not-an-address", first_funder_name: "Binance", chain: "ethereum", block_timestamp: "1" }] }),
    ]);
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: fakeSleep().fn });
    const result = (await client.profile(ADDRESS)) as { firstFunder: { address: unknown } | null };
    expect(result.firstFunder?.address).toBeNull();
  });

  it("fix round 1, finding 4: category and each kind entry are capped at 64 characters, dropping a trailing lone surrogate", async () => {
    const longCategory = "c".repeat(63) + "\u{1F600}"; // 65 UTF-16 units; the cut at 64 lands inside the emoji
    const longKind = "k".repeat(100);
    const { fn } = fakeFetch([jsonResponse(200, { data: [{ label: "x", category: longCategory, kind: [longKind] }] }), jsonResponse(200, { data: [] })]);
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: fakeSleep().fn });
    const result = (await client.profile(ADDRESS)) as { labels: { category: string; kind: string[] }[] };
    expect(result.labels[0]?.category.length).toBeLessThanOrEqual(64);
    expect(/[\uD800-\uDFFF]/.test(result.labels[0]?.category ?? "")).toBe(false);
    expect(result.labels[0]?.kind[0]?.length).toBe(64);
  });

  it("when labels fails, the whole profile fails and first-funder is never called", async () => {
    const { fn, calls } = fakeFetch([jsonResponse(403, { code: "insufficient_credits" })]);
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: fakeSleep().fn });
    const result = await client.profile(ADDRESS);
    expect(result).toEqual({ available: false, reason: "NANSEN_ERROR 403 insufficient_credits" });
    expect(calls).toHaveLength(1);
  });

  it("when labels succeeds but first-funder fails, the whole profile fails", async () => {
    const { fn, calls } = fakeFetch([jsonResponse(200, { data: [] }), jsonResponse(403, { code: "insufficient_credits" })]);
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: fakeSleep().fn });
    const result = await client.profile(ADDRESS);
    expect(result).toEqual({ available: false, reason: "NANSEN_ERROR 403 insufficient_credits" });
    expect(calls).toHaveLength(2);
  });
});

describe("nansenClient: flows()", () => {
  it("POSTs counterparties with the exact body, date window pinned to the given from/to seconds", async () => {
    const { fn, calls } = fakeFetch([jsonResponse(200, { data: [] })]);
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: fakeSleep().fn });
    const to = 1_790_000_000n;
    const from = to - RISK_V1.nansenWindowSeconds;

    await client.flows(ADDRESS, from, to);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.nansen.ai/api/v1/profiler/address/counterparties");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      address: ADDRESS,
      chain: "all",
      date: { from: new Date(Number(from) * 1000).toISOString(), to: new Date(Number(to) * 1000).toISOString() },
      source_input: "Combined",
      group_by: "wallet",
      pagination: { page: 1, per_page: 10 },
      order_by: [{ field: "total_volume_usd", direction: "DESC" }],
    });
  });

  it("normalises counterparties: USD floats become decimal strings, labels are capped, address is checksummed", async () => {
    const other = "0x1234567890123456789012345678901234567890";
    const body = {
      data: [
        {
          counterparty_address: other,
          counterparty_address_label: ["Exchange", "Hot Wallet"],
          interaction_count: 7,
          total_volume_usd: 1234.5,
          volume_in_usd: 1000.25,
          volume_out_usd: 234.25,
          tokens_info: [{ symbol: "USDC" }], // not surfaced; must not break normalisation
        },
      ],
    };
    const { fn } = fakeFetch([jsonResponse(200, body)]);
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: fakeSleep().fn });
    const result = await client.flows(ADDRESS, 0n, 1n);

    expect(result).toEqual({
      available: true,
      counterparties: [
        {
          address: getAddress(other),
          labels: ["Exchange", "Hot Wallet"],
          interactionCount: 7,
          totalVolumeUsd: "1234.5",
          volumeInUsd: "1000.25",
          volumeOutUsd: "234.25",
        },
      ],
    });
  });

  it("a non-finite or missing USD figure becomes null, never throwing or passing through a float that would break canonicalJson", async () => {
    const other = "0x1234567890123456789012345678901234567890";
    const body = { data: [{ counterparty_address: other, total_volume_usd: Number.NaN, volume_in_usd: null }] };
    const { fn } = fakeFetch([jsonResponse(200, body)]);
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: fakeSleep().fn });
    const result = (await client.flows(ADDRESS, 0n, 1n)) as { counterparties: { totalVolumeUsd: unknown; volumeInUsd: unknown; volumeOutUsd: unknown }[] };
    expect(result.counterparties[0]?.totalVolumeUsd).toBeNull();
    expect(result.counterparties[0]?.volumeInUsd).toBeNull();
    expect(result.counterparties[0]?.volumeOutUsd).toBeNull();
  });

  it("caps counterparties at RISK_V1.nansenMaxCounterparties entries even if the API returned more", async () => {
    const data = Array.from({ length: 15 }, (_, i) => ({ counterparty_address: `0x${(i + 1).toString(16).padStart(40, "0")}` }));
    const { fn } = fakeFetch([jsonResponse(200, { data })]);
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: fakeSleep().fn });
    const result = (await client.flows(ADDRESS, 0n, 1n)) as { counterparties: unknown[] };
    expect(result.counterparties).toHaveLength(RISK_V1.nansenMaxCounterparties);
  });

  it("fix round 1, finding 1: a malformed counterparty_address (not 40 hex chars) becomes null, never the raw string", async () => {
    const body = { data: [{ counterparty_address: "not-an-address", counterparty_address_label: ["Exchange"] }] };
    const { fn } = fakeFetch([jsonResponse(200, body)]);
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: fakeSleep().fn });
    const result = (await client.flows(ADDRESS, 0n, 1n)) as { counterparties: { address: unknown }[] };
    expect(result.counterparties[0]?.address).toBeNull();
  });

  it("caps each counterparty label at 64 characters", async () => {
    const other = "0x1234567890123456789012345678901234567890";
    const longLabel = "b".repeat(100);
    const body = { data: [{ counterparty_address: other, counterparty_address_label: [longLabel] }] };
    const { fn } = fakeFetch([jsonResponse(200, body)]);
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: fakeSleep().fn });
    const result = (await client.flows(ADDRESS, 0n, 1n)) as { counterparties: { labels: string[] }[] };
    expect(result.counterparties[0]?.labels[0]?.length).toBe(64);
  });
});

describe("nansenClient: errors never throw, and the key never leaks", () => {
  it("429 with Retry-After: 3 is retried once after 3,000 ms, then gives NANSEN_ERROR 429 rate_limit_exceeded", async () => {
    const responses = [
      jsonResponse(429, { code: "rate_limit_exceeded" }, { "retry-after": "3" }),
      jsonResponse(429, { code: "rate_limit_exceeded" }, { "retry-after": "3" }),
    ];
    const { fn, calls } = fakeFetch(responses);
    const sleep = fakeSleep();
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: sleep.fn });
    const result = await client.flows(ADDRESS, 0n, 1n);
    expect(result).toEqual({ available: false, reason: "NANSEN_ERROR 429 rate_limit_exceeded" });
    expect(calls).toHaveLength(2);
    expect(sleep.calls).toEqual([3_000]);
  });

  it("retry-after over the 10s cap is capped, not honoured in full", async () => {
    const responses = [
      jsonResponse(429, { code: "rate_limit_exceeded" }, { "retry-after": "999" }),
      jsonResponse(429, { code: "rate_limit_exceeded" }, { "retry-after": "999" }),
    ];
    const { fn } = fakeFetch(responses);
    const sleep = fakeSleep();
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: sleep.fn });
    await client.flows(ADDRESS, 0n, 1n);
    expect(sleep.calls).toEqual([10_000]);
  });

  it("a missing Retry-After header falls back to a non-zero delay", async () => {
    const responses = [jsonResponse(500, { code: "internal" }), jsonResponse(500, { code: "internal" })];
    const { fn } = fakeFetch(responses);
    const sleep = fakeSleep();
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: sleep.fn });
    await client.flows(ADDRESS, 0n, 1n);
    expect(sleep.calls).toEqual([2_000]);
  });

  it("fix round 1, finding 2: 504 is retried once, then gives NANSEN_ERROR 504", async () => {
    const responses = [jsonResponse(504, {}), jsonResponse(504, {})];
    const { fn, calls } = fakeFetch(responses);
    const sleep = fakeSleep();
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: sleep.fn });
    const result = await client.flows(ADDRESS, 0n, 1n);
    expect(result).toEqual({ available: false, reason: "NANSEN_ERROR 504" });
    expect(calls).toHaveLength(2);
    expect(sleep.calls).toHaveLength(1);
  });

  it("fix round 1, finding 2: 501 is retried once, then gives NANSEN_ERROR 501", async () => {
    const responses = [jsonResponse(501, {}), jsonResponse(501, {})];
    const { fn, calls } = fakeFetch(responses);
    const sleep = fakeSleep();
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: sleep.fn });
    const result = await client.flows(ADDRESS, 0n, 1n);
    expect(result).toEqual({ available: false, reason: "NANSEN_ERROR 501" });
    expect(calls).toHaveLength(2);
    expect(sleep.calls).toHaveLength(1);
  });

  it("fix round 1, finding 2: 499 is never retried", async () => {
    const { fn, calls } = fakeFetch([jsonResponse(499, {})]);
    const sleep = fakeSleep();
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: sleep.fn });
    const result = await client.flows(ADDRESS, 0n, 1n);
    expect(result).toEqual({ available: false, reason: "NANSEN_ERROR 499" });
    expect(calls).toHaveLength(1);
    expect(sleep.calls).toEqual([]);
  });

  it("403 insufficient_credits gives NANSEN_ERROR 403 insufficient_credits, with no retry", async () => {
    const { fn, calls } = fakeFetch([jsonResponse(403, { code: "insufficient_credits" })]);
    const sleep = fakeSleep();
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: sleep.fn });
    const result = await client.flows(ADDRESS, 0n, 1n);
    expect(result).toEqual({ available: false, reason: "NANSEN_ERROR 403 insufficient_credits" });
    expect(calls).toHaveLength(1);
    expect(sleep.calls).toEqual([]);
  });

  it("a network error (fetch rejecting) gives NANSEN_ERROR network, with no retry", async () => {
    const client = nansenClient({ apiKey: "k", fetch: throwingFetch(), sleep: fakeSleep().fn });
    const result = await client.flows(ADDRESS, 0n, 1n);
    expect(result).toEqual({ available: false, reason: "NANSEN_ERROR network" });
  });

  it("a second consecutive failure (after the one retry) never throws, for profile() too", async () => {
    const responses = [jsonResponse(503, {}), jsonResponse(503, {})];
    const { fn } = fakeFetch(responses);
    const client = nansenClient({ apiKey: "k", fetch: fn, sleep: fakeSleep().fn });
    await expect(client.profile(ADDRESS)).resolves.toEqual({ available: false, reason: "NANSEN_ERROR 503" });
  });

  it("the key appears in no output, error text, or thrown value", async () => {
    const { fn } = fakeFetch([jsonResponse(401, { code: "invalid_api_key" })]);
    const client = nansenClient({ apiKey: "super-secret-nansen-key", fetch: fn, sleep: fakeSleep().fn });
    const result = await client.flows(ADDRESS, 0n, 1n);
    expect(JSON.stringify(result)).not.toContain("super-secret-nansen-key");
  });
});
