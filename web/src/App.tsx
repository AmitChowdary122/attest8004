// Placeholder shell. The pages land in P6 (/approve), P7 (/inbox) and P8 (/dashboard).
const PAGES = [
  { path: "/approve", title: "Approve", body: "Register a passkey and approve an agent mandate." },
  { path: "/inbox", title: "Inbox", body: "Decrypt private validator findings with your passkey." },
  { path: "/dashboard", title: "Dashboard", body: "Requests, verdicts, validator stats and agent trust." },
];

export function App() {
  return (
    <main>
      <h1>Attest8004</h1>
      <p className="lede">The ERC-8004 Validation layer for Monad. Work in progress.</p>
      <ul className="pages">
        {PAGES.map((p) => (
          <li key={p.path}>
            <code>{p.path}</code>
            <strong>{p.title}</strong>
            <span>{p.body}</span>
            <em>coming soon</em>
          </li>
        ))}
      </ul>
    </main>
  );
}
