import type { Deployment, ValidatorStats } from "@attest8004/sdk/browser";
import { validatorRow } from "./view.ts";

/** Each validator's indexed stats: buckets and the average over each answered request's latest score. */
export function ValidatorTable({ validators, deployment }: { validators: ValidatorStats[]; deployment: Deployment }) {
  if (validators.length === 0) return <p className="muted">No validator has been asked for a validation yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Validator</th>
            <th>Tags</th>
            <th>Requests</th>
            <th>Answered</th>
            <th>Avg score</th>
            <th title="latest score of each answered request">0 / 1–39 / 40–79 / 80–99 / 100</th>
            <th>Avg time to answer</th>
          </tr>
        </thead>
        <tbody>
          {validators.map((v) => {
            const row = validatorRow(v, deployment);
            return (
              <tr key={row.address}>
                <td>
                  {row.addressUrl !== null ? (
                    <a href={row.addressUrl} target="_blank" rel="noopener noreferrer">
                      {row.validator}
                    </a>
                  ) : (
                    row.validator
                  )}
                </td>
                <td>{row.tags}</td>
                <td>{row.requests}</td>
                <td>{row.answered}</td>
                <td>{row.avgScore}</td>
                <td>{row.buckets.join(" / ")}</td>
                <td>{row.avgLatency}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
