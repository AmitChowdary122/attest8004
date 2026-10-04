# Attest8004 — Build Spec (v0.1 · 2 Oct 2026)

> Working name. Rename freely; keep the package scope consistent (`@attest8004/*`).
> Hackathon: Monad Metropolis, **Track 04 — Trust, Identity & AI Infrastructure**.
> Deadline: **13 Oct 2026 11:59 PM ET = 14 Oct 09:29 IST**. The full rules are in `../Metropolis_Hackathon_Reference.md`.

---

## 1. One-liner

**Attest8004 is the missing ERC-8004 Validation layer for Monad.** Before trusting an agent's action, any contract, app or x402 seller can ask whether an independent validator checked it and what the verdict was.

It has five parts:
- a spec-conformant **ValidationRegistry**
- **passkey-approved agent mandates**, verified with Monad's P256 precompile
- a **validator SDK** with two reference validators: one deterministic and re-executable, one agentic using an OpenAI-compatible LLM (Groq today) and Nansen
- a **Mera passkey-derived findings inbox**
- an **Envio-indexed trust API**

Why it exists: Monad's ERC-8004 docs list the Validation Registry as "coming soon" while telling builders to "use validation registry for critical operations". The canonical `erc-8004-contracts` repo has no Validation Registry deployed on any chain.

---

## 2. Non-negotiable constraints

**Rules (Rules v3.0 and the track pages):**
- Open source under the **MIT** licence, in a **public** GitHub repo that `metropolis@hackathon.monad.xyz` can access.
- The commit history must cover the build window, so commit small and often.
- The README must have: setup steps a third party can follow, architecture, tech stack, why Monad, contract addresses or transaction hashes, **pre-existing code declared**, and **AI tools disclosed** (Claude Code).
- **No secrets** in the repo, the demo video or the submission. Commit `.env.example` only, and run gitleaks before going public.
- Deploy on Monad **testnet** (chain 10143), and on mainnet (143) if needed.
- The demo video is **3 minutes or less** and must show the live product: no slides, no code walkthrough.

**Bounty requirements this build must meet (judged 40% on adherence):**

| Bounty | Hard requirement |
|---|---|
| Nansen ($5k pool) | Nansen API, MCP or CLI powers a **core feature**. The README must **name the exact endpoints and data categories** used. Public repo plus a short demo. |
| Mera "One Passkey, Many Keys" ($2.5k) | At least one PRF namespace does **non-account work**, demonstrated live. **Nothing sensitive persisted** to disk or server. A **cross-device test**: the same passkey on a second device decrypts the same state, live. |
| Envio ($1k) | HyperIndex in the repo (`config.yaml`, `schema.graphql`, handlers). **Live** data. Something useful consumes it. |
| *(stretch)* Chainlink CRE ($3k) | A CRE workflow is the orchestration layer. `cre workflow simulate` (with `--broadcast`) on Monad. A 2-minute demo video. |

---

## 3. Architecture

The diagrams, step-by-step flows, data formats, trust model and key-custody table are in **[`ARCHITECTURE.md`](./ARCHITECTURE.md)**. This file only lists scope and acceptance criteria. If an interface or flow changes, update `ARCHITECTURE.md` in the same commit.

**Monorepo layout** (pnpm workspaces, Node 22):

```
attest8004/
  ARCHITECTURE.md       how it works: diagrams, flows, data formats, trust model
  contracts/            Foundry: ValidationRegistry, AgentRequestForwarder, MandateRegistry, AttestGate, DemoAgentVault, script/, test/
  packages/sdk/         @attest8004/sdk — client + validator base + shared types + hash test vectors
  packages/cli/         @attest8004/cli — `pnpm attest8004 verify` for mandate-v1 and risk-v1 verdicts
  validators/mandate/   deterministic validator service
  validators/risk/      agentic risk-v1 validator service
  indexer/              Envio HyperIndex project
  web/                  one web app: /approve (passkey mandates), /inbox (Mera), /dashboard
  cre/                  (stretch) Chainlink CRE workflow
  docs/                 quickstart, API ref, threat model, deployments.md, spec-notes.md
  STATUS.md             running log: done / next / blockers (update at end of every session)
```

---

## 4. Components and acceptance criteria

### 4.1 `ValidationRegistry.sol` — spec-conformant
**Before writing code, re-read the latest EIP-8004 text and the `erc-8004/erc-8004-contracts` repo.** The spec is a Draft. Record any differences from the interface below in `docs/spec-notes.md`.

- Functions (EIP-8004, as of 2 Oct 2026):
  - `validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)`. The caller **must be the owner or an approved operator** of `agentId` in the Identity Registry (ERC-721 `ownerOf`, `isApprovedForAll`, `getApproved`).
  - `validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)`. Only the `validatorAddress` named in the request may call it. `response` must be between 0 and 100. Multiple responses per request are allowed (progressive updates); store the latest and `lastUpdate`.
  - `getValidationStatus(bytes32 requestHash)`, `getSummary(uint256 agentId, address[] validatorAddresses, string tag)`, `getAgentValidations(uint256 agentId)`, `getValidatorRequests(address validatorAddress)`.
  - Events `ValidationRequest` and `ValidationResponse`, exactly as in the spec.
- The constructor takes the Identity Registry address. Canonical Identity Registry addresses:
  - testnet `0x8004A818BFB912233c491871b3d84c89A494BD9e`
  - mainnet `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
  - Reputation Registry (for reading only): testnet `0x8004B663056A597Dffe9eCcC1965A193B7388713`, mainnet `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`
- No non-spec extensions inside this contract. Extensions go in separate contracts.
- **Tests (Foundry):** authorisation (owner, operator, stranger), response range, wrong validator, unknown request, repeated responses, summary maths, fuzz, and a **fork test against the testnet Identity Registry**.
- **Done when:** deployed on testnet, address in `docs/deployments.md`, and a request→response round trip made by a script.

### 4.2 `MandateRegistry.sol` — owner-set mandates (P4), passkey-approved (P6)
- **Mandate** fields: `allowedTargets[]`, `allowedSelectors[]`, `maxValuePerTx`, `maxValuePerDay`, `validUntil`. Its hash is `mandateHash = keccak256(abi.encode(mandate))`. Up to **16 targets and 16 selectors**; a zero target, an already-expired `validUntil`, or `maxValuePerTx > maxValuePerDay` all revert.
- **As built in P4** (`contracts/src/MandateRegistry.sol`): the **agent owner** sets or revokes the mandate with a normal wallet transaction, `setMandate(agentId, Mandate)` and `revokeMandate(agentId)`. Every change is routed through one internal hook, `_authorize(agentId, changeHash)` — `setMandate` passes `mandateHash`, `revokeMandate` passes the constant `REVOKE` — called **before any write**, so P6 can veto a change entirely. In P4 that hook requires `msg.sender == identityRegistry.ownerOf(agentId)` (an operator or approved address is not enough), and the record stores that owner: a mandate is **stale once the agent is transferred** — the old owner can no longer change it, and the record still names them until the new owner sets a fresh one. `getMandate(agentId)` returns the mandate, its hash, the owner who set it and `setAtBlock`, a **block number replacing SPEC's earlier `setAt`**, because the permission rule compares block order. Overwriting a mandate replaces its arrays completely rather than appending to them.
- Events: `MandateSet(agentId, mandateHash, owner, allowedTargets, allowedSelectors, maxValuePerTx, maxValuePerDay, validUntil, setAtBlock)`, with `owner` as its third indexed topic, and `MandateRevoked(agentId, mandateHash, owner)`.
- **P6 adds** a WebAuthn assertion (OpenZeppelin 5.7 `WebAuthn.WebAuthnAuth`) in place of P4's owner check, over the agent's passkey public key `(qx, qy)` (set once by the owner) and binding `changeHash` so a `setMandate` approval can't be replayed as a `revokeMandate` or vice versa:
  - The challenge is `sha256(abi.encode(block.chainid, address(this), agentId, changeHash, nonce))`. Increment `nonce` on every use (replay protection).
  - Verify `type == "webauthn.get"`, that the challenge in `clientDataJSON` matches, the **UP and UV flags**, the rpIdHash, and **low-s**.
  - Verify the signature with **P256 at `0x0100`**. Prefer OpenZeppelin's WebAuthn/P256 libraries if the installed version has them; they call `0x100` with a Solidity fallback. If you write your own wrapper, **check the return data length is 32 and equals 1**, because the precompile returns empty bytes on failure.
  - Because the hook is internal, P6 is a new, separate deployment, not an upgrade. It also adds `setInboxKey(agentId, bytes32 x25519Pub, WebAuthnAuth)`, `PasskeySet` and `InboxKeySet`.
- **Tests (P4):** `contracts/test/MandateRegistry.t.sol` — owner/operator/approved/stranger authorisation, every validation rule and its passing boundary, overwrite semantics, behaviour across an agent transfer, revoke, `mandateHash` binding every field (fuzz), and a harness (`test/mocks/MandateRegistryHookHarness.sol`) proving every change goes through `_authorize` before any write. **Tests (P6, not yet written):** a real assertion vector recorded from Chrome (store it in `test/vectors/`), wrong challenge, replay, UV missing, high-s rejected, and an empty-return precompile mock.
- **Done when (P4):** deployed on testnet, address in `docs/deployments.md`, and a mandate set by the owner wallet in the end-to-end script. **Done when (P6):** a mandate is approved from the `/approve` page with a real passkey on testnet, and the transaction shows the verification.

### 4.3 `AttestGate` + `DemoAgentVault.sol`
- `Action { uint256 agentId; address target; uint256 value; bytes data; uint64 deadline; bytes32 salt; }`
- Two hashes, defined once in `contracts/src/ActionHash.sol`. The **same functions live in the TS SDK** (`computeRequestHash`, `computeActionHash`), with shared test vectors (`packages/sdk/test/vectors.json`, expected values generated with `cast`), and both test suites must pass on them.
  - `requestHash = keccak256(abi.encode(block.chainid, gate, validatorAddress, agentId, target, value, keccak256(data), deadline, salt))`, **one per validator**, because the registry records exactly one validator per `requestHash`.
  - `actionHash` is the same encoding without `validatorAddress`. The gate marks it consumed.
  - `requestHash` stays an ABI-encoded action hash: that encoding is the "request payload" the EIP's `requestHash` commits to (`docs/spec-notes.md`, row 6).
- The gate has an **immutable list of `(validator, minScore, tagHash)` requirements** (1 to 4, fixed at deployment, no owner), and **every one must pass**. The constructor rejects `minScore` 0 (a pending request reads as response 0), `minScore` above 100, a zero validator, duplicate validators and a zero `tagHash` (`ZeroTagHash`) — there is no wildcard tag.
- `onlyValidated(Action)`, checked in this order — **validator → agent → score → tag**:
  1. Require `block.timestamp <= deadline`, and that `actionHash` hasn't been consumed.
  2. For each requirement, **recompute** that validator's `requestHash` from the call, so a verdict can't be reused for a different action, gate, chain or validator.
  3. Look it up in the ValidationRegistry. Require that the stored `validatorAddress` is that validator, that the stored `agentId` is the action's (anyone who owns an agent can claim a hash first), and that `response >= minScore` (a pending request still reverts `ScoreTooLow`).
  4. Require the stored tag hashes to `tagHash`; a sufficient score with the wrong tag reverts `TagMismatch(validator, requestHash, expected, actual)`.
  5. **Mark `actionHash` consumed** (single use) **before the external call**. The gated function is also `nonReentrant`.
- The SDK's `isValidated()` and `attestGateAbi` mirror this same order, including the tag check.
- `DemoAgentVault`: holds test MON or ERC-20 for **one immutable `agentId`**, and rejects actions for any other agent. `execute(Action)` is gated by `onlyValidated`. It is permissionless, because the validated action is the authorisation. The P2 testnet deployment requires validator A only; P5 redeploys it requiring both validators.
- **Done when:** a validated action executes, and these revert: unvalidated, pending, low score, wrong tag, untrusted validator, wrong `agentId` (squatted hash), expired, replayed, a different action, and a verdict for another gate. Each case has a test.

### 4.4 `packages/sdk` (TypeScript, viem)
- **Client:**
  - `buildAction()` and `computeRequestHash()`.
  - `requestValidation({validators[], action})`. Puts the request JSON in `requestURI` as a `data:` URI (no hosting; the reference validators accept nothing else), then calls the registry.
  - `awaitVerdict()` and `isValidated()`.
  - `getAgentTrust(agentId)`, which reads from the Envio GraphQL API (P8).
  - As built in P3 (`packages/sdk/src/client.ts`): `requestValidation` goes through the `AgentRequestForwarder` when one is configured (the wallet is then the agent's hot key), else straight to the registry. `awaitVerdict` scans `ValidationResponse` logs in windows of at most 100 blocks (Monad testnet's `eth_getLogs` limit). `isValidated` mirrors `AttestGate`: the deadline, consumption, and each requirement's stored validator, agentId, score and tag. Every transaction goes through `writeWithGasGuard`: simulate, estimate, refuse if the estimate is above the explicit limit, then send with that limit and with fees and nonce set, so the node never fills the gas.
- **Validator base class** (`ValidatorBase`, `packages/sdk/src/validator.ts`):
  - Find `ValidationRequest` events where `validatorAddress == self` by **polling `eth_getLogs` from a saved block cursor**, at most 100 blocks per query (Monad testnet's limit), up to the finalized head, rather than relying only on subscriptions.
  - Treat `requestURI` as attacker-controlled: accept only a `data:` URI of at most **16 KB**, with **no HTTP fetching**.
  - **Don't respond at all** (log the reason instead) if: the JSON doesn't hash to `requestHash`, `validator` isn't this validator, `agentId` differs from the event's, `chainId` isn't this chain, or the deadline has passed or is more than a configurable maximum (default 1 hour) in the future.
  - Run `check()`, then post `validationResponse` with an evidence JSON v1 and its keccak256 hash.
  - Check `getValidationStatus` before posting, so a restart never posts twice. Retry a failed send, re-checking the status first; retry a failing request in later cycles with a growing wait, then give up on it.
  - Let a subclass decline a valid request without responding, either from `accepts()` before `check()` runs, or from `check()` itself by returning `{ decline: "<reason>" }` instead of a `CheckResult`: `accepts()` returning `false` declines silently, and either method's `{ decline: "<reason>" }` declines with that reason as the outcome's logged `detail`. Neither case is retried in a later cycle.
  - Call a subclass's `onResponded()` once per response that actually lands onchain, with its block and gas limit, so it can record spend or a rate limit without a second chain read; never on an already-answered status alone, and a throw from it is logged, not retried (the response already landed).
  - Use **explicit gas limits** with the estimate guard (Monad charges on the gas limit, not gas used): a literal, or an evidence-sized `{ headroomPercent, max }` policy, since a response's evidence (and so its gas) varies with the validator's own findings.
  - Build evidence JSON v1 as **canonical JSON** (`buildEvidence()`, sorted keys, no whitespace), so a later `verify` command can rebuild the exact bytes from a recomputed `CheckResult` and reproduce `responseHash`.
- **`AgentRequestForwarder.sol`** (in `contracts/src/`; added in P3). It lets an agent's hot key request validations without any power over the agent itself. EIP-8004 accepts `validationRequest` only from the owner or an ERC-721 operator, and an operator can also transfer the agent.
  - The agent's owner approves the forwarder on the Identity Registry, once for all its agents with `setApprovalForAll(forwarder, true)` or per agent with `approve(forwarder, agentId)` (what the demo agents use since P4), then calls `setAgentKey(agentId, key)` on the forwarder. Only the current `ownerOf(agentId)` may set or revoke (`key = address(0)`) the key, and the record stores that owner.
  - `request(validator, agentId, requestURI, requestHash)` works only when called by that agent's key, and only while the recorded owner is still `ownerOf(agentId)`. It makes exactly one call: `validationRequest` on the fixed ValidationRegistry.
  - Immutable, no admin, holds no funds. Deployed through the CREATE2 factory with the estimate guard.
  - **Tests:** wrong key, a key set by a previous owner and used after the agent is transferred, a revoked key, and that the forwarder can do nothing except `validationRequest`.
  - **Done when:** deployed on testnet, and a demo agent's hot key requests through it in the end-to-end script.
- Request JSON schema v1: `{ "schema":"attest8004.request.v1", "chainId", "gate", "validator", "agentId", "action":{ "target", "value", "data", "deadline", "salt" } }`, one per validator (ARCHITECTURE §6). `agentId`, `value` and `deadline` are **decimal strings**; `chainId` is a JSON number. It is defined once, as a strict zod schema (unknown keys are rejected), in `packages/sdk/src/request.ts`.
- Register two demo agents in the canonical Identity Registry using the **agent0 SDK** (sdk.ag0.xyz). Check that it supports testnet 10143; if not, call `register()` directly. **P3:** agent0-sdk 1.7.1 has no defaults for 10143, so `register(string)` is called directly. The demo agents are **1984** and **1985**, owned by the deployer, each with its own hot key registered on the forwarder (`docs/deployments.md`).

### 4.5 Validator A — `mandate-v1` (deterministic)
**This validator carries the "is it trust?" argument: anyone can re-run a verdict from chain data alone and get the same score and the same `responseHash`.** Lead with it in the docs and the demo. As built in P4 (`validators/mandate/`):

- **One pinned block.** Every input is read at one block `P`, and the verdict's clock is `P`'s timestamp. `P` is 5 blocks below the finalized head when the check runs (so an RPC node a few blocks behind can't silently drop the last logs before `P`), never below the request's block, the block this process's last response landed in, or the MandateRegistry's deployment block (ARCHITECTURE §6). One validator process per key.
- **Checks.** Every rule is evaluated. Any failure scores 0, and the reasons are reported in this order:
  1. `MANDATE_MISSING`: the agent has no mandate in `MandateRegistry` (never set, or revoked).
  2. `MANDATE_OWNER_CHANGED`: the mandate was set by someone who no longer owns the agent.
  3. `MANDATE_EXPIRED`: the mandate's `validUntil` is before `P`'s time.
  4. `ACTION_EXPIRED`: the action's deadline is before `P`'s time.
  5. `DEADLINE_AFTER_MANDATE`: the action's deadline is after the mandate's `validUntil`.
  6. `TARGET_NOT_ALLOWED`: the target isn't on the mandate's allowlist.
  7. `SELECTOR_NOT_ALLOWED`: the calldata's selector isn't on the allowlist. **`0x00000000` in the allowlist means empty calldata only** (a plain MON transfer): non-empty data starting with `0x00000000`, or 1–3 bytes of data, never matches, and an empty allowlist allows nothing.
  8. `VALUE_OVER_TX_CAP`: the value is above `maxValuePerTx`.
  9. `DAILY_CAP_EXCEEDED`: the spend (below) plus the value is above `maxValuePerDay`.
  10. `SPEND_HISTORY_UNREADABLE`: a past approval's evidence was found, but its response URI isn't an inline `data:` URI the validator accepts, or the evidence doesn't hash to that approval's `responseHash`, isn't `mandate-v1` evidence, names another `requestHash`, or has request fields that recompute to another `requestHash`.
  11. `PERMISSION_CHANGED_AFTER_MANDATE`: a permission change in the last N blocks (below) came after the current mandate was set. This is the Grok/Bankr pattern.
  12. `SIMULATION_FAILED`: an `eth_call` of the action at `P`, from the gate, with its value and data and a 1,000,000 gas cap, reverts, runs out of gas or lacks funds.

  Without a mandate, only `MANDATE_MISSING`, `ACTION_EXPIRED`, `PERMISSION_CHANGED_AFTER_MANDATE` and `SIMULATION_FAILED` apply.
- **Spend** is this validator's own `mandate-v1` approvals (score 100) of the agent's actions, **approved in the last 25 h** (`lastUpdate` after `P`'s time − 90,000 s).
  - The registry records when an action was approved, not when it ran. `mandate-v1` fixes the deadline horizon at 3,600 s, so an action runs at most 1 h after its approval, and 25 h of approvals covers every execution in the last 24 h. It can over-count by at most an hour.
  - An approval counts if the gate consumed it, if it is unconsumed and its deadline hasn't passed at `P`, or if its `consumed()` read gave no answer: it reverted, ran out of gas, or returned no bool, as a gate with no code does (fail closed). An RPC failure, including a node reply with no hex result, is never an answer: the check fails and is retried. **One that expired unconsumed never counts**, because it can never run.
  - Which approvals exist comes from state at `P` (`getAgentValidations` and each status). Each one's amount comes from that approval's own posted evidence, used only if it hashes to the approval's `responseHash` and its request fields recompute to its `requestHash`. An evidence log that can't be found is never a verdict: the check fails and is retried later.
  - **Caps cover native MON only.** A mandate that allowlists token-moving selectors (`transfer`, `approve`, …) doesn't cap token amounts. This is on the P10 threat-model list.
- **Permission changes** are read in the window `(P − N, P]`, with **N = 6,000 blocks** (about 30 minutes): the Identity Registry's `Transfer` and `Approval` of the agent and `ApprovalForAll` by its owner at `P`, the forwarder's `AgentKeySet` for the agent, and the MandateRegistry's `MandateSet` and `MandateRevoked` for the agent. An event after the current mandate's own `MandateSet`, comparing `(block, logIndex)`, fails the action: the owner never approved a mandate with that change in view.
- **Output:** a score of 100 or 0, tag `mandate-v1`, the reasons, and canonical evidence JSON (ARCHITECTURE §6) with `block` (`P`'s number, hash and timestamp), `request`, `params` (N, the spend window, the deadline horizon, the simulation gas cap, and the Identity Registry, forwarder and MandateRegistry addresses), `mandate`, `spend`, `permissions` and `simulation`. The evidence is an inline `data:` URI in public plaintext, because spend accounting and `verify` read it. **Its format is frozen:** a change to any key, encoding, constant or contract it depends on needs a new tag, or recorded verdicts stop verifying.
- **Gas-spend policy.** `accepts()` decides whether to answer at all. A declined request gets no response, and one `warn` log line names the agent and the reason.
  - It serves only its allowlisted (gate, agent) pairs (`MANDATE_V1_GATES` as `<gate>:<agentId>,…`, by default the demo vault with agent 1984), declining an unlisted gate (`GATE_NOT_SERVED`) or a listed gate named for another agent (`GATE_NOT_FOR_AGENT`) before any RPC, so nobody can spend its gas by naming our gate for their own agent. Then it serves only agents with an unexpired mandate set by their current owner.
  - Then a per-agent rate limit (20 requests an hour) and a validator-wide daily gas budget (10,000,000 gas, with each response reserving its 400,000 gas cap until it lands) apply. All three are configurable in env, and a restart resets the counters.
  - Each response's gas limit is the estimate plus 20 %, capped at 400,000.
- **Reproducibility:** `pnpm attest8004 verify <requestHash>`, from the repo root, re-runs the verdict at the evidence's `P` and must give the same score and the same `responseHash` (ARCHITECTURE §5.5). The CLI (`packages/cli`, as built in P5) reads the response's tag once and sends `mandate-v1` verdicts here and `risk-v1` verdicts to §4.6's re-check; any other tag exits 2 (`UNKNOWN_TAG`). It is read-only and defaults to the public testnet RPC, so it needs no `.env`; another RPC (an archive one for verdicts older than about 51 days) goes in `MONAD_TESTNET_RPC_URL`. It exits 0 on a match, 1 on a mismatch (public proof that the validator misbehaved) and 2 when it couldn't verify. There is no `npx attest8004` command: `@attest8004/cli` is private and declares no `bin` in its `package.json`, and shipping a CLI package is a later decision.

### 4.6 Validator B — `risk-v1` (agentic)
**Runs only after `mandate-v1` has answered the same action, and is never meant to be the only check.** `risk-v1` is provider-neutral: it calls an OpenAI-compatible chat endpoint, configured by `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` (today Groq's `openai/gpt-oss-120b`). The evidence records the model requested, the model the provider says it served, and `system_fingerprint`.

- **The pin and prerequisite.** Shares `mandate-v1`'s pin rule (§4.5): block `P`, 5 blocks below the finalized head, never below the request's block or this process's last response. Before `P` is accepted, validator A's `mandate-v1` verdict for the same action at the same `P` must already be answered — `check()` waits up to 120 s, polling every 500 ms, then throws for the base to retry; no model or guard call happens before this. If A's answer at `P` is from another validator or isn't tagged `mandate-v1`, B declines (`MANDATE_V1_VERDICT_INVALID`) with no model call. **A score of 0 from A still runs B** (the SPEC §5 demo needs B's explanation). B reads A's reasons from A's own evidence, checked against its `responseHash`, keeping only the known reason codes.
- **Admission.** `accepts()` declines before any RPC for a gate it isn't listed to serve (`GATE_NOT_SERVED`, via `RISK_V1_GATES` in the same `gate:agentId,…` form as `MANDATE_V1_GATES`) or a listed gate named for another agent (`GATE_NOT_FOR_AGENT`), then applies `mandate-v1`'s admission limits (20 requests per agent per hour, 10,000,000 gas a day).
- **The check, in order:** screen every untrusted text field with Prompt Guard; run a tool loop against the endpoint with `tool_choice: "auto"` (every tool read-only, pinned at `P`); make one final, tool-free call with a strict `json_schema` response format to get the findings (the endpoint doesn't support tools and structured output together); score the findings in code. Parameters: `reasoning_effort: "low"`, `include_reasoning: false`, `temperature: 0.2`, `seed: 8004`; `parallel_tool_calls` and `service_tier` are never sent.
- **Caps and pacing.** `max_completion_tokens` is 1,024 per tool turn and 1,536 for the final call; the loop stops calling tools once the next final call would pass 7,000 tokens, and a whole check is capped at 36,000 tokens. A client-side pacer holds a configurable RPM/TPM budget per model, honouring the provider's rate-limit headers and `retry-after`.
- **Failure handling.** A provider failure (rate limit, timeout, 5xx and the like, or an unparseable guard answer) is always transient, never a verdict: it retries in place, then `check()` throws for the base to retry from scratch, giving up after about 8 minutes with no response. Invalid model output (a failed tool call, a failed structured-output call, an answer that fails schema validation, or a final answer that calls a tool, which is then not recorded) shares one budget of 2 retries per check; on the third failure `check()` **declines** (`MODEL_OUTPUT_INVALID`) with no retry.
- **Findings.** The model's output is `{findings: [{code, severity, explanation, sources}]}`: `code` from a fixed list (`FUNDS_FORWARDED`, `NEW_CONTRACT`, `FRESH_COUNTERPARTY`, `MANDATE_VIOLATION`, `PERMISSION_CHANGE`, `SIMULATION_FAILED`, `LOW_REPUTATION`, `RISKY_LABEL`, `SUSPICIOUS_CALLDATA`, `OTHER`); `severity` is `low`, `medium` or `high`; `explanation` is at most 400 characters; `sources` is 1–4 names, each `request`, `mandate_v1_verdict`, or a tool actually called in the run; at most 8 findings. The model never emits `PROMPT_INJECTION_SUSPECTED`; only code adds it.
- **Score.** Code only, never the model: 100 with no findings, 80 if every finding is low, 40 if any is medium, 0 if any is high. `reasons` lists the finding codes, the model's findings first, then code's. **The vault's B minimum is 80.**
- **The system prompt's severity rubric:** value leaving the target for an address outside the mandate is **high** (`FUNDS_FORWARDED`, the one code for it; a target outside the mandate is `mandate-v1`'s `MANDATE_VIOLATION`); a `mandate-v1` failure is **high**; only the action's target, or an address value flows to, can be the subject of `NEW_CONTRACT` or `FRESH_COUNTERPARTY` — never the gate, the validators or the agent's own contracts; `NEW_CONTRACT` (medium) means a contract younger than about 7 days; `FRESH_COUNTERPARTY` is medium **only** when the subject has nonce 0 and no code at `P` — an EOA that has sent transactions is never above low for its age alone; a tool that is unavailable, or data that is missing, is never a finding.
- **`promptVersion`** is a string constant, `"risk-v1/4"` today (tuned three times on the recorded runs of Task 13), recorded next to `promptHash` (keccak256 of the canonical JSON of the initial messages, tool definitions and model parameters). `verify` doesn't re-derive the prompt; it can be tuned later under the same tag by bumping `promptVersion`.
- **Prompt-injection defence.** Untrusted text — printable-ASCII runs in calldata (capped), the simulation's decoded revert reason, and Nansen label/first-funder/counterparty strings — is screened by Prompt Guard before the model ever sees it, chunked with overlap and scored by its highest-scoring chunk. A field scoring **at or above 0.5** is flagged; any flagged field makes code add one `PROMPT_INJECTION_SUSPECTED` finding (medium, so the score is capped at 40), naming the flagged fields in `sources`. Flagged text is never redacted from the model. Every piece of untrusted data reaches the model delimited as canonical JSON inside `<untrusted_data source="…">…</untrusted_data>`, with `<`, `>` and `&` escaped so the block can't be closed from inside; the system prompt states that data is never instructions. A guard failure is a transient provider failure (never an unscreened verdict).
- **Seven read-only tools, all pinned at `P`:** `get_mandate`, `simulate_action` (a flattened `debug_traceCall`), `recent_permission_events`, `counterparty_onchain(address)`, `erc8004_reputation(agentId)`, `nansen_counterparty_profile(address)` and `nansen_flows(address)`; `get_request` is the first user message rather than a tool, because the model always needs it. Use Nansen API or x402 pay-per-call, and list every endpoint used in the README. Account age comes from 5 probes (code or nonce at `P` minus roughly {1k, 10k, 100k, 1M, 2M} blocks), reporting the smallest window the account is younger than. An address argument must be the target, the gate, the owner at `P`, a mandate-allowed target, or an address seen earlier in the run; anything else is `{error: "ADDRESS_OUT_OF_SCOPE"}` (still a counted call). Tool outputs are capped at 1,536 bytes of canonical JSON, truncated deterministically and marked `truncated`. Without `NANSEN_API_KEY`, both Nansen tools return `{available: false, reason: "NANSEN_API_KEY is not set"}` without fetching; with a key, a Nansen error becomes tool output, never a check failure. Tool calls are capped at 8; a call beyond that gets `{error: "TOOL_CALL_LIMIT"}` without running.
- **Response gas** is the estimate × 1.2, capped at 1,000,000. Evidence over 24,576 bytes of canonical JSON declines (`EVIDENCE_TOO_LARGE`) before sending, so the cap can never fail a send after the model has run.
- **Evidence is public plaintext**, a `data:application/json;base64` canonical-JSON URI, just like `mandate-v1`'s (P7's encrypted findings are a separate feature). Beyond the base fields it carries `block`, `request`, `params`, `prerequisite`, `llm` (host only, never the URL or key, plus `promptHash`), `classifier`, `tools`, `toolCalls`, `modelOutputs`, `finalOutput` and `findings` (each with `origin: "model" | "code"`). **The format freezes once the first live verdict exists** — the tag `risk-v1`, the keys, the encodings and every constant `verify` uses — the same way `mandate-v1`'s did; the prompt can still change under `promptVersion`.
- **`verify` for `risk-v1`** (as built in P5: `verifyRiskRequest`, `validators/risk/src/verify.ts`, behind the same `pnpm attest8004 verify`) never re-runs the model, and stops at the first problem, checking in order: status, the response log, the keccak check and a strict parse; the pin range, the request log and JSON, and the block hash and time at `P`; that the evidence's `request` matches the request; that `params` match the constants; the prerequisite at `P` (A's status and reasons, read the same way B read them); the classifier → code-findings rule; a re-parse of `finalOutput.raw` into model findings; that `scoreOf(findings)` matches the posted score and `reasons` match the codes; and a re-run of every onchain tool call, in order, with its recorded arguments, at `P`. Nansen calls are reported `unchecked`, never a problem. As built, it is also strict about the record's own consistency: the evidence must be exactly canonical JSON (`EVIDENCE_INVALID`), `finalOutput.raw` must be the last recorded model response (`FINDINGS_MISMATCH`), tool-call records must pair one to one with the tool calls in `modelOutputs` (`EVIDENCE_INVALID`), and each re-run uses the model's raw argument string from there. The injection rule includes coverage: every untrusted text the model was shown (the calldata's text, a re-run simulation's revert reason, every recorded Nansen label) must have a classifier result of its own (`FINDINGS_MISMATCH`), whose text is one of the field's guard chunks for the calldata and a revert reason; the guard's scores themselves are recorded, not re-run, and Nansen labels are covered only as recorded (Nansen outputs are unchecked). A call answered `TOOL_CALL_LIMIT` is not re-run and needs no classifier result (the model never saw that answer). `params` are compared with the current `DEPLOYMENTS`, so a redeployed contract would need a versioned params table before older verdicts re-verify.
  - **What this proves:** the score follows from the recorded findings; every onchain fact shown to the model was true at `P`; the injection rule was applied.
  - **What it does not prove: that the recorded output came from the model.** Trusting `risk-v1` means trusting validator B's operator — which is why the gate also requires `mandate-v1`, fully reproducible by anyone. The CLI prints `model output: recorded, not re-run` on every `risk-v1` report (and `--json` carries `"modelOutput": "recorded, not re-run"`). Exit 0 is a match; exit 1 is a mismatch (`EVIDENCE_HASH_MISMATCH`, `EVIDENCE_INVALID`, `PIN_OUT_OF_RANGE`, `PIN_MISMATCH`, `REQUEST_BLOCK_WRONG`, `REQUEST_INVALID`, `REQUEST_FIELDS_MISMATCH`, `PARAMS_MISMATCH`, `PREREQUISITE_MISMATCH`, `FINDINGS_MISMATCH`, `SCORE_MISMATCH` or `TOOL_OUTPUT_MISMATCH`); exit 2 means it couldn't verify (not found, not decoded, an RPC error, including one during a tool re-run, a missing log, or an unknown tag).

### 4.7 Mera findings inbox (web `/inbox`) — the Mera bounty
- **Salt:** `sha256("attest8004.inbox.v1")`. Get the 32-byte PRF output with `getPasskeyPrfOutput`, run **HKDF-SHA256**, and get an **X25519** private key. It lives **in memory only**; zero the buffers after use.
- The public key is published with `MandateRegistry.setInboxKey`, using the passkey assertion. That is a separate ceremony from the PRF prompt, because Mera evaluates one salt per ceremony.
- **Validators encrypt** findings with X25519 ECDH, HKDF and AES-256-GCM (or a libsodium sealed box) to that public key. The ciphertext is served at **a URI of its own, never `responseURI`**: that field stays each validator's public plaintext evidence (§4.5, §4.6), which `verify` and spend accounting depend on, and P7 must not replace it. Where the findings URI is announced (a field inside the evidence, a separate event, or the indexer) is P7's decision.
- **The `/inbox` page:** tap the passkey, derive the key, fetch, decrypt and display. **Nothing is written to localStorage or any server.**
- **Cross-device test:** the same Google Password Manager passkey on an Android phone decrypts the same findings live.
- **rpId gotcha:** passkeys are bound to the domain. Deploy the web app to its final domain early (e.g. Vercel) and create the demo passkeys there, not on localhost.

### 4.8 Envio indexer (`indexer/`)
- **Entities:**
  - `Agent`
  - `ValidationRequest` and `ValidationResponse`
  - `Validator`, with derived stats: count, average score and latency
  - `Mandate` and `InboxKey`
  - `PermissionEvent`: Identity Registry `Approval`, `ApprovalForAll` and agent-wallet/URI changes
  - `AgentTrustSummary` (derived)
- The repo contains `config.yaml`, `schema.graphql` and the handlers. The GraphQL API is used by `getAgentTrust()` and `/dashboard`. (`mandate-v1`'s daily-spend check reads chain state and posted evidence instead, as built in P4, so a verdict can be re-run without the indexer.)
- **Day 1 check:** is Monad testnet 10143 supported? If not, also deploy the contracts to mainnet and index mainnet.

### 4.9 Web app (`web/`)
- `/approve`: register the passkey and approve a mandate.
- `/inbox`: the Mera findings inbox.
- `/dashboard`: requests, verdicts, validator stats and an agent trust lookup.
- Minimal, dark and clean. **For Track 04, developer experience beats visuals.** Link to the docs prominently.

### 4.10 Docs (`docs/`)
- **The docs are part of the product** (Track 04's design score is developer experience):
  - a 10-minute quickstart
  - an SDK and API reference
  - a threat model
  - "trust modes" (deterministic vs agentic)
  - a migration path to the canonical registry
  - a **BTX design note, marked future work and never claimed as live**
  - `deployments.md`
  - the Nansen endpoints list
  - the AI disclosure

### 4.11 *(Stretch, only if the 8 Oct gate passes)* Chainlink CRE (`cre/`)
- A log trigger on `ValidationRequest`, then an HTTP call to the validator logic and Nansen, then an EVM write of `validationResponse`.
- Run `cre workflow simulate … --broadcast` on Monad testnet (CLI v1.30.0+). No production deployment.

---

## 5. Demo scenario (must run end to end, live, on testnet)
1. The operator registers an agent and approves a mandate with a passkey. The `0x0100` verification is visible in the transaction.
2. The agent proposes a benign action. Both validators pass it, and `DemoAgentVault` executes it.
3. **Replay of the Grok/Bankr pattern** (scripted, testnet only, against our own demo contracts): the agent's permissions change outside the mandate, then a transfer to an unknown address is attempted.
   - `mandate-v1` scores it 0 (mandate violation plus an unapproved permission change).
   - `risk-v1` explains why, from its tools: simulation, the counterparty, permission history, and Nansen data when a key is set.
   - `onlyValidated` reverts.
4. The dashboard shows the record.
5. The phone, using the same passkey, decrypts the private findings live.

## 6. Security requirements (judges check "correct and secure")
- Check the precompile return length. Enforce low-s. Bind the challenge and nonce. Check the UV flag and rpIdHash.
- Bind `requestHash` to the exact action, chain, gate, validator and deadline, and make each action single use.
- Validators verify that the request JSON matches `requestHash` before acting.
- Never store private keys or PRF output. Zero buffers. Treat every LLM output as untrusted data: schema-validate it, and the LLM never holds keys.
- Use explicit gas limits. Keep the deployer and validator keys hackathon-only, funded with testnet MON (or a few dollars on mainnet).
- Run a gitleaks scan before the repo goes public and before submission.
- Before submission, run a self-review using the Opus "auditor" prompt in GAMEPLAN, and write `docs/security-review.md`.

## 7. Out of scope
Tokens, staking and slashing (roadmap only), TEE or zk validators, live BTX, a mobile app, the MetaMask plugin, a Perpl trading bot, Mera UX, Privy and Dynamic.
