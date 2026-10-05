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
> **Passkey-approved mandates are live (5 Oct 2026).** MandateRegistry v2 accepts a mandate change only with the owner's transaction **and** an assertion from the agent's passkey, verified onchain by Monad's P256 precompile (`0x0100`; the 6,900-gas call shows in the transaction's trace). One Google Password Manager passkey, created on [`/approve`](https://attest8004.vercel.app/approve), approved agent 1984's mandate from laptop Chrome and again, synced, from Chrome on Android; both real assertions are test vectors. The same three-action e2e then passed against v2 (`e2e OK`, all six verdicts `match`), and the P4/P5 verdicts still verify. **The Mera findings inbox is live (P7, 5 Oct 2026):** validators post an encrypted operator report after each verdict to `FindingsBoard`, sealed to an X25519 key derived from the agent's passkey through Mera's PRF, and [`/inbox`](https://attest8004.vercel.app/inbox) decrypts them on any device with that passkey. Agent 1984's passkey published its inbox key from laptop Chrome. The e2e then posted six trusted reports, and the same passkey decrypted them on laptop Chrome and, synced, on Android Chrome ([docs/mera.md](./docs/mera.md), [the Android screenshot](./docs/img/p7-android-inbox-decrypt.jpg)). **The Envio trust API is live (P8, 5 Oct 2026):** an Envio HyperIndex indexer of every Attest8004 contract feeds the SDK's `getAgentTrust()`, the new [`/dashboard`](https://attest8004.vercel.app/dashboard) and `/inbox` (which now finds reports through it, with no time window, and re-checks each one on chain). It is a convenience, never a trust root: no verdict and no `verify` reads it. Progress is in [STATUS.md](./STATUS.md).

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
- **Private findings inbox (Mera)**: after each verdict, each validator posts an operator report (its reasons, the agent's spend, each finding with a recommended action) to `FindingsBoard`, encrypted to an X25519 key derived from the operator's passkey through Mera's PRF. The key is derived on demand, never stored, and zeroed after use; any device with the same synced passkey derives the same key (in P7's live run, laptop Chrome and Android Chrome derived the same key and decrypted the same reports, [docs/mera.md](./docs/mera.md)). The public evidence stays public, for `verify`.
- **Trust API (Envio)**: an Envio HyperIndex indexer of every Attest8004 contract (and the Identity Registry's ownership events for our agents) behind the SDK's `getAgentTrust()`, `/dashboard` and `/inbox`. Every record links back to its transaction, and the SDK re-checks what matters on chain: the indexer is a convenience, never a trust root ([below](#trust-api-envio)).
- **Validator C, orchestrated by Chainlink CRE** (P11): the same deterministic `mandate-v1` check, run by a CRE workflow: a log trigger, its own chain reads, the evaluation API through CRE consensus, cross-checks, and a write through CRE's forwarder into `CreValidator`. It runs as a CRE workflow (simulation forwarder, not a trust root); see [Chainlink CRE](#chainlink-cre-validator-c).

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
| [`indexer/`](./indexer) | Envio HyperIndex V3 project: `config.yaml`, `schema.graphql`, handlers ([its README](./indexer/README.md)) |
| [`web/`](./web) | `/approve`, `/inbox`, `/dashboard` |
| [`scripts/`](./scripts) | `@attest8004/scripts`: operational scripts (testnet round trip, demo agents, end to end, `indexer-check`, the indexer keep-alive) |
| [`docs/`](./docs) | Quickstart, API reference, threat model, deployments, integrations |

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
pnpm --filter @attest8004/scripts hot-keys                     # one hot key per demo agent, and pnpm demo's rogue key, into .env; prints addresses only
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

## Demo

`pnpm demo` plays the SPEC §5 scenario live on Monad testnet, scene by scene, for a screen recording. Each scene ends
with explorer links for its transactions, and the runner pauses for Enter between scenes.
- **1, the mandate:** a passkey approves the mandate on `/approve`; the runner submits it, reads it back from chain, and
  shows the `0x0100` P256VERIFY call in the transaction's trace.
- **2, a benign action:** both validators pass it, and the vault executes it.
- **3, the Grok/Bankr pattern:** a new forwarder key outside the mandate asks to send MON to an unknown address.
  `mandate-v1` scores it 0, `risk-v1` explains why, and the gate's refusal is simulated.
- **3b, recovery:** the rogue key is revoked and the mandate re-approved with the passkey.
- **4 and 5:** the dashboard, and the phone decrypting the private findings.

Both validators run in the runner's process, so stop the validator services first.

```bash
pnpm --loglevel silent demo --preflight   # balances, takes left today (Groq, the daily cap, each key), blockers; sends nothing
pnpm --loglevel silent demo               # every scene; you approve on /approve in scenes 1 and 3b
pnpm --loglevel silent demo --scene 3b    # one scene: 1, 2, 3, 3b, 4 or 5 (3b is also the reset after an interrupted take)
pnpm --loglevel silent demo --fast        # no pauses between scenes
pnpm --loglevel silent demo --fund        # top the hot key, the rogue key and both validators up to 4 takes from the deployer
```

**Taking another take:** scene 3b is also the reset. A mandate approved after the key changes is clean at once,
because `mandate-v1` compares permission events with the newest `MandateSet`, so takes can follow each other without
the e2e's 31-minute wait.

**What a take costs:**
- **Groq:** two `risk-v1` checks, about 19K of the free tier's 200K tokens a day;
- **The daily cap:** 0.0005 MON of agent 1984's daily cap.

When a key is short, the preflight prints its full address to paste into the faucet.

[docs/demo.md](./docs/demo.md) is the 3-minute narration script, with the browser steps, the real durations from the
live run, and where to cut the waiting time. The live run (5 Oct 2026) is in
[docs/deployments.md](./docs/deployments.md).

## Trust API (Envio)

The Envio HyperIndex indexer in [`indexer/`](./indexer) (`config.yaml`, `schema.graphql`, one handler file per
contract) indexes **live Monad testnet data** through HyperSync: every request and verdict on the ValidationRegistry
(with the request JSON and the evidence decoded and checked against their hashes), both MandateRegistries each in its
own epoch, passkeys and inbox keys, the forwarder's hot keys, the vaults' executed actions, every FindingsBoard post
with the trust rule as a stored flag (untrusted posts are kept, never dropped), and the canonical Identity Registry's
ownership events for our agents. Three things consume it:

- **The SDK** ([`packages/sdk/src/trust-api.ts`](./packages/sdk/src/trust-api.ts), browser-safe):
  `getAgentTrust(agentId)`, `getTrustOverview()`, `getIndexedVerdicts()` and `findIndexedReports()` (findings
  discovery), each one GraphQL query whose answer is validated as untrusted data. Every result carries its
  `requestHash`, transaction and log index, and `confirmIndexedVerdict` / `confirmIndexedReport` re-check one from the
  chain.
- **[`/dashboard`](https://attest8004.vercel.app/dashboard):** recent `mandate-v1` and `risk-v1` verdicts (score,
  reasons, validator, agent, time, whether the action executed), each with its explorer link and its
  `pnpm attest8004 verify` line; validator stats (requests, answers, score buckets, average time to answer); and an
  agent trust lookup. Only real, indexed numbers; our own validators and demo agents are labelled as ours.
- **[`/inbox`](https://attest8004.vercel.app/inbox):** finds an agent's reports through the indexer, with no time
  window, keeps each one only if the chain's status trusts its poster and its own transaction receipt carries it, and
  falls back to the chain search when the indexer is down.

**Never a trust root:** `mandate-v1`, `risk-v1` and `pnpm attest8004 verify` read the chain at the pinned block and
never the indexer. A lagging, broken or lying indexer can hide or stale data, but can't change a verdict or slip a
report past `/inbox` ([ARCHITECTURE §5.7, §7](./ARCHITECTURE.md)).

```ts
import { createPublicClient, http } from "viem";
import { monadTestnet } from "viem/chains";
import { DEPLOYMENTS, confirmIndexedVerdict, getAgentTrust } from "@attest8004/sdk";

const publicClient = createPublicClient({ chain: monadTestnet, transport: http() });
const trust = await getAgentTrust(1984n); // the hosted endpoint recorded in DEPLOYMENTS, or pass { url }
for (const v of trust?.recentVerdicts ?? []) {
  console.log(v.tag, v.score, v.reasons, v.requestHash, v.responseTx);
  // { ok: true } when getValidationStatus agrees; `pnpm attest8004 verify <requestHash>` re-runs the verdict itself
  console.log(await confirmIndexedVerdict({ publicClient, deployment: DEPLOYMENTS[10143], verdict: v }));
}
```

### Run the indexer locally

You need Docker (Envio's local mode runs Postgres and Hasura in containers) and a free HyperSync API token from
[envio.dev/app/api-tokens](https://envio.dev/app/api-tokens), saved as `ENVIO_API_TOKEN` in `.env`
(`indexer/scripts/envio.mjs` reads only that one line and never prints it):

```bash
pnpm --filter @attest8004/indexer dev       # envio dev: Docker, then syncs Monad testnet from HyperSync (a few minutes)
# GraphQL at http://localhost:8080/v1/graphql (Hasura console: http://localhost:8080, admin secret "testing")
pnpm --filter @attest8004/scripts indexer-check -- --url http://localhost:8080/v1/graphql   # the indexer against the chain
VITE_TRUST_API_URL=http://localhost:8080/v1/graphql pnpm --filter @attest8004/web dev     # /dashboard on the local indexer
pnpm --filter @attest8004/indexer test      # handler tests (Envio's test framework; no Docker, no token)
```

`pnpm --filter @attest8004/indexer exec envio stop` stops the containers and deletes the local database.

## Chainlink CRE (validator C)

Validator C is `mandate-v1` with a [Chainlink CRE](https://docs.chain.link/cre) workflow as its orchestration layer
([docs/cre.md](./docs/cre.md), the full account and the 2-minute video script). For a `ValidationRequest` naming C,
the workflow ([`cre/validator-c/`](./cre/validator-c/)):
1. **reads Monad itself:** the request's block and hash, that the request names C, finality, the deadline, that it's
   unanswered;
2. **asks the unchanged `mandate-v1` logic** over HTTP (`POST /evaluate` on 127.0.0.1, read-only, reads no key) through
   identical-aggregation consensus;
3. **cross-checks the evidence** against its own reads, and computes the response hash itself;
4. **writes the verdict** through CRE's forwarder into `CreValidator`
   ([`0x6D12F00870cB6edA2d8e389696f6B5d050423B95`](https://monad-testnet.socialscan.io/address/0x6d12f00870cb6eda2d8e389696f6b5d050423b95)),
   which posts it to the ValidationRegistry under the `mandate-v1` tag;
5. **reads the verdict back** to confirm it landed.

```bash
pnpm cre:demo -- --preflight   # the vault excludes C, the mandate, balances and takes left, the CRE CLI, Bun; sends nothing
pnpm cre:demo                  # a benign request (C → 100) and a violating one (C → 0), each simulated with --broadcast
```

- **Not a trust root.** C is a **CRE workflow (simulation forwarder, not a trust root)**. It runs with
  `cre workflow simulate --broadcast` against CRE's mock forwarder, through which anyone can deliver a report. So no
  gate requires it: the demo vault requires validators A and B only, and a fork test pins that.
- **What consensus proves.** Identical aggregation makes CRE's nodes agree on what `/evaluate` answered; it doesn't
  compute the score.
- **What makes a C verdict checkable.** `pnpm attest8004 verify <requestHash>` re-executes it, as it does an A verdict.
- **First live take, 6 Oct 2026:** C scored 100 and 0 (`TARGET_NOT_ALLOWED`), both matched by `verify`
  ([docs/deployments.md](./docs/deployments.md#p11-cre-run-validator-c-orchestrated-by-chainlink-cre-testnet-2026-10-06)).
  CRE CLI v1.37.0, `@chainlink/cre-sdk` 1.23.0, Bun 1.3.14; simulation only, no CRE-network deployment.

## Integrations

**Any escrow with a verifier hook can require Attest8004 verdicts on its verifier's releases.** Name an AttestGate vault
as a job's verifier, and the vault releases the payment, through `vault.execute(release(jobId))`, only once every
required validator has passed that exact action. No adapter contract is needed.

**The verifier isn't exclusive.** The escrow's other release paths still apply: the hirer can release at any time, and
anyone can once the review window has passed. So a refusal by the validators stops the vault, not the payment
([caveat 1](./docs/integrations.md#caveats)).

[docs/integrations.md](./docs/integrations.md) works this through with AgentPassport's JobEscrow v2 (by agentfromzero,
MIT). [Ten fork tests](./contracts/test/fork/AgentPassportIntegration.fork.t.sol) drive our live `DemoAgentVault`
against their live bytecode on Monad testnet:
- a delivered job is paid out through the vault;
- a release without verdicts, or with a low `risk-v1` score, reverts;
- a replay reverts `ActionAlreadyConsumed`.

That proves the two compose. **It is not adoption by their team:** nothing was broadcast, and their GitHub account is
gone.

## Deployments

| Chain | Contract | Address |
|---|---|---|
| Monad testnet (10143) | `ValidationRegistry` (spec-conformant, **not canonical**) | [`0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f`](https://monad-testnet.socialscan.io/address/0xc4a4d0ceb3971cbe7a2536494ac106f2cd9f9a8f) |
| Monad testnet (10143) | `AgentRequestForwarder` (agent hot keys request through it) | [`0x1451F3C36545b191d3642f759D59f21DcFD657B2`](https://monad-testnet.socialscan.io/address/0x1451f3c36545b191d3642f759d59f21dcfd657b2) |
| Monad testnet (10143) | `MandateRegistry` v2 (per-agent spending mandates; owner + passkey, P6) | [`0x2Ee5f78149762DE630c6bFF8CD81166010D0454B`](https://monad-testnet.socialscan.io/address/0x2ee5f78149762de630c6bff8cd81166010d0454b) |
| Monad testnet (10143) | `MandateRegistry` (P4, owner-set; read only for verdicts pinned before block 68,196,462) | [`0x2523197373ef813E19b5b14Ef2984130868cD17c`](https://monad-testnet.socialscan.io/address/0x2523197373ef813e19b5b14ef2984130868cd17c) |
| Monad testnet (10143) | `FindingsBoard` (encrypted operator reports for the Mera inbox, P7) | [`0xa7d52B3B08FAB0cd0527c6242ca678f9Feee6a1c`](https://monad-testnet.socialscan.io/address/0xa7d52b3b08fab0cd0527c6242ca678f9feee6a1c) |
| Monad testnet (10143) | `DemoAgentVault` (AttestGate demo, demo agent 1984, requires `mandate-v1` and `risk-v1`) | [`0x12fAb3E3cA810Cc44bD9f537613a230a2be8D614`](https://monad-testnet.socialscan.io/address/0x12fab3e3ca810cc44bd9f537613a230a2be8d614) |
| Monad testnet (10143) | `DemoPassThrough` (AttestGate demo target, forwards every payment to `SINK`) | [`0xEEEBBa55620afC42E9c88b5d962476367b8da338`](https://monad-testnet.socialscan.io/address/0xeeebba55620afc42e9c88b5d962476367b8da338) |
| Monad testnet (10143) | `CreValidator`: validator C, the Chainlink CRE workflow's receiver (P11). CRE workflow (simulation forwarder, not a trust root): no gate requires it | [`0x6D12F00870cB6edA2d8e389696f6B5d050423B95`](https://monad-testnet.socialscan.io/address/0x6d12f00870cb6eda2d8e389696f6b5d050423b95) |
| Monad testnet (10143) | `DemoAgentVault`, agent 1984, validator A only (**superseded**) | [`0x23BfBD12545CCd1501ddA1B65a54518FD6212a96`](https://monad-testnet.socialscan.io/address/0x23bfbd12545ccd1501dda1b65a54518fd6212a96) |
| Monad testnet (10143) | `DemoAgentVault`, P2, agent 1982 (**superseded**) | [`0x7A5EC388CCbfD3B255CFa94fc2062c0807F2C4CD`](https://monad-testnet.socialscan.io/address/0x7a5ec388ccbfd3b255cfa94fc2062c0807f2c4cd) |
| Vercel | Web app, production (the WebAuthn rpId for P6; never a preview URL) | [`attest8004.vercel.app`](https://attest8004.vercel.app) |
| Envio Cloud | The hosted indexer's GraphQL endpoint (free plan; the URL changes with each deployment, [docs/deployments.md](./docs/deployments.md)) | [`indexer.dev.hyperindex.xyz/3d57e4d/v1/graphql`](https://indexer.dev.hyperindex.xyz/3d57e4d/v1/graphql) |

Registry deploy tx [`0x724f31e0…cf64d03`](https://monad-testnet.socialscan.io/tx/0x724f31e0efd09993f2d73581cb742e71d4bef52c0f4f2a30cccd43d79cf64d03). A scripted register → request → response round trip on this registry (agentId 1982), a validated execute through the P2 vault ([`0x59d5987e…71e3f85`](https://monad-testnet.socialscan.io/tx/0x59d5987e1d2583def79af6af40efd60daf0fa88cc7553d6f3b31a0eab71e3f85)), the demo agents 1984 and 1985 with their hot keys, the switch to per-agent forwarder approvals with agent 1984's mandate, the P3 end-to-end run (hot key → forwarder → validator → execute, [`0x6f694020…bb1336a8`](https://monad-testnet.socialscan.io/tx/0x6f6940203907d8d759e1887953d1170015be7f0c6d27b39c4e22090bbb1336a8)), the P4 run with `mandate-v1` (one action inside agent 1984's mandate executed, [`0xb666247e…60c84f9`](https://monad-testnet.socialscan.io/tx/0xb666247e2ac448a233c1bac336c19d65373aa908a2656b2f6e999408f60c84f9); one outside it scored 0 and refused; both re-checked with `verify`), and the P5 run with both validators (the safe action executed, [`0x2aee06f1…87dd2b0`](https://monad-testnet.socialscan.io/tx/0x2aee06f120850aef87201566d032750666c8ed42b6ec55f2026e7143e87dd2b0); the payment to `DemoPassThrough` got `risk-v1` 0, [`0xbef321d7…679d68f`](https://monad-testnet.socialscan.io/tx/0xbef321d79bd3e86e83c64bdb30c4394b7254f09b2f57640a11c6f9e83679d68f), and is refused; all six verdicts re-checked with `verify`), the P6 passkey-approved mandate ([`0x5d4cc955…d15444d`](https://monad-testnet.socialscan.io/tx/0x5d4cc955b9bcabf5b8268cb10b7622c6e5a8019897bb5e3036df86927d15444d), whose trace shows the `0x0100` call) and the P7 inbox run (the passkey-approved inbox key, [`0x6b328dde…b70c160`](https://monad-testnet.socialscan.io/tx/0x6b328dde8791b4d7fc6099e925330d44ffa9d1c933e81c4297509630db70c160), then six encrypted operator reports, decrypted on laptop Chrome and Android Chrome) are recorded with their transaction hashes in [docs/deployments.md](./docs/deployments.md). That file records every deployment with its chain, address, commit and date. Differences from the EIP-8004 Draft are in [docs/spec-notes.md](./docs/spec-notes.md).

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

## Limitations

Known gaps, stated plainly. The full threat model is P12's.

- **`risk-v1` can't see ERC-20 transfers.** Its simulation tool reports MON movements and each inner call's selector,
  never the call's arguments or logs. Tokens moved inside an action, such as an escrow's payout, a router sweeping a
  balance, or any `transfer` the target makes, show the model no recipient and no amount: **a token drain made that way
  is invisible to it.** A direct `token.transfer(to, amount)` reaches it only as raw calldata hex, and no rule of its
  rubric reads token value.
  - **The fix:** a `risk-v2` that decodes `Transfer` logs from the call trace. Monad's RPC serves `callTracer` with
    logs, so it is feasible. It needs a new tag, because `risk-v1`'s evidence format is frozen. Roadmap, not built
    ([ARCHITECTURE §12](./ARCHITECTURE.md#12-extension-points-and-roadmap)).
- **`mandate-v1`'s caps count native MON only.** A mandate that allowlists a token-moving selector (`transfer`,
  `approve`, …) doesn't cap the token amount. Together with the previous point, **an action that moves tokens is today
  bounded only by the mandate's target and selector allowlist**, so allowlist such selectors only with targets you'd
  trust with the whole balance ([ARCHITECTURE §9](./ARCHITECTURE.md#9-security-design-decisions)).
- **Validator C (Chainlink CRE) runs in simulation only.** It trusts CRE's mock forwarder, through which anyone can
  deliver a report. So no gate requires it, and anyone can fill its write-once slot first with a forged verdict:
  griefing that affects only C. `verify` shows such a verdict as a MISMATCH, as "could not verify" (an undecodable
  URI), or as a match at a later pin, which isn't C's: C always pins the request's block
  ([docs/cre.md §7](./docs/cre.md#7-trust-model)).
  - **On-chain `getSummary`** counts C's `mandate-v1` verdicts together with A's; pass the validators you trust.
  - **Its daily-spend view** is as of each request's block.
  - **The production path** is on the roadmap: a new receiver with CRE's KeystoneForwarder, a DON deployment, and
    `/evaluate` at a public URL ([docs/cre.md §11](./docs/cre.md#11-the-production-path)).

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
| [Envio HyperIndex](https://docs.envio.dev) (`envio` 3.12.1) | Envio's own licences, **not OSI**: per the package's `licenses/README.md`, the generated indexer code is under Envio's EULA (self-hosting allowed) and the code generator under a non-commercial licence | The indexer (`indexer/`): codegen, the runtime and its test framework. Our handlers, schema and config are MIT |
| [yaml](https://eemeli.org/yaml) 2.9.1 | ISC | The indexer's config test |
| [`@chainlink/cre-sdk`](https://www.npmjs.com/package/@chainlink/cre-sdk) 1.23.0 (Chainlink) | MIT | Validator C's CRE workflow (`cre/validator-c/`), compiled to WASM with its Javy plugin |
| [CRE CLI](https://docs.chain.link/cre) v1.37.0 (Chainlink) | Chainlink's terms | Not included: runs `cre workflow simulate --broadcast` locally |
| [Bun](https://bun.sh) 1.3.14 | MIT | Runs the CRE SDK's compiler and the workflow's tests (`cre/mise.toml`) |

**Standards and reference code:**

- `contracts/src/interfaces/IReceiver.sol` is Chainlink's `IReceiver`, copied from the CRE documentation's sample ([smartcontractkit/documentation](https://github.com/smartcontractkit/documentation), `public/samples/CRE/IReceiver.sol`, MIT), with its `IERC165` import pointed at OpenZeppelin's identical file.
- `contracts/src/interfaces/IValidationRegistry.sol` copies the function and event signatures from the [EIP-8004](https://eips.ethereum.org/EIPS/eip-8004) text (CC0).
- `ValidationRegistry` was written for this project. Its behaviour deliberately matches the reference [`erc-8004/erc-8004-contracts`](https://github.com/erc-8004/erc-8004-contracts) `ValidationRegistryUpgradeable` (MIT), but no code was copied from it. The differences are in [docs/spec-notes.md](./docs/spec-notes.md).
- The expected values in the shared hash vectors (`packages/sdk/test/vectors.json`) are generated with Foundry's `cast`.
- Deployment goes through the widely used deterministic deployment proxy at `0x4e59b44847b379578588920cA78FbF26c0B4956C` (Arachnid); it is called onchain, and none of its code is included here.

**Composed with, not included:**

- [AgentPassport](https://agentfromzero.netlify.app/agentpassport/) (JobEscrow v2 and AgentPassport on Monad testnet), by
  agentfromzero, an autonomous AI agent (disclosed). **MIT**, per the SPDX headers of its
  [Sourcify-verified source](https://sourcify.dev/server/v2/contract/10143/0x41Cb9b1a7Ebe2e1a420d8Cd96D02a9009AC54355) and
  its npm SDK [`@agentfromzero/agentpassport-sdk`](https://www.npmjs.com/package/@agentfromzero/agentpassport-sdk).
  - **How we use it:** `contracts/test/fork/AgentPassportIntegration.fork.t.sol` calls their deployed contracts on a fork,
    and copies only their function, event and error signatures. No code of theirs is in this repository.
  - **Their GitHub repository and account are gone** (404 as of 5 Oct 2026).
  - Details: [docs/integrations.md](./docs/integrations.md#credits).

The demo agents are registered by calling the Identity Registry's `register(string)` directly; the [agent0 SDK](https://sdk.ag0.xyz) was not used, because its latest release (1.7.1) has no defaults for Monad. This list grows as libraries are added.

## License

[MIT](./LICENSE)
