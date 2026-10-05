// Where the pages read the trust API (the Envio indexer): the recorded hosted endpoint, the only one the CSP's
// connect-src allows. Under `vite dev` only, VITE_TRUST_API_URL may point at a local indexer (README, "Run the indexer
// locally"); production builds compile that branch out. Nothing here comes from the page's own URL.
import type { TrustApiOptions } from "@attest8004/sdk/browser";
import { deployment } from "./approve/chain.ts";

/** The trust API's GraphQL URL, or null when none is recorded (the pages then work from the chain alone). */
export function trustApiUrl(): string | null {
  const local = import.meta.env.DEV && import.meta.env.VITE_TRUST_API_URL ? String(import.meta.env.VITE_TRUST_API_URL) : null;
  return local ?? deployment.trustApi?.graphqlUrl ?? null;
}

/** The SDK's trust API options for this page, or null without an indexer. */
export function trustApiOptions(): TrustApiOptions | null {
  const url = trustApiUrl();
  return url === null ? null : { url };
}
