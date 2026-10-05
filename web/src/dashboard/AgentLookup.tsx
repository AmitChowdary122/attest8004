import { TrustApiError, getAgentTrust, type AgentTrust, type Deployment } from "@attest8004/sdk/browser";
import { useState } from "react";
import { formatEther } from "viem";
import { errorText } from "../approve/exportJson.ts";
import { explorerAddress } from "../explorer.ts";
import { VerdictList } from "./VerdictList.tsx";
import { agentLabel, mandateInForce, offlineView, utcTime } from "./view.ts";

/** The agent trust lookup: one getAgentTrust query per click, from a typed agent id (never from the URL). */
export function AgentLookup({ url, deployment }: { url: string; deployment: Deployment }) {
  const [agentText, setAgentText] = useState(String(deployment.demoAgents[0]));
  const [result, setResult] = useState<{ agentId: bigint; trust: AgentTrust | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const agentId = /^(0|[1-9]\d{0,76})$/.test(agentText) ? BigInt(agentText) : null;

  async function lookUp() {
    if (agentId === null) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult({ agentId, trust: await getAgentTrust(agentId, { url }) });
    } catch (e) {
      setError(e instanceof TrustApiError ? offlineView(deployment, e.kind).reason : `couldn't look up agent ${agentId}: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <label>
        Agent id
        <input value={agentText} onChange={(e) => setAgentText(e.target.value.trim())} inputMode="numeric" readOnly={busy} />
      </label>
      <button type="button" disabled={busy || agentId === null} onClick={lookUp}>
        {busy ? "Looking up…" : "Look up"}
      </button>
      {error && <p className="error">{error}</p>}
      {result && result.trust === null && <p className="notice">The indexer has never seen agent {result.agentId.toString()} in Attest8004's contracts.</p>}
      {result?.trust && <AgentTrustView trust={result.trust} deployment={deployment} />}
    </>
  );
}

function AgentTrustView({ trust, deployment }: { trust: AgentTrust; deployment: Deployment }) {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const s = trust.summary;
  const addressUrl = explorerAddress(trust.owner);
  return (
    <div className="agent">
      <h3>Agent {agentLabel(trust.agentId, deployment)}</h3>
      <dl>
        <dt>Owner</dt>
        <dd>{trust.owner === null ? "not seen" : addressUrl ? <a href={addressUrl} target="_blank" rel="noopener noreferrer">{trust.owner}</a> : trust.owner}</dd>
        <dt>Hot key</dt>
        <dd>{trust.hotKey ?? "none"}</dd>
        <dt>First seen</dt>
        <dd>block {trust.firstSeenBlock.toString()}</dd>
        <dt>Requests</dt>
        <dd>
          {s.requests} ({s.answered} answered, {s.executed} executed through a gate)
        </dd>
        <dt>Verdicts by tag</dt>
        <dd>
          {trust.tags.length === 0
            ? "none"
            : trust.tags
                .filter((t) => t.verdicts > 0)
                .map((t) => `${t.tag}: ${t.verdicts} (avg ${t.avgScore?.toFixed(1) ?? "—"}, ${t.fullScores} × 100, ${t.zeroScores} × 0)`)
                .join(" · ")}
        </dd>
        <dt>Operator reports</dt>
        <dd>
          {s.trustedReports} trusted{s.untrustedReports > 0 ? `, ${s.untrustedReports} from others (ignored)` : ""}
        </dd>
        <dt>Permission changes</dt>
        <dd>
          {s.permissionChanges}
          {s.lastPermissionChangeBlock !== null ? ` (last at block ${s.lastPermissionChangeBlock.toString()})` : ""}
        </dd>
        <dt>Mandate</dt>
        <dd>
          {trust.mandate === null
            ? "none on the current MandateRegistry"
            : `${mandateInForce(trust.mandate, trust.owner, now)} · up to ${formatEther(trust.mandate.maxValuePerTx)} MON per action, ${formatEther(trust.mandate.maxValuePerDay)} MON a day · ${trust.mandate.allowedTargets.length} target(s), ${trust.mandate.allowedSelectors.length} selector(s) · valid until ${utcTime(trust.mandate.validUntil)}`}
        </dd>
        <dt>Passkey</dt>
        <dd>{trust.passkey === null ? "none" : `set (block ${trust.passkey.block.toString()})`}</dd>
        <dt>Inbox key</dt>
        <dd>{trust.inboxKey === null ? "none" : <code>{trust.inboxKey.x25519Pub}</code>}</dd>
      </dl>
      <h3>Recent requests</h3>
      <VerdictList verdicts={trust.recentVerdicts} deployment={deployment} empty="No requests yet." />
      {trust.recentPermissionEvents.length > 0 && (
        <>
          <h3>Recent permission events</h3>
          <ul className="events">
            {trust.recentPermissionEvents.map((e) => (
              <li key={`${e.tx}-${e.logIndex}`}>
                block {e.block.toString()} · {e.kind}
                {e.to ? ` → ${e.to}` : ""}
                {e.approved === false ? " (revoked)" : ""}
                {e.inEpoch ? "" : " (retired registry: not counted)"}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted">Indexed to block {trust.indexedTo.toString()}.</p>
    </div>
  );
}
