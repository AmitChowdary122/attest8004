import { useState } from "react";
import { createPasskey, type CreatedPasskey } from "./ceremonies.ts";
import { JsonExport } from "./JsonExport.tsx";
import { errorText } from "./exportJson.ts";

/** Step 1: create the agent's passkey (once) and export its public registration for `set-passkey`. */
export function Register({ enabled }: { enabled: boolean }) {
  const [name, setName] = useState("attest8004-operator");
  const [created, setCreated] = useState<CreatedPasskey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      setCreated(await createPasskey(name.trim() || "attest8004-operator"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const registration = created?.registration;
  return (
    <section>
      <h2>1 · Create the agent's passkey</h2>
      <p className="muted">
        Once per agent. In Chrome, save it to <strong>Google Password Manager</strong> so your phone has it too. The owner then binds
        its public key with <code>set-passkey</code>.
      </p>
      <label>
        Name shown in your password manager
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
      </label>
      <button type="button" disabled={!enabled || busy} onClick={create}>
        {busy ? "Waiting for the passkey…" : "Create passkey"}
      </button>
      {error && <p className="error">{error}</p>}
      {registration && created && (
        <>
          <dl>
            <dt>Credential id</dt>
            <dd><code>{registration.credentialId}</code></dd>
            <dt>Public key qx</dt>
            <dd><code>{registration.qx}</code></dd>
            <dt>Public key qy</dt>
            <dd><code>{registration.qy}</code></dd>
            <dt>Algorithm</dt>
            <dd>{registration.alg === -7 ? "ES256 (P-256)" : `unsupported (${registration.alg})`}</dd>
            <dt>PRF (for the Mera inbox)</dt>
            <dd>{registration.prfEnabled ? "enabled" : "not enabled"}</dd>
            <dt>Synced</dt>
            <dd>{created.synced ? "yes" : "no: your phone won't have this passkey"}</dd>
          </dl>
          {created.problems.length > 0 ? (
            <p className="error">This passkey can't be the agent's passkey: {created.problems.join(", ")}. Delete it in your password manager and try again.</p>
          ) : (
            <JsonExport label="registration" fileName="attest8004-passkey-registration.json" value={registration} />
          )}
        </>
      )}
    </section>
  );
}
