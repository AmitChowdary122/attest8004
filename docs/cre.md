# Chainlink CRE: validator C

Validator C is a [Chainlink Runtime Environment](https://docs.chain.link/cre) (CRE) workflow that orchestrates
Attest8004's deterministic `mandate-v1` check on Monad testnet. When an agent asks for a validation naming C:
1. the workflow wakes on the request's log;
2. it reads the chain itself;
3. it asks the unchanged `mandate-v1` logic for a verdict over HTTP, through CRE's consensus;
4. it cross-checks the answer against its own reads;
5. it writes the verdict through CRE's forwarder into `CreValidator`, which posts it to Attest8004's ValidationRegistry.

**C is a CRE workflow (simulation forwarder, not a trust root).** It runs with `cre workflow simulate --broadcast`
against CRE's mock forwarder, through which anyone can deliver a report, so no gate requires it. Its verdicts are
checkable because `pnpm attest8004 verify` re-executes them.

| | |
|---|---|
| Workflow | [`cre/validator-c/`](../cre/validator-c/) (TypeScript, `@chainlink/cre-sdk` 1.23.0, CRE CLI v1.37.0, Bun 1.3.14) |
| Receiver (validator C) | `CreValidator` [`0x6D12F00870cB6edA2d8e389696f6B5d050423B95`](https://monad-testnet.socialscan.io/address/0x6d12f00870cb6eda2d8e389696f6b5d050423b95) ([source](../contracts/src/CreValidator.sol)) |
| Forwarder it trusts | CRE's MockKeystoneForwarder `0xB9F79d863261869B234c481D1f9A7af84AeAd192` (Forwarder Directory, monad-testnet) |
| Evaluation API | `POST /evaluate` on 127.0.0.1:8787 ([`validators/mandate/src/evaluate*.ts`](../validators/mandate/src/evaluate.ts)): read-only, no keys |
| Run it | `pnpm cre:demo` ([§9](#9-how-to-run-it)) |
| Live runs | [§10](#10-the-live-runs) and [deployments](./deployments.md#p11-cre-run-validator-c-orchestrated-by-chainlink-cre-testnet-2026-10-06) |

---

## 1. What CRE does in Attest8004

Attest8004 is the ERC-8004 Validation layer for Monad.
1. An agent asks a named validator to check one exact action (`validationRequest`).
2. The validator posts a 0–100 verdict (`validationResponse`).
3. A gate (`AttestGate`) executes the action only with the verdicts it requires.

Validators A (`mandate-v1`) and B (`risk-v1`) are plain services, each holding its own key.

**Validator C is the same `mandate-v1` check with CRE as its orchestration layer.** The workflow connects two systems:
- **Monad.** A log trigger on the ValidationRegistry's `ValidationRequest`, filtered to C. EVM reads (block headers,
  `getValidationStatus` at chosen blocks, an `eth_estimateGas`). An EVM write of a signed report through the Keystone
  forwarder.
- **An external API.** `mandate-v1`'s evaluation, served by `POST /evaluate`. It runs the exact code validator A and
  `verify` run: the collector, the rules and the canonical evidence. It holds no key and sends nothing.

Everything between them is the workflow's own work, in [`src/workflow.ts`](../cre/validator-c/src/workflow.ts):
1. Authenticate the trigger's request JSON (the repo SDK's `requestHash`).
2. Pin the evaluation to the request's block.
3. Wait for finality.
4. Poll `/evaluate` through identical-aggregation consensus.
5. Check the evidence against its own reads.
6. Compute the response URI and hash.
7. Sign the report.
8. Size the gas limit from a live estimate.
9. Write.
10. Read the verdict back to confirm it landed.

Every step can refuse. A refusal writes nothing.

## 2. The flow

```mermaid
sequenceDiagram
  autonumber
  participant HK as Agent 1984 hot key
  participant FW as AgentRequestForwarder
  participant VR as ValidationRegistry
  participant WF as CRE workflow (validator C)
  participant EV as mandate-v1 /evaluate (127.0.0.1, no keys)
  participant MF as MockKeystoneForwarder
  participant C as CreValidator
  HK->>FW: request(C, 1984, data:URI, requestHash)
  FW->>VR: validationRequest → ValidationRequest(validator = C)
  VR-->>WF: log trigger (registry, topic1 = C; P = the log's block)
  WF->>WF: parse the data: URI, recompute requestHash (repo SDK), (gate, agent) allowlist
  WF->>VR: reads: header(P) = the log's block hash; status@P names C; finalized ≥ P+5; unanswered; deadline window
  loop up to 10 polls (server holds ≤ 6 s, 9 s timeout), identical aggregation
    WF->>EV: POST /evaluate {requestHash, pinnedBlock: P}
    EV-->>WF: pending | done {score, reasons, evidence, evidenceHash} | declined
  end
  WF->>WF: evidence canonical; requestHash, block number/hash/time and request fields match its own reads; responseHash = keccak(evidence)
  WF->>WF: runtime.report(abi.encode(requestHash, score, responseURI, responseHash))
  WF->>C: eth_estimateGas(onReport) as the forwarder → gas limit
  WF->>MF: writeReport (CRE_ETH_PRIVATE_KEY broadcasts) → report(C, raw, ctx, [])
  MF->>C: onReport(metadata, report)
  C->>VR: validationResponse(requestHash, score, responseURI, responseHash, "mandate-v1")
  WF->>VR: status@latest = C's verdict, or the run fails
```

## 3. Why a deterministic validator fits CRE

In a DON, every node runs the workflow, and an HTTP call goes through consensus. Identical aggregation succeeds only
when a Byzantine quorum of nodes got **byte-identical** values. A deterministic validator is exactly what gives that:
- `mandate-v1`'s verdict is a pure function of the chain at one block;
- its evidence is canonical JSON (sorted keys, integers as decimal strings, no whitespace);
- `/evaluate` remembers each (requestHash, pin) answer and returns it as canonical JSON.

So every node that asks gets the same bytes. An LLM validator (`risk-v1`) could not be orchestrated this way: two runs
of a model don't produce the same bytes.

**What consensus proves, and what it doesn't.**
- **It agrees on the answer.** Identical aggregation makes the DON agree on *what `/evaluate` answered*; it does not
  compute the score itself.
- **The workflow checks what it can.** Its own reads pin the facts it can check: the block (number, hash, time), the
  request's fields and the evidence's hash.
- **Only re-execution checks the score.** The score's correctness is proven only by `verify`'s re-execution, which
  anyone can run against the chain.
- **One endpoint is one source.** In production a single `/evaluate` endpoint is the one source of the score, unless
  each node operator runs its own. Then identical aggregation becomes a real cross-check between independent
  evaluations.

## 4. The pin, finality and the long-poll

**The pin is the request's own block.** `P` is the trigger log's `blockNumber`: identical on every node, never "now".
`verify` accepts it unchanged:
- the request's block ≤ `P` ≤ the response's block;
- `P` is at or after the first MandateRegistry;
- the action's deadline is at most 3,600 s after `P`'s time. The workflow and the service both decline a request that
  fails this.

**Finality is waited for the way validator A waits.** Nothing is read at `P` until the finalized head is at least
`P + 5`, `mandate-v1`'s `PIN_LAG_BLOCKS`: a load-balanced RPC can serve logs from a node a few blocks behind.
- The workflow checks it before calling `/evaluate`; if it doesn't hold, that run fails and is re-run.
- The service also waits for it, bounded, before reading.
- The log trigger asks for `CONFIDENCE_LEVEL_FINALIZED`. The simulator ignores this, so `pnpm cre:demo` waits for
  finality itself before it simulates.

**The long-poll.** A `mandate-v1` evaluation takes about 13 s on the public RPC; CRE cuts every HTTP call at 10 s.
- **The server.** `/evaluate` starts (or joins) one memoized job per (requestHash, pin), waits up to 6 s, and answers
  `pending` if it isn't done. Jobs run one at a time, and final answers are remembered.
- **The workflow.** It polls up to 10 times, each with a 9 s timeout, within CRE's 15 HTTP calls per run. A failed call,
  a round without quorum, `pending` and a 503 all mean "ask again".
- **No `cacheSettings`.** CRE's response cache would hand every node a cached `pending` and freeze the poll, and the
  memoized server already makes duplicate requests cheap.

**One limitation, stated.** Validator A pins *after its own last response* (process state), so two back-to-back
approvals see each other in its daily-spend total. A stateless workflow pinned at the request's block can't. Two
requests for the same agent, made before C answers the first, are each judged against C's spend as of their own block.
No gate requires C, and `verify` reproduces exactly that verdict, so this weakens only C's own advice
([ARCHITECTURE §9](../ARCHITECTURE.md#9-security-design-decisions)).

## 5. The cross-checks

Before anything is signed, the workflow checks `/evaluate`'s answer against what it read itself
([`src/evidence.ts`](../cre/validator-c/src/evidence.ts)).

| Fact | The workflow's own source | Checked against the evidence |
|---|---|---|
| The request | the trigger log's data: URI, parsed and re-hashed with the repo SDK (`requestHashOfJson` = the event's `requestHash`) | `requestHash`, and the request's chain, gate, agent, target, value, `keccak256(data)`, deadline and salt |
| The pin | the trigger log's block number and hash; `headerByNumber(P)` (its hash must equal the log's) | `block.number`, `block.hash`, `block.timestamp`; `request.block` |
| The verdict | — (from `/evaluate`) | the document's `score` and `reasons` must equal the answer's; `schema` and `validator` must be `mandate-v1`'s |
| The bytes | — | canonical JSON exactly, at most 16,384 bytes, hashing to the service's `evidenceHash` |
| The response | computed by the workflow | `responseURI` = a base64 data: URI of those exact bytes; `responseHash` = their keccak256 |

So a faulty or hostile `/evaluate` can't attach a verdict to another request, another block or another action, or
publish evidence other than what it hashed. It can only lie about the score, and `verify` catches that.

## 6. The receiver contract: CreValidator

[`contracts/src/CreValidator.sol`](../contracts/src/CreValidator.sol) implements CRE's `IReceiver`, copied from
Chainlink's documentation sample: `onReport(bytes metadata, bytes report)`. It also implements ERC-165, for
`0x805f2132` (`IReceiver`) and `0x01ffc9a7`, and refuses `0xffffffff`.

**The production forwarder checks this interface first, through OZ's `ERC165Checker`.** No owner, no setters, no funds,
no upgrade path; `test_abiIsMinimal` pins its ABI.

`onReport` checks, in order:
1. `msg.sender == forwarder`.
2. The 64-byte metadata (workflowId ‖ workflowName ‖ workflowOwner ‖ reportId) names the expected **workflow owner**
   and **workflow name**. The name is the first 10 hex characters of `sha256("attest8004-validator-c")`, as CRE encodes
   it: `0x36386365303833636635`.
3. The report decodes as `abi.encode(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash)`.
4. `responseHash ≠ 0`.
5. **Write-once:** the request has no response yet. The registry itself lets a validator overwrite its own verdict.
6. `validationResponse(…, "mandate-v1")`: **the tag is a constant**, never chosen by a report. The registry still
   enforces that the request names C, and the 0–100 range.

**What the metadata check is worth.**
- **With the production KeystoneForwarder**, the metadata is part of the DON-signed report, so the owner + name check
  binds C to one owner's workflow of one name. Without it, any CRE user's workflow could write as C.
- **On the mock**, the simulator writes placeholders: owner `0xaaaa…aaaa`, workflowId `0x1111…1111`, only the name real.
  Anyone can forge them through the mock's public `route()`. Testnet C is deployed with these placeholders, so the
  check runs end to end but **protects nothing there**.

**Gas.** Monad charges the gas limit, and prices calldata with EIP-7623's floor over the whole transaction.
- **The formula.** The workflow sets `max(onReport estimate + 60,000, 49,000 + 40 × raw report bytes) × 1.2`:
  - `onReport estimate` is `eth_estimateGas` of `CreValidator.onReport`, called as the forwarder, on the live request;
  - the second term is the floor line, fitted from read-only probes (`pnpm --filter @attest8004/scripts
    cre-gas-probe`).
- **Refusal.** It refuses (no write) above 1,130,000 gas, or when the estimate reverts, for example on a request
  answered in the meantime.
- **On the first live report** the limit was 236,051. The trace's inner frames put the real use at about 201k.

## 7. Trust model

**C is a CRE workflow (simulation forwarder, not a trust root).**
- **Anyone can deliver a report.** The mock forwarder verifies no DON signature, and the deployed build's `route()` is
  public. So anyone can deliver any report, with any metadata, to C.
  `testFork_anyoneCanReachCThroughMockRoute` pins this against the live mock.
- **No gate may require C.** The live DemoAgentVault requires validators A (`mandate-v1` = 100) and B
  (`risk-v1` ≥ 80) only.
  - `testFork_liveVaultExcludesC` pins it on every CI fork run.
  - `pnpm cre:demo` refuses to run if that ever changes.
  - Every surface labels C the same way: these docs, `verify`'s output, `/dashboard` and the demo.
- **What makes a C verdict checkable.** It is `verify`'s re-execution: `pnpm attest8004 verify <requestHash>`
  re-reads the chain at C's pin, re-runs `mandate-v1` as validator C, rebuilds the evidence and compares the score and
  `responseHash`.
  - A match proves the posted verdict is what `mandate-v1` gives at that block.
  - A MISMATCH is public proof that whoever delivered it lied.
- **Consensus doesn't compute the score.** Identical aggregation makes the DON agree on what `/evaluate` answered; it
  does not compute the score itself. Only `verify` proves the score. One `/evaluate` endpoint is the one source of the
  score unless each node operator runs its own ([§3](#3-why-a-deterministic-validator-fits-cre)).
- **Write-once griefing on the mock.** Anyone can fill C's slot first with a forged verdict through the public
  `route()`; the real workflow then can't write, because C refuses a second response.
  - **This affects only C:** no gate requires it.
  - **It is visible:** `verify` shows the forged verdict as a MISMATCH
    (`verifyRequest_flagsForgedCreVerdictAsMismatch`).
  - **The demo says so:** for an already-answered request, `pnpm cre:demo` prints `verify`'s result for the existing
    verdict instead of simulating.
- **A successful write isn't a landed verdict.** Both forwarders swallow a receiver's revert: the transaction succeeds,
  and only `ReportProcessed(…, result)` says whether `onReport` did. The simulator reports success from the receipt
  alone, and even without `--broadcast`.
  - So the workflow reads C's verdict back after writing, and fails if it isn't there.
  - The demo also checks `ReportProcessed.result`.
  - `testFork_mockSwallowsReceiverRevert` pins it.
- **Keys.**
  - **The broadcast key:** `CRE_ETH_PRIVATE_KEY` is the only key that broadcasts reports. `pnpm cre:demo` passes it to
    the CRE CLI in the CLI's environment alongside only `PATH` and `HOME`; nothing else from `.env` reaches the CLI.
  - **The service:** `/evaluate` reads no key, and a source scan pins that its modules sign nothing.
  - **The deployer:** it only deployed C.

## 8. Limits

| CRE limit | Value | Attest8004's measured or capped value |
|---|---|---|
| Log trigger event size | 5 kB | a ValidationRequest log is 608 B |
| HTTP call timeout | 10 s | an evaluation takes ~13 s → the long-poll ([§4](#4-the-pin-finality-and-the-long-poll)) |
| HTTP calls per run | 15 | ≤ 10 polls |
| HTTP response size | 250 kB | ~2–5 kB bodies |
| Consensus observation | 25 kB | evidence capped at 16,384 bytes (≈ 20 kB as a JSON string); live 1,651 and 1,928 bytes |
| EVM report size | 50 kB | live 2,509 and 2,893 bytes; ≤ ~22 kB at the evidence cap |
| Chain reads per run | 15 | 6 |
| Gas per write | 10,000,000 | capped at 1,130,000 |
| Execution | 5 min | ~16–19 s per live run |

- **The evidence format stays frozen.** C posts under `mandate-v1` with the same evidence as validator A, so `verify`
  re-executes it unchanged. Evidence over 16,384 bytes is declined (`EVIDENCE_TOO_LARGE`), never truncated. That
  happens only with dozens of approvals in C's 25 h window.
- **C's spend is judged at the request's block** ([§4](#4-the-pin-finality-and-the-long-poll)).
- **C posts no operator reports,** so `/inbox` shows none for its verdicts: it has no key to post with.
- **`/dashboard`'s per-tag summary mixes C's verdicts in.** The agent lookup counts C's verdicts under `mandate-v1`
  together with A's. Each verdict row and the validator table name C with its label. The indexer is a convenience that
  no verdict reads.
- **CRE's QuickJS runtime lacks `atob`/`btoa`** (its types declare them). The workflow installs a tested pure-JS
  polyfill before the repo SDK's data: URI code runs.

## 9. How to run it

**Prerequisites:**
- the CRE CLI v1.37.0 ([install](https://docs.chain.link/cre)), logged in with `cre login`;
- [mise](https://mise.jdx.dev), which runs the Bun that `cre/mise.toml` pins (1.3.14);
- in `.env`:
  - `CRE_ETH_PRIVATE_KEY` and `CRE_BROADCAST_ADDRESS`: a hackathon-only key with a little testnet MON;
  - `DEMO_AGENT_1_HOT_PRIVATE_KEY`/`_ADDRESS`, `DEPLOYER_ADDRESS` and `MONAD_TESTNET_RPC_URL`.

Then, from the repo root, the checks only: balances, takes left, the vault, the mandate, the CLI, Bun and the port.

```bash
pnpm cre:demo -- --preflight
```

The two scenes: a benign request (expect 100) and a violating one (expect 0).

```bash
pnpm cre:demo
```

**What a scene does.**
1. It sends the request from agent 1984's hot key.
2. It waits for finality.
3. It prints the exact simulate command, of the form
   `cd cre && CRE_ETH_PRIVATE_KEY=<from .env> mise exec -- cre workflow simulate validator-c --target monad-testnet-sim
   --non-interactive --broadcast --trigger-index 0 --evm-tx-hash <request tx> --evm-event-index <i>`.
4. It runs the command with `/evaluate` in the same process, streaming the workflow's own log lines.
5. It checks `ReportProcessed` and C's status.
6. It re-executes the verdict with `verify` and prints the explorer links.

**By hand.**
- **The service:** `pnpm --filter @attest8004/validator-mandate evaluate` serves `/evaluate`, read-only, on
  127.0.0.1:8787.
- **The simulation:** run the command above from `cre/` for any request naming C. `--evm-event-index` is the
  ValidationRequest log's position in its transaction's receipt.
- **A dry run:** a simulation without `--broadcast` runs every check, then ends in `NOT_LANDED` by design: a dry write
  proves nothing.

**Tests** (CI's `cre` job runs all three; CI can't log in to CRE, so it never simulates):

```bash
cd cre/validator-c && mise exec -- bun test && mise exec -- bun run typecheck && mise exec -- bun run compile
```

**Costs:**
- **Hot key:** two requests a take, ≤ 315,000 gas each, about 0.08 MON at the time of the run.
- **CRE broadcast key:** two reports, ~236k–250k gas limits each.
- **The preflight** prints the takes left.

## 10. The live runs

On 6 Oct 2026, `pnpm cre:demo`'s first take ([deployments](./deployments.md#p11-cre-run-validator-c-orchestrated-by-chainlink-cre-testnet-2026-10-06)):

| Scene | Request | Report (through the mock forwarder) | C's verdict | `verify` |
|---|---|---|---|---|
| Benign: 0.0005 MON to the owner | [`0xc3ffd9e6…f6ac48`](https://monad-testnet.socialscan.io/tx/0xc3ffd9e6ef537e5311436dff6d0b1a22fb8db36ff32d86c4da89733262f6ac48) | [`0x66d47022…d75dc3`](https://monad-testnet.socialscan.io/tx/0x66d470221949e17e8a75be2263b2dadaa1af657f3caa00266574baeb35d75dc3) | 100 | match |
| Violating: 0.001 MON outside the mandate | [`0x0575b052…205c7c`](https://monad-testnet.socialscan.io/tx/0x0575b052c41975df60d3168464b46d90def506fca0d0bf896af7d37f71205c7c) | [`0xcbf28a6d…bba6da0`](https://monad-testnet.socialscan.io/tx/0xcbf28a6d61baee08f7f881d3298639fa31f00d0fac26be97604f29adcbba6da0) | 0, `TARGET_NOT_ALLOWED` | match |

## 11. The production path

What a real C would need; this is on the roadmap, not built ([ARCHITECTURE §12](../ARCHITECTURE.md#12-extension-points-and-roadmap)).

1. **CRE deployment access** (`cre account access`), and the workflow deployed to a DON.
2. **A new CreValidator** with Monad testnet's production KeystoneForwarder
   `0xF8344CFd5c43616a4366C34E3EEE75af79a74482` and our real workflow owner and name. There, the DON's signatures make
   the metadata check bind C to our workflow. A stricter option is to pin the workflow ID; that needs a new C for every
   workflow or config change.
3. **`/evaluate` at an HTTPS URL the DON's nodes can reach.** CRE nodes can't reach 127.0.0.1. A single hosted
   endpoint is the one source of the score unless each node operator runs its own `/evaluate`, against its own RPC.
   With independent evaluations, identical aggregation becomes a real cross-check rather than an agreement on one
   server's answer.
4. **Still no gate requires C** until those hold. Even then, C's verdict is `mandate-v1`'s, checkable by `verify` like
   validator A's.

## 12. A 2-minute video script

Record `pnpm cre:demo` in a terminal next to the explorer. Cuts are at the `┄ waiting … (cut from here)` and
`(cut to here)` lines the demo prints. A take runs ~75 s before cuts.

| Time | Screen | Say |
|---|---|---|
| 0:00–0:15 | The title line and the preflight | "Attest8004 is the ERC-8004 Validation layer for Monad. Validator C runs the deterministic mandate-v1 check with Chainlink CRE as its orchestration layer. It's labelled a CRE workflow on a simulation forwarder, not a trust root: the preflight shows the vault still requires validators A and B only." |
| 0:15–0:30 | Scene 1: the hot key's request, the simulate command | "Agent 1984's hot key asks validator C to check a payment inside its mandate. This is the exact `cre workflow simulate --broadcast` command, on that transaction's log." |
| 0:30–0:55 | The `CRE ▸` lines (cut the evaluation wait) | "The workflow reads Monad itself: the request's block, its hash, that it names C, finality. It asks mandate-v1's API through CRE's identical-aggregation consensus. A deterministic check gives every node the same bytes. It cross-checks the evidence against its own reads, computes the response hash, sizes the gas from a live estimate, and writes through the forwarder." |
| 0:55–1:10 | `LANDED`, the verdict 100, verify's match, the report link | "C scored 100. verify re-executes mandate-v1 at the same block and gets the same score and hash: that's what makes C's verdict checkable." |
| 1:10–1:35 | Scene 2, cut to the verdict | "Now a payment to an address outside the mandate. C scores 0 with TARGET_NOT_ALLOWED, and verify matches again." |
| 1:35–1:50 | `/dashboard` with C's two rows and the label | "Both verdicts are on chain and on the dashboard, labelled." |
| 1:50–2:00 | The summary | "Consensus agrees on what the API answered; re-execution proves the score. That's why C is a checkable validator, and why no gate trusts it on the simulation forwarder." |
