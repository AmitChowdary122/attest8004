# STATUS

Running log, updated at the end of every session (CLAUDE.md, rule 10). Newest session first.

---

## Sat 3 Oct 2026 · P4 MandateRegistry, mandate-v1 and verify

### Done
- **The P3 e2e, re-run after the P3 review fixes: passed.** Request `0x09de350a…`, response `0x5d51d39c…` (estimate 86,740, limit 105,000), execute `0x9c28cc68…`. The stub validator answered only its own request, and a restarted one skipped it (`ALREADY_RESPONDED`). CI on the P3 head (`d2a73f2`) passed all four jobs.
- **Measured the public RPC (`testnet-rpc.monad.xyz`) before designing:**

  | Question | Result |
  |---|---|
  | How much history is served | About 14.6M blocks, about **51 days**. From block 53,246,440 (head then 67,831,402), `eth_call`, `eth_getBalance`, `eth_getCode` and `eth_getStorageAt` answer, and old balances differ from today's, so the node really reads the past. Older blocks fail with `-32602` ("historical state that is not available"). |
  | Block time | 0.305 s, so 24 h ≈ 283,500 blocks |
  | `finalized` lag | 0–1 blocks behind `latest` |
  | `eth_getLogs`, 100 windows of 100 blocks (Identity Registry and forwarder, 6 event types) | 68.8 s sequential, 18.3 s at concurrency 4, **9.3 s at concurrency 8**, no errors. 24 h of logs would take about 4.4 min per verdict. |
  | Simulation errors | A revert is code `3` with revert data; too little balance for `value` is `-32003`. Multicall3 is deployed. |

  **What that decided.** Every input is re-read from chain state at one pinned block, so `verify` works on the public RPC for about 51 days (an archive RPC after that). The real constraint is the 100-block `eth_getLogs` limit, so spend doesn't scan logs: which approvals exist comes from state (`getAgentValidations` and each status at the pin), and each amount from that approval's own posted evidence, found with one targeted `eth_getLogs` and authenticated by its `responseHash` and recomputed `requestHash`. The permission window is 6,000 blocks (about 30 min, 60 queries, about 6 s).
- **`MandateRegistry`** (`contracts/src/MandateRegistry.sol`), tests committed before the contract:
  - One mandate per agent: allowed targets and selectors (at most 16 each), a per-tx and a per-day cap in native MON, and `validUntil`. It rejects a zero target, `validUntil` at or before now, and a per-tx cap above the daily cap.
  - **Owner-set in P4.** `setMandate` and `revokeMandate` work only from the agent's current `ownerOf` (an operator or token-approved address is refused). Both go through one internal hook, `_authorize(agentId, changeHash)`, before any write; P6 puts a WebAuthn assertion there, as a new deployment.
  - The record stores the owner who set it and `setAtBlock`, a block number (SPEC's `setAt` was a time; the permission rule compares block order). `MandateSet` has `owner` as its third indexed topic.
  - 10 unit and fuzz tests (a harness proves every change goes through the hook before any write), 6 deploy-script tests and 2 fork tests.
  - **Deployed:** `0x2523197373ef813E19b5b14Ef2984130868cD17c` (commit `6e08223`, tx `0x1222b700…`, block 67,842,487), through CREATE2 with the estimate guard.
- **SDK (`@attest8004/sdk`):**
  - Canonical JSON (`canonical.ts`: sorted keys, no whitespace, bigints as decimal strings), `computeRequestHashFromParts`, the MandateRegistry and Identity Registry ABIs, and `DEPLOYMENTS` (moved here from `scripts/`, now with each registry's deploy block).
  - The validator base: `accepts()` can return `{ decline: "<reason>" }`, logged once at `warn`; an `onResponded()` hook runs once per response that lands; a response's gas limit can be evidence-sized (`{ headroomPercent, max }`); `buildEvidence()` publishes canonical evidence.
  - `Admission`: a per-agent rate limit and a validator-wide daily gas budget. Each admitted request reserves the response cap, settled to the limit actually sent.
- **`mandate-v1`** (`validators/mandate/`):
  - Pure rules (`rules.ts`): 12 reasons in a fixed order; any failure scores 0.
  - A pinned-block reader (`reader.ts`). Every read is a raw `eth_call` at the pin, behind one shared concurrency limit.
  - The collector (`collect.ts`): the mandate and owner, spend (above), the permission window `(P − 6,000, P]` (Identity Registry `Transfer`/`Approval`/`ApprovalForAll`, the forwarder's `AgentKeySet`, `MandateSet`/`MandateRevoked`, compared by `(block, logIndex)`), and a simulation of the action from the gate.
  - `MandateValidator` (`validator.ts`): `accepts()` answers only allowlisted gates and agents with an unexpired mandate set by their current owner, then applies admission. The pin is the finalized head, never below the request's block, this process's last response or the MandateRegistry's deploy block, and it waits until this process's last approval is visible there.
  - **The service:** `pnpm --filter @attest8004/validator-mandate start`. Settings come from `.env` (`MANDATE_V1_*` in `.env.example`); it refuses to start unless the RPC's chain and both registries' Identity Registry match the recorded deployment. One process per key.
  - **`verify`:** `pnpm attest8004 verify <requestHash> [--rpc-url URL] [--json]` from the repo root. It re-runs the verdict at its pinned block with an empty cache and compares the score and `responseHash`. Exit 0 match, 1 mismatch (public proof the validator misbehaved), 2 could not verify. It defaults to the public RPC, needs no `.env`, and never prints the URL. There is no `npx attest8004`: the package is private and has no `bin`.
- **Scripts:**
  - `setup-demo-agents`: per-token approvals, revokes the blanket one, and `--fund-validator` tops validator A up to 2 MON (read back afterwards).
  - `set-mandate`: agent 1984's e2e mandate. It is idempotent, and checks the permission window the way `mandate-v1` does (at most 60 queries).
  - `e2e`: rewritten for `mandate-v1` (below).
  - **The P3 stub validator and its test are deleted**, so validator A's key signs only `mandate-v1` verdicts from now on.
- **Least privilege on testnet.** Demo agents 1984 and 1985 each have a per-token `approve(forwarder, agentId)`, and the deployer's blanket `setApprovalForAll(forwarder)` is revoked; ARCHITECTURE §7 explains both modes. Agent 1984's mandate: the deployer only, plain MON transfers only (`0x00000000`), 0.002 MON per tx, 0.005 MON per day, valid until 2026-10-31T00:00:00Z, `setAtBlock` 67,890,013 (after the approval changes).
- **Every testnet transaction this session** had an explicit limit, checked against a fresh estimate. Each receipt's `gasUsed` equals its limit (Monad charges the limit).

  | Transaction | Block | Monad `eth_estimateGas` | Limit |
  |---|---|---|---|
  | P3 e2e rerun: `forwarder.request` `0x09de350a…` | | — | 315,000 (SDK default) |
  | P3 e2e rerun: `validationResponse` (stub) `0x5d51d39c…` | | 86,740 | 105,000 |
  | P3 e2e rerun: `execute` `0x9c28cc68…` | | — | 106,000 |
  | Deploy `MandateRegistry` `0x1222b700…` | 67,842,487 | 834,877 | 1,010,000 |
  | `approve(forwarder, 1984)` `0xdd51f04b…` | 67,889,819 | 79,523 | 96,000 |
  | `approve(forwarder, 1985)` `0x0445510c…` | 67,889,825 | 79,523 | 96,000 |
  | `setApprovalForAll(forwarder, false)` `0x27c2245b…` | 67,889,831 | 54,444 | 66,000 |
  | Fund agent 1984's hot key, 0.097854 MON `0x8a6a68c0…` | 67,889,842 | 21,000 | 26,000 |
  | Fund agent 1985's hot key, 0.001464 MON `0x77e0ff03…` | 67,889,847 | 21,000 | 26,000 |
  | Fund validator A to 2 MON, 1.55865 MON `0x4a15f7b0…` | 67,889,852 | 21,000 | 26,000 |
  | `setMandate(1984, …)` `0x0b961153…` | 67,890,013 | 254,362 | 306,000 |
  | e2e `forwarder.request` A `0xdf56b446…` | 67,896,188 | about 251,900 (setup's simulation) | 315,000 (SDK default) |
  | e2e `forwarder.request` B `0x4be3145c…` | 67,896,193 | about 251,900 | 315,000 |
  | e2e `validationResponse` A → 100 `0xef94ea65…` | 67,896,224 | 127,781 | 153,338 (estimate × 1.2, cap 400,000) |
  | e2e `validationResponse` B → 0 `0xc429d953…` | 67,896,251 | 148,451 | 178,142 (same policy) |
  | e2e `execute(A)` `0xb666247e…` | 67,896,267 | 87,626 | 106,000 |

  Full hashes of the P4 transactions are in `docs/deployments.md` (the P3 rerun was a check of the P3 fixes and isn't recorded there). Negative cases were simulated, never sent.
- **End to end with `mandate-v1`** (`pnpm --filter @attest8004/scripts e2e`, `e2e OK` on the first live run). Agent 1984's hot key requested two actions through the forwarder before any validator ran:
  - **A**, 0.001 MON to the deployer: **100**, no reasons. Executed by the deployer (permissionless); the vault fell by exactly 0.001 MON, `consumed` is true, and a replay reverts `ActionAlreadyConsumed` (simulated).
  - **B**, 0.003 MON to an unlisted address (`0xFdD9…671F`): **0**, `[TARGET_NOT_ALLOWED, VALUE_OVER_TX_CAP]`. `execute(B)` reverts `ScoreTooLow(validator A, B, 0, 100)` (simulated). B's pin waited for A's approval, so B's spend lists A's 0.001 MON as counted.
  - A freshly started validator skipped both (`ALREADY_RESPONDED`); exactly one `ValidationResponse` exists for each.
  - `verifyRequest` re-ran both with a fresh reader and an empty cache: both **match**. So did the CLI, from a fresh shell (output abbreviated):

    ```
    $ pnpm attest8004 verify 0xd0ca15eae05d88cc58f404494ae58ad70055f84b7f72573fd60acfc43c6cd283
    match: re-running mandate-v1 at block 67896198 gives the posted score and responseHash
    score              posted 100, recomputed 100
    responseHash       posted     0x6f2011dc…fbc08a
                       recomputed 0x6f2011dc…fbc08a
    reasons            none
    spend              0 mandate-v1 approval(s) in the 25 h window
    exit: 0

    $ pnpm attest8004 verify 0x85b92cb27c06a013bd63c9ee51e29b6329570ccd784a3e2941496f2c4a5965e9
    match: re-running mandate-v1 at block 67896225 gives the posted score and responseHash
    score              posted 0, recomputed 0
    responseHash       posted     0x7631feb9…4bf4bd
                       recomputed 0x7631feb9…4bf4bd
    reasons            TARGET_NOT_ALLOWED, VALUE_OVER_TX_CAP
    spend              1 mandate-v1 approval(s) in the 25 h window
                       0xd0ca15ea…c6cd283  1000000000000000 wei (0.001 MON)  counted
    exit: 0
    ```
  - Balances afterwards: agent 1984's hot key 0.08946 MON (one more run at the 122 gwei maximum fee), validator A 1.966 MON, the vault 0.007 MON. Validator B holds 0 MON.
- **Review-driven fixes worth knowing** (each test-first):
  - **No CCIP-Read.** viem's `call` and `readContract` follow an `OffchainLookup` revert: an unpinned second call and a request to an attacker's URL from the validator. Every reader call is now a raw `eth_call` at the pin, and a test proves `fetch` is never called.
  - **A malformed RPC answer never becomes chain state.** A reply whose result isn't a 0x-hex string is an RPC failure (retry), checked once in the reader's `eth_call`, which covers simulation and `consumed()` too.
  - **`consumed()` on a gate with no code counts as unknown, so it counts toward spend** (fail closed). Throwing instead let a colluding hot key and validator make an agent's verdicts unverifiable for 25 h.
  - **Fixed `SPEND_HISTORY_UNREADABLE` texts**, not zod's issue text, so the evidence hash can't change with a library upgrade.
  - **One RPC concurrency limit** (there were two pools, about 17 requests in flight), so public-RPC 429s don't fail cycles.
  - **A logger can't break a landed response.** The SDK's default logger threw on bigints inside `respond()`'s `try`, so a landed response looked failed and `onResponded` never ran. It is bigint-safe now, and a logger error never reaches control flow.
  - **`accepts()` retries when the finalized head is behind the request's block**, instead of a permanent `NO_MANDATE` decline on a lagging node.
  - **`verify` proves a wrong request block from state** (`REQUEST_BLOCK_WRONG`, exit 1): a request exists from exactly one block, so a validator can't make its verdict unverifiable by misstating that field. A request block before the ValidationRegistry existed is wrong too, and a pin before the MandateRegistry existed is `PIN_OUT_OF_RANGE`.
  - **`MandateValidator` pins its request-size limit** to the SDK's 16 KB, which `verify` uses, so an honest validator configured otherwise can't be accused (`REQUEST_INVALID`).
  - **A tag alone proves nothing:** another validator's verdict (`NOT_MANDATE_V1`) and evidence that isn't inline, or is too large, exit 2, not 1.
  - **`set-mandate`'s ordering check** scanned back from the head with no real bound; it now checks exactly `mandate-v1`'s rule in its 6,000-block window.
  - **`pnpm -s` doesn't exist in pnpm 12.8.1** (`pnpm run`'s `-s` is gone). The CLI usage, its test and ARCHITECTURE §5.5 now say `pnpm --loglevel silent attest8004 verify … --rpc-url <url>`, checked to print no echoed command line.
- **Tests:**
  - 146 forge unit and fuzz tests (10k fuzz runs in `ci`) and 14 fork tests;
  - 157 SDK tests;
  - 311 `mandate-v1` tests (rules, reader, block search, concurrency, collector, validator, evidence, config, verify, CLI);
  - 7 script tests.
- **Whole-branch check, fresh runs on the final tree:** `forge fmt --check`, `forge build --sizes` (MandateRegistry 3,527 B runtime), the `ci`-profile unit and fuzz tests, the fork tests against Monad testnet, `vectors.sh --check` (8 vectors match `cast`), `pnpm -r typecheck`, `pnpm test`, the SDK build and `gitleaks` over the full history: all clean.
- **Docs:** README (status, `mandate-v1` leads the architecture as the reason to trust a verdict, the MandateRegistry in the deployments table, the quickstart's `set-mandate`, `e2e`, `verify` and the validator service); `contracts/README.md` (MandateRegistry and its tests, the deploy script); `docs/README.md`; `docs/deployments.md`; ARCHITECTURE header, §2, §5.1, §5.2, §5.5, §6, §7, §9 (the daily cap; caps are native MON only) and §13; SPEC §4.2, §4.4, §4.5 and §4.8.

### Next
- **P5:**
  - `risk-qwen-v1` runs its paid checks only after `mandate-v1` has passed the same action. Its validator-A `requestHash` is computable from the same action, so B reads A's status first.
  - **When redeploying the vault, give each gate requirement a required tag hash** (an immutable `bytes32`), so the gate accepts only `mandate-v1`-tagged verdicts from validator A. That makes "validator A signs only `mandate-v1`" a contract guarantee instead of key discipline. Mark the agent-1984 vault superseded.
  - Fund validator B (0 MON today), and pick `risk-qwen-v1`'s `minScore`.
- **P6:** a new `MandateRegistry` with WebAuthn in `_authorize`. `verify` checks a verdict's contracts against the SDK's `DEPLOYMENTS`, so it needs a way to handle P4-era verdicts that name the old registry (for example `--mandate-registry`).
- **P7:** `mandate-v1`'s evidence must stay **public plaintext at `responseURI`**, because spend accounting and `verify` read it. Encrypted findings go in a separate field or URI and never replace it.
- **P8:** index the six permission events `mandate-v1` reads (Identity Registry `Transfer`, `Approval` and `ApprovalForAll`; the forwarder's `AgentKeySet`; `MandateSet` and `MandateRevoked`), with `MandateSet` also feeding the `Mandate` entity; then `getAgentTrust`.
- **P10 threat-model items:**
  - Token-moving selectors (`transfer`, `approve`, …) aren't amount-capped: the caps cover native MON only.
  - Spend counts only `mandate-v1` approvals, so a validator key must sign only its own validator's tag (key discipline until the P5 tag requirement).
  - Admission is in memory, so a restart resets the rate limit and the gas budget. Run one process per key; the pin also relies on it.
  - An agent can stall its own approvals with oversized evidence (many spend entries or permission events against the 400,000 gas cap).
  - `getAgentValidations` grows with each agent's history, and every check reads every status.
  - An attacker can wait out the 6,000-block (about 30 min) permission window before acting.
  - The public RPC serves about 51 days of history; older pins need an archive RPC.
  - Hardening from the reviews: `block()`/`finalized()` should reject a malformed answer (a null number or hash) the way `eth_call` does; a restart loses the pin floors (seed them from `latest` at the first poll); `verify` recognises the registry's `UnknownRequest` only as JSON-RPC code 3, so an archive RPC that reports reverts as `-32000` fails safe to exit 2; an inline `MONAD_TESTNET_RPC_URL=…` lands in shell history (`.env` is the alternative); the preimage cache is never pruned; a custom logger that throws can fail a cycle, and one that returns a rejected promise escapes the base's guard as an unhandled rejection, which stops the process (neither loses or doubles a response); `Admission.settle` doesn't validate the gas limit.
- **Deferred minors** (when convenient):
  - Tests: no passing case at exactly 16 targets or selectors, or for an empty selector list in the rules; `selectorOf`'s malformed-hex path; `MandateSetLogNotFoundError`, `REQUEST_NOT_FOUND` on an agent mismatch, and nested `UnknownRequest` shapes in `verify`; an http-transport reader test with mocked `fetch`; the settle-failure log line; a `headroomPercent` `RangeError`; two misnamed tests (`collect.test.ts` "(consumed, status)", `evidence.test.ts` "unreadable spend").
  - No committed test compares `mandateRegistryAbi` with forge's compiled ABI (CI's TypeScript job has no forge; checked by hand).
  - `canonicalJson` has no cycle guard; `resolveGasLimit` checks `headroomPercent` after its RPC round trips; the `tag` and `maxDeadlineAheadSeconds` options are silently ignored by `MandateValidator`; block-timestamp lookups aren't memoized within one check; leftover permission-window requests can queue ahead of the next cycle after an early failure; `nodeCliDeps.connect` resolves `deploymentsFor` twice; `main.ts` logs the RPC host (never the URL).
  - SIGINT isn't seen during a pin wait (up to 30 s; a second Ctrl-C kills the process).
  - `verify --json` prints nothing on a thrown error (stderr only, exit 2); exit 1 is also Node's crash code, so treat the `--json` verdict as authoritative; the usage's exit-2 line doesn't mention another validator's tag.
  - `validators/mandate` exports only under the `@attest8004/source` condition (fine for the workspace; publishing needs a build, a P11 decision).
  - viem with a custom EIP-1193 transport and `retryCount > 0` retries wrapped reverts (code -1) before they are classified.
  - `_authorize` runs before the mandate is validated, so a stranger sending an invalid mandate gets `NotAgentOwner`. Kept: authorisation first is the right order for P6.
- **Before a demo re-run:**
  - The e2e's exact check on B's reasons holds for 2 runs per 25 h. A third run adds `DAILY_CAP_EXCEEDED` to B and the script stops there; A itself fails from the 6th. The recorded run (18:05 UTC, 3 Oct) is the first, so one more fits until about 19:05 UTC on 4 Oct.
  - Agent 1984's hot key has one run left: top it up with `setup-demo-agents -- --fund`.
- **Still deferred from P1–P3:** the deployer key in forge's argv; three test gaps; `timeout-minutes` on `contracts-fork`; a README note that each round trip registers a new agent; halving the `eth_getLogs` window when a window keeps failing; a second response if a send is still pending after viem's 180 s receipt timeout; `gated-execute` and `roundtrip` still send with only `gas`; `awaitVerdict` aborts on one `eth_getLogs` error and scans up to `latest`.

### Blockers or decisions needed
- **Decisions I made (all reversible; flag any you disagree with):**
  - **Spend: which approvals exist comes from state at the pin; each amount from its own authenticated evidence.** A log that can't be found is retried, never a verdict. Only evidence that was found and fails its checks scores 0 with `SPEND_HISTORY_UNREADABLE`.
  - **Approvals count toward spend** if consumed, if unconsumed with a deadline not yet passed, or if `consumed()` gives no answer (fail closed); one that expired unconsumed never counts.
  - **The spend window is 25 h on approval time**, because the registry records approval, not execution, and the deadline horizon is 1 h. Cost if wrong: over-counting by up to an hour.
  - **The permission window is N = 6,000 blocks** (about 30 min, about 6 s of queries). 3,000 or 10,000 were the alternatives.
  - **Only `mandate-v1`-tagged approvals count**; the stub validator is deleted, so validator A's key signs only `mandate-v1`.
  - **The pin** is the finalized head, floored at the request's block, this process's last response and the MandateRegistry's deploy block, and waits (250 ms polls, up to 30 s, then a retry) until this process's last approval is visible. One process per key. The base's deadline checks use the cycle's head; `mandate-v1` re-checks the deadline at the pin (`ACTION_EXPIRED`).
  - **`0x00000000` in an allowlist means empty calldata only**; 1–3 bytes of data, or non-empty data starting with `0x00000000`, never match; an empty allowlist allows nothing.
  - **A mandate is stale when its owner no longer owns the agent** (`MANDATE_OWNER_CHANGED`).
  - **`setAtBlock` replaces `setAt`**, and `MandateSet` indexes `owner` as its third topic.
  - **A response's gas limit is its estimate × 1.2, capped at 400,000**, per transaction; every other transaction keeps a literal limit.
  - **Admission:** in memory, clocked by the head's timestamp; 20 requests per agent per hour and 10,000,000 gas a day, overridable in env; one `warn` line per skip. The gas budget is validator-wide and the rate limit per agent. Cost if wrong: one busy agent can use up the budget for everyone (that is the intent: it caps the validator's spend).
  - **`accepts()` reads the mandate at the finalized head, not at the pin**: it decides only whether to answer, not the verdict.
  - **`verify` is `pnpm attest8004 verify`**, a root script running the TypeScript source (no `npx` until a package is published), with the public RPC by default.
  - **`verify` exit codes:** 1 only for a proven mismatch (`SCORE_MISMATCH`, `RESPONSE_HASH_MISMATCH`, `EVIDENCE_HASH_MISMATCH`, `PIN_OUT_OF_RANGE`, `REQUEST_BLOCK_WRONG`, `REQUEST_INVALID`); 2 for anything not found, an RPC error, another validator's tag or evidence it can't decode. Cost if wrong: a script that treats exit 2 as a mismatch.
  - **`verify` checks contracts against the SDK's `DEPLOYMENTS`**, which moved into the SDK; evidence naming another MandateRegistry doesn't reproduce.
  - **The `_authorize` hook is internal**; P6 is a new deployment, and `mandate-v1` takes the registry address from `DEPLOYMENTS`.
  - **Agent 1984's e2e mandate** (the deployer only, plain transfers, 0.002/0.005 MON, until 31 Oct) was set after the approval changes, so they predate it.
  - **Without a mandate**, `mandate-v1` still reports `ACTION_EXPIRED`, `PERMISSION_CHANGED_AFTER_MANDATE` and `SIMULATION_FAILED`, which need no mandate field. Cost if wrong: one extra reason on no-mandate verdicts.
  - **`consumed()`:** a revert, out of gas, or no data at all (a gate with no code) is "no answer" and counts; a transport or RPC error, or a malformed reply, throws and is retried. A call that succeeds with undecodable data also throws (it could be an RPC fault). Cost if wrong: one over-counted approval for an approved gate with no code, or an agent stalled until that approval leaves the 25 h window.
  - **The current mandate's `MandateSet` log** is the agent's last `MandateSet` in block `setAtBlock`; if it should be in the window but isn't found, the check is retried. Cost if wrong: a retry instead of a verdict.
  - **`onResponded` stays silent** when a send landed but its call failed and the retry finds it answered. The budget stays reserved at the cap (over-counts, never under-counts), and the pin waits for the last approval by a status check instead. Cost if wrong: one extra status read per check.
  - **The preimage cache keys are lower-case hashes.** Cost if wrong: cache misses (still correct).
  - **All work is on `main`**, as in P1–P3. Cost if wrong: move the commits to a branch before pushing.
  - **Review findings I graded up and fixed** (each above, under Done): fixed `SPEND_HISTORY_UNREADABLE` texts; one RPC limiter; the SDK logger; `accepts()` retrying on a lagging head; the pinned request-size limit; one guard for malformed `eth_call` answers; oversized evidence is "could not verify", not proof; no `npx` claim; `verify` redacts only error text, never the report (redacting could rewrite a hash); the bounded `set-mandate` check, with ARCHITECTURE §7 restructured and the validator funding read back. Each cost a few lines.
- **Your side:**
  - `git push` (the P4 commits: 31 on `main` as of this entry, none pushed), then check CI.
  - Still open: the Envio token, Nansen credits, the Vercel deploy, the integration offer (GAMEPLAN §6) and the team DMs. Qwen is deferred to P5 (any OpenAI-compatible endpoint).

## Sat 3 Oct 2026 · P3 SDK, validator base, AgentRequestForwarder and demo agents

### Done
- **Who sends `validationRequest`: decided and built.** The agent's hot key sends it through **`AgentRequestForwarder`** (`contracts/src/AgentRequestForwarder.sol`), which you approved as an addition to SPEC §4.4.
  - The owner calls `setApprovalForAll(forwarder, true)` once, then `setAgentKey(agentId, key)` per agent. Only the current `ownerOf` may set or revoke (`address(0)`) a key, and the record stores that owner.
  - `request(validator, agentId, requestURI, requestHash)` works only from that key, and only while the recorded owner still owns the agent. It makes exactly one call: `validationRequest` on the fixed ValidationRegistry.
  - It is immutable, has no admin and holds no funds. It reads the Identity Registry from the ValidationRegistry, so the two can't disagree.
  - **Tests first** (committed before the contract):
    - 26 unit and fuzz tests, 6 deploy-script tests and 3 fork tests.
    - Cases: wrong key; a key set by a previous owner after a transfer, even when the new owner also approved the forwarder (`StaleAgentKey`); a revoked key; A→B→A (the key works again; pinned and documented); and a per-token `approve` instead of `setApprovalForAll` (works for that agent only).
    - **That it can do nothing else:** a state-diff recording of every call it makes (one `CALL`, to the registry, with exactly `validationRequest(...)`; the rest are `ownerOf` reads), the compiled ABI pinned to five functions, ERC-721 calls sent to it refused, no funds, fuzzed calldata.
    - 6 hand mutants are each caught.
  - **ARCHITECTURE §7 records the trade-off:** `setApprovalForAll` covers all of the owner's agents, but the forwarder only exposes `validationRequest`. It also covers the residual risks (a forwarder bug, a stolen hot key, ownership changes) and the narrower alternative, a per-token `approve(forwarder, agentId)`, which works unchanged.
  - **Deployed:** `0x1451F3C36545b191d3642f759D59f21DcFD657B2` (commit `5f2f4a4`), through CREATE2 with the estimate guard; gas limit 490,000 (estimate 407,868).
- **Request JSON v1** is now a strict zod schema with `validator` (`packages/sdk/src/request.ts`).
  - **`deadline` is a decimal string** like `agentId` and `value`. SPEC §4.4, ARCHITECTURE §6 and `gated-execute.ts` changed in the same commit.
  - `parseRequestUri` accepts only `data:application/json` URIs (base64 or percent-encoded) of at most 16 KB, and never fetches. Every rejection has a reason code.
- **SDK client** (`Attest8004Client`):
  - `buildAction`.
  - `requestValidation`, through the forwarder or straight to the registry.
  - `awaitVerdict`, scanning `ValidationResponse` logs in windows of at most 100 blocks.
  - `isValidated`, which mirrors the gate: deadline, consumed, and each requirement's validator, agent and score.
  - Every transaction goes through `writeWithGasGuard` / `sendWithGasGuard`.
- **Found and fixed: viem could replace our explicit gas limit.**
  - viem 2.57 calls `eth_fillTransaction` when fees or the nonce aren't set, and takes the node's `gas` from the result. Monad supports that method; P1/P2's transactions kept their limits only because Monad echoes a `gas` that is already given.
  - The guard now sets chainId, fees and nonce itself, so the node is never asked to fill, and a test pins that.
  - The e2e reads each sent transaction back, and every one carried exactly its explicit limit.
- **Validator base** (`ValidatorBase`, `packages/sdk/src/validator.ts`):
  - It polls `eth_getLogs` from a saved block cursor, at most 100 blocks per query, up to the `finalized` head. Monad testnet refuses `toBlock − fromBlock > 100`, measured.
  - It doesn't respond at all (it logs the reason) on a bad URI or JSON, a hash mismatch, another validator, agent or chain, or a deadline that has passed or is more than 1 hour (configurable) ahead.
  - It checks `getValidationStatus` before working and before every send, so a restart never posts twice. It retries a failed send, retries a failing request in later cycles with a doubling wait, and gives up on it after 5 failed cycles without skipping anything before it.
  - A subclass can decline a valid request without responding (`accepts()`).
  - `FileCursorStore` is in the subpath `@attest8004/sdk/node`.
  - 8 hand mutants are each caught.
- **Two demo agents, 1984 and 1985,** are in the canonical testnet Identity Registry, owned by the deployer.
  - They were registered by calling `register(string)` directly: agent0-sdk 1.7.1 (the latest) has no defaults for chain 10143 (its `DEFAULT_REGISTRIES` cover chains 1, 137, 8453, 11155111 and 84532).
  - Each has its own hot key, made by `pnpm --filter @attest8004/scripts hot-keys`, which writes the keys into `.env`, never overwrites one, and prints only addresses:
    - 1984 → `0xa43427fF…96787`
    - 1985 → `0xa7277471…327D8`
  - One `setApprovalForAll` for the forwarder, then `setAgentKey` for each agent.
  - Each hot key was funded with 0.152 MON, enough for 4 requests.
- **New `DemoAgentVault`** for agent 1984, still requiring only validator A at 100: `0x23BfBD12545CCd1501ddA1B65a54518FD6212a96` (commit `319006a`). The agent-1982 vault is marked **superseded** in `docs/deployments.md`, and `gated-execute` is pinned to it.
- **End to end on testnet** (`pnpm --filter @attest8004/scripts e2e`):
  - Agent 1984's hot key requested through the forwarder (`0xe2b7df42…`).
  - A stub validator built on `ValidatorBase` (which now answers only the run's own request) responded once (`0x8dada3c3…`). A freshly started second one re-read the same blocks and skipped the request (`ALREADY_RESPONDED`), and exactly one response exists onchain.
  - `awaitVerdict` and `isValidated` agreed, and the gated `execute` went through (`0x6f694020…`).
  - The refusals were simulated only: the owner and agent 1985's key calling for agent 1984, and a replay.
  - An earlier attempt stopped after its request (a script check compared the sender's letter case). It is recorded, and its request has expired.
- **CI:** `packages/sdk/test/vectors.sh --check` now runs in the contracts job. CI on the P2 head (`b9a36b0`) passed all four jobs (read through the public GitHub API).
- **Explicit gas limits.** Every transaction sent this session used a literal limit, checked against a fresh estimate.

  | Transaction | Monad `eth_estimateGas` | Limit |
  |---|---|---|
  | Deploy `AgentRequestForwarder` | 407,868 | 490,000 |
  | Deploy `DemoAgentVault` (agent 1984) | 829,476 | 1,000,000 |
  | `register` (demo agent) | 411,546 | 494,000 |
  | `setApprovalForAll(forwarder)` | 71,523 | 86,000 |
  | `setAgentKey` | 118,742 / 107,899 | 130,000 (now 143,000) |
  | Fund a hot key / the vault | 21,000 / 21,212 | 26,000 |
  | `forwarder.request` (hot key) | 251,331 – 262,217 | 315,000 (SDK `DEFAULT_GAS`) |
  | `validationResponse` (stub evidence) | 86,765 | 140,000 provisional (now 105,000) |
  | `execute` | 87,626 | 106,000 |

- **Tests:**
  - 130 forge unit and fuzz tests (10k fuzz runs in `ci`) and 12 fork tests;
  - 113 SDK vitest tests (a fake JSON-RPC transport checks the exact transactions, gas and log ranges);
  - 8 script tests.
- **Final review:** a fresh reviewer went over the whole P3 range and found no Critical issues and two Important ones. I fixed those and four findings I re-graded upward, each test-first:
  - `parseRequestUri` threw on `agentId: "abc"` (zod runs the BigInt refinement after the regex fails), so the validator retried a junk request instead of skipping it once.
  - `run()` didn't wait after a failed request.
  - An option passed as `undefined` erased its default (`sendAttempts: undefined` looped forever).
  - Validator logs could include the RPC URL (and any API key in it).
  - **The e2e stub, which signs with validator A's real key, would have scored 100 for anyone's request naming validator A.** It now declines everything but its own request. In the recorded run it answered only ours.
  - ARCHITECTURE §7 now covers the per-token approval.

  The e2e wasn't re-run after these fixes, to save the hot keys' MON. Only the stub's request-hash plumbing changed, and a unit test covers it.
- **Your side, done (as you reported):**
  - the PRF smoke test passed, with the same address on laptop Chrome and on Android;
  - the Discord questions are posted;
  - the repo is public.

### Next
- **Your side:**
  - `git push` (the P3 commits, review fixes included), then check CI. The repo is public, so I can now read CI through the GitHub API: the P2 head passed all four jobs.
  - **Qwen is deferred:** P5 will target any OpenAI-compatible endpoint, using the model set in `.env` (today `QWEN_BASE_URL` / `QWEN_MODEL`; P5 may rename them to something provider-neutral).
  - Still open: the Envio token, Nansen credits, the Vercel deploy, the integration offer (GAMEPLAN §6) and the team DMs.
  - Scripts read addresses from `scripts/src/deployments.ts`; `DEMO_AGENT_VAULT` in `.env` is no longer read.
- **P4 (`mandate-v1`):**
  - Build it on `ValidatorBase` (`check()`, and `accepts()` to turn away agents with no mandate).
  - Treat the forwarder's `AgentKeySet` and the Identity Registry's `Approval`/`ApprovalForAll` as permission events for "a permission change in the last N blocks".
  - The `verify` CLI.
- **P5:**
  - Redeploy the vault requiring both validators, and mark the agent-1984 vault superseded.
  - Build `risk-qwen-v1` on `ValidatorBase`; its paid checks make the cost and rate-limit question below concrete.
- **P7:** override `publishEvidence` for encrypted findings.
- **P8:** index `AgentKeySet`, and add `getAgentTrust`.
- **Deferred minors from the final review** (P10 or when convenient):
  - If eth_getLogs keeps refusing a window (for example one stuffed with huge hostile request logs), the validator stalls on it. Halve the window on error.
  - A second response is possible if a send is still pending after viem's 180 s receipt timeout. Keep waiting on the same hash, or reuse the nonce.
  - `gated-execute` and `roundtrip` still send with only `gas`, so viem may call `eth_fillTransaction`. Move them to `writeWithGasGuard`.
  - `awaitVerdict` aborts on a single eth_getLogs error, and scans up to `latest`, so a lagging log index could miss a response (it then times out).
- **Still deferred from P1 and P2:**
  - the deployer key in forge's argv;
  - three test gaps;
  - `timeout-minutes` on `contracts-fork`;
  - a README note that each round trip registers a new agent.

### Blockers or decisions needed
- **Decisions I made (all reversible; flag any you disagree with):**
  - The forwarder reads the Identity Registry from the ValidationRegistry.
  - Revoking a key is `setAgentKey(agentId, address(0))`.
  - A→B→A revives the key.
  - `AgentKeySet` is the only event.
  - The request JSON is strict: unknown keys and non-canonical decimals are rejected.
  - The validator's head is the `finalized` block, and its clock is that block's timestamp.
  - `FileCursorStore` is in `@attest8004/sdk/node`.
  - In the e2e, the deployer submits `execute` (permissionless), so hot keys only pay for requests.
  - The demo agents' registration files say `active: false`.
  - **The gas guard sets chainId, fees and nonce** so viem never asks the node to fill the transaction.
  - Each hot key is funded for 4 requests. After the e2e, agent 1984's key holds about 2 requests' worth; top up with `setup-demo-agents -- --fund`.
- **The demo uses the blanket `setApprovalForAll`**, which also covers the deployer's test agent 1982. Switch to per-token `approve` if you prefer; it works with the forwarder unchanged.
- **For P4/P5: anyone who owns an agent can make our validators work and spend gas,** because ERC-8004 lets any agent owner name any validator. `accepts()` lets a validator decline requests it doesn't serve (for example, agents without a mandate), but there is no budget or rate limit yet. Decide the policy before `risk-qwen-v1` makes paid calls.
- Still open from P2: squatting is a denial of service (spec-notes row 12), for the P10/P11 threat model.

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
