// The only two places /approve touches the page URL (enforced by web/test/no-url-input.test.ts). It never reads a
// value from the URL: the agent, the mandate and everything else come from presets, typed input or the chain, so a
// phishing link can't pre-fill anything.

/** Whether passkey ceremonies may run here: the hostname must be the production rpId (see `isApproveHost`). */
export function currentHostname(): string {
  return window.location.hostname;
}

/**
 * Drops any query string or fragment from the address bar without reading it, and says whether there was one, so
 * the page can tell the person it ignored link parameters.
 */
export function stripLinkParameters(): boolean {
  const hadParameters = window.location.search !== "" || window.location.hash !== "";
  if (hadParameters) window.history.replaceState(null, "", window.location.pathname);
  return hadParameters;
}
