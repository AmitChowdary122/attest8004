import {
  RP_ID_HASH,
  buildApproval,
  describeMandate,
  e2eMandate,
  mandateHash,
  mandateJsonSchema,
  mandateFromJson,
  mandateRuleProblems,
  mandateToJson,
  passkeyChallenge,
  verifyAssertionLocally,
  type Approval,
  type AssertionProblem,
  type Mandate,
} from "@attest8004/sdk/browser";
import { useEffect, useMemo, useState } from "react";
import { getAddress } from "viem";
import { approveWithPasskey } from "./ceremonies.ts";
import { chainId, contractHashes, deployment, readAgent, registry, type AgentState } from "./chain.ts";
import { errorText, prettyJson } from "./exportJson.ts";
import { JsonExport } from "./JsonExport.tsx";

const ASSERTION_PROBLEMS: Record<AssertionProblem, string> = {
  RP_ID_HASH: "the passkey answered for another site",
  USER_NOT_PRESENT: "the authenticator didn't report user presence",
  USER_NOT_VERIFIED: "the authenticator didn't verify you (PIN, fingerprint or screen lock)",
  BACKUP_STATE: "the authenticator's backup flags are inconsistent",
  TYPE: "the browser's client data isn't an assertion",
  CHALLENGE: "the browser signed a different challenge",
  HIGH_S: "the signature wasn't normalised (a bug in this page)",
  SIGNATURE: "this passkey isn't the agent's passkey; approve again and pick the right one",
};

function labelsFor(agent: AgentState | null): Record<string, string> {
  const labels: Record<string, string> = {
    [getAddress(deployment.demoPassThrough)]: "DemoPassThrough: forwards every payment to a sink nobody controls",
    [getAddress(deployment.demoAgentVault)]: "DemoAgentVault",
    [getAddress(deployment.validators.mandateV1)]: "validator A (mandate-v1)",
    [getAddress(deployment.validators.riskV1)]: "validator B (risk-v1)",
  };
  if (agent) labels[agent.owner] = "the agent's owner";
  return labels;
}

function parseMandate(text: string): { mandate: Mandate } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: "not valid JSON" };
  }
  const parsed = mandateJsonSchema.safeParse(json);
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "mandate"}: ${i.message}`).join("; ") };
  return { mandate: mandateFromJson(parsed.data) };
}

/** Step 3: approve a mandate change with the agent's passkey and export the signed approval for `submit-approval`. */
export function ApproveChange({ enabled }: { enabled: boolean }) {
  const [agentText, setAgentText] = useState(String(deployment.demoAgents[0]));
  const [agent, setAgent] = useState<AgentState | null>(null);
  const [mandateText, setMandateText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);

  const agentId = /^(0|[1-9]\d{0,76})$/.test(agentText) ? BigInt(agentText) : null;
  const parsed = useMemo(() => (mandateText.trim() ? parseMandate(mandateText) : null), [mandateText]);
  const mandate = parsed && "mandate" in parsed ? parsed.mandate : null;
  const ruleProblems = mandate ? mandateRuleProblems(mandate, BigInt(Math.floor(Date.now() / 1000))) : [];

  async function load() {
    if (agentId === null) return;
    setBusy(true);
    setError(null);
    setApproval(null);
    try {
      setAgent(await readAgent(agentId));
    } catch (e) {
      setAgent(null);
      setError(`couldn't read agent ${agentId} from the chain: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
    // Read the default agent once at load; later reads are explicit.
  }, []);

  function presetE2e() {
    if (!agent) return;
    setApproval(null);
    setMandateText(prettyJson(mandateToJson(e2eMandate({ owner: agent.owner, demoPassThrough: deployment.demoPassThrough }))));
  }

  async function approve() {
    if (agentId === null || !mandate) return;
    setBusy(true);
    setError(null);
    setApproval(null);
    try {
      // Fresh reads right before signing: the nonce and passkey the approval binds.
      const state = await readAgent(agentId);
      setAgent(state);
      if (!state.passkey) throw new Error(`agent ${agentId} has no passkey yet: the owner runs set-passkey first`);
      const changeHash = mandateHash(mandate);
      const challenge = passkeyChallenge({ chainId, registry, agentId, changeHash, nonce: state.nonce });
      const onchain = await contractHashes(agentId, mandate, state.nonce);
      if (onchain.mandateHash !== changeHash || onchain.challenge !== challenge) {
        throw new Error("the registry computes a different hash or challenge than this page; not signing");
      }
      const { auth, credentialId } = await approveWithPasskey(challenge);
      const verdict = await verifyAssertionLocally({ auth, challenge, qx: state.passkey.qx, qy: state.passkey.qy, rpIdHash: RP_ID_HASH });
      if (!verdict.ok) throw new Error(`not exported: ${ASSERTION_PROBLEMS[verdict.problem]} (${verdict.problem})`);
      setApproval(buildApproval({ chainId, registry, agentId, mandate, nonce: state.nonce, passkey: { credentialId, ...state.passkey }, auth }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const labels = labelsFor(agent);
  return (
    <section>
      <h2>3 · Approve a mandate change</h2>
      <p className="muted">
        The passkey signs a challenge bound to this chain, this registry ({registry}), the agent, the exact mandate and the agent's nonce.
        The owner submits the signed approval; neither factor alone can change the mandate.
      </p>
      <label>
        Agent id
        <input value={agentText} onChange={(e) => setAgentText(e.target.value.trim())} inputMode="numeric" />
      </label>
      <div className="buttons">
        <button type="button" disabled={busy || agentId === null} onClick={load}>
          Read agent from chain
        </button>
        <button type="button" disabled={busy || !agent} onClick={presetE2e}>
          Preset: e2e mandate
        </button>
      </div>
      {agent && (
        <dl>
          <dt>Owner</dt>
          <dd><code>{agent.owner}</code></dd>
          <dt>Passkey</dt>
          <dd>{agent.passkey ? <code>{agent.passkey.qx}</code> : "none set (the owner runs set-passkey first)"}</dd>
          <dt>Nonce</dt>
          <dd>{agent.nonce.toString()} (read at block {agent.block.toString()})</dd>
          <dt>Current mandate</dt>
          <dd>
            {agent.mandate ? (
              <>
                <ul>{describeMandate(agent.mandate.mandate, labels).map((line) => <li key={line}>{line}</li>)}</ul>
                <code>{agent.mandate.hash}</code> (set at block {agent.mandate.setAtBlock.toString()})
              </>
            ) : (
              "none"
            )}
          </dd>
        </dl>
      )}
      <label>
        New mandate (JSON; use the preset or type it)
        <textarea value={mandateText} onChange={(e) => setMandateText(e.target.value)} rows={10} spellCheck={false} />
      </label>
      {parsed && "error" in parsed && <p className="error">Mandate: {parsed.error}</p>}
      {mandate && (
        <div className="summary">
          <h3>You are approving, for agent {agentId?.toString()}:</h3>
          <ul>{describeMandate(mandate, labels).map((line) => <li key={line}>{line}</li>)}</ul>
          <p className="muted">Mandate hash <code>{mandateHash(mandate)}</code>. Approving replaces the current mandate.</p>
          {ruleProblems.length > 0 && <p className="error">The registry would refuse this mandate: {ruleProblems.join(", ")}.</p>}
        </div>
      )}
      <button type="button" disabled={!enabled || busy || !mandate || !agent?.passkey || ruleProblems.length > 0} onClick={approve}>
        {busy ? "Working…" : "Approve with passkey"}
      </button>
      {error && <p className="error">{error}</p>}
      {approval && (
        <>
          <p className="ok">
            Signed and checked against agent {approval.agentId}'s onchain passkey (nonce {approval.nonce}). The owner submits it with{" "}
            <code>pnpm --filter @attest8004/scripts submit-approval &lt;file&gt;</code>.
          </p>
          <JsonExport label="approval" fileName={`attest8004-approval-agent${approval.agentId}-nonce${approval.nonce}.json`} value={approval} />
        </>
      )}
    </section>
  );
}
