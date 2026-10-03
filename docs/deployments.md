# Deployments

Every Attest8004 deployment is recorded here: chain, contract, address, the commit it was built from, and the date.

| Chain | Contract | Address | Commit | Date | Deploy tx |
|---|---|---|---|---|---|
| Monad testnet (10143) | `ValidationRegistry` | [`0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f`](https://monad-testnet.socialscan.io/address/0xc4a4d0ceb3971cbe7a2536494ac106f2cd9f9a8f) | `8dc8859` | 2026-10-02 | [`0x724f31e0…cf64d03`](https://monad-testnet.socialscan.io/tx/0x724f31e0efd09993f2d73581cb742e71d4bef52c0f4f2a30cccd43d79cf64d03) (block 67,604,893) |
| Monad testnet (10143) | `DemoAgentVault` (AttestGate) | [`0x7A5EC388CCbfD3B255CFa94fc2062c0807F2C4CD`](https://monad-testnet.socialscan.io/address/0x7a5ec388ccbfd3b255cfa94fc2062c0807f2c4cd) | `f826eec` | 2026-10-03 | [`0xd960c130…72b6a64`](https://monad-testnet.socialscan.io/tx/0xd960c1304d88b0352d2bdf054eac174c704fd356ae465eeb8df570a6572b6a64) (block 67,757,166) |

### ValidationRegistry (testnet) details

- **Constructor argument:** the canonical testnet Identity Registry `0x8004A818BFB912233c491871b3d84c89A494BD9e`.
- **How it was deployed:** `contracts/script/DeployValidationRegistry.s.sol` via `script/deploy-testnet.sh` (now
  `script/deploy-testnet.sh ValidationRegistry`), through the
  CREATE2 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` with salt `keccak256("attest8004.ValidationRegistry.v1")`.
  The broadcast record is `contracts/broadcast/DeployValidationRegistry.s.sol/10143/run-latest.json`.
- **Gas:** explicit limit 1,140,000 (Monad `eth_estimateGas` was 949,673; limit = ×1.2, rounded up to 10k).
- **The address depends on the Identity Registry.** The init code includes the Identity Registry argument, and testnet and
  mainnet use different Identity Registries, so a mainnet deployment will have a different address. Check it with
  `predictedAddress(<identity registry>)` on the deploy script.
- **Not canonical.** This is a spec-conformant ERC-8004 Validation Registry, not an official erc-8004 deployment.
  Differences from the EIP are listed in [spec-notes.md](./spec-notes.md).
- **Not upgradeable, no owner.** Nobody can change this contract after deployment. It reads the canonical Identity Registry,
  which *is* an upgradeable proxy with an owner; see the trust model in ARCHITECTURE §7.

### DemoAgentVault (testnet) details

- **Constructor arguments:** the ValidationRegistry above (`0xc4A4…F9a8f`), agent **1982** (the P1 test agent, owned by
  the deployer), and one requirement: validator A `0xa62DaB21E0C0F57e94B3ed6e675F214199989e92` (`mandate-v1`) with
  `minScore` 100. Read them back with `validationRegistry()`, `agentId()` and `requirements()`.
- **Requires validator A only, for now.** P5 redeploys the vault requiring both validators (`mandate-v1` and
  `risk-qwen-v1`). Different constructor arguments give a different address, and this one stays as it is.
- **How it was deployed:** `contracts/script/DeployDemoAgentVault.s.sol` via `script/deploy-testnet.sh DemoAgentVault`,
  through the CREATE2 factory with salt `keccak256("attest8004.DemoAgentVault.v1")`. The broadcast record is
  `contracts/broadcast/DeployDemoAgentVault.s.sol/10143/run-latest.json`.
- **Gas:** explicit limit 1,000,000 (Monad `eth_estimateGas` was 829,476; limit = ×1.2, rounded up to 10k).
- **Not upgradeable, no owner.** Funds leave the vault only through `execute` with an action that validator A passed.
  `execute` is permissionless: the validated action is the authorisation.

## Verified round trips

`scripts/src/validation-roundtrip.ts` (`pnpm --filter @attest8004/scripts roundtrip`) registers a test agent, requests
validation from validator A, and has validator A respond. It then checks `getValidationStatus` and `getSummary`
onchain. The response is a smoke test of the registry, not a validation verdict; its evidence JSON says so.

| Date | Chain | Registry | agentId | requestHash | register tx | validationRequest tx | validationResponse tx |
|---|---|---|---|---|---|---|---|
| 2026-10-02 | Monad testnet (10143) | `0xc4A4D0cE…F9a8f` | 1982 | `0xe7382dcc…996dea2` | [`0x1cbd6edd…e9e1327`](https://monad-testnet.socialscan.io/tx/0x1cbd6eddb85ac102c8916b120793dd8dff716311bab0be7a6492f7411e9e1327) | [`0x7ef1b474…fcf040`](https://monad-testnet.socialscan.io/tx/0x7ef1b474bcdd6d0b10104ebd9b872aa1f0f66bf904a34ae99c19ef4348fcf040) | [`0x7eb0f99e…901bfb6`](https://monad-testnet.socialscan.io/tx/0x7eb0f99e00b7c4557f3634aa847316c2ebb2c6f86e20bead2e09f002a901bfb6) |

- Agent owner (the deployer): `0x3EFEB3Cf2FB54A7D99abE90AaB786cE5A831a8CF`. Validator A: `0xa62DaB21E0C0F57e94B3ed6e675F214199989e92`.
- Full `requestHash`: `0xe7382dcc048aaacd828a3af2a7cd955bed6ba731877ba5149b5b0f3eb996dea2`. Check it yourself:
  `cast call 0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f "getValidationStatus(bytes32)(address,uint256,uint8,bytes32,string,uint256)" <requestHash> --rpc-url https://testnet-rpc.monad.xyz`
- Gas limits (all explicit): register 493,000; validationRequest 284,000; validationResponse 165,000 (provisional for this
  first run; tightened to 102,000 afterwards from the measured estimate of 84,212).

## Canonical contracts used (not deployed by us)

| Contract | Monad testnet (10143) | Monad mainnet (143) |
|---|---|---|
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| P256VERIFY precompile | `0x0100` | `0x0100` |
