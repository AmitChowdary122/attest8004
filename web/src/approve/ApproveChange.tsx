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
import { getAddress, type Hex } from "viem";
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
  SIGNATURE: "this passkey isn't the agent's passkey; sign again and pick the right one",
};

/** Everything a signature will bind, read fresh and cross-checked with the registry by "Prepare". */
interface Prepared {
  agentId: bigint;
  mandate: Mandate;
  changeHash: Hex;
  nonce: bigint;
  challenge: Hex;
  passkey: { qx: Hex; qy: Hex };
  block: bigint;
}

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

/**
 * Step 3: approve a mandate change with the agent's passkey and export the signed approval for `submit-approval`.
 * "Prepare" reads the agent fresh and cross-checks the hash and challenge with the registry; "Sign" then asks for the
 * passkey straight away. Changing the agent id or the mandate drops everything read, prepared or signed before.
 */
export function ApproveChange({ enabled }: { enabled: boolean }) {
  const [agentText, setAgentText] = useState(String(deployment.demoAgents[0]));
  const [agent, setAgent] = useState<AgentState | null>(null);
  const [mandateText, setMandateText] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const agentId = /^(0|[1-9]\d{0,76})$/.test(agentText) ? BigInt(agentText) : null;
  // Only the agent the id field names counts: a read for another id is never shown, labelled or signed for.
  const current = agent !== null && agent.agentId === agentId ? agent : null;
  const parsed = useMemo(() => (mandateText.trim() ? parseMandate(mandateText) : null), [mandateText]);
  const mandate = parsed && "mandate" in parsed ? parsed.mandate : null;
  const ruleProblems = mandate ? mandateRuleProblems(mandate, BigInt(Math.floor(Date.now() / 1000))) : [];
  const labels = labelsFor(current);

  function changeAgent(text: string) {
    setAgentText(text);
    setAgent(null);
    setPrepared(null);
    setApproval(null);
    setError(null);
  }

  function changeMandate(text: string) {
    setMandateText(text);
    setPrepared(null);
    setApproval(null);
    setError(null);
  }

  async function load() {
    if (agentId === null) return;
    setBusy(true);
    setError(null);
    setPrepared(null);
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
    if (!current) return;
    changeMandate(prettyJson(mandateToJson(e2eMandate({ owner: current.owner, demoPassThrough: deployment.demoPassThrough }))));
  }

  async function prepare() {
    if (agentId === null || !mandate) return;
    setBusy(true);
    setError(null);
    setPrepared(null);
    setApproval(null);
    try {
      const state = await readAgent(agentId);
      setAgent(state);
      if (!state.passkey) throw new Error(`agent ${agentId} has no passkey yet: the owner runs set-passkey first`);
      const changeHash = mandateHash(mandate);
      const challenge = passkeyChallenge({ chainId, registry, agentId, changeHash, nonce: state.nonce });
      const onchain = await contractHashes(agentId, mandate, state.nonce);
      if (onchain.mandateHash !== changeHash || onchain.challenge !== challenge) {
        throw new Error("the registry computes a different hash or challenge than this page; not signing");
      }
      setPrepared({ agentId, mandate, changeHash, nonce: state.nonce, challenge, passkey: state.passkey, block: state.block });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function sign() {
    if (!prepared) return;
    setBusy(true);
    setError(null);
    try {
      // The passkey prompt comes straight from the click: no network round trip before it.
      const { auth, credentialId } = await approveWithPasskey(prepared.challenge);
      const verdict = await verifyAssertionLocally({ auth, challenge: prepared.challenge, ...prepared.passkey, rpIdHash: RP_ID_HASH });
      if (!verdict.ok) throw new Error(`not exported: ${ASSERTION_PROBLEMS[verdict.problem]} (${verdict.problem})`);
      setApproval(
        buildApproval({
          chainId,
          registry,
          agentId: prepared.agentId,
          change: { kind: "setMandate", mandate: prepared.mandate },
          nonce: prepared.nonce,
          passkey: { credentialId, ...prepared.passkey },
          auth,
        }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>3 · Approve a mandate change</h2>
      <p className="muted">
        The passkey signs a challenge bound to this chain, this registry ({registry}), the agent, the exact mandate and the agent's nonce.
        The owner submits the signed approval; neither factor alone can change the mandate.
      </p>
      <label>
        Agent id
        <input value={agentText} onChange={(e) => changeAgent(e.target.value.trim())} inputMode="numeric" readOnly={busy} />
      </label>
      <div className="buttons">
        <button type="button" disabled={busy || agentId === null} onClick={load}>
          Read agent from chain
        </button>
        <button type="button" disabled={busy || !current} onClick={presetE2e}>
          Preset: e2e mandate
        </button>
      </div>
      {current && (
        <dl>
          <dt>Owner</dt>
          <dd><code>{current.owner}</code></dd>
          <dt>Passkey</dt>
          <dd>{current.passkey ? <code>{current.passkey.qx}</code> : "none set (the owner runs set-passkey first)"}</dd>
          <dt>Nonce</dt>
          <dd>{current.nonce.toString()} (read at block {current.block.toString()})</dd>
          <dt>Current mandate</dt>
          <dd>
            {current.mandate ? (
              <>
                <ul>{describeMandate(current.mandate.mandate, labels).map((line, i) => <li key={i}>{line}</li>)}</ul>
                <code>{current.mandate.hash}</code> (set at block {current.mandate.setAtBlock.toString()})
              </>
            ) : (
              "none"
            )}
          </dd>
        </dl>
      )}
      <label>
        New mandate (JSON; use the preset or type it)
        <textarea value={mandateText} onChange={(e) => changeMandate(e.target.value)} rows={10} spellCheck={false} readOnly={busy} />
      </label>
      {parsed && "error" in parsed && <p className="error">Mandate: {parsed.error}</p>}
      {mandate && agentId !== null && (
        <div className="summary">
          <h3>You are approving, for agent {agentId.toString()}:</h3>
          <ul>{describeMandate(mandate, labels).map((line, i) => <li key={i}>{line}</li>)}</ul>
          <p className="muted">Mandate hash <code>{mandateHash(mandate)}</code>. Approving replaces the current mandate.</p>
          {!current && <p className="muted">Read the agent from the chain to see its owner and current mandate before you approve.</p>}
          {ruleProblems.length > 0 && <p className="error">The registry would refuse this mandate: {ruleProblems.join(", ")}.</p>}
        </div>
      )}
      <button type="button" disabled={busy || !mandate || agentId === null || ruleProblems.length > 0} onClick={prepare}>
        {busy && !prepared ? "Working…" : "Prepare approval"}
      </button>
      {prepared && !approval && (
        <div className="summary">
          <p>
            Ready to sign for agent {prepared.agentId.toString()} at nonce {prepared.nonce.toString()} (read at block{" "}
            {prepared.block.toString()}); the registry agrees on the hash and the challenge <code>{prepared.challenge}</code>.
          </p>
          <button type="button" disabled={!enabled || busy} onClick={sign}>
            {busy ? "Waiting for the passkey…" : "Sign with passkey"}
          </button>
        </div>
      )}
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
