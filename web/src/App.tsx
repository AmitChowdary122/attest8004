import { ApprovePage } from "./approve/ApprovePage.tsx";
import { InboxPage } from "./inbox/InboxPage.tsx";

// The routes: /approve (P6) and /inbox (P7) are live; /dashboard (P8) is still to come.
const PAGES = [
  { path: "/approve", title: "Approve", body: "Create the agent's passkey and approve a mandate change.", live: true },
  { path: "/inbox", title: "Inbox", body: "Decrypt validators' private operator reports with your passkey.", live: true },
  { path: "/dashboard", title: "Dashboard", body: "Requests, verdicts, validator stats and agent trust.", live: false },
];

export function App() {
  if (window.location.pathname === "/approve") return <ApprovePage />;
  if (window.location.pathname === "/inbox") return <InboxPage />;
  return (
    <main>
      <h1>Attest8004</h1>
      <p className="lede">The ERC-8004 Validation layer for Monad. Work in progress.</p>
      <ul className="pages">
        {PAGES.map((p) => (
          <li key={p.path}>
            <code>{p.path}</code>
            {p.live ? (
              <a href={p.path}>
                <strong>{p.title}</strong>
              </a>
            ) : (
              <strong>{p.title}</strong>
            )}
            <span>{p.body}</span>
            {!p.live && <em>coming soon</em>}
          </li>
        ))}
      </ul>
    </main>
  );
}
