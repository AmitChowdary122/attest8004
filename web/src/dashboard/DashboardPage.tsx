import { TrustApiError, getTrustOverview, type TrustApiErrorKind, type TrustOverview } from "@attest8004/sdk/browser";
import { useCallback, useEffect, useState } from "react";
import { client, deployment } from "../approve/chain.ts";
import { stripLinkParameters } from "../approve/url.ts";
import { trustApiUrl } from "../trust-api-url.ts";
import { AgentLookup } from "./AgentLookup.tsx";
import { ValidatorTable } from "./ValidatorTable.tsx";
import { VerdictList } from "./VerdictList.tsx";
import { isOurs, offlineView } from "./view.ts";

type Filter = "all" | "mandate-v1" | "risk-v1" | "pending";
type State = { kind: "loading" } | { kind: "offline"; reason: TrustApiErrorKind } | { kind: "ready"; overview: TrustOverview; head: bigint | null };

/**
 * /dashboard (SPEC §4.9): requests, verdicts, validator stats and an agent trust lookup, read from the Envio indexer
 * (one GraphQL query per load, one per lookup; no polling). A convenience view, never a trust root: every verdict
 * carries its `pnpm attest8004 verify` line. Only real, indexed numbers; our own validators and agents are labelled.
 * Everything is shown as plain text; nothing is stored and nothing is read from the URL.
 */
export function DashboardPage() {
  const [ignoredLinkParameters] = useState(stripLinkParameters);
  const url = trustApiUrl();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    if (url === null) {
      setState({ kind: "offline", reason: "NOT_CONFIGURED" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const [overview, head] = await Promise.all([
        getTrustOverview({ url }),
        client.getBlockNumber().catch(() => null),
      ]);
      setState({ kind: "ready", overview, head });
    } catch (e) {
      setState({ kind: "offline", reason: e instanceof TrustApiError ? e.kind : "NETWORK" });
    }
  }, [url]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="wide">
      <h1>Dashboard</h1>
      <p className="lede">
        Validation requests, verdicts and validators on Monad testnet, read from the Envio indexer. A convenience view, not a trust root: re-check any
        verdict from the chain with its <code>pnpm attest8004 verify</code> line.
      </p>
      {ignoredLinkParameters && <p className="notice">This page ignores link parameters.</p>}
      {state.kind === "loading" && <p className="muted">Reading the indexer…</p>}
      {state.kind === "offline" && <OfflineState reason={state.reason} onRetry={url === null ? null : load} />}
      {state.kind === "ready" && <Overview overview={state.overview} head={state.head} filter={filter} setFilter={setFilter} onRefresh={load} url={url as string} />}
      <footer>
        <p className="muted">
          This page stores nothing and sends nothing but public chain reads and queries to the public Envio indexer. Build <code>{__BUILD_SHA__}</code>.
        </p>
        <p className="muted">
          <a href="https://github.com/AmitChowdary122/attest8004#readme">Docs and quickstart</a> · <a href="/inbox">Inbox</a> · <a href="/approve">Approve</a>
        </p>
      </footer>
    </main>
  );
}

function Overview(o: { overview: TrustOverview; head: bigint | null; filter: Filter; setFilter: (f: Filter) => void; onRefresh: () => void; url: string }) {
  const { overview, head, filter } = o;
  const shown =
    filter === "pending" ? overview.pending : filter === "all" ? [...overview.verdicts, ...overview.pending] : overview.verdicts.filter((v) => v.tag === filter);
  const ours = overview.agents.filter((a) => isOurs(a, deployment)).length;
  const lag = head !== null && head > overview.indexedTo ? head - overview.indexedTo : 0n;
  return (
    <>
      <p className="muted">
        Indexed to block {overview.indexedTo.toString()}
        {head !== null ? ` · chain head ${head.toString()} (${lag.toString()} blocks behind)` : ""} · {overview.agents.length}
        {overview.agentsTruncated ? "+" : ""} agent(s) seen, {ours} of them ours{" "}
        <button type="button" onClick={o.onRefresh}>
          Refresh
        </button>
      </p>
      <section>
        <h2>Recent verdicts</h2>
        <div className="buttons" role="group" aria-label="Filter verdicts">
          {(["all", "mandate-v1", "risk-v1", "pending"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} disabled={filter === f} onClick={() => o.setFilter(f)}>
              {f === "all" ? "All" : f === "pending" ? "Pending" : f}
            </button>
          ))}
        </div>
        <VerdictList verdicts={shown} deployment={deployment} empty="Nothing indexed here yet." />
      </section>
      <section>
        <h2>Validators</h2>
        <ValidatorTable validators={overview.validators} deployment={deployment} />
      </section>
      <section>
        <h2>Agent trust</h2>
        <p className="muted">Everything the indexer has on one agent: its verdicts by tag, mandate, keys, reports and permission changes.</p>
        <AgentLookup url={o.url} deployment={deployment} />
      </section>
    </>
  );
}

function OfflineState({ reason, onRetry }: { reason: TrustApiErrorKind; onRetry: (() => void) | null }) {
  const view = offlineView(deployment, reason);
  return (
    <section>
      <p className="notice">
        {view.reason}{" "}
        {onRetry && (
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        )}
      </p>
      <p>Every record lives onchain, and none of it depends on the indexer. Read the contracts directly:</p>
      <ul className="contracts">
        {view.contracts.map((c) => (
          <li key={c.label}>
            {c.label}:{" "}
            {c.url !== null ? (
              <a href={c.url} target="_blank" rel="noopener noreferrer">
                <code>{c.address}</code>
              </a>
            ) : (
              <code>{c.address}</code>
            )}
          </li>
        ))}
      </ul>
      <p>
        Check any verdict from the chain alone: <code>{view.verifyLine}</code> (in the repo; it needs no indexer and no keys).
      </p>
      <p>{view.inbox}</p>
    </section>
  );
}
