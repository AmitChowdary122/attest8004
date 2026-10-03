# Deployments

Every Attest8004 deployment is recorded here: chain, contract, address, the commit it was built from, and the date.

| Chain | Contract | Address | Commit | Date | Deploy tx |
|---|---|---|---|---|---|
| Monad testnet (10143) | `ValidationRegistry` | [`0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f`](https://monad-testnet.socialscan.io/address/0xc4a4d0ceb3971cbe7a2536494ac106f2cd9f9a8f) | `8dc8859` | 2026-10-02 | [`0x724f31e0…cf64d03`](https://monad-testnet.socialscan.io/tx/0x724f31e0efd09993f2d73581cb742e71d4bef52c0f4f2a30cccd43d79cf64d03) (block 67,604,893) |
| Monad testnet (10143) | `AgentRequestForwarder` | [`0x1451F3C36545b191d3642f759D59f21DcFD657B2`](https://monad-testnet.socialscan.io/address/0x1451f3c36545b191d3642f759d59f21dcfd657b2) | `5f2f4a4` | 2026-10-03 | [`0x82883206…72a3cd7`](https://monad-testnet.socialscan.io/tx/0x828832065b96235728c1782e9be9b4b712e3f408f8755e20f554a210472a3cd7) (block 67,779,694) |
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

### AgentRequestForwarder (testnet) details

- **Constructor argument:** the ValidationRegistry above (`0xc4A4…F9a8f`). The forwarder reads the Identity Registry from
  it (`identityRegistry()` returns the canonical `0x8004A818BFB912233c491871b3d84c89A494BD9e`).
- **What it does:** an agent's owner approves it once with `setApprovalForAll(forwarder, true)` on the Identity Registry
  and registers a hot key with `setAgentKey(agentId, key)`. The key can then call `request(...)`, which makes exactly one
  call, `validationRequest`, on the ValidationRegistry, while the owner who registered it still owns the agent. See
  ARCHITECTURE §5.2 and §7 (the approval covers all of the owner's agents; the forwarder only exposes `validationRequest`).
- **How it was deployed:** `contracts/script/DeployAgentRequestForwarder.s.sol` via
  `script/deploy-testnet.sh AgentRequestForwarder`, through the CREATE2 factory with salt
  `keccak256("attest8004.AgentRequestForwarder.v1")`. The broadcast record is
  `contracts/broadcast/DeployAgentRequestForwarder.s.sol/10143/run-latest.json`.
- **Gas:** explicit limit 490,000 (Monad `eth_estimateGas` was 407,868; limit = ×1.2, rounded up to 10k).
- **Not upgradeable, no owner, holds no funds.**

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

## Verified gated executes

`scripts/src/gated-execute.ts` (`pnpm --filter @attest8004/scripts gated-execute`) runs one validated action through
`DemoAgentVault` for agent 1982. It checks that the SDK's `actionHash` and `requestHash` equal the vault's own
(`actionHashOf`, `requestHashOf`). The deployer, as the agent's owner, requests validation from validator A with the
request JSON v1 as a `data:` URI, validator A responds 100, and the deployer calls `execute`. Before and after, it
**simulates** (never sends) the cases the gate must refuse. The response is a smoke test of the gate, not a
`mandate-v1` verdict: tag `attest8004-gate-smoke`, and its evidence JSON says no checks ran.

| Date | Chain | Vault | agentId | Action | validationRequest tx | validationResponse tx | execute tx |
|---|---|---|---|---|---|---|---|
| 2026-10-03 | Monad testnet (10143) | `0x7A5EC388…F2C4CD` | 1982 | 0.001 MON from the vault to the deployer | [`0x526b86de…5f3bc97`](https://monad-testnet.socialscan.io/tx/0x526b86de0581903664bea5eae7c2e24fe29ffcb64783312bfd9ed7fe65f3bc97) | [`0x1330ecb6…f42d82a`](https://monad-testnet.socialscan.io/tx/0x1330ecb60852ce2ef238f0b2e9abf5f0fb342d3ed3fc66a047afeecf5f42d82a) | [`0x59d5987e…71e3f85`](https://monad-testnet.socialscan.io/tx/0x59d5987e1d2583def79af6af40efd60daf0fa88cc7553d6f3b31a0eab71e3f85) (block 67,757,794) |

- `actionHash` `0x395747b092f0a549890a53edc7e36807d744d602c00c0baaadd04053b8bef0de` (consumed);
  `requestHash` `0xab7381321a83c0f46407f2b770c88b8d76f155e1974b13b8bb63489e240bd7b9` (validator A).
- Simulated and refused as expected: the action before validation (`ValidationNotFound`), while the request was
  pending (`ScoreTooLow`, response 0), a different action with `value + 1 wei` (`ValidationNotFound`), and a replay
  after execution (`ActionAlreadyConsumed`).
- The vault was first funded with 0.01 MON ([`0x36bba3bc…5a29e1a`](https://monad-testnet.socialscan.io/tx/0x36bba3bcc0b40ea3d77898066a81a7d1656dc9f79a060fbb2625a5de95a29e1a)).
- Gas limits for this run were provisional (fund 30,000; validationRequest 400,000; validationResponse 165,000;
  execute 250,000). Monad's estimates were 21,212, 202,643, 84,514 and 87,626, and the script now uses those × 1.2:
  26,000, 244,000, 102,000 and 106,000.
- Check it yourself:
  `cast call 0x7A5EC388CCbfD3B255CFa94fc2062c0807F2C4CD "consumed(bytes32)(bool)" 0x395747b092f0a549890a53edc7e36807d744d602c00c0baaadd04053b8bef0de --rpc-url https://testnet-rpc.monad.xyz`

## Canonical contracts used (not deployed by us)

| Contract | Monad testnet (10143) | Monad mainnet (143) |
|---|---|---|
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| P256VERIFY precompile | `0x0100` | `0x0100` |
