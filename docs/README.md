# Attest8004 docs

The docs are part of the product (SPEC §4.10). Each file is added in the phase shown.

| Doc | What | Status |
|---|---|---|
| [deployments.md](./deployments.md) | Every deployment: chain, address, commit and date, and every recorded testnet run | live on testnet (ValidationRegistry, P1; AgentRequestForwarder, demo agents and the agent-1984 DemoAgentVault, P3; MandateRegistry, the per-agent forwarder approvals, agent 1984's mandate and the `mandate-v1` end-to-end run, P4; the P2 vault is superseded; P5 adds the two-validator vault, `DemoPassThrough`, and testnet preparation — funding and agent 1984's new mandate allowlisting `DemoPassThrough` — and the end-to-end run with both validators, `mandate-v1` and `risk-v1`; P6 adds MandateRegistry v2 (owner + passkey), the passkey run — agent 1984's passkey and two passkey-approved mandates, laptop Chrome and Android — and the e2e against v2; P7 the inbox run; P8 the Envio indexer; P9 the live `pnpm demo` run and its reset proof; P11 `CreValidator` (validator C) and the live CRE runs) |
| [demo.md](./demo.md) | The demo (`pnpm demo`): recording setup, the 3-minute narration script with browser steps, the live run's real durations and where to cut, the reset between takes, what a take costs | done (P9) |
| [spec-notes.md](./spec-notes.md) | Differences between our ValidationRegistry and the EIP-8004 Draft | done (P1, checked 2 Oct 2026; P2 decisions 3 Oct) |
| [nansen.md](./nansen.md) | Every Nansen endpoint and data category used | done (P5, Task 9): the two tools are integrated and unused until `NANSEN_API_KEY` is set |
| `quickstart.md` | A 10-minute integration guide | planned (docs phase, after P12) |
| `api.md` | SDK and API reference | planned (docs phase, after P12) |
| [threat-model.md](./threat-model.md) | Threat model: assets, actors, trust boundaries, threats → mitigations → residual risk, and every open item (risk-v1's ERC-20 blind spot, MON-only caps, C on the mock forwarder, squatting, …) | done (P12) |
| `trust-modes.md` | Deterministic vs agentic validation | planned (docs phase, after P12) |
| `migration.md` | Migrating to the canonical Validation Registry | planned (docs phase, after P12) |
| `btx.md` | BTX encrypted-mempool design note (**future work, not live**) | planned (docs phase, after P12) |
| [mera.md](./mera.md) | The Mera findings inbox: why it is non-account use of Mera, the key lifecycle and zeroing, what's on chain, the cross-device test | done (P7); the cross-device results are added after the live run |
| [cre.md](./cre.md) | Validator C: Chainlink CRE as the orchestration layer of a `mandate-v1` verdict (the flow, why a deterministic validator fits CRE's consensus, the pin and the long-poll, the cross-checks, `CreValidator`, the trust model — a CRE workflow (simulation forwarder, not a trust root) — the limits, how to run `pnpm cre:demo`, the live runs, the production path, a 2-minute video script) | done (P11) |
| [integrations.md](./integrations.md) | Plug Attest8004 into any escrow with a verifier hook: the pattern, AgentPassport's JobEscrow v2 as the worked example, the fork tests that prove it against their live bytecode (not adoption by their team), the caveats and credits | done (P10) |
| [security-review.md](./security-review.md) | The independent security review of `32b55a1` (an AI-assisted self-review, not a professional audit): method, findings and their fixes, the Slither/Aderyn triage, coverage, gitleaks, the dependency audits and the live headers | done (P12) |

How the system works is in [../ARCHITECTURE.md](../ARCHITECTURE.md). How to re-check a verdict (`pnpm attest8004 verify <requestHash>`: a `mandate-v1` one is re-run, a `risk-v1` one re-checked without re-running the model) is in its §5.5 and the [README](../README.md#quickstart).
