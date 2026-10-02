# STATUS

Running log, updated at the end of every session (CLAUDE.md, rule 10). Newest session first.

---

## Fri 2 Oct 2026 · P1 ValidationRegistry

### Done
- **Spec check** (`docs/spec-notes.md`). Checked against the EIP-8004 text (`ethereum/ERCs` `503591a`, 25 Jan 2026, still a Draft) and `erc-8004-contracts` (`b9e466c`, 15 Aug 2026).
  - The interface in SPEC §4.1 matches the EIP exactly.
  - 13 behavioural differences and decisions are logged, with the selector table.
  - `erc-8004-contracts` still lists **no Validation Registry on Monad**, and says that part of the spec is "still under active update".
- **`ValidationRegistry`** (`contracts/src/`): EIP-conformant and immutable.
  - The Identity Registry is a constructor argument. There is no owner, proxy or `initialize`.
  - It uses custom errors, and behaves like the reference v2.0.0 in everything else.
- **Tests, written first and committed before the contract:**
  - 38 unit and fuzz tests, with 10k fuzz runs in the `ci` profile and a reference model for `getSummary`
  - 6 fork tests against the **live canonical Identity Registry** on Monad testnet
  - 6 deploy-script tests
  - 5 hand-made mutants of the contract are each caught by the suite.
- **Deployed on Monad testnet:** `0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f` (commit `8dc8859`), tx `0x724f31e0…cf64d03`.
  - It goes through the CREATE2 factory with a literal gas limit (`script/deploy-testnet.sh`).
  - The address depends on the Identity Registry address in the init code. Testnet and mainnet use different Identity Registries, so a mainnet deploy would land at a different address.
- **Round trip on testnet** (`pnpm --filter @attest8004/scripts roundtrip`).
  - The deployer registered test agent **1982**. As owner it requested validation from validator A, and validator A responded 100 with tag `attest8004-roundtrip`.
  - The script checked `getValidationStatus` and `getSummary` onchain, and they were checked again with `cast`.
  - The tx hashes are in `docs/deployments.md`. The evidence JSON says it is a smoke test, not a verdict.
- **New workspace package `scripts/`** (`@attest8004/scripts`, private): viem scripts run with Node 22's built-in type stripping. No new dependencies.
- **Explicit gas limits.** Every transaction sent this session used a literal limit; Monad charges for the limit.

  | Transaction | Monad `eth_estimateGas` | Limit |
  |---|---|---|
  | Deploy (CREATE2 factory call) | 949,673 | 1,140,000 |
  | Identity Registry `register` | 410,457 | 493,000 |
  | `validationRequest` | 235,881 | 284,000 |
  | `validationResponse` | 84,212 | 102,000 (the first run used a provisional 165,000) |

- **CI** (`.github/workflows/ci.yml`) has four jobs:
  - `contracts`: unit and fuzz tests
  - **`contracts-fork`**: fork tests over the public testnet RPC, with `continue-on-error: true`
  - **`secrets`**: `fetch-depth: 0` and gitleaks v8.30.1 (checksum-pinned) over every commit on every ref, using `.gitleaks.toml`. This closes the P0 proposal.
  - `typescript`

  A local `gitleaks git` over the full history finds no leaks.
- **Docs:** README (status, deployments, quickstart lines, credits for the EIP interface and the reference implementation), `contracts/README.md`, `docs/README.md`, and ARCHITECTURE §4.1, §4.4, §5.2 and §13.
- **Learned about forge on Monad.**
  - `forge script`'s on-chain simulation ignores `{gas: N}` and re-estimates each transaction against pre-broadcast state. In a probe it gave 27.6k to a call that needed more.
  - `--skip-simulation` keeps `{gas: N}` as the literal limit, and deploying through the CREATE2 factory makes the deploy a gas-limited CALL.
  - Reuse this pattern for the P2/P4 deploy scripts.

### Next
- **Your side:**
  - `git push`, then check all four CI jobs on GitHub. `gh` isn't authenticated here, so I can't see them.
  - Add `VALIDATION_REGISTRY=0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f` to `.env`. I don't edit `.env`; until then the scripts fall back to `scripts/src/deployments.ts`.
  - Make the repo public (GAMEPLAN, Sat 3 Oct). The local full-history scan is clean, and the `secrets` CI job will confirm it on GitHub.
  - Post the integration offer (GAMEPLAN §6) with the testnet registry address.
  - Still open from P0, status unknown to me: the Qwen 3.8 Max model ID, the Envio token, Nansen credits, the PRF smoke test, the Discord questions, deploying `web/` to Vercel, and funding validator B.
- **P2 (Sun 4 Oct):** AttestGate and DemoAgentVault (SPEC §4.3). First settle the `requestHash` decision below.

### Blockers or decisions needed
- **P2: `requestHash` and the two-validator flow.** EIP-8004 (and our registry, like the reference) allows **one validator per `requestHash`**: a second `validationRequest` with the same hash reverts. So ARCHITECTURE §5.2, which sends one hash to both validators, can't work as drawn. Recommended:
  - add `validatorAddress` to the `requestHash` preimage, so the gate recomputes one hash per trusted validator;
  - mark consumption on a **validator-independent action hash**, so one action can't execute twice using different validators' verdicts;
  - check the **stored `agentId` and `validatorAddress`** from `getValidationStatus`, not only the score (any agent owner can claim a hash first, and can repeat that for every retry: spec-notes row 12);
  - require `minScore >= 1` (a pending request reads as response 0).

  This changes SPEC §4.3 and ARCHITECTURE §4.3–4.4, so it needs your OK. Also decide whether `requestHash` stays an *action* hash, or becomes `keccak256` of the request payload as the EIP's wording says (spec-notes, row 6).
- **P3: how agents submit requests.** Only the agent's owner or an ERC-721 operator can call `validationRequest`. But making the agent's hot key an operator (`setApprovalForAll` or `approve`) would also let it **transfer the agent NFT**. Decide in P3 how agents submit requests. One option: a minimal forwarder contract, approved as operator, that can only forward `validationRequest` for agents whose owners enabled it.
- **Trust note:** the canonical Identity Registry is an upgradeable (UUPS) proxy with an owner. Our registry pins its address, so it inherits that trust (ARCHITECTURE §7).
- **Before reusing the deploy pattern in P2/P4:** `deploy-testnet.sh` now checks Monad's `eth_estimateGas` for the exact deploy call (`deployPlan`) against `DEPLOY_GAS` before broadcasting. Copy that guard.
- **Test agent 1982** now exists in the canonical testnet Identity Registry, owned by the deployer. Its registration file says it is a test agent (`active: false`).

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
