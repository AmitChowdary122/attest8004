// /inbox's "Found" line: how the reports were found, and, when the indexer is behind, how many verdicts were searched
// on chain instead (plan Review Focus 1). Pure, so it is tested without a DOM.
import { CRE_VALIDATOR_LABEL, DEPLOYMENTS, displayText, REPORT_SEARCH_BLOCKS, type InboxEntry } from "@attest8004/sdk/browser";
import { getAddress, type Address } from "viem";

const testnet = DEPLOYMENTS[10143];

/** The validators /inbox trusts to have written a report: Attest8004's A, B and C (P12, AUD-03). */
export const KNOWN_VALIDATORS: readonly Address[] = [testnet.validators.mandateV1, testnet.validators.riskV1, testnet.validators.creMandateV1];

const LABELS: Record<string, string> = {
  [getAddress(testnet.validators.mandateV1)]: "validator A (mandate-v1)",
  [getAddress(testnet.validators.riskV1)]: "validator B (risk-v1)",
  [getAddress(testnet.validators.creMandateV1)]: `validator C: ${CRE_VALIDATOR_LABEL}`,
};

/** Our validators' labels; null for any other address, which the page shows apart (P12, AUD-03). */
export function validatorLabel(address: string): string | null {
  return LABELS[getAddress(address)] ?? null;
}

/** Known validators' entries, and every other validator's, each in discovery's order. */
export function splitEntries<T extends Pick<InboxEntry, "validatorKnown">>(entries: readonly T[]): { known: T[]; others: T[] } {
  return { known: entries.filter((e) => e.validatorKnown), others: entries.filter((e) => !e.validatorKnown) };
}

/** A validator's tag as printable ASCII, capped (anyone answering their own request picks it). */
export function tagText(tag: string): string {
  return tag === "" ? "no tag" : displayText(tag);
}

export function foundSummary(found: { via: "indexer" | "chain"; fallbackReason: string | null; indexedTo: bigint | null; entries: Pick<InboxEntry, "source">[] }): string {
  const window = `on chain, within ${REPORT_SEARCH_BLOCKS.toString()} blocks of each verdict`;
  if (found.via === "chain") return found.fallbackReason !== null ? `${window}: the indexer is unavailable (${found.fallbackReason})` : `${window} (no indexer recorded)`;
  if (found.entries.length === 0) return "no answered verdicts to search";
  if (found.indexedTo === null || found.indexedTo < 0n) return `${window}: the Envio indexer hasn't indexed anything yet`;
  const line = `through the Envio indexer (indexed to block ${found.indexedTo.toString()}); every report re-checked onchain`;
  const onChain = found.entries.filter((e) => e.source === "chain").length;
  return onChain === 0
    ? line
    : `${line}. The indexer is behind: ${onChain} verdict(s) newer than its progress were searched on chain, within ${REPORT_SEARCH_BLOCKS.toString()} blocks of each`;
}
