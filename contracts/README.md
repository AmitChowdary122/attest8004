# contracts

Foundry project for the Attest8004 contracts (SPEC §4.1–4.4; `DemoPassThrough` below is the §4.6 demo target, for the end-to-end demo scenario in §5):

| Contract | Status |
|---|---|
| `ValidationRegistry` | **live on Monad testnet** at `0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f` (P1; see [docs/deployments.md](../docs/deployments.md)) |
| `AttestGate` + `DemoAgentVault` | **live on Monad testnet**: `DemoAgentVault` at `0x12fAb3E3cA810Cc44bD9f537613a230a2be8D614`, for demo agent 1984, requiring both `mandate-v1` and `risk-v1` (the P2 vault for agent 1982 and the single-validator P3 vault for agent 1984 are superseded; see [docs/deployments.md](../docs/deployments.md)) |
| `AgentRequestForwarder` | **live on Monad testnet** at `0x1451F3C36545b191d3642f759D59f21DcFD657B2` (P3; see [docs/deployments.md](../docs/deployments.md)) |
| `MandateRegistry` | **v2 (P6, owner + passkey) built and tested, not yet deployed.** The live testnet registry is still P4's owner-set one, at `0x2523197373ef813E19b5b14Ef2984130868cD17c` (source at commit `6e08223`; see [docs/deployments.md](../docs/deployments.md)) |
| `DemoPassThrough` | demo-only, **live on Monad testnet** at `0xEEEBBa55620afC42E9c88b5d962476367b8da338`: the P5 risky-but-mandated target (SPEC §4.6) that forwards every payment to a fixed sink nobody controls; now allowlisted in demo agent 1984's mandate, next to the deployer (see [docs/deployments.md](../docs/deployments.md)) |

```bash
forge build
forge test          # unit + fuzz tests (fork tests skip without an RPC URL)
forge fmt --check   # CI enforces formatting
```

- Solidity 0.8.37, EVM `osaka`, Foundry `network = "monad"` (P256VERIFY at `0x0100`).
- Dependencies are git submodules in `lib/`: forge-std v1.17.0 and OpenZeppelin Contracts v5.7.0
  (pinned in `foundry.lock`). Clone with `--recurse-submodules`, or run `git submodule update --init --recursive`.
- RPC aliases `monad_testnet` and `monad` read `MONAD_TESTNET_RPC_URL` and `MONAD_RPC_URL` from the environment.

## ValidationRegistry

`src/ValidationRegistry.sol` implements the EIP-8004 Validation Registry interface
(`src/interfaces/IValidationRegistry.sol`, copied from the EIP). It is immutable: the Identity Registry is a
constructor argument, and there is no owner or proxy. Every difference from the EIP Draft and the reference
implementation is in [docs/spec-notes.md](../docs/spec-notes.md).

| Test file | What it covers |
|---|---|
| `test/ValidationRegistry.t.sol` | Authorisation (owner, operator, token-approved, stranger, transfers), response range, wrong validator, unknown request, repeated responses, summary maths and filters, exact EIP signatures, fuzz (incl. a reference model for `getSummary`) |
| `test/fork/ValidationRegistry.fork.t.sol` | The same flows against the **live canonical Identity Registry** on a fork of Monad testnet |
| `test/DeployValidationRegistry.t.sol` | The CREATE2 deploy script: predicted address, idempotence, per-chain Identity Registry |

## AgentRequestForwarder

`src/AgentRequestForwarder.sol` lets an agent's hot key request validations without being able to move the agent.
EIP-8004 accepts `validationRequest` only from the owner or an ERC-721 operator, and an operator can also transfer
the agent. So the owner approves the forwarder, either per agent (`approve(forwarder, agentId)`, which the demo
agents use) or once for all its agents (`setApprovalForAll`), and registers one key per agent (`setAgentKey`, current
owner only; `address(0)` revokes). `request` works only from that key, only while the owner
who registered it still owns the agent, and makes exactly one call: `validationRequest` on the fixed registry.
Immutable, no admin, no funds. The trade-off between the two approvals is in ARCHITECTURE §7.

| Test file | What it covers |
|---|---|
| `test/AgentRequestForwarder.t.sol` | Key management (owner only, not an operator or the key; rotate; revoke); requests: wrong key, another agent's key, the owner, no key, a revoked key, a key set by a previous owner after a transfer (even if the new owner approved the forwarder), the A→B→A case, a revoked approval, a reused hash, a per-token `approve` instead of `setApprovalForAll` (works for that agent only, cleared by a transfer); that the forwarder can only call `validationRequest` (state-diff recording of every call it makes, the compiled ABI pinned, ERC-721 calls refused, no funds, fuzzed calldata) |
| `test/fork/AgentRequestForwarder.fork.t.sol` | The testnet configuration against the live registry and canonical Identity Registry: a key requests; a stale key after a transfer is refused |
| `test/DeployAgentRequestForwarder.t.sol` | The CREATE2 deploy script: predicted address, idempotence, wiring, the testnet configuration |

## MandateRegistry

`src/MandateRegistry.sol` (v2, P6) holds each agent's current spending mandate (SPEC §4.2): allowed targets and
selectors (at most 16 of each), a per-transaction and a per-day cap in native MON, and an expiry; plus the agent's
passkey public key and its X25519 inbox public key. `mandate-v1` reads the mandate at its pinned block.

Every change needs **two factors**: a transaction from the agent's current `ownerOf` (an operator or a token-approved
address is refused) **and** a WebAuthn assertion from the passkey bound to the agent, verified with OpenZeppelin 5.7's
`WebAuthn` (UP and UV required, low-s) through the P256 precompile at `0x0100`. The owner sets the passkey once
(`setPasskey`, on-curve check only); it stays with the agent across a transfer, so rotate to the buyer's passkey
(`rotatePasskey`, owner + current passkey) before selling. `setMandate`, `rotatePasskey` and `setInboxKey` all go
through one internal hook, `_authorize(agentId, changeHash, auth)`, before any write: owner, passkey set,
`authenticatorData` starting with the immutable `rpIdHash` (`sha256("attest8004.vercel.app")`; OpenZeppelin doesn't
check it), then the assertion over `challengeFor(agentId, changeHash, nonce) = sha256(abi.encode(chainid, registry,
agentId, changeHash, nonce))`; success increments the nonce. `revokeMandate` is the panic button: owner only, no
passkey, and it also increments the nonce, cancelling approvals signed but not yet submitted (while a mandate is set:
with none set it reverts `NoMandate`). There is no passkey
recovery. `MandateSet`/`MandateRevoked` keep P4's exact signatures. The record stores the setting owner and
`setAtBlock`, so a mandate goes stale once the agent is transferred (`mandate-v1` then fails
`MANDATE_OWNER_CHANGED`). It rejects a zero target, an expiry at or before now, and a per-transaction cap above the
daily cap. Immutable, no admin, no funds, no fallback. P4's owner-only source (the live deployment) is at commit
`6e08223`.

| Test file | What it covers |
|---|---|
| `test/MandateRegistry.t.sol` | Real `vm.signP256` assertions against the real precompile. Two factors (owner; operator, token-approved address, stranger and a nonexistent agent refused; no passkey; another key, garbage `r`/`s`, an empty struct, short `authenticatorData`); the challenge (each of changeHash, agentId, nonce, chain id and registry wrong), replay, UV or UP missing, another site's rpIdHash, high-s (low-s passes), Chrome's extra clientDataJSON key; the precompile mocked to always answer empty (never success) and to answer only OpenZeppelin's probe; `setPasskey` (owner, once, on curve), rotation, the passkey across a transfer, revoke (owner only, bumps the nonce, kills a pending approval), the inbox key; an approval can't cross operations or agents; fuzz (nonce binding, challenge binding, indices never panic or run out of gas, `mandateHash` binds every field); every P4 rule and boundary, overwrite, the record after a transfer; P4's event topics; the constructor; `passkey-vectors.json`; and a gas record (`test_Gas_Record`) |
| `test/helpers/WebAuthnFixture.sol` | Builds real assertions: a P-256 key from `vm.publicKeyP256`, Chrome-shaped `clientDataJSON` (optionally with its extra key), `authenticatorData` with flags `0x1D` and our rpIdHash, low-s (or high-s on request), indices found in the JSON |
| `test/mocks/MandateRegistryHookHarness.sol` | A subclass that records and can veto `_authorize`, used to prove every passkey-approved change goes through the hook, with its own `changeHash`, before any write |
| `test/fork/MandateRegistry.fork.t.sol` | On a fork of Monad testnet: the deploy script's testnet deployment is wired to the canonical Identity Registry and our rpIdHash; on a fresh v2 registry (`new`, with the script's constructor arguments, so it stays fresh once v2 is live), the live owner of agent 1984 sets a passkey and a mandate with a real assertion, and a stranger, and the owner with another key's assertion, are refused |
| `test/DeployMandateRegistry.t.sol` | The CREATE2 deploy script: predicted address, idempotence, both immutables, the v2 salt and rpId, the exact broadcast transaction, the testnet configuration, unsupported chains |

The expected challenge, change hashes, e2e mandate hash, selectors and topics in
`packages/sdk/test/passkey-vectors.json` come from `cast` and `sha256sum` (`passkey-vectors.sh`; CI runs it with
`--check`).

## AttestGate and DemoAgentVault

`src/ActionHash.sol` defines the `Action` struct and the two hashes (SPEC §4.3): `requestHash`, one per validator,
and `actionHash`, which leaves the validator out. The TypeScript SDK implements the same encoding, and both are
checked against `packages/sdk/test/vectors.json`, whose expected values come from `cast` (`vectors.sh`).

`src/AttestGate.sol` is an abstract contract with the `onlyValidated(action)` modifier. It holds 1 to 4 immutable
`(validator, minScore, tagHash)` requirements, and every one must pass. For each, it recomputes that validator's
`requestHash` and checks the registry's stored validator, agentId, score and tag: a verdict naming the right
validator and agent with a sufficient score but the wrong tag reverts `TagMismatch`. `requestHash` already binds
one validator to one exact action, but not to any particular check that validator ran for it, so without the tag
a gate naming a validator by address alone would accept a verdict from some other check that same key happens to
answer for this action — the tag is what makes "validator A's key signs only `mandate-v1` verdicts" (ARCHITECTURE
§9) a contract rule. The constructor rejects a zero `tagHash`, because no real tag hashes to it, so it would be a
requirement nothing could ever satisfy. It marks `actionHash` consumed before the consumer's external call.
`src/DemoAgentVault.sol` is the example consumer: bound to one agentId, it holds native funds and makes validated
calls under a transient reentrancy guard. `script/DeployDemoAgentVault.s.sol` configures the vault to require both
`mandate-v1` (validator A, minimum 100) and `risk-v1` (validator B, minimum 80), each under its own tag; the live
testnet deployment (status table above) matches, superseding the single-validator P3 vault. See
`docs/deployments.md`.

| Test file | What it covers |
|---|---|
| `test/ActionHash.t.sol` | The shared vectors (8 cases, read from the SDK's `vectors.json`), and fuzz: the validator is bound, `requestHash` never equals `actionHash` |
| `test/AttestGate.t.sol` | Constructor rules (minScore 1-100, no zero or duplicate validators, no zero tagHash, 1-4 requirements); executes when validated; reverts when unvalidated, pending, low or lowered score, wrong tag (and that score is checked before tag), untrusted validator, hash squatted by another agent, expired, replayed, different action, another gate, another chain; two validators must both pass, including both tags; fuzz on score, tag, fields and deadline |
| `test/DemoAgentVault.t.sol` | Bound to one agent, native transfers, a failed call rolls back consumption, any caller may submit, re-entry blocked, consumed before the external call |
| `test/fork/DemoAgentVault.fork.t.sol` | The vault against the **live P1 registry** and canonical Identity Registry, including the exact testnet configuration (demo agent 1984, both validators answering with their own tag) |
| `test/DeployDemoAgentVault.t.sol` | The CREATE2 deploy script: predicted address, idempotence, wiring, the testnet configuration (both validators and tags) |
| `test/Toolchain.t.sol` | P0 toolchain smoke test: P256VERIFY at `0x0100` in Foundry's Monad profile (32 bytes `…01` for a valid signature, empty for an invalid one), and the OpenZeppelin remapping (`P256.verify`) |

## DemoPassThrough (demo-only, live on Monad testnet)

`src/DemoPassThrough.sol` is the P5 risky-but-mandated demo target (SPEC §4.6, decision 34): a fresh "payment
router" that actually sweeps every payment it receives straight to a fixed `sink` nobody controls
(`address(uint160(uint256(keccak256("attest8004.demo.sink"))))`). It has no `fallback`, so a call that carries data
has no matching function and reverts before `receive` ever runs. The story: the operator allowlists it next to the
deployer in demo agent 1984's mandate (approved on `/approve`, submitted with `submit-approval`); mandate-v1 then approves a plain transfer to it like any
other allowlisted target (within caps, simulation succeeds), while risk-v1's `simulate_action` trace sees the value
keep moving on to `sink`, which isn't on the mandate, has no code and nonce 0 — the rubric scores that **high**, so
the gate refuses. `script/DeployDemoPassThrough.s.sol` deploys it through the same CREATE2 factory; it is **live on
Monad testnet** at `0xEEEBBa55620afC42E9c88b5d962476367b8da338` and **is now allowlisted** in demo agent 1984's
mandate, next to the deployer (see [docs/deployments.md](../docs/deployments.md)).

| Test file | What it covers |
|---|---|
| `test/DemoPassThrough.t.sol` | `receive` forwards all value to `sink` (plus fuzz), reverts `ForwardFailed` when the sink can't accept the forward, the zero-sink constructor check, a call with data reverts (no fallback), and a vault action to the pass-through executes under the gate's per-verdict tag check |
| `test/DeployDemoPassThrough.t.sol` | The CREATE2 deploy script: predicted address, idempotence, the exact broadcast transaction, and `SINK`'s value pinned independently with `cast` |

Fork tests fork the latest testnet block (Monad RPC nodes don't reliably serve old state) and skip unless
`MONAD_TESTNET_RPC_URL` is set:

```bash
MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz forge test --match-path 'test/fork/*'
```

CI runs them in a separate `contracts-fork` job that may fail without turning the build red (public RPC rate limits).

## Deploying

`script/DeployValidationRegistry.s.sol`, `script/DeployAgentRequestForwarder.s.sol`, `script/DeployMandateRegistry.s.sol`, `script/DeployDemoAgentVault.s.sol` and `script/DeployDemoPassThrough.s.sol` deploy through the CREATE2
factory `0x4e59…956C` with a **literal gas limit** (`DEPLOY_GAS`), because Monad charges for the gas limit, not
the gas used. The address depends on the init code, which includes the constructor arguments: the
ValidationRegistry's and the MandateRegistry's addresses depend on the Identity Registry (so testnet and mainnet
differ; the MandateRegistry's also on its `rpIdHash`), the forwarder's on its ValidationRegistry, the vault's on its registry, agent and validator requirements,
and the pass-through's on its `sink`. Re-running is a no-op once the contract exists.

```bash
./script/deploy-testnet.sh ValidationRegistry               # dry run against Monad testnet; nothing is sent
BROADCAST=1 ./script/deploy-testnet.sh ValidationRegistry   # deploy
./script/deploy-testnet.sh AgentRequestForwarder            # same, for the forwarder
./script/deploy-testnet.sh MandateRegistry                  # same, for the mandate registry
./script/deploy-testnet.sh DemoAgentVault                   # same, for the demo vault
./script/deploy-testnet.sh DemoPassThrough                  # same, for the risky-but-mandated demo target
```

The wrapper loads `../.env` into the environment and never prints it. The deployer key reaches forge through
`--private-key`, never through a cheatcode, so it doesn't appear in script traces. The wrapper also passes
`--skip-simulation`, so that forge keeps the script's literal gas limit instead of replacing it with its own estimate. Record every deployment in [docs/deployments.md](../docs/deployments.md).
