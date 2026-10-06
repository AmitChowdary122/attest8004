# Security review (P12)

An independent audit of Attest8004 as built, the fixes it led to, and what is left. The threat model that goes with it
is [threat-model.md](./threat-model.md).

> **What this review is, and isn't.**
> - **It is an AI-assisted self-review, not a professional audit.** The auditor was a fresh Claude Opus 5.5 subagent,
>   the same model family that helped build the code (README, "Built with AI").
> - **Its independence is limited.** The auditor didn't see the build's status notes, plans or review ledgers, but it
>   did read the design docs written during the build.
> - **What it didn't include:** formal verification, a new fuzzing campaign beyond the repo's fuzz and invariant tests,
>   or any test outside Monad testnet.
> - **What would change before real value:** a professional audit.

## 1. Scope and the commit audited

- **The commit:** `main` at `32b55a11efb2b6c219be5d0bc254023a6bfcc6cd` (`32b55a1`, 6 Oct 2026), as deployed on Monad
  testnet ([deployments.md](./deployments.md)).
- **The deployed code matches it.** The auditor compared the runtime bytecode of all seven live contracts with a fresh
  build of that commit (immutables masked, metadata hashes equal). The live web bundle carries the same commit.
- **Contracts** (`contracts/src`):
  - `ValidationRegistry`, `AttestGate`, `DemoAgentVault`, `ActionHash`, `AgentRequestForwarder`, `MandateRegistry` v2,
    `DemoPassThrough`, `FindingsBoard`, `CreValidator`;
  - what was checked: authorisation; `requestHash`/`actionHash` binding, replay and single use; reentrancy and
    griefing; WebAuthn and P256 (the `0x0100` return, low-s, the challenge and nonce, UV, `rpIdHash`, clientDataJSON
    indices); revoke and nonces; gas; events against EIP-8004.
- **Verdict logic:**
  - `mandate-v1`: determinism, pinning, spend counting, evidence and `verify`;
  - `/evaluate`'s input handling;
  - `risk-v1`: LLM-output handling and replay-verify.
- **Crypto:** PRF → HKDF → X25519; the findings envelope (AES-256-GCM nonces, AAD, the version byte); buffer zeroing;
  what `/inbox`'s sender check authenticates.
- **Web:** CSP and headers, XSS and sanitising, no storage, no URL input, the passkey page.
- **CRE:** the workflow, `CreValidator`'s trust in the mock forwarder, and the indexer never being a trust root.
- **Keys and secrets:** every script, service and CI job; gitleaks over the full history; the CI supply chain.
- **Dependencies:** `pnpm audit --prod` and `cre/`'s `bun audit`.

## 2. Method

1. **Tools first, on the untouched commit.** Versions as run:

   | Tool | Version | Notes |
   |---|---|---|
   | Foundry (forge) | 1.8.4 | solc 0.8.37, optimizer 200 runs, `evm_version` osaka, `network = "monad"` |
   | Slither | 0.11.6 (crytic-compile 0.4.2) | `uv tool`, Python 3.12; it parsed solc 0.8.37 through `forge build` |
   | Aderyn | 0.6.8 | from Cyfrin's npm package; crates.io only has an abandoned 0.1.9, which no longer compiles |
   | `forge coverage` | 1.8.4 | `--ir-minimum` (stack too deep without the optimizer, in OZ `P256.sol`) |
   | gitleaks | 8.30.1 | the repo's `.gitleaks.toml` (default rules plus an EVM private-key rule), `--log-opts="--all"` |
   | `pnpm audit --prod` | pnpm 12.8.1 | |
   | `bun audit` | Bun 1.3.14 | `cre/validator-c` |
   | `curl -sI` | 8.22.0 | the live headers (§8.4) |
   | actionlint | 1.7.12 | the hardened workflows |

2. **The independent auditor.** One fresh subagent on Claude Opus 5.5 (SPEC §6 names "the Opus auditor prompt").
   - **What it was given:** SPEC §6, ARCHITECTURE §5–§9, docs/deployments.md, the repository and the tool output.
   - **What it was withheld:** STATUS, the plans, the review ledgers and commit messages. It never opened `.env`.
   - **Its rules:** read-only, with proof-of-concept tests allowed in a scratch folder; no transactions; no Groq or
     Nansen calls; RPC reads under 10 a second.
   - **What it did:** wrote proof-of-concept tests (forge unit tests, forge fork tests against the live contracts, and
     one TypeScript test), and triaged every tool hit itself.
3. **The builder's triage.** Every finding was reproduced (all PoCs pass) or traced in the code, graded with the rubric
   below, and routed:
   - **fix** (no redeploy, no frozen-format change);
   - **stop and ask the owner** (a redeploy or a frozen format);
   - **accept**, **roadmap** or **doc-only**.

   The owner chose the routes for AUD-01 and AUD-04.
4. **No silent downgrades.** Any Medium finding routed to roadmap or docs, in whole or in part, needed the auditor's
   agreement before shipping (§4).
5. **The re-check.** The same auditor re-checked every Medium fix against the final commit, and skimmed the whole diff
   for new problems (§4).

**Severity, judged on this deployment.**
- **Critical:** with no special access, an attacker moves funds out of a deployed contract, executes an action outside a
  passkey-approved mandate, or makes a gate accept a verdict not given for that exact action.
- **High:** a stated security property breaks under realistic conditions, or a secret is exposed.
- **Medium:** a property breaks only under unusual conditions; a core flow can be cheaply denied; or a security claim
  in the docs isn't backed by the code.
- **Low:** hardening, or a misleading line that changes no security decision.
- **Info:** clarity.

## 3. Findings

**0 Critical, 0 High, 4 Medium, 8 Low, 3 Info.** No way was found, without special access, to:
- move funds out of a deployed contract;
- execute an action outside a passkey-approved mandate;
- make a gate accept a verdict not given for that exact action.

Every grade below is the auditor's; triage changed none. "Fixed in" names the commit on `main`.

| ID | Severity | Title | Location | Status |
|---|---|---|---|---|
| AUD-01 | Medium | Any agent owner can block every two-validator action by claiming the second `requestHash` from the first request's log | `ValidationRegistry.sol:60`, `packages/sdk/src/client.ts` | **Interim fix in `6d0a823`** (requests signed first and sent together; live: one block). Residual on the roadmap (an EIP-7702 batch), as the owner chose |
| AUD-02 | Medium | `verify` accepts any pin between request and response, so validator A can under-count daily spend and still match | `validators/mandate/src/verify.ts:186`, `validator.ts` | **Fixed in `1435f1b`** |
| AUD-03 | Medium | An agent's hot key can mint "trusted" inbox reports and push the real ones out of `/inbox` | `packages/sdk/src/inbox-read.ts`, `web/src/inbox/` | **Fixed in `b730cd1`, `0fe0967`.** Residual documented (the growth of `getAgentValidations`); an allowlisted forwarder is on the roadmap |
| AUD-04 | Medium | risk-v1's forwarding check can be evaded: the target can detect the simulation, and the model chooses severity and whether to simulate | `validators/risk/src/` | **Model-choice half fixed in `662c748`** (posting gate, the owner's route A+). The target-detection half is documented, with `risk-v2` on the roadmap |
| AUD-05 | Low | Validators make one RPC per request before the allowlist check | `packages/sdk/src/validator.ts` | **Fixed in `99c26a1`** |
| AUD-06 | Low | `revokeMandate` doesn't stop actions already validated | `MandateRegistry.sol`, `AttestGate.sol` | **Doc corrected in `2a014bc`**; pinned by a fork test (`afa0696`). A gate-side check is on the roadmap (needs a new vault) |
| AUD-07 | Low | The deployer key went on forge's command line; every `.env` secret was exported to forge and cast | `contracts/script/deploy-testnet.sh` | **Fixed in `c937e29`** |
| AUD-08 | Low | risk-v1's address scope can be widened by target-controlled text and an unscoped `erc8004_reputation` | `validators/risk/src/tools.ts` | **Doc corrected in `2a014bc`**; roadmap (`risk-v2`: the fix changes semantics that `verify` re-runs) |
| AUD-09 | Low | Calldata text can avoid Prompt Guard while still reaching the model as hex | `validators/risk/src/untrusted.ts` | **Doc corrected in `2a014bc`**; roadmap (`risk-v2`) |
| AUD-10 | Low | The `setInboxKey` approval proves the passkey approved a key, not that the key derives from its PRF | `web/src/approve/InboxKey.tsx`, SPEC, ARCHITECTURE | **Doc corrected in `2a014bc`** |
| AUD-11 | Low | `/evaluate` had no `Host` check and a 4-slot queue that far-future pins could fill | `validators/mandate/src/evaluate-http.ts`, `evaluate-jobs.ts` | **Fixed in `29794cb`** |
| AUD-12 | Low | Web defence in depth: no Permissions-Policy, lexical guard tests described as enforcement, a stale CSP in the docs | `web/vercel.json`, ARCHITECTURE §5.1 | **Fixed in `178053d`**; Trusted Types and an AST lint are on the roadmap |
| AUD-13 | Info | The P256 "return length" is checked through zeroed scratch space, not `returndatasize` | OZ `P256.sol` | **Accepted:** correct, and already ARCHITECTURE §9's first bullet |
| AUD-14 | Info | risk-v1 `verify` didn't recompute `llm.promptHash` | `validators/risk/src/verify.ts` | **Fixed in `ff821ed`** |
| AUD-15 | Info | Output and log hygiene | the SDK, the CLI, risk config, a script | **Fixed in `0881ff2`** |

### Finding details

**AUD-01: second-request squat (Medium).**
- **The problem.** A landed request carries the whole action in its URI, so anyone who owns an agent can compute the
  other validator's `requestHash` from the first request's log and claim it before the agent's second transaction
  lands. The agent's request then reverts `RequestExists`, and the gate refuses the action (`AgentMismatch`) on every
  retry. Denial of service only: a squatted hash never passes the gate.
- **Proof:** the auditor's PoCs, now `test_Limitation_AUD01_*` and `testFork_Limitation_AUD01_LiveVaultSecondRequestSquat`.
- **The fix (`6d0a823`).** The SDK prepares every request, signs them locally on consecutive nonces, and sends them
  together before awaiting any receipt. A claimed hash becomes `RequestSquattedError`. The demo and the e2e request A
  and B in one call.
- **The live check (`docs/deployments.md`).** A first attempt, without local signing, split across two blocks. The
  fixed path landed both requests in block 68,749,841.
- **What remains:** a mempool front-runner, and pairs that still split. One transaction per action (an EIP-7702 batch
  from the hot key; Monad testnet accepts EIP-7702 transactions) is on the roadmap. A batching forwarder was rejected:
  it would change `mandate-v1`'s recorded contract set, so it would need a new tag, a new vault and a new C.

**AUD-02: early pin (Medium).**
- **The problem.** `verify` checked only that the pin lay between the request and the response. So a validator A that
  pinned before its own earlier approval of the agent landed would leave that approval out of the daily spend, and
  still verify as a match. An honest A that restarted lost its in-memory pin floor in the same way.
- **The fix (`1435f1b`).**
  - `approvalsAfterPin` compares the statuses at the response's block with those at `P`.
  - `verify` reports any skipped approval as `PIN_SKIPS_APPROVAL`, a mismatch; validator C is exempt, because its
    documented pin is the request's block.
  - A's pin waits on the same predicate, read from the chain.
- **No history changed:** all 19 recorded validator-A verdicts still re-verify as match.

**AUD-03: hot-key-minted inbox reports (Medium).**
- **The problem.** An agent's hot key can name any address as validator, answer as it, and post a report that the
  inbox's trust rule accepts. Twenty of those pushed the real reports out of `/inbox`'s newest-20 window. Tags and
  report text were shown raw.
- **Proof:** `testFork_Limitation_AUD03_HotKeyNamesItsOwnValidatorAndPosts`.
- **The fix (`b730cd1`, `0fe0967`).**
  - Discovery takes `knownValidators`: A, B and C each keep their own newest 20, and other validators share 5, after
    them.
  - `/inbox` labels C as the CRE simulation, and collapses other validators' verdicts under a warning.
  - Tags go through `displayText`, and decrypted text through `reportText`.
  - ARCHITECTURE §7 now says a hot key can name any validator.
- **What remains:** the junk entries stay in `getAgentValidations` for good, and every check of that agent reads them.
  Revoking the key stops the growth.

**AUD-04: risk-v1's forwarding check (Medium).**
- **Two halves.**
  - **The model chooses** whether to simulate and how severe a `FUNDS_FORWARDED` is: graded low, it scores 80, which
    passes the vault.
  - **A target can detect** the validators' simulation (`tx.origin`, gas price, time, later state, an upgrade) and
    behave differently there. Pinned by `test_Limitation_AUD04_TargetHidesForwardingFromTheValidatorsSimulation`.
- **A full fix was a STOP case:** it changes semantics that `verify` re-checks, so it would need `risk-v2` and a new
  vault. The owner chose route A+: no new tag, no new vault.
- **The fix (`662c748`).** A posting gate in validator B's service declines `SIMULATION_NOT_RUN`,
  `FORWARDING_NOT_FLAGGED_HIGH` and `SEVERITY_BELOW_RUBRIC` (four codes the prompt's rubric makes high). A decline posts
  nothing, so the vault fails closed, and every verdict still posted means what risk-v1 meant. Replaying the gate over
  all 12 posted B verdicts declines none.
- **What remains:** the target-detection half. No simulation can be made sound against a malicious target, so the bound
  is the passkey-approved target allowlist plus the MON caps. ARCHITECTURE §9 tells owners to allowlist only immutable
  or owner-controlled targets.

**The Lows and Infos.**

| ID | What changed |
|---|---|
| AUD-05 | The SDK base runs a no-RPC `servesLocally()` (the allowlist) before any status read |
| AUD-06 | The docs state the gap; a fork test pins it |
| AUD-07 | The wrapper reads only its three variables, passes the key to forge only through its environment, and sends the RPC through foundry.toml's alias. ARCHITECTURE §8 says the deployer is also the demo agents' owner wallet |
| AUD-08, AUD-09 | ARCHITECTURE §9 now says exactly what the tool scope and the calldata screening cover |
| AUD-10 | SPEC and ARCHITECTURE no longer say "provably" |
| AUD-11 | `/evaluate` answers 421 to a foreign `Host`, and refuses pins that can't finalize in time without taking a queue slot |
| AUD-12 | A `Permissions-Policy` header, and exact docs |
| AUD-14 | `verify` recomputes the prompt hash for `risk-v1/4`; all 12 recorded B verdicts are on that version and match |
| AUD-15 | Log lines and CLI text escape C1, bidi and invisible characters; tool names are clipped; `LLM_BASE_URL` must be https except on loopback; a script prints viem's short message only |

## 4. The re-check, and grades the auditor was asked to agree to

**No Medium finding was downgraded.** For three Medium findings, part of the work was routed to the roadmap or the
docs, so the auditor was asked to agree twice: before the fixes (on the proposed routes) and after them (re-checking
against `cc94049`). Its words, verbatim (saved with the review's working files, outside the repo):

| Finding | Route the auditor was asked to agree to | Before the fixes | After the fixes |
|---|---|---|---|
| AUD-01 (Medium) | Interim fix now; the residual (a mempool front-runner; pairs that still split) on the roadmap | "AGREE (conditionally). Sending both requests on consecutive nonces before any receipt closes the landed-log variant whenever they land in the same block." Its conditions: explicit nonces, both broadcast before awaiting, a "possibly squatted" error, docs saying a landed request reveals the other hash. All four were met | "VERDICT: fixed (interim). AGREE that the residual can go on the roadmap." |
| AUD-02 (Medium) | A full fix | "AGREE." | "VERDICT: fixed." |
| AUD-03 (Medium) | Fix (1) and (2); residual (3) documented; an allowlisted forwarder on the roadmap | "AGREE with the (3) residual if the wording is corrected." The wording was corrected | "VERDICT: fixed for (1) and (2). AGREE with the documented (3) residual and with the allowlisted forwarder on the roadmap." |
| AUD-04 (Medium) | A STOP case. The owner chose A+: the decline gate fixes the model-choice half; the target-detection half is documented, with `risk-v2` on the roadmap | "AGREE with (A); (B) isn't required. I recommend one no-tag addition." That addition is the posting gate, built as A+ | "VERDICT: the model-choice half is fixed. AGREE that the target-detection half stays documented, with risk-v2 on the roadmap." |

**What the re-check also ran:** the forge non-fork suite (250 passing), the known-limitation fork tests against the
live contracts (3/3), every TypeScript suite, and its AUD-02 PoC against the fixed `verify` (now
`PIN_SKIPS_APPROVAL`). It found that the fixes introduced:

| ID | Severity | Finding | Status |
|---|---|---|---|
| N1 | Low | If the send at nonce n is rejected, the staggered send at n+1 has usually already gone out, so B's request can land later, unpaired | **Partly fixed in `fb586d9`:** `RequestSendError` names every later request already sent. The auditor's suggestion, sending each request only after the previous one is accepted, would add a full RPC round trip between them (about 0.4 s measured, roughly a Monad block) and reopen AUD-01's split-block window, so the sends stay concurrent. **Accepted:** a rejected first send can still leave B's request queued; it's a liveness issue, and the error says to re-salt |
| N2 | Info | Validator A's pin re-read every one of the agent's validations on every poll while it waited | **Fixed in `33772ff`:** requests naming another validator or agent are cached (they never change) |
| N3 | Info | The posting gate reads the capped `simulate_action` output, so a forward the cap trimmed would be invisible | **Fixed in `915a83c`:** `VALUE_FLOWS_TRUNCATED`. All 12 posted B verdicts would still post |
| N4 | Info | This document was untracked when the auditor looked | Committed before the push |

It checked as sound: the gas-guard split (the abort and replaced-transaction checks are kept); the SDK base's new order
(a status read still precedes `check()` and every send); `deploy-testnet.sh` (the key reaches forge only through its
environment, and the `monad_testnet` alias resolves to chain 10143); and the CRE receipt check (only the forwarder's
`ReportProcessed` naming C counts, and a missing transaction hash fails closed). In its words: "None of the Lows is
wrong."

## 5. Known items cleared

Deferred items from earlier phases, cleared in this one.

| Item | Status |
|---|---|
| Literal U+202E and U+FEFF characters in three test files (GitHub's hidden-Unicode warning) | Rewritten as `\u` escapes in `fe9fd3a`; a checker and a required CI job (`unicode`) in `fe9fd3a` and `6e30b64` |
| CI on `ubuntu-latest`, with no timeouts, and a fork job set to `continue-on-error` | `6e30b64`: every job is on `ubuntu-24.04` with a timeout. `contracts-fork` is required, and retries the whole fork suite up to 3 times, 60 s apart, for the public RPC's rate limit; a real failure still fails it. actionlint is clean |
| Coverage gaps: stateful invariants, `crossOrigin`, the auditor's PoCs | `afa0696`: gate and vault invariants (mutation-checked) and known-limitation tests |
| CRE `gas.max` near the evidence cap | `5861588`: 1,160,000, because the inner estimate is floor-bound at the cap |
| CRE landing check from the read-back only; any estimate error read as a revert; an unreachable branch | `933953c`: `ReportProcessed` decoded from the write's receipt. A live take landed both reports, and `verify` matched |
| `cre:demo`'s `JSON.parse` in the stream handler; the `NOT_LANDED` output | `0a26a07` |
| P10's wordings (`FUNDS_FORWARDED`'s rule, the release trace, whose contracts, the token-drain line, `debug_traceCall` with `withLog`) and the fork test's comments | `cc94049`, `3d6de12` (and the `isBlacklisted` assertion) |
| The workflow's `NOT_FINAL` throw | Accepted for simulation: the production path's finality wait is already in docs/cre.md §11 |
| The forge-lint `unused-return` warning at `CreValidator.sol:72` | Accepted: silencing it would change the deployed contract's CREATE2 address (also Slither S3, a false positive) |

## 6. Slither and Aderyn

**Slither 0.11.6:** 11 results; 10 false positives and 1 informational, no true positive. The auditor's triage, checked
by the builder:

| # | Detector | Location | Verdict | Why |
|---|---|---|---|---|
| S1 | arbitrary-send-eth | `DemoAgentVault.execute` | FP | The target and value are exactly what A and B passed for this `requestHash` |
| S2 | unused-return | `AttestGate._checkVerdict` | FP | `responseHash`/`lastUpdate` are deliberately ignored; validator, agent, score and tag are checked |
| S3 | unused-return | `CreValidator.onReport:72` | FP | Only `responseHash`/`tag` are needed for write-once |
| S4 | calls-loop | `AttestGate._checkVerdict` | FP | At most 4 view calls to an immutable registry; any failure reverts (fails closed) |
| S5 | timestamp | `AttestGate._consumeValidation` | FP | Deadline semantics; seconds of skew are harmless |
| S6 | timestamp | `MandateRegistry._validate` | FP | `validUntil` at set time |
| S7 | timestamp | `ValidationRegistry.validationRequest` | FP | Mislabelled: the `validatorAddress != 0` check shares a slot with `lastUpdate` |
| S8 | cyclomatic-complexity | `AttestGate` constructor | Info | A bounded validation loop |
| S9 | solc-version `^0.8.0` | `IReceiver.sol` | FP | Built with a pinned solc 0.8.37; the listed bugs don't apply |
| S10 | low-level-calls | `DemoAgentVault.execute` | FP | Intended; the return is checked (`CallFailed`) |
| S11 | low-level-calls | `DemoPassThrough.receive` | FP | Intended; the return is checked (`ForwardFailed`) |

**Aderyn 0.6.8:** 10 issue types (2 "High", 8 Low), 26 instances. Every one is a false positive or a style note:

| # | Issue | Verdict | Why |
|---|---|---|---|
| H-1 | ETH sent without an address check (`DemoPassThrough`) | FP | Forwards to an immutable sink by design |
| H-2 | State change after an external call (`AgentRequestForwarder`) | FP | View calls to the fixed registries; no reentry path |
| L-1 | SSTORE in a loop (`MandateRegistry`) | FP | Bounded at 16 each |
| L-2, L-3, L-8 | Literals, a modifier used once, an unspecific pragma | Info | Style (solc is pinned in foundry.toml) |
| L-4 | PUSH0 | FP | Osaka was verified on Monad; the deployed code matches the build |
| L-5 | `revert` in a loop | FP | Intended, fail-closed |
| L-6 | Unchecked return (`AttestGate:106`) | FP | The `actionHash` return is informational; failures revert |
| L-7 | Uninitialised local (`AttestGate:86`) | FP | Zero-initialisation intended |

Neither tool found AUD-01 to AUD-06: those are protocol-level issues.

## 7. Coverage

`forge coverage --ir-minimum`, unit and fuzz tests (fork tests excluded):

| File | Lines | Statements | Branches | Functions |
|---|---|---|---|---|
| `ActionHash` | 4/4 | 4/4 | none | 2/2 |
| `AgentRequestForwarder` | 17/17 | 23/24 | 4/5 | 3/3 |
| `AttestGate` | 59/59 | 78/78 | 39/39 | 9/9 |
| `CreValidator` | 22/22 | 37/37 | 8/8 | 3/3 |
| `DemoAgentVault` | 11/11 | 8/8 | 2/2 | 5/5 |
| `DemoPassThrough` | 6/6 | 7/7 | 2/2 | 2/2 |
| `FindingsBoard` | 3/3 | 3/3 | 1/1 | 1/1 |
| `MandateRegistry` | 90/90 | 106/106 | 17/17 | 16/16 |
| `ValidationRegistry` | 57/57 | 76/76 | 13/13 | 10/10 |
| **`src` total** | **269/269** | **342/343** | **86/87** | **51/51** |

- **The one miss** is `AgentRequestForwarder.sol:42` (`ZeroIdentityRegistry`), which can't be reached with this
  registry.
- **The numbers were the same before and after P12.** What P12 added is scenarios, not lines:
  - stateful invariants on the gate and vault: each action executes at most once; MON leaves only through a validated
    `execute`; consumed means executed once;
  - the invariants were mutation-checked: removing the single-use check, or skipping B's requirement, makes them fail;
  - known-limitation tests from the auditor's PoCs;
  - the `crossOrigin` case.
- **Under coverage instrumentation,** the 19 `Deploy*.t.sol` tests that pin CREATE2 addresses fail, because the
  instrumented bytecode differs; plain `forge test` passes them.

## 8. Secrets, dependencies and headers

### 8.1 gitleaks

gitleaks 8.30.1, with the repo's config, over every commit on every ref (`--log-opts="--all"`).
- **At the audited commit:** 209 commits, **no leaks**. The auditor re-ran it with the default rules only, also clean.
- **At the end of P12:** 234 commits on every ref, **no leaks** (§9).
- **Checked by hand:** `.env.example` (every secret blank), `contracts/broadcast/*/run-latest.json` (no URLs or keys),
  and the test fixtures (patterned or label-derived test keys only).

### 8.2 Keys during this review

**One local exposure.** AUD-07's first test run, before the fix existed, executed the unmodified deploy script. That
script ignored the test's env file and sourced the repo's real `.env`, so the test's stub `forge` wrote the testnet
deployer key to two files under `/tmp`.
- **Contained:** the files were shredded within a minute. The key was never printed, logged or sent anywhere.
- **The test is safe now:** it runs a copy of the script inside a throwaway tree, so its `.env` can only be the
  test's own.

### 8.3 Dependencies

**`pnpm audit --prod`:** 14 advisories (5 high, 2 moderate, 7 low), all under `indexer > envio` (express 4.19.2 and its
middleware, `ws`, `esbuild`). None reaches the web bundle, the SDK, the validators or the CLI.
- **envio's Express app:** fixed-string routes only, and no body-parser, static or cookie middleware.
- **ws:** the WebSocket client in that path is unused.
- **esbuild:** the advisory is a Windows dev-server issue; envio uses esbuild for transpiling only.
- **qs:** could matter only if Envio Cloud exposed the indexer's internal port. The impact would be a denial of service
  on a convenience, since the indexer isn't a trust root. Unverified.

**`bun audit`** (`cre/validator-c`): no vulnerabilities.

### 8.4 The headers attest8004.vercel.app actually serves

Checked with `curl -sI`, with no browser, on 6 Oct 2026 at 14:56 UTC, before the P12 changes, on:
- `/`, `/approve`, `/inbox` and `/dashboard`;
- one JavaScript asset.

| Header | `web/vercel.json` | Served |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; connect-src 'self' https://testnet-rpc.monad.xyz https://indexer.dev.hyperindex.xyz/3d57e4d/v1/graphql; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'` | identical on every path |
| `X-Frame-Options` | `DENY` | identical |
| `Referrer-Policy` | `no-referrer` | identical |
| `X-Content-Type-Options` | `nosniff` | identical |
| `Cross-Origin-Opener-Policy` | `same-origin` | identical |

- **No mismatch,** so no finding.
- **Vercel also adds** `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` and
  `Access-Control-Allow-Origin: *`. The latter is harmless for a public static app that uses no credentials.
- **After the push,** with AUD-12's `Permissions-Policy`: see §9's addendum.

## 9. Final checks

Run on the final tree before the push (`915a83c` plus these documents). The full output is in
`../plans/p12-checks-final.log`, outside the repo.

| Check | Result |
|---|---|
| `forge fmt --check`, `forge build` | clean |
| Unit, fuzz and invariant tests (`FOUNDRY_PROFILE=ci`: 10,000 fuzz runs, 256 invariant runs) | 250 passed |
| Fork tests against Monad testnet | 36 passed |
| `vectors.sh --check`, `passkey-vectors.sh --check` (against `cast`), `make-inbox-vectors.ts --check` (against `node:crypto`) | all match |
| `pnpm typecheck` | clean |
| `pnpm test` | 1,659 passed: indexer 60, SDK 358, web 41, `mandate-v1` 359, `risk-v1` 538, scripts 221, CLI 82 |
| Web build (what Vercel deploys) | built |
| `cre/validator-c`: `bun test`, typecheck, WASM compile | 70 passed, clean, built |
| Hidden Unicode (bidi, zero-width) over every tracked file | none |
| gitleaks over every commit on every ref (234) | no leaks |
| Frozen formats (`mandate-v1` and `risk-v1` evidence, the `risk-v1` prompt, inbox envelope v1, their vectors and fixtures) and `contracts/src`, since `32b55a1` | unchanged |

**After the push of `8e2f00e`:**
- **CI** ([run 37514273458](https://github.com/AmitChowdary122/attest8004/actions/runs/37514273458)): all six jobs green
  on `ubuntu-24.04`. That includes the now-required `contracts-fork` and the new `Hidden Unicode` job.
- **The keep-alive workflow** ([run 37514531096](https://github.com/AmitChowdary122/attest8004/actions/runs/37514531096)):
  green on `ubuntu-24.04`.
- **Vercel** serves `8e2f00e`.
- **The live headers,** with `curl -sI` on `/`, `/approve`, `/inbox`, `/dashboard` and the JavaScript asset at
  18:50 UTC on 6 Oct: all six headers in `web/vercel.json` are served exactly, the new `Permissions-Policy` included.
- **In the browser,** on the real host, the page still allows `publickey-credentials-get`/`-create` and
  `clipboard-write`, and denies camera and geolocation. The console is clean.

**What P12 spent on testnet:** two request pairs from agent 1985's hot key (0.064 MON each) and one `pnpm cre:demo` take
(about 0.05 MON of the CRE key and 0.064 MON of agent 1984's hot key). Nothing was deployed, and no Groq or Nansen
call was made.
