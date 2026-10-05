import { getPasskeyPrfOutput } from "@category-labs/mera";
import {
  INBOX_PRF_SALT,
  REPORT_SEARCH_BLOCKS,
  RP_ID,
  findInboxEntries,
  isApproveHost,
  openInbox,
  viemInboxReader,
  withInboxKey,
  type FindingsPost,
  type InboxEntry,
  type InboxStatus,
  type OpenedReport,
} from "@attest8004/sdk/browser";
import { useState } from "react";
import { getAddress, hexToBytes, type Hex } from "viem";
import { chainId, client, deployment, readInboxKey } from "../approve/chain.ts";
import { errorText } from "../approve/exportJson.ts";
import { currentHostname, stripLinkParameters } from "../approve/url.ts";
import { ReportCard } from "./ReportCard.tsx";

const EXPLORER = "https://monad-testnet.socialscan.io";

/** Our validators by address, so a report says whose it is; any other validator is shown by address. */
const VALIDATOR_LABELS: Record<string, string> = {
  [getAddress(deployment.validators.mandateV1)]: "validator A (mandate-v1)",
  [getAddress(deployment.validators.riskV1)]: "validator B (risk-v1)",
};

interface Found {
  agentId: bigint;
  inboxKey: Hex;
  entries: InboxEntry[];
}

type Decrypted =
  | { ok: false; problem: "NO_INBOX_KEY" | "KEY_MISMATCH"; publicKey: Hex }
  | { ok: true; publicKey: Hex; reports: { post: FindingsPost; status: InboxStatus; opened: OpenedReport }[] };

/**
 * /inbox (SPEC §4.7): the agent's encrypted operator reports. "Find reports" makes public chain reads only (no
 * passkey) and keeps the posts the trust rule allows; "Decrypt with passkey" then derives the inbox key from the
 * passkey's PRF, opens every report and zeroes the key, so the private key exists only for the decryption itself.
 * Nothing is stored and nothing is read from the URL.
 */
export function InboxPage() {
  const [ignoredLinkParameters] = useState(stripLinkParameters);
  const enabled = isApproveHost(currentHostname());
  const [agentText, setAgentText] = useState(String(deployment.demoAgents[0]));
  const [found, setFound] = useState<Found | null>(null);
  const [decrypted, setDecrypted] = useState<Decrypted | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const board = deployment.findingsBoard;

  const agentId = /^(0|[1-9]\d{0,76})$/.test(agentText) ? BigInt(agentText) : null;
  const current = found !== null && found.agentId === agentId ? found : null;
  const postCount = current?.entries.reduce((n, e) => n + e.posts.length, 0) ?? 0;

  function changeAgent(text: string) {
    setAgentText(text);
    setFound(null);
    setDecrypted(null);
    setError(null);
  }

  async function find() {
    if (agentId === null || board === null) return;
    setBusy(true);
    setError(null);
    setDecrypted(null);
    setFound(null);
    try {
      const inboxKey = await readInboxKey(agentId);
      const reader = viemInboxReader({ publicClient: client, deployment });
      const entries = await findInboxEntries(reader, {
        agentId,
        findingsBoard: board,
        onProgress: (done, total) => setProgress(`Reading verdicts… ${done}/${total}`),
      });
      setFound({ agentId, inboxKey, entries });
    } catch (e) {
      setError(`couldn't read agent ${agentId}'s reports: ${errorText(e)}`);
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  async function decrypt() {
    if (!current || board === null) return;
    setBusy(true);
    setError(null);
    try {
      // The passkey prompt comes straight from the click; the key lives only inside withInboxKey, which zeroes it and
      // the PRF output (wiped again here whatever happens). Each decrypted plaintext is wiped once decoded.
      const { prfOutput } = await getPasskeyPrfOutput({ rpId: RP_ID, prfSalt: hexToBytes(INBOX_PRF_SALT) });
      try {
        const result: Decrypted = await withInboxKey(prfOutput, ({ privateKey, publicKey }) => ({
          ...openInbox({
            entries: current.entries,
            privateKey,
            publicKey,
            onchainInboxKey: current.inboxKey,
            chainId,
            findingsBoard: board.address,
            validationRegistry: deployment.validationRegistry,
          }),
          publicKey,
        }));
        setDecrypted(result);
      } finally {
        prfOutput.fill(0);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const opened = (post: FindingsPost) =>
    decrypted?.ok ? decrypted.reports.find((r) => r.post.txHash === post.txHash && r.post.logIndex === post.logIndex) : undefined;

  return (
    <main>
      <h1>Inbox</h1>
      <p className="lede">Validators' private operator reports, encrypted to a key only this agent's passkey can derive (Mera PRF).</p>
      {ignoredLinkParameters && <p className="notice">This page ignores link parameters: nothing in a link can choose an agent.</p>}
      {!enabled && (
        <p className="notice">
          Passkeys are bound to <strong>{RP_ID}</strong>. Open <a href={`https://${RP_ID}/inbox`}>https://{RP_ID}/inbox</a> to decrypt; finding
          reports works anywhere.
        </p>
      )}
      {board === null ? (
        <p className="notice">The FindingsBoard isn't deployed yet, so there are no reports to read.</p>
      ) : (
        <section>
          <h2>1 · Find the agent's reports</h2>
          <p className="muted">
            Public chain reads only: the agent's verdicts, then each verdict's encrypted report, kept only when the ValidationRegistry names its
            poster as that verdict's validator.
          </p>
          <label>
            Agent id
            <input value={agentText} onChange={(e) => changeAgent(e.target.value.trim())} inputMode="numeric" readOnly={busy} />
          </label>
          <button type="button" disabled={busy || agentId === null} onClick={find}>
            {busy && !current ? (progress ?? "Reading…") : "Find reports"}
          </button>
          {current && (
            <>
              <dl>
                <dt>Inbox key onchain</dt>
                <dd>{BigInt(current.inboxKey) === 0n ? "none set: publish one on /approve (section 4)" : <code>{current.inboxKey}</code>}</dd>
                <dt>Verdicts read</dt>
                <dd>
                  {current.entries.length}, with {postCount} encrypted report(s)
                </dd>
              </dl>
              <h2>2 · Decrypt with the passkey</h2>
              <button type="button" disabled={!enabled || busy || postCount === 0} onClick={decrypt}>
                {busy && current ? "Waiting for the passkey…" : "Decrypt with passkey"}
              </button>
              {decrypted && !decrypted.ok && (
                <p className="error">
                  {decrypted.problem === "NO_INBOX_KEY"
                    ? `Agent ${current.agentId} has no inbox key.`
                    : `This passkey derives ${decrypted.publicKey}, but agent ${current.agentId}'s inbox key is ${current.inboxKey}: pick the agent's passkey.`}
                </p>
              )}
              {decrypted?.ok && (
                <p className="ok">
                  This passkey derives <code>{decrypted.publicKey}</code>: agent {current.agentId.toString()}'s inbox key. Key zeroed.{" "}
                  <button type="button" onClick={() => setDecrypted(null)}>
                    Forget decrypted reports
                  </button>
                </p>
              )}
              <ul className="entries">
                {current.entries.map((entry) => (
                  <li key={entry.status.requestHash}>
                    <p>
                      <strong>{VALIDATOR_LABELS[getAddress(entry.status.validator)] ?? entry.status.validator}</strong>: {entry.status.tag || "no tag"}, score{" "}
                      {entry.status.response}
                    </p>
                    <p className="muted">
                      Request{" "}
                      {entry.responseTx ? (
                        <a href={`${EXPLORER}/tx/${entry.responseTx}`} target="_blank" rel="noopener noreferrer">
                          <code>{entry.status.requestHash}</code>
                        </a>
                      ) : (
                        <code>{entry.status.requestHash}</code>
                      )}{" "}
                      (public evidence; re-check it with <code>pnpm attest8004 verify {entry.status.requestHash}</code>)
                    </p>
                    {entry.posts.length === 0 && (
                      <p className="muted">No report found within {REPORT_SEARCH_BLOCKS.toString()} blocks of this verdict.</p>
                    )}
                    {entry.posts.map((post) => {
                      const report = opened(post);
                      return report ? (
                        <ReportCard key={`${post.txHash}-${post.logIndex}`} post={post} status={entry.status} opened={report.opened} />
                      ) : (
                        <p key={`${post.txHash}-${post.logIndex}`} className="muted">
                          Encrypted report found ({(post.envelope.length - 2) / 2} bytes, block {post.blockNumber.toString()}).
                        </p>
                      );
                    })}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {error && <p className="error">{error}</p>}
      <footer>
        <p className="muted">
          This page stores nothing and sends nothing but public chain reads. The inbox key is derived on demand from the passkey and zeroed after
          use. {board ? <>FindingsBoard <code>{board.address}</code> on Monad testnet. </> : null}Build <code>{__BUILD_SHA__}</code>.
        </p>
        <p className="muted">
          <a href="https://github.com/AmitChowdary122/attest8004#readme">Docs and quickstart</a>
        </p>
      </footer>
    </main>
  );
}
