# contracts

Foundry project for the Attest8004 contracts (SPEC §4.1–4.3):

| Contract | Status |
|---|---|
| `ValidationRegistry` | **live on Monad testnet** at `0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f` (P1; see [docs/deployments.md](../docs/deployments.md)) |
| `AttestGate` + `DemoAgentVault` | planned (P2) |
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
