import type { InboxEntry } from "@attest8004/sdk/browser";
import { describe, expect, it } from "vitest";
import { CRE_VALIDATOR_LABEL, DEPLOYMENTS } from "@attest8004/sdk/browser";
import { foundSummary, KNOWN_VALIDATORS, splitEntries, tagText, validatorLabel } from "../src/inbox/found.ts";

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

// P12 AUD-03: a hot key can name its own address as validator and post a report the trust rule accepts, so /inbox
// lists Attest8004's validators first and every other validator's verdicts apart, labelled as such.
describe("/inbox: known and other validators (P12 AUD-03)", () => {
  const d = DEPLOYMENTS[10143];

  it("knows validators A, B and C, and labels C as the CRE simulation it is", () => {
    expect(KNOWN_VALIDATORS).toEqual([d.validators.mandateV1, d.validators.riskV1, d.validators.creMandateV1]);
    expect(validatorLabel(d.validators.mandateV1)).toBe("validator A (mandate-v1)");
    expect(validatorLabel(d.validators.riskV1)).toBe("validator B (risk-v1)");
    expect(validatorLabel(d.validators.creMandateV1)).toBe(`validator C: ${CRE_VALIDATOR_LABEL}`);
    expect(validatorLabel("0x00000000000000000000000000000000000057a1")).toBeNull();
  });

  it("splits entries into known validators' and the others'", () => {
    const known = { validatorKnown: true } as InboxEntry;
    const other = { validatorKnown: false } as InboxEntry;
    expect(splitEntries([known, other, known])).toEqual({ known: [known, known], others: [other] });
  });

  it("shows a tag as printable ASCII only, capped", () => {
    expect(tagText("mandate-v1\u202E<script>" + "x".repeat(80))).toMatch(/^mandate-v1\?<script>x+…$/);
    expect(tagText("")).toBe("no tag");
  });
});
