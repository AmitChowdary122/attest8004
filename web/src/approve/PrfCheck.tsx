import { getPasskeyPrfOutput } from "@category-labs/mera";
import { PRF_CHECK_SALT, RP_ID, prfFingerprint } from "@attest8004/sdk/browser";
import { useState } from "react";
import { hexToBytes, type Hex } from "viem";
import { errorText } from "./exportJson.ts";

/**
 * Step 2: Mera's PRF works with this passkey. It evaluates a check-only salt (never the inbox salt P7 uses) and shows
 * an 8-byte fingerprint of the output, then zeroes the output. The same passkey on another device must show the
 * same fingerprint.
 */
export function PrfCheck({ enabled }: { enabled: boolean }) {
  const [result, setResult] = useState<{ credentialId: string; fingerprint: Hex } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const { credentialId, prfOutput } = await getPasskeyPrfOutput({ rpId: RP_ID, prfSalt: hexToBytes(PRF_CHECK_SALT) });
      const fingerprint = prfFingerprint(prfOutput);
      prfOutput.fill(0);
      setResult({ credentialId, fingerprint });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>2 · Check the passkey with Mera's PRF</h2>
      <p className="muted">
        The Mera inbox (P7) derives keys from this passkey's PRF. Run this on each device: the fingerprints must match.
      </p>
      <button type="button" disabled={!enabled || busy} onClick={check}>
        {busy ? "Waiting for the passkey…" : "Mera PRF check"}
      </button>
      {error && <p className="error">{error}</p>}
      {result && (
        <dl>
          <dt>Credential id</dt>
          <dd><code>{result.credentialId}</code></dd>
          <dt>Fingerprint</dt>
          <dd><code className="fingerprint">{result.fingerprint}</code></dd>
        </dl>
      )}
    </section>
  );
}
