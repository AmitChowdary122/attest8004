# contracts

Foundry project for the Attest8004 contracts (SPEC §4.1–4.3):

| Contract | Status |
|---|---|
| `ValidationRegistry` | **live on Monad testnet** at `0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f` (P1; see [docs/deployments.md](../docs/deployments.md)) |
| `AttestGate` + `DemoAgentVault` | **live on Monad testnet**: `DemoAgentVault` at `0x23BfBD12545CCd1501ddA1B65a54518FD6212a96`, for demo agent 1984, requiring validator A (P3; the P2 vault for agent 1982 is superseded; see [docs/deployments.md](../docs/deployments.md)) |
| `MandateRegistry` | planned (P4, passkeys in P6) |

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

## AttestGate and DemoAgentVault

`src/ActionHash.sol` defines the `Action` struct and the two hashes (SPEC §4.3): `requestHash`, one per validator,
and `actionHash`, which leaves the validator out. The TypeScript SDK implements the same encoding, and both are
checked against `packages/sdk/test/vectors.json`, whose expected values come from `cast` (`vectors.sh`).

`src/AttestGate.sol` is an abstract contract with the `onlyValidated(action)` modifier. It holds 1 to 4 immutable
`(validator, minScore)` requirements, and every one must pass. For each, it recomputes that validator's
`requestHash` and checks the registry's stored validator, agentId and score. It marks `actionHash` consumed
before the consumer's external call. `src/DemoAgentVault.sol` is the example consumer: bound to one agentId,
it holds native funds and makes validated calls under a transient reentrancy guard.

| Test file | What it covers |
|---|---|
| `test/ActionHash.t.sol` | The shared vectors (8 cases, read from the SDK's `vectors.json`), and fuzz: the validator is bound, `requestHash` never equals `actionHash` |
| `test/AttestGate.t.sol` | Constructor rules (minScore 1-100, no zero or duplicate validators, 1-4 requirements); executes when validated; reverts when unvalidated, pending, low or lowered score, untrusted validator, hash squatted by another agent, expired, replayed, different action, another gate, another chain; two validators must both pass; fuzz on score, fields and deadline |
| `test/DemoAgentVault.t.sol` | Bound to one agent, native transfers, a failed call rolls back consumption, any caller may submit, re-entry blocked, consumed before the external call |
| `test/fork/DemoAgentVault.fork.t.sol` | The vault against the **live P1 registry** and canonical Identity Registry, including the exact testnet configuration (demo agent 1984) |
| `test/DeployDemoAgentVault.t.sol` | The CREATE2 deploy script: predicted address, idempotence, wiring, the testnet configuration |
| `test/Toolchain.t.sol` | P0 toolchain smoke test: P256VERIFY at `0x0100` in Foundry's Monad profile (32 bytes `…01` for a valid signature, empty for an invalid one), and the OpenZeppelin remapping (`P256.verify`) |

Fork tests fork the latest testnet block (Monad RPC nodes don't reliably serve old state) and skip unless
`MONAD_TESTNET_RPC_URL` is set:

```bash
MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz forge test --match-path 'test/fork/*'
```

CI runs them in a separate `contracts-fork` job that may fail without turning the build red (public RPC rate limits).

## Deploying

`script/DeployValidationRegistry.s.sol` and `script/DeployDemoAgentVault.s.sol` deploy through the CREATE2
factory `0x4e59…956C` with a **literal gas limit** (`DEPLOY_GAS`), because Monad charges for the gas limit, not
the gas used. The address depends on the init code, which includes the constructor arguments: the
ValidationRegistry's address depends on the Identity Registry (so testnet and mainnet differ), and the vault's on
its registry, agent and validator requirements. Re-running is a no-op once the contract exists.

```bash
./script/deploy-testnet.sh ValidationRegistry               # dry run against Monad testnet; nothing is sent
BROADCAST=1 ./script/deploy-testnet.sh ValidationRegistry   # deploy
./script/deploy-testnet.sh DemoAgentVault                   # same, for the demo vault
```

The wrapper loads `../.env` into the environment and never prints it. The deployer key reaches forge through
`--private-key`, never through a cheatcode, so it doesn't appear in script traces. The wrapper also passes
`--skip-simulation`, so that forge keeps the script's literal gas limit instead of replacing it with its own estimate. Record every deployment in [docs/deployments.md](../docs/deployments.md).
