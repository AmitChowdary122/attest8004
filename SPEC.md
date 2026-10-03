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
- a **validator SDK** with two reference validators: one deterministic and re-executable, one agentic using Qwen 3.8 Max and Nansen
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
| Qwen 3.8 Max ($5k credits) | **Agentic** use: planning, tool use and multi-step execution. A working product deployed on Monad. A **published article** on how Qwen was used. |
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
  contracts/            Foundry: ValidationRegistry, MandateRegistry, AttestGate, DemoAgentVault, script/, test/
  packages/sdk/         @attest8004/sdk — client + validator base + shared types + hash test vectors
  validators/mandate/   deterministic validator service
  validators/qwen/      agentic Qwen validator service
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

### 4.2 `MandateRegistry.sol` — passkey-approved mandates
- Per `agentId`, the **agent owner** sets the operator's passkey public key `(qx, qy)` once, via a normal wallet transaction.
- **Mandate** fields: `allowedTargets[]`, `allowedSelectors[]`, `maxValuePerTx`, `maxValuePerDay`, `validUntil`. Its hash is `mandateHash`.
- `setMandate(agentId, Mandate, WebAuthnAuth)` and `setInboxKey(agentId, bytes32 x25519Pub, WebAuthnAuth)` require a **WebAuthn assertion**:
  - The challenge is `sha256(abi.encode(block.chainid, address(this), agentId, actionHash, nonce))`. Increment `nonce` on every use (replay protection).
  - Verify `type == "webauthn.get"`, that the challenge in `clientDataJSON` matches, the **UP and UV flags**, the rpIdHash, and **low-s**.
  - Verify the signature with **P256 at `0x0100`**. Prefer OpenZeppelin's WebAuthn/P256 libraries if the installed version has them; they call `0x100` with a Solidity fallback. If you write your own wrapper, **check the return data length is 32 and equals 1**, because the precompile returns empty bytes on failure.
- Events: `PasskeySet`, `MandateSet(agentId, mandateHash, …fields, setAt)`, `MandateRevoked`, `InboxKeySet`.
- **Tests:** a real assertion vector recorded from Chrome on Day 7 (store it in `test/vectors/`), wrong challenge, replay, UV missing, high-s rejected, and an empty-return precompile mock.
- **Done when:** a mandate is approved from the `/approve` page with a real passkey on testnet, and the transaction shows the verification.

### 4.3 `AttestGate` + `DemoAgentVault.sol`
- `Action { uint256 agentId; address target; uint256 value; bytes data; uint64 deadline; bytes32 salt; }`
- Two hashes, defined once in `contracts/src/ActionHash.sol`. The **same functions live in the TS SDK** (`computeRequestHash`, `computeActionHash`), with shared test vectors (`packages/sdk/test/vectors.json`, expected values generated with `cast`), and both test suites must pass on them.
  - `requestHash = keccak256(abi.encode(block.chainid, gate, validatorAddress, agentId, target, value, keccak256(data), deadline, salt))`, **one per validator**, because the registry records exactly one validator per `requestHash`.
  - `actionHash` is the same encoding without `validatorAddress`. The gate marks it consumed.
  - `requestHash` stays an ABI-encoded action hash: that encoding is the "request payload" the EIP's `requestHash` commits to (`docs/spec-notes.md`, row 6).
- The gate has an **immutable list of `(validator, minScore)` requirements** (1 to 4, fixed at deployment, no owner), and **every one must pass**. The constructor rejects `minScore` 0 (a pending request reads as response 0), `minScore` above 100, a zero validator and duplicate validators.
- `onlyValidated(Action)`:
  1. Require `block.timestamp <= deadline`, and that `actionHash` hasn't been consumed.
  2. For each requirement, **recompute** that validator's `requestHash` from the call, so a verdict can't be reused for a different action, gate, chain or validator.
  3. Look it up in the ValidationRegistry. Require that the stored `validatorAddress` is that validator, that the stored `agentId` is the action's (anyone who owns an agent can claim a hash first), and that `response >= minScore`.
  4. **Mark `actionHash` consumed** (single use) **before the external call**. The gated function is also `nonReentrant`.
- `DemoAgentVault`: holds test MON or ERC-20 for **one immutable `agentId`**, and rejects actions for any other agent. `execute(Action)` is gated by `onlyValidated`. It is permissionless, because the validated action is the authorisation. The P2 testnet deployment requires validator A only; P5 redeploys it requiring both validators.
- **Done when:** a validated action executes, and these revert: unvalidated, pending, low score, untrusted validator, wrong `agentId` (squatted hash), expired, replayed, a different action, and a verdict for another gate. Each case has a test.

### 4.4 `packages/sdk` (TypeScript, viem)
- **Client:**
  - `buildAction()` and `computeRequestHash()`.
  - `requestValidation({validators[], action})`. Puts the request JSON in `requestURI`, either as a `data:` URI (preferred, no hosting) or over HTTP, then calls the registry.
  - `awaitVerdict()` and `isValidated()`.
  - `getAgentTrust(agentId)`, which reads from the Envio GraphQL API.
- **Validator base class:**
  - Subscribe to `ValidationRequest` where `validatorAddress == self`.
  - Load the request and check that its action hashes to `requestHash`.
  - Run `check()`, then post `validationResponse` with an evidence JSON hash.
  - Handle retries and idempotency, and use **explicit gas limits** (Monad charges on the gas limit, not gas used).
- Request JSON schema v1: `{ "schema":"attest8004.request.v1", "chainId", "gate", "validator", "agentId", "action":{…} }`, one per validator (ARCHITECTURE §6).
- Register two demo agents in the canonical Identity Registry using the **agent0 SDK** (sdk.ag0.xyz). Check that it supports testnet 10143; if not, call `register()` directly.

### 4.5 Validator A — `mandate-v1` (deterministic)
- **Checks:**
  - A mandate exists and hasn't expired.
  - The target is allowlisted.
  - The selector is allowlisted.
  - The value is within the per-transaction cap.
  - The rolling 24h spend is within the daily cap (from the indexer or onchain history).
  - **No permission or mandate change in the last N blocks without a passkey-approved mandate.** This is the Grok/Bankr pattern.
  - An `eth_call` simulation at a **pinned block** doesn't revert.
- **Output:** a score of 100 or 0, with tag `mandate-v1` and machine-readable reasons. The evidence JSON includes the pinned block number.
- **Reproducibility:** `npx attest8004 verify <requestHash>` re-runs it and must give the same verdict. **This validator carries the "is it trust?" argument.** Lead with it in the docs and the demo.

### 4.6 Validator B — `risk-qwen-v1` (agentic, Qwen 3.8 Max)
- Calls Qwen 3.8 Max through Alibaba Model Studio's international OpenAI-compatible endpoint. **Confirm the exact model ID in the console.**
- **Tools** (function calling):
  - `get_request`
  - `get_mandate`
  - `simulate_tx`
  - `nansen_counterparty_profile` and `nansen_flows`. Use Nansen API or x402 pay-per-call, and list every endpoint used in the README. EVM addresses are the same across chains, so the counterparty's real history is available even when the demo runs on testnet.
  - `erc8004_reputation` (for counterparty agents)
  - `recent_permission_events`
- The model **plans, calls tools over several steps, and returns structured JSON**: `{score 0-100, risk_level, reasons[], evidence[]}`.
- Hard caps on tool calls and tokens, and low temperature. Save the full trace (plan, tool calls and results) into the evidence. It feeds the article and the demo.
- Tag `risk-qwen-v1`. **Detailed findings are encrypted to the operator's inbox key** (§4.7). Only the score and evidence hash are public.

### 4.7 Mera findings inbox (web `/inbox`) — the Mera bounty
- **Salt:** `sha256("attest8004.inbox.v1")`. Get the 32-byte PRF output with `getPasskeyPrfOutput`, run **HKDF-SHA256**, and get an **X25519** private key. It lives **in memory only**; zero the buffers after use.
- The public key is published with `MandateRegistry.setInboxKey`, using the passkey assertion. That is a separate ceremony from the PRF prompt, because Mera evaluates one salt per ceremony.
- **Validators encrypt** findings with X25519 ECDH, HKDF and AES-256-GCM (or a libsodium sealed box) to that public key. The ciphertext is served at `responseURI`; `responseHash` is the keccak of the ciphertext.
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
- The repo contains `config.yaml`, `schema.graphql` and the handlers. The GraphQL API is used by `getAgentTrust()`, the mandate validator's daily-spend check and `/dashboard`.
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
   - `risk-qwen-v1` explains why, citing Nansen data on the counterparty.
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
