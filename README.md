# Attest8004

> **The missing ERC-8004 Validation layer for Monad.**
> Built for Monad Metropolis, Track 04 (Trust, Identity & AI Infrastructure).
> **Status: work in progress.** Nothing is deployed yet; see [STATUS.md](./STATUS.md).

## What

Before trusting an AI agent's action, any contract, app or x402 seller can ask: *did an independent validator check this exact action, and what was the verdict?*

Attest8004 provides that answer onchain. It has five parts:

- **ValidationRegistry**: implements the EIP-8004 validation interface and authorises requesters through the canonical ERC-8004 Identity Registry on Monad. It is spec-conformant but **not** the canonical deployment.
- **Passkey-approved mandates**: an agent's operator approves what the agent may do (targets, functions, spend caps, expiry) with a passkey, verified onchain by Monad's P256 precompile at `0x0100`.
- **Validator SDK** with two reference validators:
  - `mandate-v1`: deterministic, so anyone can re-run it and get the same verdict
  - `risk-qwen-v1`: agentic, using Qwen 3.8 Max with Nansen data
- **Private findings inbox**: detailed findings are encrypted to a key derived from the operator's passkey (Mera PRF). The key is never stored.
- **Trust API**: an Envio HyperIndex indexer behind the SDK and the dashboard.

Monad's ERC-8004 docs list the Validation Registry as "coming soon", and the canonical [`erc-8004-contracts`](https://github.com/erc-8004/erc-8004-contracts) repo has no Validation Registry deployed on any chain. Attest8004 fills that gap.

## Why Monad

- **Native P256 precompile (`0x0100`)**: passkey signatures are verified onchain for about 6,900 gas, so operators can approve mandates with a passkey (fingerprint or face unlock) on their laptop or phone.
- **Canonical ERC-8004 Identity and Reputation registries are already live on Monad.** Attest8004 completes the set rather than building a parallel identity system.
- **Sub-second finality and low fees** make validating every action practical: the request, the verdict and the gated execution fit inside an agent's normal latency budget.
- **The first users are already building here**: ERC-8004 agents, Monad's x402 facilitator and Mera passkeys.

## Architecture

The flow, in short:

1. An agent builds an `Action` and calls `validationRequest` on the **ValidationRegistry**. The request is bound by `requestHash` to one chain, one gate, one exact action and a deadline.
2. Validators pick up the `ValidationRequest` event, check the action against the operator's passkey-approved **mandate** (and, for `risk-qwen-v1`, against simulation, Nansen data and ERC-8004 reputation), then post `validationResponse` with a score and an evidence hash.
3. A consumer contract using **AttestGate** recomputes `requestHash` from the call. It executes only if a trusted validator's fresh verdict meets its minimum score, and each verdict can be used once.
4. Detailed findings go to the operator's encrypted inbox. Envio indexes everything for the trust API.

The diagrams, flows, data formats, trust model and key custody are in **[ARCHITECTURE.md](./ARCHITECTURE.md)**. Scope and acceptance criteria are in [SPEC.md](./SPEC.md).

| Path | What |
|---|---|
| [`contracts/`](./contracts) | Foundry: ValidationRegistry, MandateRegistry, AttestGate, DemoAgentVault |
| [`packages/sdk/`](./packages/sdk) | `@attest8004/sdk`: client, validator base, shared types, hash test vectors |
| [`validators/mandate/`](./validators/mandate) | `mandate-v1` deterministic validator |
| [`validators/qwen/`](./validators/qwen) | `risk-qwen-v1` agentic validator |
| [`indexer/`](./indexer) | Envio HyperIndex project |
| [`web/`](./web) | `/approve`, `/inbox`, `/dashboard` |
| [`docs/`](./docs) | Quickstart, API reference, threat model, deployments |

## Quickstart

> The 10-minute integration guide will be in `docs/quickstart.md` once the contracts are deployed. For now, this is the development setup.

**Prerequisites:** Node 22, pnpm (version pinned in `package.json`), [Foundry](https://getfoundry.sh), and [gitleaks](https://github.com/gitleaks/gitleaks).

```bash
git clone --recurse-submodules https://github.com/AmitChowdary122/attest8004.git
cd attest8004
pnpm install            # also enables the gitleaks pre-commit hook
cp .env.example .env    # fill in hackathon-only keys; never commit .env
pnpm test:contracts     # forge test
pnpm test               # TypeScript tests
```

## Deployments

Not deployed yet. Every deployment (chain, address, commit and date) will be recorded in [docs/deployments.md](./docs/deployments.md).

Canonical contracts this project builds on:

| Contract | Monad testnet (10143) | Monad mainnet (143) |
|---|---|---|
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| P256VERIFY precompile | `0x0100` | `0x0100` |

## Nansen endpoints

The `risk-qwen-v1` validator will use Nansen for counterparty profiles and fund flows. Each endpoint and data category will be listed here and in [docs/nansen.md](./docs/nansen.md) once integrated.

| Endpoint | Data category | Used for |
|---|---|---|
| *TBD* | | |

## Built with AI

This project is built with **Claude Code** (Anthropic; model Claude Opus 5.5) as a coding assistant. The developer writes the specification and architecture, reviews each change, and runs the tests. Claude Code writes much of the code, tests and docs under the rules in [CLAUDE.md](./CLAUDE.md). Commits it co-authored carry a `Co-Authored-By: Claude` trailer.

At runtime, `risk-qwen-v1` uses **Qwen 3.8 Max** (Alibaba Cloud Model Studio) for agentic risk assessment. Its output is treated as untrusted data and validated against a schema, and the model never holds or sees private keys.

## Credits and pre-existing code

**Pre-existing code:** none. Everything in this repository was written during the Metropolis build window (1 Sep to 13 Oct 2026); work on it started on 2 Oct 2026. Third-party libraries are used unmodified, as dependencies:

| Library | Licence | Used for |
|---|---|---|
| [forge-std](https://github.com/foundry-rs/forge-std) v1.17.0 | MIT / Apache-2.0 | Foundry testing |
| [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) v5.7.0 | MIT | Contract utilities (P256, WebAuthn) |
| [viem](https://viem.sh) | MIT | TypeScript EVM client |
| [zod](https://zod.dev) | MIT | Schema validation |
| [Vitest](https://vitest.dev) | MIT | TypeScript tests |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 | Language |
| [React](https://react.dev) | MIT | Web app |
| [Vite](https://vite.dev) | MIT | Web build |

This list grows as libraries are added (Envio, Mera, agent0 and others).

## License

[MIT](./LICENSE)
