// /inbox's "Found" line: how the reports were found, and, when the indexer is behind, how many verdicts were searched
// on chain instead (plan Review Focus 1). Pure, so it is tested without a DOM.
import { REPORT_SEARCH_BLOCKS, type InboxEntry } from "@attest8004/sdk/browser";

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
