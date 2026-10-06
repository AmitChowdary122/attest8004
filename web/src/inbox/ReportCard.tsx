import { reportText, type FindingsPost, type InboxStatus, type OpenedReport } from "@attest8004/sdk/browser";
import { tagText } from "./found.ts";

const PROBLEMS: Record<Exclude<OpenedReport, { ok: true }>["problem"], string> = {
  MALFORMED: "the envelope isn't a findings envelope",
  VERSION: "the envelope's version isn't one this page reads",
  RECIPIENT_MISMATCH: "the envelope isn't for this passkey's inbox key",
  LOW_ORDER_KEY: "the envelope's key exchange is invalid",
  DECRYPT_FAILED: "can't decrypt with this passkey's current inbox key (the key changed since, or the report is corrupt)",
  NOT_UTF8: "the decrypted report isn't text",
  NOT_JSON: "the decrypted report isn't JSON",
  SCHEMA: "the decrypted report isn't an attest8004.report.v1 document",
  REPORT_MISMATCH: "the decrypted report names another request, agent or validator tag than its post",
};

/**
 * One decrypted operator report. Every string in it is the validator's (and, for risk-v1's explanations, the
 * model's): it is shown as plain text only, never as HTML or a link, and through `reportText`, so bidi, invisible and
 * control characters can't reorder or hide what it says (P12, AUD-03).
 */
export function ReportCard({ post, status, opened }: { post: FindingsPost; status: InboxStatus; opened: OpenedReport }) {
  if (!opened.ok) {
    return (
      <div className="report">
        <p className="error">
          Report in block {post.blockNumber.toString()}: {PROBLEMS[opened.problem]} ({opened.problem}).
        </p>
      </div>
    );
  }
  const { report, matchesOnchain } = opened;
  return (
    <div className="report">
      <p className={matchesOnchain ? "ok" : "notice"}>
        {matchesOnchain
          ? `Matches the verdict onchain: ${tagText(status.tag)} scored ${status.response}.`
          : `This report is for an earlier response (score ${report.score}); the verdict onchain now is ${status.response}.`}
      </p>
      <p>
        <strong>{reportText(report.summary)}</strong>
      </p>
      {report.items.length > 0 && (
        <ul className="items">
          {report.items.map((item, i) => (
            <li key={i}>
              <span className="code">
                {item.severity ? `${item.severity} ` : ""}
                {item.code}
              </span>
              {" — "}
              {reportText(item.text)}
              <br />
              <span className="muted">→ {reportText(item.action)}</span>
            </li>
          ))}
        </ul>
      )}
      {report.notes.map((note, i) => (
        <p key={i} className="muted">
          {reportText(note)}
        </p>
      ))}
    </div>
  );
}
