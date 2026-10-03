# STATUS

Running log, updated at the end of every session (CLAUDE.md, rule 10). Newest session first.

---

## Sat 3 Oct 2026 · P2 AttestGate + DemoAgentVault

### Done
- **The approved `requestHash` decision is implemented.**
  - `requestHash = keccak256(abi.encode(chainid, gate, validatorAddress, agentId, target, value, keccak256(data), deadline, salt))`, one per validator. `actionHash` is the same without `validatorAddress`.
  - `requestHash` stays an ABI-encoded action hash. spec-notes row 6 records that this encoding is the EIP's "request payload". Request JSON v1 gains `validator` (ARCHITECTURE §6, SPEC §4.4).
- **One definition, two implementations, an independent oracle.**
  - `contracts/src/ActionHash.sol` (struct `Action` and the library) and `@attest8004/sdk` (`computeRequestHash`, `computeActionHash`, viem).
  - Both check the 8 vectors in `packages/sdk/test/vectors.json`, whose expected hashes come from `cast` (`vectors.sh`; `--check` verifies).
  - The SDK rejects `data` that isn't whole bytes of hex, because viem would silently read `0x123` as `0x0123`. viem itself rejects bad checksums, out-of-range integers and a wrong-size salt.
- **`AttestGate`** (`contracts/src/AttestGate.sol`):
  - 1 to 4 immutable `(validator, minScore)` requirements, packed into immutables, and **all must pass**. The constructor rejects `minScore` 0 or above 100, zero validators and duplicates.
  - For each requirement it recomputes that validator's `requestHash` and requires the stored validator, the stored `agentId` and `response >= minScore`. Any failure to read the registry fails closed (`ValidationNotFound`).
  - It marks `actionHash` consumed before the external call, under OZ `ReentrancyGuardTransient`. TSTORE was checked live on Monad testnet.
  - Views `actionHashOf` and `requestHashOf` let clients check their hashes against the chain.
- **`DemoAgentVault`:** bound to one immutable `agentId`. `execute` is permissionless (the validated action is the authorisation), and a failed call rolls everything back, so the action can be retried until its deadline.
- **Tests, written first and committed before the code:**
  - 49 new unit and fuzz tests (gate 31, vault 9, deploy script 6, hash 3), with 10k fuzz runs in the `ci` profile, plus 3 new fork tests against the live registry. One fork test runs the exact testnet configuration end to end as agent 1982's real owner and validator A.
  - All of the listed cases revert: unvalidated, pending, low score, untrusted validator (two ways), squatted hash, expired, replayed, a different action (each field), another gate and another chain.
  - 14 hand-made mutants (each check removed, the check moved after the call, no guard) are each caught.
  - 13 vitest tests.
- **Deployed on Monad testnet:** `DemoAgentVault` at `0x7A5EC388CCbfD3B255CFa94fc2062c0807F2C4CD` (commit `f826eec`), tx `0xd960c130…72b6a64`. It is bound to agent 1982 and requires validator A at 100.
- **One validated execute on testnet** (`pnpm --filter @attest8004/scripts gated-execute`), as agent 1982:
  - The SDK hashes equal the vault's.
  - request `0x526b86de…`, response `0x1330ecb6…`, execute `0x59d5987e…` (block 67,757,794).
  - The unvalidated, pending, different-action and replay cases were simulated and refused.
  - All tx hashes are in `docs/deployments.md`.
- **Final review** by a fresh reviewer over the whole P2 range found no Critical issues. Fixed, with failing tests first where code changed:
  - The SDK hashed malformed salts instead of throwing. viem accepts a 63-digit salt (padded) and hashes non-hex text as UTF-8. `action.salt` must now be exactly 32 bytes of hex, and a numeric `chainId` must be a safe integer.
  - Docs:
    - the ARCHITECTURE §4.1 diagram (`onlyValidated(action)` with immutable requirements);
    - §4.4 and §9: a note for integrators that permissionless execution means a withdrawn pass can be front-run, and that a target which tolerates a failed sub-call can run degraded with a low gas limit;
    - §12: a gate consumer is redeployed to move to the canonical registry;
    - the README: the gated-execute script signs a smoke-test score, and no `mandate-v1` checks run.
- **Explicit gas limits.** Every transaction sent this session used a literal limit.

  | Transaction | Monad `eth_estimateGas` | Limit |
  |---|---|---|
  | Deploy `DemoAgentVault` (CREATE2 factory call) | 829,476 | 1,000,000 |
  | Fund the vault (0.01 MON) | 21,212 | 26,000 (first run: provisional 30,000) |
  | `validationRequest` (request JSON v1 as a data: URI) | 202,643 | 244,000 (first run: 400,000) |
  | `validationResponse` | 84,514 | 102,000 (first run: 165,000) |
  | `execute` (one requirement, native transfer) | 87,626 | 106,000 (first run: 250,000) |

- **Tooling:**
  - `deploy-testnet.sh` now takes the contract name and keeps the estimate guard.
  - SDK sources import `.ts` files (rewritten to `.js` on build), and an `@attest8004/source` export condition lets `scripts/` run the SDK source directly, with no build step in CI.
- **Docs:** SPEC §4.3, §4.4 and §6; ARCHITECTURE §1, §3, §4.1, §4.3, §4.4, §5.2 (the "known conflict" is resolved), §6, §7 and §9; spec-notes rows 5, 6, 7 and 12 plus a log row; README; `contracts/README.md` (also restores the `Toolchain.t.sol` row deferred from P1); `docs/README.md`; CLAUDE.md line 43 (as you approved).
- **Resolved from P1's STATUS:**
  - the `requestHash` blocker (decided and implemented);
  - the CLAUDE.md wording;
  - the `Toolchain.t.sol` row in `contracts/README.md`;
  - RPC URLs in error output (the new script prints viem's `shortMessage`; `roundtrip` still prints the full message).
- **Learned:** `vm.prank` applies to the next external call, and a call evaluated inside the next call's arguments counts. Compute hashes before pranking.

### Next
- **Your side:**
  - `git push`, then check CI on GitHub.
  - Optionally add `DEMO_AGENT_VAULT=0x7A5EC388CCbfD3B255CFa94fc2062c0807F2C4CD` to `.env`; until then the script falls back to `scripts/src/deployments.ts`.
  - Still open from P0/P1: the Qwen model ID, Envio token, Nansen credits, PRF smoke test, Discord questions, the Vercel deploy, making the repo public, the integration offer.
- **P3 (Sun 4 Oct): the SDK client and validator base.**
  - Write the request JSON v1 zod schema, including `validator`.
  - Validators must reject a request whose `validator` isn't themselves, or whose `agentId` differs from the `ValidationRequest` event's (ARCHITECTURE §6).
  - Decide who sends `validationRequest` (see Blockers).
- **P5:** redeploy `DemoAgentVault` requiring both validators. Mark the current vault as superseded in `docs/deployments.md`; its last 0.009 MON can leave only through a validated execute.
- **Deferred minor from the final review:** run `packages/sdk/test/vectors.sh --check` in CI. The `contracts` job has `cast`, and `jq` is on the runner. Today the "independent oracle" check runs only by hand.
- **Still deferred from P1** (P10 or whenever convenient):
  - the deployer key in forge's argv;
  - three test gaps;
  - filtering `Registered` logs by emitter;
  - `timeout-minutes` on `contracts-fork`;
  - a README note that each round trip registers a new test agent.
- The tightened gas limits in `gated-execute.ts` haven't been used in a run yet (you asked for one execute). The estimate guard stops the script before sending if any is too low.

### Blockers or decisions needed
- **Decisions I made (all reversible; flag any you disagree with):**
  - At most 4 requirements, packed into immutables. Solidity has no immutable arrays, and on Monad a cold `SLOAD` costs 8,100 gas.
  - `execute` is permissionless, and a failed call can be retried until the deadline.
  - The vault's testnet configuration is constants in the deploy script, so it can be reviewed in git.
  - The smoke-test verdict uses tag `attest8004-gate-smoke`, not `mandate-v1`, because no checks ran.
- **P5: pick `risk-qwen-v1`'s `minScore`** for the redeploy (`mandate-v1` stays at 100).
- **Request JSON v1 `deadline` is a JSON number.** Above 2^53 it would lose precision. A validator would then reject the request on hash mismatch, so it fails safe. Making it a decimal string like `agentId` and `value` would be a format change; decide in P3.
- **Squatting is still a denial of service** (spec-notes row 12). A squatted hash can't pass the gate, but a determined squatter can keep an action from being validated. The agent can retry with a new `salt`. This belongs in the P10/P11 threat model.
- Still open from P1: how agents submit requests (P3), and the Identity Registry upgradeability trust note.

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
- **Minor review findings, deferred** (from the P1 whole-branch review; for P10 or whenever convenient):
  - `deploy-testnet.sh` passes the deployer key in forge's argv, so other local users could see it via `ps` while forge runs. Use `--keystore`, or document the trade-off.
  - Test gaps:
    - the old owner's `setApprovalForAll` operator after a transfer;
    - a fork test that a nonexistent `agentId` reverts through the live registry;
    - `testFuzz_OnlyNamedValidatorCanRespond` asserts nothing on its success path.
  - Round-trip script:
    - filter `Registered` logs by emitter address;
    - viem errors print the RPC URL, which matters only if a keyed URL is used.
  - Add `timeout-minutes` to the `contracts-fork` CI job.
  - Re-add a line on `test/Toolchain.t.sol` to `contracts/README.md`.
  - Note in the README quickstart that each round trip registers a new test agent in the shared registry.
  - `CLAUDE.md` still says "No Validation Registry is deployed anywhere". That's your file to edit; "no canonical one" is now the accurate wording.

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
