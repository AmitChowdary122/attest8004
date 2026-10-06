import { getPasskeyPrfOutput } from "@category-labs/mera";
import {
  INBOX_PRF_SALT,
  REPORT_SEARCH_BLOCKS,
  RP_ID,
  discoverInbox,
  isApproveHost,
  openInbox,
  viemInboxReader,
  withInboxKey,
  type FindingsPost,
  type InboxEntry,
  type InboxStatus,
  type OpenedReport,
  type RejectedPost,
} from "@attest8004/sdk/browser";
import { useState } from "react";
import { hexToBytes, type Hex } from "viem";
import { chainId, client, deployment, readInboxKey } from "../approve/chain.ts";
import { errorText } from "../approve/exportJson.ts";
import { currentHostname, stripLinkParameters } from "../approve/url.ts";
import { explorerTx } from "../explorer.ts";
import { foundSummary, KNOWN_VALIDATORS, splitEntries, tagText, validatorLabel } from "./found.ts";
import { trustApiOptions } from "../trust-api-url.ts";
import { ReportCard } from "./ReportCard.tsx";


interface Found {
  agentId: bigint;
  inboxKey: Hex;
  entries: InboxEntry[];
  /** How the reports were found: through the Envio indexer (each re-checked on chain) or on chain alone. */
  via: "indexer" | "chain";
  fallbackReason: string | null;
  indexedTo: bigint | null;
  /** Posts the indexer listed that the chain doesn't carry as listed. */
  rejected: RejectedPost[];
}

type Decrypted =
  | { ok: false; problem: "NO_INBOX_KEY" | "KEY_MISMATCH"; publicKey: Hex }
  | { ok: true; publicKey: Hex; reports: { post: FindingsPost; status: InboxStatus; opened: OpenedReport }[] };

/**
 * /inbox (SPEC §4.7): the agent's encrypted operator reports. "Find reports" (no passkey) reads the agent's verdicts
 * from the chain, finds their posts through the Envio indexer when one is recorded (else, or when it fails, on chain
 * within 600 blocks of each verdict), and keeps only posts the chain's status trusts and whose receipt carries them
 * exactly. Only public chain reads and one indexer query. "Decrypt with passkey" then derives the inbox key from the
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
  const split = splitEntries(current?.entries ?? []);

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
      const result = await discoverInbox(reader, {
        agentId,
        findingsBoard: board,
        knownValidators: KNOWN_VALIDATORS,
        trustApi: trustApiOptions(),
        onProgress: (done, total) => setProgress(`Reading verdicts… ${done}/${total}`),
      });
      setFound({ agentId, inboxKey, ...result });
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
            The agent's verdicts from the chain, then each verdict's encrypted report (found through the Envio indexer when it's available),
            kept only when the ValidationRegistry names its poster as that verdict's validator and its transaction carries it exactly.
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
                <dt>Found</dt>
                <dd>{foundSummary(current)}</dd>
              </dl>
              {current.rejected.length > 0 && (
                <p className="notice">
                  The indexer listed {current.rejected.length} report(s) that the chain doesn't carry as listed; they were dropped and aren't shown.
                </p>
              )}
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
                {split.known.map((entry) => (
                  <li key={entry.status.requestHash}>
                    <p>
                      <strong>{validatorLabel(entry.status.validator) ?? entry.status.validator}</strong>: {tagText(entry.status.tag)}, score{" "}
                      {entry.status.response}
                    </p>
                    <p className="muted">
                      Request{" "}
                      {explorerTx(entry.responseTx) ? (
                        <a href={explorerTx(entry.responseTx) ?? undefined} target="_blank" rel="noopener noreferrer">
                          <code>{entry.status.requestHash}</code>
                        </a>
                      ) : (
                        <code>{entry.status.requestHash}</code>
                      )}{" "}
                      (public evidence; re-check it with <code>pnpm attest8004 verify {entry.status.requestHash}</code>)
                    </p>
                    {entry.posts.length === 0 && (
                      <p className="muted">
                        {entry.source === "indexer"
                          ? `No report indexed for this verdict (indexed to block ${entry.searchedTo.toString()}).`
                          : `No report found on chain up to block ${entry.searchedTo.toString()} (within ${REPORT_SEARCH_BLOCKS.toString()} blocks of this verdict).`}
                      </p>
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
              {split.others.length > 0 && (
                <details className="other-validators">
                  <summary>
                    {split.others.length} verdict(s) from validators Attest8004 doesn't run (not validators A, B or C)
                  </summary>
                  <p className="notice">
                    Anyone holding this agent's hot key can name any address as its validator, answer as it, and post a
                    report this page can decrypt. These are shown apart and capped; don't act on them unless you know
                    who runs that validator.
                  </p>
                  <ul className="entries">
                    {split.others.map((entry) => (
                          <li key={entry.status.requestHash}>
                            <p>
                              <strong>{validatorLabel(entry.status.validator) ?? entry.status.validator}</strong>: {tagText(entry.status.tag)}, score{" "}
                          {entry.status.response}
                            </p>
                            <p className="muted">
                          Request{" "}
                          {explorerTx(entry.responseTx) ? (
                                <a href={explorerTx(entry.responseTx) ?? undefined} target="_blank" rel="noopener noreferrer">
                                  <code>{entry.status.requestHash}</code>
                                </a>
                          ) : (
                                <code>{entry.status.requestHash}</code>
                          )}{" "}
                          (public evidence; re-check it with <code>pnpm attest8004 verify {entry.status.requestHash}</code>)
                            </p>
                        {entry.posts.length === 0 && (
                              <p className="muted">
                            {entry.source === "indexer"
                              ? `No report indexed for this verdict (indexed to block ${entry.searchedTo.toString()}).`
                              : `No report found on chain up to block ${entry.searchedTo.toString()} (within ${REPORT_SEARCH_BLOCKS.toString()} blocks of this verdict).`}
                              </p>
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
                </details>
              )}
            </>
          )}
        </section>
      )}
      {error && <p className="error">{error}</p>}
      <footer>
        <p className="muted">
          This page stores nothing and sends nothing but public chain reads and one query to the public Envio indexer. The inbox key is derived on
          demand from the passkey and zeroed after use. {board ? <>FindingsBoard <code>{board.address}</code> on Monad testnet. </> : null}Build <code>{__BUILD_SHA__}</code>.
        </p>
        <p className="muted">
          <a href="https://github.com/AmitChowdary122/attest8004#readme">Docs and quickstart</a>
        </p>
      </footer>
    </main>
  );
}
