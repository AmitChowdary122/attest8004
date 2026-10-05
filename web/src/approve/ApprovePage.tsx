import { RP_ID, isApproveHost } from "@attest8004/sdk/browser";
import { useState } from "react";
import { ApproveChange } from "./ApproveChange.tsx";
import { InboxKey } from "./InboxKey.tsx";
import { PrfCheck } from "./PrfCheck.tsx";
import { Register } from "./Register.tsx";
import { registry } from "./chain.ts";
import { currentHostname, stripLinkParameters } from "./url.ts";

/**
 * /approve (SPEC §4.2, §4.7, §4.9): create the agent's passkey, check it with Mera's PRF, approve a mandate change, and
 * publish the agent's inbox key.
 * Client-only: no server, nothing stored, and nothing read from the URL.
 */
export function ApprovePage() {
  const [ignoredLinkParameters] = useState(stripLinkParameters);
  const enabled = isApproveHost(currentHostname());
  return (
    <main>
      <h1>Approve</h1>
      <p className="lede">Passkey-approved agent mandates, verified onchain by Monad's P256 precompile (0x0100).</p>
      {ignoredLinkParameters && <p className="notice">This page ignores link parameters: nothing in a link can fill in an agent or a mandate.</p>}
      {!enabled && (
        <p className="notice">
          Passkeys are bound to <strong>{RP_ID}</strong>. Open <a href={`https://${RP_ID}/approve`}>https://{RP_ID}/approve</a> to create
          or use one; ceremonies are disabled here.
        </p>
      )}
      <Register enabled={enabled} />
      <PrfCheck enabled={enabled} />
      <ApproveChange enabled={enabled} />
      <InboxKey enabled={enabled} />
      <footer>
        <p className="muted">
          This page stores nothing and sends nothing but public chain reads; everything it shows or exports is public data. MandateRegistry{" "}
          <code>{registry}</code> on Monad testnet. Build <code>{__BUILD_SHA__}</code>.
        </p>
        <p className="muted">
          <a href="https://github.com/AmitChowdary122/attest8004#readme">Docs and quickstart</a>
        </p>
      </footer>
    </main>
  );
}
