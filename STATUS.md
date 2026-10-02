# STATUS

Running log, updated at the end of every session (CLAUDE.md, rule 10). Newest session first.

---

## Fri 2 Oct 2026 · P0 scaffold

### Done
- **Monorepo scaffold, as in SPEC §3:** `contracts/`, `packages/sdk/`, `validators/mandate/`, `validators/qwen/`, `indexer/`, `web/`, `cre/` (stretch placeholder) and `docs/`. No feature code.
- **Contracts:** a Foundry project with `network = "monad"`, solc 0.8.37 and EVM `osaka`. forge-std v1.17.0 and OpenZeppelin Contracts v5.7.0 are git submodules, pinned in `foundry.lock`. `test/Toolchain.t.sol` passes (3/3).
- **TypeScript:** a pnpm 12.8.1 workspace on Node 22 (`.nvmrc`, `engines`). Shared versions live in the pnpm catalog: TypeScript 7, vitest 5, viem 2.57, zod 4. `pnpm typecheck`, `pnpm test` and `pnpm build` all pass. The lockfile was resolved under pnpm's minimum-release-age policy with no exclusions.
- **Web:** a Vite + React placeholder shell for `/approve`, `/inbox` and `/dashboard`, with a `vercel.json` SPA rewrite so it can be deployed early.
- **Repo hygiene:** MIT `LICENSE`, a README skeleton (all eight sections), `.env.example`, `.gitignore`, and docs stubs (`deployments.md`, `spec-notes.md`, `nansen.md`, plus an index).
- **Secrets:**
  - The gitleaks pre-commit hook in `.githooks/` fails closed if gitleaks is missing, and `pnpm install` enables it.
  - `.gitleaks.toml` adds an EVM private-key rule.
  - Verified: the hook blocks a fake GitHub token and fake hex keys, and every P0 commit passed it.
- **CI:** `.github/workflows/ci.yml` has two jobs:
  - contracts: `forge fmt --check`, `build --sizes` and `test` with a 10k-run fuzz profile, Foundry pinned to v1.8.4
  - typescript: frozen install, typecheck and test

  Actions are SHA-pinned and the token is read-only.
- **Facts verified tonight (useful for later phases):**
  - **OZ v5.7.0 ships `P256.sol` and `WebAuthn.sol`.** `P256.verify` calls `0x0100` with a Solidity fallback and rejects high-s. P6 should build on these.
  - **Forge's test EVM (Monad profile) exposes P256VERIFY at `0x0100`** with the documented semantics: 32 bytes `…01` for a valid signature, empty bytes for an invalid one. P6 tests can sign with `vm.signP256`.
  - **Monad testnet and mainnet both execute Osaka's CLZ opcode** (checked by `eth_call` on 2 Oct), so `evm_version = "osaka"` is safe to deploy.
  - **gitleaks' default rules miss some hex private-key forms** (`pk = "0x…"`, `--private-key 0x…`); the custom rule covers them.

### Next
- **P1 (Sat 3 Oct):** ValidationRegistry, test-first. Re-read EIP-8004 and `erc-8004-contracts`, log differences in `docs/spec-notes.md`, write the tests including the fork test, deploy to testnet, and run a scripted round trip.
- Check that CI is green on GitHub after the first push.
- Before the repo goes public, run `gitleaks git` over the full history.
- **Your side (GAMEPLAN §2), status unknown to me:**
  - `.env` currently has key names but **no values**. Create the three hackathon wallets, fill them in, and fund them from the faucet.
  - Confirm the Qwen 3.8 Max model ID (`QWEN_MODEL`), get an Envio token, and ask about Nansen credits.
  - Run the PRF smoke test (Chrome + Android) and post the Discord questions.
- **Deploy `web/` to Vercel soon** (Root Directory `web`) to lock the domain/rpId before any demo passkey is created.

### Blockers or decisions needed
- **Decision made, reversible: the web app is a Vite + React SPA.** It's client-only, which fits "nothing stored on a server" for Mera, and it's a simple static deploy on Vercel. If you'd rather use Next.js, switch before P6.
- **LICENSE copyright holder** is "Attest8004 contributors". Replace it with your name if you prefer.
- **Node version:** the repo pins Node 22 for CI and Vercel, but your global mise default is Node 24. Node 24 works locally (pnpm doesn't complain); to match CI, run `mise use node@22` in the repo.
- **`indexer` is listed in `pnpm-workspace.yaml`** but has no `package.json` yet. Check this when `envio init` runs in P8, because Envio generates its own package.
- **Proposal (outside the P0 request):** add a gitleaks job to CI, so secret scanning doesn't depend on every clone having the local hook enabled.
