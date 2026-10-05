import type { Deployment, IndexedVerdict } from "@attest8004/sdk/browser";
import { verdictRow } from "./view.ts";

/**
 * Requests and their latest verdicts, newest first. Everything shown is plain text from `verdictRow`; the only link
 * is the response transaction, built from checked hex.
 */
export function VerdictList({ verdicts, deployment, empty }: { verdicts: IndexedVerdict[]; deployment: Deployment; empty: string }) {
  if (verdicts.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="verdicts">
      {verdicts.map((v) => {
        const row = verdictRow(v, deployment);
        return (
          <li key={row.key}>
            <p>
              <strong className={row.pending ? "muted" : Number(row.score) >= 80 ? "ok" : "error"}>{row.score}</strong> <span className="tag">{row.tag}</span> · agent{" "}
              {row.agent} · {row.validator}
            </p>
            <p className="muted">
              {row.time}
              {row.pending ? " · requested, no verdict yet" : ` · ${row.evidence} · ${row.executed}`}
            </p>
            {!row.pending && <p>Reasons: {row.reasons}</p>}
            <p className="muted">
              {row.txUrl !== null ? (
                <a href={row.txUrl} target="_blank" rel="noopener noreferrer">
                  response transaction
                </a>
              ) : (
                "no response transaction yet"
              )}{" "}
              · re-check it yourself: <code>{row.verifyLine}</code>
            </p>
          </li>
        );
      })}
    </ul>
  );
}
