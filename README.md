# Attest8004

> **The missing ERC-8004 Validation layer for Monad.**
> Built for Monad Metropolis, Track 04 (Trust, Identity & AI Infrastructure).
> **Status: work in progress.** On Monad testnet, the ValidationRegistry, the AgentRequestForwarder, the MandateRegistry and a demo AttestGate consumer (`DemoAgentVault`) are live. The deterministic validator **`mandate-v1`** runs end to end against them: it approved an action inside demo agent 1984's mandate, which executed, and scored 0 an action outside it, which the gate refuses (checked by simulation). Anyone can re-run those verdicts with `pnpm attest8004 verify <requestHash>` (see [Deployments](#deployments)). Mandates are set by the agent owner's wallet for now; passkey approval, the agentic validator `risk-qwen-v1`, the findings inbox and the indexer are being built. Progress is in [STATUS.md](./STATUS.md).

## What

Before trusting an AI agent's action, any contract, app or x402 seller can ask: *did an independent validator check this exact action, and what was the verdict?*

Attest8004 provides that answer onchain. It has five parts:

- **ValidationRegistry**: implements the EIP-8004 validation interface and authorises requesters through the canonical ERC-8004 Identity Registry on Monad. It is spec-conformant but **not** the canonical deployment.
- **Passkey-approved mandates**: an agent's operator approves what the agent may do (targets, functions, spend caps, expiry) with a passkey, verified onchain by Monad's P256 precompile at `0x0100`. Today the MandateRegistry takes the mandate from the owner's wallet; passkey approval replaces that in P6.
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

**Why a verdict is trust, not opinion: anyone can re-run `mandate-v1`.** It is deterministic. Every input (the
agent's mandate and owner, its approved spend in the last 25 h, recent permission changes, and a simulation of the
action) is read at one pinned block, and the verdict's clock is that block's time. Its evidence is public canonical
JSON, posted inline, and records that block. `pnpm attest8004 verify <requestHash>` re-runs the verdict from chain data
alone and must reproduce the same score and the same `responseHash`. The validator signed both, so a mismatch is public
proof that it misbehaved ([ARCHITECTURE §5.5](./ARCHITECTURE.md)). The agentic `risk-qwen-v1` (P5) will add advisory
context on top, and is never meant to be the only check.

The flow, in short:

1. An agent builds an `Action` and requests validation on the **ValidationRegistry**, once per validator. Each `requestHash` is bound to one chain, one gate, one validator, one exact action and a deadline. The agent's own hot key sends the request through the **AgentRequestForwarder**, which the agent's owner approved once: the key can request validations for its agent and do nothing else with it.
2. Validators pick up the `ValidationRequest` event (the SDK's validator base polls for it and verifies the request JSON against `requestHash`), check the action against the agent's **mandate** in the MandateRegistry (owner-set today, passkey-approved from P6) and recent permission changes (and, for `risk-qwen-v1`, against simulation, Nansen data and ERC-8004 reputation), then post `validationResponse` with a score and an evidence hash.
3. A consumer contract using **AttestGate** recomputes each required validator's `requestHash` from the call. It executes only if every one of those verdicts names the right agent and meets its minimum score, and each action runs once.
4. Detailed findings go to the operator's encrypted inbox. Envio indexes everything for the trust API.

The diagrams, flows, data formats, trust model and key custody are in **[ARCHITECTURE.md](./ARCHITECTURE.md)**. Scope and acceptance criteria are in [SPEC.md](./SPEC.md).

| Path | What |
|---|---|
| [`contracts/`](./contracts) | Foundry: ValidationRegistry, AgentRequestForwarder, MandateRegistry, AttestGate, DemoAgentVault |
| [`packages/sdk/`](./packages/sdk) | `@attest8004/sdk`: client, validator base, shared types, hash test vectors |
| [`validators/mandate/`](./validators/mandate) | `mandate-v1` deterministic validator: the service and the `verify` CLI |
| [`validators/qwen/`](./validators/qwen) | `risk-qwen-v1` agentic validator (P5) |
| [`indexer/`](./indexer) | Envio HyperIndex project |
| [`web/`](./web) | `/approve`, `/inbox`, `/dashboard` |
| [`scripts/`](./scripts) | `@attest8004/scripts`: operational scripts (testnet round trip, demo agents, end to end) |
| [`docs/`](./docs) | Quickstart, API reference, threat model, deployments |

## Quickstart

> The 10-minute integration guide will be in `docs/quickstart.md` once the contracts are deployed. For now, this is the development setup.

**Prerequisites:** Node 22.18 or later in the 22.x line (the scripts and `verify` run TypeScript source through Node's
type stripping, on by default from 22.18), pnpm (version pinned in `package.json`), [Foundry](https://getfoundry.sh), and [gitleaks](https://github.com/gitleaks/gitleaks).

```bash
git clone --recurse-submodules https://github.com/AmitChowdary122/attest8004.git
cd attest8004
pnpm install            # also enables the gitleaks pre-commit hook
cp .env.example .env    # fill in hackathon-only keys; never commit .env
pnpm test:contracts     # forge test (fork tests skip unless MONAD_TESTNET_RPC_URL is set)
pnpm test               # TypeScript tests
```

Re-run any `mandate-v1` verdict from chain data alone. It is read-only, and uses the public testnet RPC unless
`MONAD_TESTNET_RPC_URL` names another. pnpm echoes its arguments, so pass a URL with an API key through that variable
(or `.env`), not `--rpc-url`, or run `pnpm --loglevel silent attest8004 verify …` ([ARCHITECTURE §5.5](./ARCHITECTURE.md)):

```bash
pnpm attest8004 verify <requestHash>   # exit 0 match, 1 mismatch, 2 could not verify; --json prints the report
MONAD_TESTNET_RPC_URL=<archive-rpc-url> pnpm attest8004 verify <requestHash>   # pins older than ~51 days
```

Run the fork tests against the live testnet Identity Registry, and a full validation round trip on testnet (it needs
`DEPLOYER_PRIVATE_KEY` and `VALIDATOR_A_PRIVATE_KEY` in `.env`, funded with testnet MON):

```bash
cd contracts && MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz forge test --match-path 'test/fork/*' && cd ..
pnpm --filter @attest8004/scripts roundtrip   # register agent -> validationRequest -> validationResponse
```

The end-to-end path is scripted too. These scripts act as our demo agents, so they only run with our deployer's,
validator A's and the demo agents' keys; they show how the recorded testnet runs were made. The e2e runs validator A
as `mandate-v1`. Agent 1984's hot key requests two actions: one inside the agent's mandate, which scores 100 and
executes, and one outside it (an unlisted target, over the per-tx cap), which scores 0 and the gate refuses. The
script then re-runs both verdicts with `verify` and checks that each matches. Anyone can do the same for a recorded
verdict with `pnpm attest8004 verify <requestHash>` (above).

```bash
pnpm --filter @attest8004/scripts hot-keys                     # one hot key per demo agent into .env; prints addresses only
pnpm --filter @attest8004/scripts setup-demo-agents            # register agents, approve the forwarder per agent, set each agent's key
pnpm --filter @attest8004/scripts setup-demo-agents -- --fund  # top each hot key up to four requests
pnpm --filter @attest8004/scripts setup-demo-agents -- --fund-validator  # top validator A up to 2 MON
pnpm --filter @attest8004/scripts set-mandate                  # agent 1984's e2e mandate (owner-set until P6's passkeys)
pnpm --filter @attest8004/scripts set-mandate -- --force       # set the same mandate again: a new MandateSet baseline
pnpm --filter @attest8004/scripts e2e                          # hot key -> forwarder -> mandate-v1 -> gated execute; verify both
pnpm --filter @attest8004/scripts gated-execute                # P2: the superseded agent-1982 vault, owner requests directly
```

The e2e runs the validator in-process. To run validator A as a long-lived `mandate-v1` service instead (it needs
`VALIDATOR_A_PRIVATE_KEY` and `MONAD_TESTNET_RPC_URL`; the optional `MANDATE_V1_*` settings are in `.env.example`):

```bash
pnpm --filter @attest8004/validator-mandate start   # polls until Ctrl-C; JSON-line logs, never the key or the RPC URL
```

Run one process per validator key: the pinned block relies on knowing that key's last response. It answers only its
allowlisted (gate, agent) pairs (by default the demo vault with agent 1984, the one agent it is bound to) and agents
with an unexpired mandate set by their current owner, with a per-agent rate limit and a validator-wide daily gas
budget; a restart resets both.

## Deployments

| Chain | Contract | Address |
|---|---|---|
| Monad testnet (10143) | `ValidationRegistry` (spec-conformant, **not canonical**) | [`0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f`](https://monad-testnet.socialscan.io/address/0xc4a4d0ceb3971cbe7a2536494ac106f2cd9f9a8f) |
| Monad testnet (10143) | `AgentRequestForwarder` (agent hot keys request through it) | [`0x1451F3C36545b191d3642f759D59f21DcFD657B2`](https://monad-testnet.socialscan.io/address/0x1451f3c36545b191d3642f759d59f21dcfd657b2) |
| Monad testnet (10143) | `MandateRegistry` (per-agent spending mandates; owner-set until P6) | [`0x2523197373ef813E19b5b14Ef2984130868cD17c`](https://monad-testnet.socialscan.io/address/0x2523197373ef813e19b5b14ef2984130868cd17c) |
| Monad testnet (10143) | `DemoAgentVault` (AttestGate demo, demo agent 1984, requires validator A) | [`0x23BfBD12545CCd1501ddA1B65a54518FD6212a96`](https://monad-testnet.socialscan.io/address/0x23bfbd12545ccd1501dda1b65a54518fd6212a96) |
| Monad testnet (10143) | `DemoAgentVault`, P2, agent 1982 (**superseded**) | [`0x7A5EC388CCbfD3B255CFa94fc2062c0807F2C4CD`](https://monad-testnet.socialscan.io/address/0x7a5ec388ccbfd3b255cfa94fc2062c0807f2c4cd) |

Registry deploy tx [`0x724f31e0…cf64d03`](https://monad-testnet.socialscan.io/tx/0x724f31e0efd09993f2d73581cb742e71d4bef52c0f4f2a30cccd43d79cf64d03). A scripted register → request → response round trip on this registry (agentId 1982), a validated execute through the P2 vault ([`0x59d5987e…71e3f85`](https://monad-testnet.socialscan.io/tx/0x59d5987e1d2583def79af6af40efd60daf0fa88cc7553d6f3b31a0eab71e3f85)), the demo agents 1984 and 1985 with their hot keys, the switch to per-agent forwarder approvals with agent 1984's mandate, the P3 end-to-end run (hot key → forwarder → validator → execute, [`0x6f694020…bb1336a8`](https://monad-testnet.socialscan.io/tx/0x6f6940203907d8d759e1887953d1170015be7f0c6d27b39c4e22090bbb1336a8)), and the P4 run with `mandate-v1` (one action inside agent 1984's mandate executed, [`0xb666247e…60c84f9`](https://monad-testnet.socialscan.io/tx/0xb666247e2ac448a233c1bac336c19d65373aa908a2656b2f6e999408f60c84f9); one outside it scored 0 and refused; both re-checked with `verify`) are recorded with their transaction hashes in [docs/deployments.md](./docs/deployments.md). That file records every deployment with its chain, address, commit and date. Differences from the EIP-8004 Draft are in [docs/spec-notes.md](./docs/spec-notes.md).

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
| [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) v5.7.0 | MIT | `ReentrancyGuardTransient` in AttestGate; `P256` in a toolchain test; ERC721 in a test mock; its WebAuthn library is planned for P6's passkey mandates |
| [viem](https://viem.sh) | MIT | TypeScript EVM client |
| [zod](https://zod.dev) | MIT | Schema validation |
| [Vitest](https://vitest.dev) | MIT | TypeScript tests |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 | Language |
| [React](https://react.dev) | MIT | Web app |
| [Vite](https://vite.dev) | MIT | Web build |

**Standards and reference code:**

- `contracts/src/interfaces/IValidationRegistry.sol` copies the function and event signatures from the [EIP-8004](https://eips.ethereum.org/EIPS/eip-8004) text (CC0).
- `ValidationRegistry` was written for this project. Its behaviour deliberately matches the reference [`erc-8004/erc-8004-contracts`](https://github.com/erc-8004/erc-8004-contracts) `ValidationRegistryUpgradeable` (MIT), but no code was copied from it. The differences are in [docs/spec-notes.md](./docs/spec-notes.md).
- The expected values in the shared hash vectors (`packages/sdk/test/vectors.json`) are generated with Foundry's `cast`.
- Deployment goes through the widely used deterministic deployment proxy at `0x4e59b44847b379578588920cA78FbF26c0B4956C` (Arachnid); it is called onchain, and none of its code is included here.

The demo agents are registered by calling the Identity Registry's `register(string)` directly; the [agent0 SDK](https://sdk.ag0.xyz) was not used, because its latest release (1.7.1) has no defaults for Monad. This list grows as libraries are added (Envio, Mera and others).

## License

[MIT](./LICENSE)
