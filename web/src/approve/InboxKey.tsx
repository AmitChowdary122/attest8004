import { getPasskeyPrfOutput } from "@category-labs/mera";
import {
  INBOX_PRF_SALT,
  RP_ID,
  RP_ID_HASH,
  buildApproval,
  describeInboxKeyChange,
  inboxKeyChangeHash,
  inboxPublicKeyFromPrf,
  passkeyChallenge,
  verifyAssertionLocally,
  type Approval,
} from "@attest8004/sdk/browser";
import { useState } from "react";
import { hexToBytes, type Hex } from "viem";
import { approveWithPasskey } from "./ceremonies.ts";
import { chainId, contractChallenge, deployment, readAgent, registry, type AgentState } from "./chain.ts";
import { errorText } from "./exportJson.ts";
import { JsonExport } from "./JsonExport.tsx";

const ZERO: Hex = `0x${"00".repeat(32)}`;
const isZero = (key: Hex) => BigInt(key) === 0n;
const same = (a: Hex, b: Hex) => a.toLowerCase() === b.toLowerCase();

/** The inbox key derived in step a: public data only (the PRF output and the private key are already zeroed). */
interface Derived {
  credentialId: string;
  publicKey: Hex;
}

/** Everything step c's signature binds, read fresh and cross-checked with the registry by "Prepare". */
interface Prepared {
  agentId: bigint;
  x25519Pub: Hex;
  changeHash: Hex;
  nonce: bigint;
  challenge: Hex;
  passkey: { qx: Hex; qy: Hex };
  currentInboxKey: Hex;
  block: bigint;
}

/**
 * Step 4: publish the agent's inbox key (SPEC §4.7), in two ceremonies, because Mera evaluates one salt per ceremony:
 * (a) a Mera PRF ceremony derives the X25519 key and shows its public half, zeroing the PRF output and the private key
 * before it returns; (b) an assertion over `setInboxKey`'s challenge, restricted to the credential (a) used and
 * verified against the agent's onchain passkey, so the key provably comes from the agent's own passkey. The owner then
 * submits the approval. Changing the agent drops everything read, derived, prepared or signed before.
 */
export function InboxKey({ enabled }: { enabled: boolean }) {
  const [agentText, setAgentText] = useState(String(deployment.demoAgents[0]));
  const [agent, setAgent] = useState<AgentState | null>(null);
  const [derived, setDerived] = useState<Derived | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const agentId = /^(0|[1-9]\d{0,76})$/.test(agentText) ? BigInt(agentText) : null;
  const current = agent !== null && agent.agentId === agentId ? agent : null;
  const alreadySet = current !== null && derived !== null && same(current.inboxKey, derived.publicKey);

  function changeAgent(text: string) {
    setAgentText(text);
    setAgent(null);
    setDerived(null);
    setPrepared(null);
    setApproval(null);
    setError(null);
  }

  async function run(step: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const load = () =>
    run(async () => {
      if (agentId === null) return;
      setPrepared(null);
      setApproval(null);
      setAgent(await readAgent(agentId));
    });

  const derive = () =>
    run(async () => {
      setPrepared(null);
      setApproval(null);
      // The passkey prompt comes straight from the click. The PRF output is wiped by inboxPublicKeyFromPrf (with the
      // private key), and again here whatever happens; only the credential id and the public key are kept.
      const { credentialId, prfOutput } = await getPasskeyPrfOutput({ rpId: RP_ID, prfSalt: hexToBytes(INBOX_PRF_SALT) });
      try {
        setDerived({ credentialId, publicKey: inboxPublicKeyFromPrf(prfOutput) });
      } finally {
        prfOutput.fill(0);
      }
    });

  const prepare = () =>
    run(async () => {
      if (agentId === null || derived === null) return;
      setPrepared(null);
      setApproval(null);
      const state = await readAgent(agentId);
      setAgent(state);
      if (!state.passkey) throw new Error(`agent ${agentId} has no passkey yet: the owner runs set-passkey first`);
      if (same(state.inboxKey, derived.publicKey)) throw new Error(`agent ${agentId}'s inbox key is already this key: nothing to sign`);
      const changeHash = inboxKeyChangeHash(derived.publicKey);
      const challenge = passkeyChallenge({ chainId, registry, agentId, changeHash, nonce: state.nonce });
      if (!same(await contractChallenge(agentId, changeHash, state.nonce), challenge)) {
        throw new Error("the registry computes a different challenge than this page; not signing");
      }
      setPrepared({
        agentId,
        x25519Pub: derived.publicKey,
        changeHash,
        nonce: state.nonce,
        challenge,
        passkey: state.passkey,
        currentInboxKey: state.inboxKey,
        block: state.block,
      });
    });

  const sign = () =>
    run(async () => {
      if (!prepared || !derived) return;
      // Only the passkey that derived the key may sign; then it must verify against the agent's onchain key.
      const { auth, credentialId } = await approveWithPasskey(prepared.challenge, { credentialId: derived.credentialId });
      const verdict = await verifyAssertionLocally({ auth, challenge: prepared.challenge, ...prepared.passkey, rpIdHash: RP_ID_HASH });
      if (!verdict.ok) {
        throw new Error(`not exported: the passkey that derived this key isn't agent ${prepared.agentId}'s passkey (${verdict.problem})`);
      }
      setApproval(
        buildApproval({
          chainId,
          registry,
          agentId: prepared.agentId,
          change: { kind: "setInboxKey", x25519Pub: prepared.x25519Pub },
          nonce: prepared.nonce,
          passkey: { credentialId, ...prepared.passkey },
          auth,
        }),
      );
    });

  return (
    <section>
      <h2>4 · Publish the inbox key (Mera)</h2>
      <p className="muted">
        Validators encrypt operator reports to an X25519 key derived from this passkey's PRF (salt <code>sha256("attest8004.inbox.v1")</code>
        ). Only its public half leaves this page. The owner publishes it with the same two factors as a mandate change, then reads the reports
        on <a href="/inbox">/inbox</a>, on any device with this passkey.
      </p>
      <label>
        Agent id
        <input value={agentText} onChange={(e) => changeAgent(e.target.value.trim())} inputMode="numeric" readOnly={busy} />
      </label>
      <div className="buttons">
        <button type="button" disabled={busy || agentId === null} onClick={load}>
          Read agent from chain
        </button>
        <button type="button" disabled={!enabled || busy} onClick={derive}>
          {busy && !derived ? "Waiting for the passkey…" : "a · Derive inbox key"}
        </button>
      </div>
      {current && (
        <dl>
          <dt>Owner</dt>
          <dd><code>{current.owner}</code></dd>
          <dt>Inbox key now</dt>
          <dd>{isZero(current.inboxKey) ? "none set" : <code>{current.inboxKey}</code>}</dd>
          <dt>Nonce</dt>
          <dd>{current.nonce.toString()} (read at block {current.block.toString()})</dd>
        </dl>
      )}
      {derived && (
        <dl>
          <dt>Credential id</dt>
          <dd><code>{derived.credentialId}</code></dd>
          <dt>Derived inbox key</dt>
          <dd><code className="fingerprint">{derived.publicKey}</code></dd>
        </dl>
      )}
      {alreadySet && <p className="ok">This is already agent {agentText}'s inbox key: nothing to sign.</p>}
      {derived && agentId !== null && !alreadySet && (
        <div className="summary">
          <h3>You are approving, for agent {agentId.toString()}:</h3>
          <ul>{describeInboxKeyChange(derived.publicKey, current?.inboxKey ?? ZERO).map((line, i) => <li key={i}>{line}</li>)}</ul>
          {!current && <p className="muted">Read the agent from the chain to see its current inbox key before you approve.</p>}
          <button type="button" disabled={busy} onClick={prepare}>
            {busy && !prepared ? "Working…" : "b · Prepare approval"}
          </button>
        </div>
      )}
      {prepared && !approval && (
        <div className="summary">
          <p>
            Ready to sign for agent {prepared.agentId.toString()} at nonce {prepared.nonce.toString()} (read at block {prepared.block.toString()}); the
            registry agrees on the challenge <code>{prepared.challenge}</code>. Only the passkey that derived the key is offered.
          </p>
          <button type="button" disabled={!enabled || busy} onClick={sign}>
            {busy ? "Waiting for the passkey…" : "c · Sign with passkey"}
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
          <JsonExport label="approval" fileName={`attest8004-inbox-approval-agent${approval.agentId}-nonce${approval.nonce}.json`} value={approval} />
        </>
      )}
    </section>
  );
}
