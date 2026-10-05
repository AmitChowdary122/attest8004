import type { InboxEntry } from "@attest8004/sdk/browser";
import { describe, expect, it } from "vitest";
import { foundSummary } from "../src/inbox/found.ts";

// /inbox's "Found" line (plan Review Focus 1, review M3): how the reports were found, and when the indexer is behind,
// how many verdicts were searched on chain instead.
const entry = (source: "indexer" | "chain") => ({ source }) as InboxEntry;

describe("foundSummary", () => {
  it("through the indexer, everything indexed", () => {
    expect(foundSummary({ via: "indexer", fallbackReason: null, indexedTo: 68_351_658n, entries: [entry("indexer"), entry("indexer")] })).toBe(
      "through the Envio indexer (indexed to block 68351658); every report re-checked onchain",
    );
  });

  it("says the indexer is behind when verdicts were searched on chain", () => {
    expect(foundSummary({ via: "indexer", fallbackReason: null, indexedTo: 68_351_658n, entries: [entry("chain"), entry("indexer"), entry("chain")] })).toBe(
      "through the Envio indexer (indexed to block 68351658); every report re-checked onchain. The indexer is behind: 2 verdict(s) newer than its progress were searched on chain, within 600 blocks of each",
    );
  });

  it("an indexer that hasn't started yet", () => {
    expect(foundSummary({ via: "indexer", fallbackReason: null, indexedTo: -1n, entries: [entry("chain")] })).toBe(
      "on chain, within 600 blocks of each verdict: the Envio indexer hasn't indexed anything yet",
    );
  });

  it("no verdicts to search", () => {
    expect(foundSummary({ via: "indexer", fallbackReason: null, indexedTo: null, entries: [] })).toBe("no answered verdicts to search");
  });

  it("the chain, and why", () => {
    expect(foundSummary({ via: "chain", fallbackReason: "NETWORK: the indexer couldn't be reached", indexedTo: null, entries: [entry("chain")] })).toBe(
      "on chain, within 600 blocks of each verdict: the indexer is unavailable (NETWORK: the indexer couldn't be reached)",
    );
    expect(foundSummary({ via: "chain", fallbackReason: null, indexedTo: null, entries: [entry("chain")] })).toBe("on chain, within 600 blocks of each verdict (no indexer recorded)");
  });
});
