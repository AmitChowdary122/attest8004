# CLAUDE.md — Attest8004 (Monad Metropolis, Track 04)

## What this is
Attest8004 is the ERC-8004 **Validation** layer for Monad: a spec-conformant ValidationRegistry, passkey-approved agent mandates (P256 precompile `0x0100`), a validator SDK, two reference validators (deterministic `mandate-v1`, and agentic `risk-qwen-v1` built on Qwen 3.8 Max + Nansen), a Mera passkey-derived findings inbox, and an Envio-indexed trust API.

- **Read `SPEC.md` and `ARCHITECTURE.md` before any work.** SPEC is the source of truth for scope and acceptance criteria. ARCHITECTURE is the source of truth for how the system works: flows, data formats, `requestHash`, trust model and key custody.
- The hackathon rules are in `../Metropolis_Hackathon_Reference.md`.
- The day-by-day plan is in `../GAMEPLAN.md`.

**Deadline: 14 Oct 2026, 09:29 IST** (13 Oct 11:59 PM ET). Solo builder. Scope is fixed, so don't add features outside SPEC §4. Propose them in STATUS.md instead.

## Hard rules
1. **Never commit secrets.** Only `.env.example` goes in git. Don't print keys in logs or tests. Gitleaks runs as a pre-commit hook; never bypass it.
2. **Open source, MIT**, public repo. Every external library and any pre-existing code must be attributed in the README.
3. **AI disclosure:** the README section "Built with AI" states that Claude Code was used. Keep it accurate.
4. **Commit small and often**, with meaningful messages. The judges check that the commit history covers the build window.
5. **Contracts are test-first.** Foundry tests (including fuzz) are written before or alongside each contract. Never deploy untested code.
6. **The EIP-8004 Validation interface must match the spec exactly.** The spec is a Draft, so re-check eips.ethereum.org/EIPS/eip-8004 and github.com/erc-8004/erc-8004-contracts before changing the registry, and log differences in `docs/spec-notes.md`.
7. **Never claim features that aren't live**, especially BTX (design note only) or a "canonical" registry (ours is spec-conformant but non-canonical).
8. **Treat all LLM output as untrusted data.** Validate it against a schema. The LLM never holds or sees private keys.
9. **Keep `ARCHITECTURE.md` in sync.** Any change to an interface, flow, data format or trust assumption updates it in the same commit.
10. At the end of every session, **update `STATUS.md`** with three lists: Done, Next, Blockers or decisions needed.

## Stack
- **Contracts:** Solidity (latest stable 0.8.x), Foundry, and OpenZeppelin, using its P256/WebAuthn utils if the installed version has them.
- **TypeScript:** Node 22, pnpm workspaces, viem, vitest, zod for schemas.
- **Indexer:** Envio HyperIndex (`indexer/`: `config.yaml`, `schema.graphql`, handlers).
- **Web:** a single app for `/approve`, `/inbox` and `/dashboard`, deployed to a fixed domain early (passkeys are bound to the rpId).
- **Passkeys:** `@category-labs/mera` (PRF, one salt per ceremony), plus raw WebAuthn assertions for the onchain checks.
- **LLM:** Qwen 3.8 Max via Alibaba Model Studio's international, OpenAI-compatible endpoint. Confirm the model ID. Config comes from env.
- **Data:** Nansen API or x402 pay-per-call. List every endpoint used in `docs/nansen.md`.

## Monad facts that bite
- Chains: testnet `10143`, mainnet `143`. Testnet MON comes from faucet.monad.xyz.
- **Gas is charged on the gas limit, not gas used.** Always set explicit, tight gas limits.
- **P256VERIFY lives at `0x0100`.** It costs 6,900 gas and takes 160 bytes of input (`hash‖r‖s‖qx‖qy`). It returns 32 bytes ending `…01` if valid and **empty bytes** if invalid, so always check the return length. It doesn't enforce low-s, so enforce it yourself.
- Canonical ERC-8004 Identity Registry:
  - testnet `0x8004A818BFB912233c491871b3d84c89A494BD9e`
  - mainnet `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- Reputation Registry:
  - testnet `0x8004B663056A597Dffe9eCcC1965A193B7388713`
  - mainnet `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`
- **No canonical Validation Registry is deployed anywhere.**
- x402 facilitator: `https://x402-facilitator.molandak.org`. Use `@x402/evm >= 2.22.0`; testnet needs a custom USDC money parser.
- **Mera PRF on desktop Chrome works only with passkeys stored in Google Password Manager.** Firefox on Linux won't work. The demo uses Chrome plus an Android phone with the same Google account.

## Conventions
- `requestHash` is defined once (SPEC §4.3) and implemented identically in Solidity and TypeScript, with shared test vectors in `packages/sdk/test/vectors.json`.
- Record every deployment in `docs/deployments.md`: chain, address, commit hash and date.
- Docs are part of the product. Update the quickstart whenever an interface changes.
- When unsure about an external API (Qwen, Nansen, Envio, Mera, CRE), **fetch the current docs first** rather than guessing.
