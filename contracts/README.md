# contracts

Foundry project for the Attest8004 contracts (SPEC §4.1–4.3):

| Contract | Status |
|---|---|
| `ValidationRegistry` | planned (P1) |
| `AttestGate` + `DemoAgentVault` | planned (P2) |
| `MandateRegistry` | planned (P4, passkeys in P6) |

```bash
forge build
forge test          # unit + fuzz tests
forge fmt --check   # CI enforces formatting
```

- Solidity 0.8.37, EVM `osaka`, Foundry `network = "monad"` (P256VERIFY at `0x0100`).
- Dependencies are git submodules in `lib/`: forge-std v1.17.0 and OpenZeppelin Contracts v5.7.0
  (pinned in `foundry.lock`). Clone with `--recurse-submodules`, or run `git submodule update --init --recursive`.
- `test/Toolchain.t.sol` is a scaffold smoke test for the P256 precompile and the OpenZeppelin remapping.
- RPC aliases `monad_testnet` and `monad` read `MONAD_TESTNET_RPC_URL` and `MONAD_RPC_URL` from `.env`.
