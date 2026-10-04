# Attest8004 docs

The docs are part of the product (SPEC §4.10). Each file is added in the phase shown.

| Doc | What | Status |
|---|---|---|
| [deployments.md](./deployments.md) | Every deployment: chain, address, commit and date, and every recorded testnet run | live on testnet (ValidationRegistry, P1; AgentRequestForwarder, demo agents and the agent-1984 DemoAgentVault, P3; MandateRegistry, the per-agent forwarder approvals, agent 1984's mandate and the `mandate-v1` end-to-end run, P4; the P2 vault is superseded; P5 adds the two-validator vault, `DemoPassThrough`, and testnet preparation — funding and agent 1984's new mandate allowlisting `DemoPassThrough` — and the end-to-end run with both validators, `mandate-v1` and `risk-v1`; P6 adds MandateRegistry v2 (owner + passkey), the passkey run — agent 1984's passkey and two passkey-approved mandates, laptop Chrome and Android — and the e2e against v2) |
| [spec-notes.md](./spec-notes.md) | Differences between our ValidationRegistry and the EIP-8004 Draft | done (P1, checked 2 Oct 2026; P2 decisions 3 Oct) |
| [nansen.md](./nansen.md) | Every Nansen endpoint and data category used | done (P5, Task 9): the two tools are integrated and unused until `NANSEN_API_KEY` is set |
| `quickstart.md` | A 10-minute integration guide | planned (P11) |
| `api.md` | SDK and API reference | planned (P11) |
| `threat-model.md` | Threat model | planned (P11) |
| `trust-modes.md` | Deterministic vs agentic validation | planned (P11) |
| `migration.md` | Migrating to the canonical Validation Registry | planned (P11) |
| `btx.md` | BTX encrypted-mempool design note (**future work, not live**) | planned (P11) |
| `mera.md` | Passkey-derived findings inbox and the cross-device test | planned (P7) |
| `security-review.md` | Auditor self-review | planned (P10) |

How the system works is in [../ARCHITECTURE.md](../ARCHITECTURE.md). How to re-check a verdict (`pnpm attest8004 verify <requestHash>`: a `mandate-v1` one is re-run, a `risk-v1` one re-checked without re-running the model) is in its §5.5 and the [README](../README.md#quickstart).
