// The only way the pages build links to the explorer: from well-formed hex, so no string read from the chain or the
// indexer can become a link anywhere else (web/test/no-html.test.ts holds every href to these builders).

export const EXPLORER = "https://monad-testnet.socialscan.io";

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The explorer page of a transaction, or null unless `hash` is 32 bytes of hex. */
export function explorerTx(hash: string | null | undefined): string | null {
  return typeof hash === "string" && TX_HASH.test(hash) ? `${EXPLORER}/tx/${hash.toLowerCase()}` : null;
}

/** The explorer page of an address, or null unless `address` is 20 bytes of hex. */
export function explorerAddress(address: string | null | undefined): string | null {
  return typeof address === "string" && ADDRESS.test(address) ? `${EXPLORER}/address/${address.toLowerCase()}` : null;
}
