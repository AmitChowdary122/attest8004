# Attest8004

> **The missing ERC-8004 Validation layer for Monad.**
> Built for Monad Metropolis, Track 04 (Trust, Identity & AI Infrastructure).
> **Status: work in progress.** On Monad testnet, the ValidationRegistry, the AgentRequestForwarder, the MandateRegistry, a two-validator demo AttestGate consumer (`DemoAgentVault`, requiring both `mandate-v1` and `risk-v1`) and a demo "risky but mandated" target (`DemoPassThrough`) are live. **Both validators have run end to end on testnet** (4 Oct 2026), the deterministic **`mandate-v1`** and the agentic **`risk-v1`**:
> - Demo agent 1984's safe payment got 100 from both and executed.
> - A payment to `DemoPassThrough`, which the mandate allows, got 100 from `mandate-v1` but 0 from `risk-v1`, so the gate refuses it. `risk-v1` found a high `FUNDS_FORWARDED`: the contract forwards the payment to an address nobody controls.
> - An action outside the mandate got 0 from `mandate-v1` and is refused there.
>
> The refusals were checked by simulation. Anyone can re-check all six verdicts with `pnpm attest8004 verify <requestHash>` (see [Deployments](#deployments)). `mandate-v1` is re-run in full. For `risk-v1`, the onchain facts and the scoring are re-checked, but the model output is recorded, not re-run.
>
> **Passkey-approved mandates are live (5 Oct 2026).** MandateRegistry v2 accepts a mandate change only with the owner's transaction **and** an assertion from the agent's passkey, verified onchain by Monad's P256 precompile (`0x0100`; the 6,900-gas call shows in the transaction's trace). One Google Password Manager passkey, created on [`/approve`](https://attest8004.vercel.app/approve), approved agent 1984's mandate from laptop Chrome and again, synced, from Chrome on Android; both real assertions are test vectors. The same three-action e2e then passed against v2 (`e2e OK`, all six verdicts `match`), and the P4/P5 verdicts still verify. **The Mera findings inbox is built (P7) and goes live with its board's deployment:** validators post an encrypted operator report after each verdict to a new `FindingsBoard`, sealed to an X25519 key derived from the agent's passkey through Mera's PRF, and [`/inbox`](https://attest8004.vercel.app/inbox) decrypts them on any device with that passkey ([docs/mera.md](./docs/mera.md)). The indexer is next. Progress is in [STATUS.md](./STATUS.md).

## What

Before trusting an AI agent's action, any contract, app or x402 seller can ask: *did an independent validator check this exact action, and what was the verdict?*

Attest8004 provides that answer onchain. It has five parts:

- **ValidationRegistry**: implements the EIP-8004 validation interface and authorises requesters through the canonical ERC-8004 Identity Registry on Monad. It is spec-conformant but **not** the canonical deployment.
- **Passkey-approved mandates**: an agent's operator approves what the agent may do (targets, functions, spend caps, expiry) with a passkey, verified onchain by Monad's P256 precompile at `0x0100`. Since P6 (MandateRegistry v2, live on testnet) every mandate change needs two factors: the owner's transaction and an assertion from the agent's passkey.
- **Validator SDK** with two reference validators:
  - `mandate-v1`: deterministic, so anyone can re-run it and get the same verdict
  - `risk-v1`: agentic, an LLM with read-only onchain tools and Nansen (unused until a key is set). It has posted
    live verdicts on testnet, and its tests replay recorded Groq runs offline
    ([`validators/risk/test/fixtures/llm/`](./validators/risk/test/fixtures/llm/))
- **Private findings inbox (Mera)**: after each verdict, each validator posts an operator report (its reasons, the agent's spend, each finding with a recommended action) to `FindingsBoard`, encrypted to an X25519 key derived from the operator's passkey through Mera's PRF. The key is derived on demand, never stored, and zeroed after use; any device with the same synced passkey derives the same key (the PRF fingerprints matched on laptop and Android in P6; the cross-device decrypt is P7's live run, [docs/mera.md](./docs/mera.md)). The public evidence stays public, for `verify`.
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
proof that it misbehaved ([ARCHITECTURE §5.5](./ARCHITECTURE.md)). The agentic `risk-v1` (P5) adds advisory context
on top, and is never meant to be the only check. The same command re-checks a `risk-v1` verdict without re-running the
model. It proves three things: the score follows from the recorded findings; every onchain fact shown to the model was
true at the pinned block; and the injection rule was applied. It does **not** prove that the recorded output came from
the model, so trusting `risk-v1` means trusting validator B's operator. That is why the gate also requires `mandate-v1`,
which anyone can fully reproduce.

The flow, in short:

1. An agent builds an `Action` and requests validation on the **ValidationRegistry**, once per validator. Each `requestHash` is bound to one chain, one gate, one validator, one exact action and a deadline. The agent's own hot key sends the request through the **AgentRequestForwarder**, which the agent's owner approved once: the key can request validations for its agent and do nothing else with it.
2. Validators pick up the `ValidationRequest` event (the SDK's validator base polls for it and verifies the request JSON against `requestHash`), check the action against the agent's **mandate** in the MandateRegistry (owner + passkey since P6) and recent permission changes (and, for `risk-v1`, against simulation, Nansen data and ERC-8004 reputation), then post `validationResponse` with a score and an evidence hash.
3. A consumer contract using **AttestGate** recomputes each required validator's `requestHash` from the call. It executes only if every one of those verdicts names the right agent and meets its minimum score, and each action runs once.
4. Detailed findings go to the operator's encrypted inbox. Envio indexes everything for the trust API.

The diagrams, flows, data formats, trust model and key custody are in **[ARCHITECTURE.md](./ARCHITECTURE.md)**. Scope and acceptance criteria are in [SPEC.md](./SPEC.md).

| Path | What |
|---|---|
| [`contracts/`](./contracts) | Foundry: ValidationRegistry, AgentRequestForwarder, MandateRegistry, AttestGate, DemoAgentVault |
| [`packages/sdk/`](./packages/sdk) | `@attest8004/sdk`: client, validator base, shared types, hash test vectors |
| [`packages/cli/`](./packages/cli) | `@attest8004/cli`: `pnpm attest8004 verify`, which re-checks `mandate-v1` and `risk-v1` verdicts |
| [`validators/mandate/`](./validators/mandate) | `mandate-v1` deterministic validator: the service and its re-run (`verifyRequest`) |
| [`validators/risk/`](./validators/risk) | `risk-v1` agentic validator (P5) and its re-check (`verifyRiskRequest`) |
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

Re-check any verdict from chain data alone. `verify` reads the response's tag: it re-runs a `mandate-v1` verdict at
the block its evidence pins, and re-checks a `risk-v1` verdict from its public evidence. For `risk-v1` it proves three
things: the score follows from the recorded findings; every onchain fact shown to the model was true at the pinned
block; and the injection rule was applied. It does not prove that the recorded output came from the model (every
`risk-v1` report says `model output: recorded, not re-run`). Trusting `risk-v1` means trusting validator B's operator,
which is why the gate also requires the fully reproducible `mandate-v1`. Any other tag exits 2 (`UNKNOWN_TAG`). It is
read-only, and uses the public testnet RPC unless `MONAD_TESTNET_RPC_URL` names another. pnpm echoes its arguments, so
pass a URL with an API key through that variable (or `.env`), not `--rpc-url`, or run
`pnpm --loglevel silent attest8004 verify …` ([ARCHITECTURE §5.5](./ARCHITECTURE.md)):

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
both validators' and the demo agents' keys; they show how the recorded testnet runs were made. The e2e runs validator
A as `mandate-v1` and validator B as `risk-v1`, which calls the model at `LLM_BASE_URL` (Groq today). It uses the vault
that requires A at 100 and B at 80. Agent 1984's hot key requests three actions from both validators:
- **S:** a payment to the deployer, inside the mandate. A scores 100 and B at least 80, so it executes.
- **R:** a payment to the `DemoPassThrough`. The mandate allows this target, so A scores 100, but the contract forwards
  every payment to an address nobody controls. B scores 0 with a high finding, and the gate refuses R at B.
- **O:** a payment to an unlisted target, over the per-tx cap. A scores 0, and the gate refuses O at A. B still runs and
  explains why.

The script then re-checks all six verdicts with `verify` and checks that each matches. Anyone can do the same for a
recorded verdict with `pnpm attest8004 verify <requestHash>` (above). B's three checks are paced to Groq's free tier
and take a few minutes each. The recorded run (4 Oct 2026, `e2e OK`) is in
[docs/deployments.md](./docs/deployments.md):
- S executed.
- R got 0 from B, with a high `FUNDS_FORWARDED` and a medium `FRESH_COUNTERPARTY` finding.
- O got 0 from A.
- All six verdicts matched under `verify`.
- B used 12 model calls and 25,271 Groq tokens.

```bash
pnpm --filter @attest8004/scripts hot-keys                     # one hot key per demo agent into .env; prints addresses only
pnpm --filter @attest8004/scripts setup-demo-agents            # register agents, approve the forwarder per agent, set each agent's key
pnpm --filter @attest8004/scripts setup-demo-agents -- --fund  # top agent 1984's hot key up to 8 requests (one e2e run + 2 spare), 1985's up to 4
pnpm --filter @attest8004/scripts setup-demo-agents -- --fund-validator    # top validator A up to 2 MON
pnpm --filter @attest8004/scripts setup-demo-agents -- --fund-validator-b  # top validator B up to 1 MON
# agent 1984's e2e mandate (the deployer and the DemoPassThrough) needs two factors since P6: the owner's transaction and a passkey.
# On https://attest8004.vercel.app/approve (Chrome, Google Password Manager): create the passkey, download the registration.
pnpm --filter @attest8004/scripts set-passkey <registration.json>                          # dry run: prints the key and a --confirm code
pnpm --filter @attest8004/scripts set-passkey <registration.json> --confirm <code>         # binds it to agent 1984, once
# On /approve: preset "e2e mandate", Prepare approval, Sign with passkey, download the approval.
pnpm --filter @attest8004/scripts submit-approval <approval.json>                          # dry run: re-checks it, shows the mandate in plain words
pnpm --filter @attest8004/scripts submit-approval <approval.json> --confirm <code>         # setMandate from the owner
# after a new mandate is set, wait about 31 minutes (6,000 blocks) before the e2e: it refuses to start sooner
# P7, the Mera inbox: on /approve section 4, "Derive inbox key" (Mera PRF), Prepare, Sign with passkey, download the approval.
pnpm --filter @attest8004/scripts submit-approval <inbox-approval.json>                    # dry run: shows the inbox key it sets
pnpm --filter @attest8004/scripts submit-approval <inbox-approval.json> --confirm <code>   # setInboxKey from the owner (no wait after it)
pnpm --filter @attest8004/scripts e2e                          # hot key -> forwarder -> mandate-v1 and risk-v1 -> gated execute; verify all six
# with an inbox key set, each verdict also gets an encrypted operator report: read them at https://attest8004.vercel.app/inbox
# (agent 1984 -> Find reports -> Decrypt with passkey), on any device with the agent's passkey
pnpm --filter @attest8004/scripts gated-execute                # P2: the superseded agent-1982 vault, owner requests directly
```

The e2e runs both validators in-process, so **stop the `mandate-v1` and `risk-v1` services (below) before running
it**: a running service would sign with the same validator key as the e2e, and two processes answering the same
requests would race (each validator's pinned block also assumes one process per key). **After `submit-approval` sets
a new mandate, wait about 31 minutes before the e2e.** `risk-v1`'s `recent_permission_events` reads the last 6,000
blocks, so it would show the fresh `MandateSet`, and the e2e's preflight refuses to start until it is that old.
**After a failed run, re-run `setup-demo-agents -- --fund` before another e2e:** agent 1984's hot key is funded for 8
requests, and a run uses 6.

To run validator A as a long-lived `mandate-v1` service (it needs
`VALIDATOR_A_PRIVATE_KEY` and `MONAD_TESTNET_RPC_URL`; the optional `MANDATE_V1_*` settings are in `.env.example`):

```bash
pnpm --filter @attest8004/validator-mandate start   # polls until Ctrl-C; JSON-line logs, never the key or the RPC URL
```

Run one process per validator key: the pinned block relies on knowing that key's last response. It answers only its
allowlisted (gate, agent) pairs (by default the demo vault with agent 1984, the one agent it is bound to) and agents
with an unexpired mandate set by their current owner, with a per-agent rate limit and a validator-wide daily gas
budget; a restart resets both.

To run validator B as a long-lived `risk-v1` service (it needs `VALIDATOR_B_PRIVATE_KEY`, which must be the recorded
validator B address, `MONAD_TESTNET_RPC_URL`, and `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` for an OpenAI-compatible
endpoint, Groq today; `NANSEN_API_KEY` is optional, and the `RISK_V1_*` settings are in `.env.example`):

```bash
pnpm --filter @attest8004/validator-risk start   # polls until Ctrl-C; JSON-line logs carry the LLM host and model, never a key or URL
```

It refuses to start unless its RPC serves `debug_traceCall` with `callTracer` and state 2,000,000 blocks (about 7
days) back, which its simulation and age probes need. It answers a request only after `mandate-v1` has answered the
same action, so run the `mandate-v1` service too. Like
validator A it serves only its allowlisted (gate, agent) pairs (`RISK_V1_GATES`, by default the demo vault with agent
1984), with the same per-agent rate limit and daily gas budget. It paces its LLM calls to Groq's free tier (30 requests
and 8,000 tokens a minute for the main model; Prompt Guard has its own budget), so one check takes a few minutes.

## Deployments

| Chain | Contract | Address |
|---|---|---|
| Monad testnet (10143) | `ValidationRegistry` (spec-conformant, **not canonical**) | [`0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f`](https://monad-testnet.socialscan.io/address/0xc4a4d0ceb3971cbe7a2536494ac106f2cd9f9a8f) |
| Monad testnet (10143) | `AgentRequestForwarder` (agent hot keys request through it) | [`0x1451F3C36545b191d3642f759D59f21DcFD657B2`](https://monad-testnet.socialscan.io/address/0x1451f3c36545b191d3642f759d59f21dcfd657b2) |
| Monad testnet (10143) | `MandateRegistry` v2 (per-agent spending mandates; owner + passkey, P6) | [`0x2Ee5f78149762DE630c6bFF8CD81166010D0454B`](https://monad-testnet.socialscan.io/address/0x2ee5f78149762de630c6bff8cd81166010d0454b) |
| Monad testnet (10143) | `MandateRegistry` (P4, owner-set; read only for verdicts pinned before block 68,196,462) | [`0x2523197373ef813E19b5b14Ef2984130868cD17c`](https://monad-testnet.socialscan.io/address/0x2523197373ef813e19b5b14ef2984130868cd17c) |
| Monad testnet (10143) | `DemoAgentVault` (AttestGate demo, demo agent 1984, requires `mandate-v1` and `risk-v1`) | [`0x12fAb3E3cA810Cc44bD9f537613a230a2be8D614`](https://monad-testnet.socialscan.io/address/0x12fab3e3ca810cc44bd9f537613a230a2be8d614) |
| Monad testnet (10143) | `DemoPassThrough` (AttestGate demo target, forwards every payment to `SINK`) | [`0xEEEBBa55620afC42E9c88b5d962476367b8da338`](https://monad-testnet.socialscan.io/address/0xeeebba55620afc42e9c88b5d962476367b8da338) |
| Monad testnet (10143) | `DemoAgentVault`, agent 1984, validator A only (**superseded**) | [`0x23BfBD12545CCd1501ddA1B65a54518FD6212a96`](https://monad-testnet.socialscan.io/address/0x23bfbd12545ccd1501dda1b65a54518fd6212a96) |
| Monad testnet (10143) | `DemoAgentVault`, P2, agent 1982 (**superseded**) | [`0x7A5EC388CCbfD3B255CFa94fc2062c0807F2C4CD`](https://monad-testnet.socialscan.io/address/0x7a5ec388ccbfd3b255cfa94fc2062c0807f2c4cd) |
| Vercel | Web app, production (the WebAuthn rpId for P6; never a preview URL) | [`attest8004.vercel.app`](https://attest8004.vercel.app) |

Registry deploy tx [`0x724f31e0…cf64d03`](https://monad-testnet.socialscan.io/tx/0x724f31e0efd09993f2d73581cb742e71d4bef52c0f4f2a30cccd43d79cf64d03). A scripted register → request → response round trip on this registry (agentId 1982), a validated execute through the P2 vault ([`0x59d5987e…71e3f85`](https://monad-testnet.socialscan.io/tx/0x59d5987e1d2583def79af6af40efd60daf0fa88cc7553d6f3b31a0eab71e3f85)), the demo agents 1984 and 1985 with their hot keys, the switch to per-agent forwarder approvals with agent 1984's mandate, the P3 end-to-end run (hot key → forwarder → validator → execute, [`0x6f694020…bb1336a8`](https://monad-testnet.socialscan.io/tx/0x6f6940203907d8d759e1887953d1170015be7f0c6d27b39c4e22090bbb1336a8)), the P4 run with `mandate-v1` (one action inside agent 1984's mandate executed, [`0xb666247e…60c84f9`](https://monad-testnet.socialscan.io/tx/0xb666247e2ac448a233c1bac336c19d65373aa908a2656b2f6e999408f60c84f9); one outside it scored 0 and refused; both re-checked with `verify`), and the P5 run with both validators (the safe action executed, [`0x2aee06f1…87dd2b0`](https://monad-testnet.socialscan.io/tx/0x2aee06f120850aef87201566d032750666c8ed42b6ec55f2026e7143e87dd2b0); the payment to `DemoPassThrough` got `risk-v1` 0, [`0xbef321d7…679d68f`](https://monad-testnet.socialscan.io/tx/0xbef321d79bd3e86e83c64bdb30c4394b7254f09b2f57640a11c6f9e83679d68f), and is refused; all six verdicts re-checked with `verify`) are recorded with their transaction hashes in [docs/deployments.md](./docs/deployments.md). That file records every deployment with its chain, address, commit and date. Differences from the EIP-8004 Draft are in [docs/spec-notes.md](./docs/spec-notes.md).

Canonical contracts this project builds on:

| Contract | Monad testnet (10143) | Monad mainnet (143) |
|---|---|---|
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| P256VERIFY precompile | `0x0100` | `0x0100` |

## Nansen endpoints

`risk-v1` uses Nansen for counterparty profiles and fund flows, through two read-only tools:
`nansen_counterparty_profile(address)` (labels + first-funder) and `nansen_flows(address)`
(counterparties). Base URL `https://api.nansen.ai`, key in an `apikey` header, every call a POST.

| Endpoint | Data category | Validator tool | Access | Credits |
|---|---|---|---|---|
| `POST /api/v1/profiler/address/labels` | Entity and behavioural labels | `nansen_counterparty_profile` | API key only (not payable by x402) | 100 |
| `POST /api/v1/profiler/address/first-funder` | Funding origin | `nansen_counterparty_profile` | API key, or x402 at $0.01 | 1 |
| `POST /api/v1/profiler/address/counterparties` | Counterparty volumes in/out, with labels | `nansen_flows` | API key, or x402 at $0.05 | 5 |

Every call sends `chain: "all"`, since Nansen doesn't index Monad testnet: that searches the same EVM
address across every chain Nansen does index (including Monad mainnet), rather than failing outright.
**Integrated; unused until `NANSEN_API_KEY` is set.** Without a key (today), both tools report
themselves unavailable with no fetch, no credits spent, and the model is told so upfront; the
evidence always records whether Nansen was available for a given verdict. Full detail, including the
exact request/response shapes and the per-check credit cost, is in [docs/nansen.md](./docs/nansen.md).

## Built with AI

This project is built with **Claude Code** (Anthropic; model Claude Opus 5.5) as a coding assistant. The developer writes the specification and architecture, reviews each change, and runs the tests. Claude Code writes much of the code, tests and docs under the rules in [CLAUDE.md](./CLAUDE.md). Commits it co-authored carry a `Co-Authored-By: Claude` trailer.

At runtime, `risk-v1` calls a **Groq-hosted** model through an OpenAI-compatible endpoint set in `.env`. Today that is `openai/gpt-oss-120b`, with `meta-llama/llama-prompt-guard-2-86m` screening untrusted text. The output is untrusted data: schema-validated and scored by code, and the model never sees keys.

## Credits and pre-existing code

**Pre-existing code:** none. Everything in this repository was written during the Metropolis build window (1 Sep to 13 Oct 2026); work on it started on 2 Oct 2026. Third-party libraries are used unmodified, as dependencies:

| Library | Licence | Used for |
|---|---|---|
| [forge-std](https://github.com/foundry-rs/forge-std) v1.17.0 | MIT / Apache-2.0 | Foundry testing |
| [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) v5.7.0 | MIT | `WebAuthn` and `P256` (through the `0x0100` precompile) in MandateRegistry v2; `ReentrancyGuardTransient` in AttestGate; `Base64` in tests; ERC721 in a test mock |
| [viem](https://viem.sh) | MIT | TypeScript EVM client |
| [zod](https://zod.dev) | MIT | Schema validation |
| [Vitest](https://vitest.dev) | MIT | TypeScript tests |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 | Language |
| [React](https://react.dev) | MIT | Web app |
| [Vite](https://vite.dev) | MIT | Web build |
| [Mera](https://mera.category.xyz) (`@category-labs/mera` 0.2.0, Category Labs) | MIT / Apache-2.0 | The `/approve` page's PRF check (`getPasskeyPrfOutput`); P7's passkey inbox |
| [@noble/curves](https://github.com/paulmillr/noble-curves), [@noble/hashes](https://github.com/paulmillr/noble-hashes), [@noble/ciphers](https://github.com/paulmillr/noble-ciphers) 2.2.0 (Paul Miller) | MIT | The SDK's findings inbox (`packages/sdk/src/inbox-crypto.ts`): X25519, HKDF-SHA256 and AES-256-GCM. Curves and hashes are also Mera's dependencies, at the same versions, so the web app bundles one copy |
| [@scure/base](https://github.com/paulmillr/scure-base) | MIT | Mera's dependency (bundled into the web app) |

**Standards and reference code:**

- `contracts/src/interfaces/IValidationRegistry.sol` copies the function and event signatures from the [EIP-8004](https://eips.ethereum.org/EIPS/eip-8004) text (CC0).
- `ValidationRegistry` was written for this project. Its behaviour deliberately matches the reference [`erc-8004/erc-8004-contracts`](https://github.com/erc-8004/erc-8004-contracts) `ValidationRegistryUpgradeable` (MIT), but no code was copied from it. The differences are in [docs/spec-notes.md](./docs/spec-notes.md).
- The expected values in the shared hash vectors (`packages/sdk/test/vectors.json`) are generated with Foundry's `cast`.
- Deployment goes through the widely used deterministic deployment proxy at `0x4e59b44847b379578588920cA78FbF26c0B4956C` (Arachnid); it is called onchain, and none of its code is included here.

The demo agents are registered by calling the Identity Registry's `register(string)` directly; the [agent0 SDK](https://sdk.ag0.xyz) was not used, because its latest release (1.7.1) has no defaults for Monad. This list grows as libraries are added (Envio and others).

## License

[MIT](./LICENSE)
