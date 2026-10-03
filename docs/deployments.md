# Deployments

Every Attest8004 deployment is recorded here: chain, contract, address, the commit it was built from, and the date.

| Chain | Contract | Address | Commit | Date | Deploy tx |
|---|---|---|---|---|---|
| Monad testnet (10143) | `ValidationRegistry` | [`0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f`](https://monad-testnet.socialscan.io/address/0xc4a4d0ceb3971cbe7a2536494ac106f2cd9f9a8f) | `8dc8859` | 2026-10-02 | [`0x724f31e0…cf64d03`](https://monad-testnet.socialscan.io/tx/0x724f31e0efd09993f2d73581cb742e71d4bef52c0f4f2a30cccd43d79cf64d03) (block 67,604,893) |
| Monad testnet (10143) | `AgentRequestForwarder` | [`0x1451F3C36545b191d3642f759D59f21DcFD657B2`](https://monad-testnet.socialscan.io/address/0x1451f3c36545b191d3642f759d59f21dcfd657b2) | `5f2f4a4` | 2026-10-03 | [`0x82883206…72a3cd7`](https://monad-testnet.socialscan.io/tx/0x828832065b96235728c1782e9be9b4b712e3f408f8755e20f554a210472a3cd7) (block 67,779,694) |
| Monad testnet (10143) | `MandateRegistry` | [`0x2523197373ef813E19b5b14Ef2984130868cD17c`](https://monad-testnet.socialscan.io/address/0x2523197373ef813e19b5b14ef2984130868cd17c) | `6e08223` | 2026-10-03 | [`0x1222b700…3ca0b84`](https://monad-testnet.socialscan.io/tx/0x1222b700027bc1e03676ed0f986a31ee2d5ac06ea5c5b1847672ca05b3ca0b84) (block 67,842,487) |
| Monad testnet (10143) | `DemoAgentVault` (AttestGate), agent 1984, mandate-v1 + risk-v1 | [`0x12fAb3E3cA810Cc44bD9f537613a230a2be8D614`](https://monad-testnet.socialscan.io/address/0x12fab3e3ca810cc44bd9f537613a230a2be8d614) | `7380fdc` | 2026-10-04 | [`0x65125575…61b990e`](https://monad-testnet.socialscan.io/tx/0x651255753f1d100da6b8e99bdfdbe3da60748c2297d9cffeb6554ca6161b990e) (block 67,943,657) |
| Monad testnet (10143) | `DemoPassThrough` (AttestGate demo target, forwards to `SINK`) | [`0xEEEBBa55620afC42E9c88b5d962476367b8da338`](https://monad-testnet.socialscan.io/address/0xeeebba55620afc42e9c88b5d962476367b8da338) | `7380fdc` | 2026-10-04 | [`0x0be882c3…65128bc`](https://monad-testnet.socialscan.io/tx/0x0be882c31c27d98e93934e71a573bf65f4be450759420de02a2101d8a65128bc) (block 67,943,539) |
| Monad testnet (10143) | `DemoAgentVault` (AttestGate), agent 1984, validator A only — **superseded** | [`0x23BfBD12545CCd1501ddA1B65a54518FD6212a96`](https://monad-testnet.socialscan.io/address/0x23bfbd12545ccd1501dda1b65a54518fd6212a96) | `319006a` | 2026-10-03 | [`0x2fed0cee…a14bf80`](https://monad-testnet.socialscan.io/tx/0x2fed0ceeec43384305a6cf095dc22be83a28c0d5b54e0b9055c467227a14bf80) (block 67,784,294) |
| Monad testnet (10143) | `DemoAgentVault` (AttestGate), agent 1982 — **superseded** | [`0x7A5EC388CCbfD3B255CFa94fc2062c0807F2C4CD`](https://monad-testnet.socialscan.io/address/0x7a5ec388ccbfd3b255cfa94fc2062c0807f2c4cd) | `f826eec` | 2026-10-03 | [`0xd960c130…72b6a64`](https://monad-testnet.socialscan.io/tx/0xd960c1304d88b0352d2bdf054eac174c704fd356ae465eeb8df570a6572b6a64) (block 67,757,166) |

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
- **What it does:** an agent's owner approves it on the Identity Registry, per agent with `approve(forwarder, agentId)`
  (what the demo agents use since P4) or once for all its agents with `setApprovalForAll(forwarder, true)`, and
  registers a hot key with `setAgentKey(agentId, key)`. The key can then call `request(...)`, which makes exactly one
  call, `validationRequest`, on the ValidationRegistry, while the owner who registered it still owns the agent. See
  ARCHITECTURE §5.2 and §7 (a blanket approval covers all of the owner's agents; either way the forwarder only exposes
  `validationRequest`).
- **How it was deployed:** `contracts/script/DeployAgentRequestForwarder.s.sol` via
  `script/deploy-testnet.sh AgentRequestForwarder`, through the CREATE2 factory with salt
  `keccak256("attest8004.AgentRequestForwarder.v1")`. The broadcast record is
  `contracts/broadcast/DeployAgentRequestForwarder.s.sol/10143/run-latest.json`.
- **Gas:** explicit limit 490,000 (Monad `eth_estimateGas` was 407,868; limit = ×1.2, rounded up to 10k).
- **Not upgradeable, no owner, holds no funds.**

### MandateRegistry (testnet) details

- **Constructor argument:** the canonical testnet Identity Registry `0x8004A818BFB912233c491871b3d84c89A494BD9e`.
- **What it does:** holds a per-agent spending mandate (SPEC §4.2) — allowed targets, allowed selectors, a per-tx and
  per-day MON cap, and an expiry. Only the agent's current owner can call `setMandate`/`revokeMandate`
  (`identityRegistry.ownerOf(agentId) == msg.sender`); `mandate-v1` reads it to score an action. See
  `contracts/src/MandateRegistry.sol`.
- **How it was deployed:** `contracts/script/DeployMandateRegistry.s.sol` via
  `script/deploy-testnet.sh MandateRegistry`, through the CREATE2 factory with salt
  `keccak256("attest8004.MandateRegistry.v1")`. The broadcast record is
  `contracts/broadcast/DeployMandateRegistry.s.sol/10143/run-latest.json`.
- **Gas:** explicit limit 1,010,000 (Monad `eth_estimateGas` was 834,877; limit = ×1.2, rounded up to 10k).
- **The address depends on the Identity Registry.** The init code includes the Identity Registry argument, so a
  mainnet deployment (another Identity Registry) will have a different address. Check it with
  `predictedAddress(<identity registry>)` on the deploy script.
- **Not upgradeable, no owner, holds no funds.** Every change goes through the internal `_authorize` hook, which in
  this deployment requires the agent's current owner (`msg.sender == ownerOf(agentId)`). P6 puts a WebAuthn assertion
  in that hook, which is a new deployment, so this one never changes in place.

### DemoAgentVault (testnet, two validators, agent 1984) details

- **Constructor arguments:** the ValidationRegistry above (`0xc4A4…F9a8f`), demo agent **1984** (owned by the deployer;
  its hot key requests through the AgentRequestForwarder), and two requirements: validator A
  `0xa62DaB21E0C0F57e94B3ed6e675F214199989e92` (`mandate-v1`) with `minScore` 100 and tag `keccak256("mandate-v1")`
  (`0x77de68d6…6d0b`), and validator B `0x780df855b48AeC7A3907433b0b5984A2fe5dca5E` (`risk-v1`) with `minScore` 80 and
  tag `keccak256("risk-v1")` (`0x5eda0c9f…3025`). Read them back with `validationRegistry()`, `agentId()` (1984) and
  `requirements()`.
- **Requires both validators, each under its own tag**, since this redeploy. The P3 vault below, requiring validator A
  only, is superseded; a different constructor argument (the second requirement) gives this vault a new address.
- **Holds 0 MON.** The e2e script (`scripts/src/e2e.ts`) funds it before a run; its logic still assumes a
  single-requirement vault (Task 14 updates it for the second validator).
- **How it was deployed:** `contracts/script/DeployDemoAgentVault.s.sol` via `script/deploy-testnet.sh DemoAgentVault`
  from commit `7380fdc` (the deploy-gas commit; the contract itself is from `47dfdf0`), through the CREATE2 factory
  with salt `keccak256("attest8004.DemoAgentVault.v1")`. The broadcast record is
  `contracts/broadcast/DeployDemoAgentVault.s.sol/10143/run-latest.json` (the P2 and P3 records are in git history).
- **Gas:** explicit limit 1,090,000 (Monad `eth_estimateGas` was 903,163; limit = ×1.2, rounded up to 10k).

### DemoPassThrough (testnet) details

- **Constructor argument:** `SINK` (`0xC8702cA01e934f0568ea43B354C17ec7749d313f`,
  `address(uint160(uint256(keccak256("attest8004.demo.sink"))))`), an address nobody holds the key for. Read it back
  with `sink()`.
- **What it is.** The P5 "risky but mandated" demo target (SPEC §4.6, decision 34): a fresh "payment router" that
  forwards every payment straight to `SINK`. `mandate-v1`'s simulation sees the value keep moving on to `SINK`, so a
  plain transfer to this contract can pass mandate-v1 even though the funds are unrecoverable; it is demo-only and is
  **not yet allowlisted in any mandate** (Task 15 adds it to demo agent 1984's mandate, next to the deployer).
- **How it was deployed:** `contracts/script/DeployDemoPassThrough.s.sol` via `script/deploy-testnet.sh
  DemoPassThrough` from commit `7380fdc` (the deploy-gas commit; the contract itself is from `47dfdf0`), through the
  CREATE2 factory with salt `keccak256("attest8004.DemoPassThrough.v1")`. The broadcast record is
  `contracts/broadcast/DeployDemoPassThrough.s.sol/10143/run-latest.json`.
- **Gas:** explicit limit 180,000 (Monad `eth_estimateGas` was 141,975; limit = ×1.2, rounded up to 10k).
- **Not upgradeable, no owner, holds no funds of its own.** Every payment it receives moves on to `SINK` in the same
  call.

### DemoAgentVault (testnet, P3, agent 1984) details — superseded

**Superseded on 2026-10-04 by the two-validator vault above.** It stays deployed and can't be changed. It still holds
0.006 MON, which can leave only through an A-only validated execute.

- **Constructor arguments:** the ValidationRegistry above (`0xc4A4…F9a8f`), demo agent **1984** (owned by the deployer;
  its hot key requests through the AgentRequestForwarder), and one requirement: validator A
  `0xa62DaB21E0C0F57e94B3ed6e675F214199989e92` (`mandate-v1`) with `minScore` 100.
- **Required validator A only.** The two-validator vault above requires both `mandate-v1` and `risk-v1`.
- **How it was deployed:** `script/deploy-testnet.sh DemoAgentVault` from commit `319006a`, through the CREATE2 factory
  with salt `keccak256("attest8004.DemoAgentVault.v1")`. The broadcast record is in git history (superseded by the
  current `contracts/broadcast/DeployDemoAgentVault.s.sol/10143/run-latest.json`; the P2 record is in git history too).
- **Gas:** explicit limit 1,000,000 (Monad `eth_estimateGas` was 829,476).

### DemoAgentVault (testnet, P2, agent 1982) details — superseded

**Superseded on 2026-10-03 by the agent-1984 vault above.** It stays deployed and can't be changed. It still holds
0.009 MON, which can leave only through a validated execute for agent 1982; `scripts/src/gated-execute.ts` still runs
against it.

- **Constructor arguments:** the ValidationRegistry above (`0xc4A4…F9a8f`), agent **1982** (the P1 test agent, owned by
  the deployer), and one requirement: validator A `0xa62DaB21E0C0F57e94B3ed6e675F214199989e92` (`mandate-v1`) with
  `minScore` 100. Read them back with `validationRegistry()`, `agentId()` and `requirements()`.
- **Requires validator A only, for now.** P5 redeploys the vault requiring both validators (`mandate-v1` and
  `risk-v1`). Different constructor arguments give a different address, and this one stays as it is.
- **How it was deployed:** `contracts/script/DeployDemoAgentVault.s.sol` via `script/deploy-testnet.sh DemoAgentVault`,
  through the CREATE2 factory with salt `keccak256("attest8004.DemoAgentVault.v1")`. The broadcast record is
  `contracts/broadcast/DeployDemoAgentVault.s.sol/10143/run-latest.json`.
- **Gas:** explicit limit 1,000,000 (Monad `eth_estimateGas` was 829,476; limit = ×1.2, rounded up to 10k).
- **Not upgradeable, no owner.** Funds leave the vault only through `execute` with an action that validator A passed.
  `execute` is permissionless: the validated action is the authorisation.

## Web app

| What | Value |
|---|---|
| Production domain | [`attest8004.vercel.app`](https://attest8004.vercel.app) |
| Host | Vercel |

This is the **WebAuthn rpId for P6**: passkeys are bound to the domain they were created on, so demo passkeys are
created on this production domain, never on a preview deployment or localhost. **Never use a Vercel preview URL for
passkeys** — a preview gets its own subdomain, which would mint passkeys bound to a different rpId than production.

## Demo agents (testnet)

Two ERC-8004 agents in the canonical testnet Identity Registry, owned by the deployer
(`0x3EFEB3Cf2FB54A7D99abE90AaB786cE5A831a8CF`), registered on 2026-10-03 by
`pnpm --filter @attest8004/scripts setup-demo-agents`. Each has its own hot key, made by
`pnpm --filter @attest8004/scripts hot-keys` (which writes the keys into `.env` and prints only the addresses), and
registered with `AgentRequestForwarder.setAgentKey`. A hot key can request validations for its own agent through the
forwarder and nothing else; it can't move the agent.

| Agent | Registration file name | Hot key | register tx | setAgentKey tx | Hot key funded |
|---|---|---|---|---|---|
| **1984** | `attest8004-demo-agent-1` | `0xa43427fF51eEE66cc67C94Cb55f04C9432a96787` | [`0xa86940e7…46be517`](https://monad-testnet.socialscan.io/tx/0xa86940e7360007713ca0091180443bc430afdf1ea25bb3e94796b938946be517) | [`0x9b6e701e…5f2aab1`](https://monad-testnet.socialscan.io/tx/0x9b6e701e9ce49f9959ca74681cf68f207e714dce5df670b6d945bb6fe5f2aab1) | 0.152256 MON, [`0x34577b38…80cc382`](https://monad-testnet.socialscan.io/tx/0x34577b383c9391f87ac191a40bd9f4e5abfdef04ff29be7cd7717012d80cc382) |
| **1985** | `attest8004-demo-agent-2` | `0xa72774719C6C7c8E83B3eCb98F64e38F26C327D8` | [`0xd6b458cf…04ab597`](https://monad-testnet.socialscan.io/tx/0xd6b458cf9e5fb1fc973222dc9666408b5e1dccd1c54bf4e8d1ff32c1904ab597) | [`0x44a346e9…306b1f4`](https://monad-testnet.socialscan.io/tx/0x44a346e959718cdc5506cb9a1818f6735aaee0e9431cbb791a26bf9ff306b1f4) | 0.152256 MON, [`0x56eed479…e4f8ab2`](https://monad-testnet.socialscan.io/tx/0x56eed479bcdff4f784e90d32bd8a14668498efa51030b99b5f798ee67e4f8ab2) |

- **Approval history.** The deployer first called `setApprovalForAll(forwarder, true)` once,
  [`0x49085ec3…6fd396a`](https://monad-testnet.socialscan.io/tx/0x49085ec3a53f793a4dbc4ea72d75b3d121560b08014c6e1c06b9b78006fd396a), making the forwarder an operator for all of the deployer's agents (including 1982). **That blanket
  approval is now revoked** and replaced with a per-token `approve(forwarder, agentId)` for each demo agent; see
  "Least privilege switch" below. The forwarder only exposes `validationRequest` either way (ARCHITECTURE §7).
- **Registered with `register(string)` directly**, not the agent0 SDK: agent0-sdk 1.7.1 (the latest, 16 Mar 2026) has
  no defaults for Monad (its `DEFAULT_REGISTRIES` cover chains 1, 137, 8453, 11155111 and 84532). The registration
  files are `data:` URIs that say these are demo agents (`services: []`, `active: false`).
- **Funding:** each hot key holds enough MON for 4 forwarded requests at the max fee then (4 × 312,000 gas ×
  122 gwei), and nothing more. Top up with `setup-demo-agents -- --fund`.
- **Gas limits (all explicit):** register 494,000 (estimate 411,546); setApprovalForAll 86,000 (71,523); setAgentKey
  130,000 (118,742 and 107,899; the script now uses 143,000); fund 26,000 (21,000). A forwarded request from a hot
  key estimated 251,331 to 262,217; the SDK's limit is 315,000.

## Least privilege switch and agent 1984's mandate (testnet)

On 2026-10-03, `pnpm --filter @attest8004/scripts setup-demo-agents -- --fund --fund-validator` moved both demo
agents from the deployer's blanket `setApprovalForAll` to a per-token `approve(forwarder, agentId)` each (ARCHITECTURE
§7), then revoked the blanket approval; `pnpm --filter @attest8004/scripts set-mandate` then set the end-to-end
spending mandate for agent 1984 on the MandateRegistry. Gas limits are each the Monad `eth_estimateGas` measured
from the deployer on 3 Oct 2026, × 1.2, rounded up to 1k.

| Step | Tx | Block | Gas limit (estimate) |
|---|---|---|---|
| `approve(forwarder, 1984)` | [`0xdd51f04b…c0da491`](https://monad-testnet.socialscan.io/tx/0xdd51f04b4acc12f45fcf2542ddc5c869a6a754cd284e069eb4dd161f3c0da491) | 67,889,819 | 96,000 (79,523) |
| `approve(forwarder, 1985)` | [`0x0445510c…040b4f2`](https://monad-testnet.socialscan.io/tx/0x0445510c533675fab72e9d0081762830c8fd4415cb758f5720e92c2b9040b4f2) | 67,889,825 | 96,000 (79,523) |
| `setApprovalForAll(forwarder, false)` | [`0x27c2245b…a7036c8`](https://monad-testnet.socialscan.io/tx/0x27c2245b7a32a3559cb49ef07f4af029f57f3bfd4f5e1a94d246c2837a7036c8) | 67,889,831 | 66,000 (54,444) |
| fund agent 1984's hot key (0.097854 MON) | [`0x8a6a68c0…f5f0c95`](https://monad-testnet.socialscan.io/tx/0x8a6a68c0cd0aebd184d85eec1b352854d429c3ec6aba8d440d189ec28f5f0c95) | 67,889,842 | 26,000 (21,000) |
| fund agent 1985's hot key (0.001464 MON) | [`0x77e0ff03…504afdd`](https://monad-testnet.socialscan.io/tx/0x77e0ff0310adc4b088e443c61b1186de97381668fb1da21e35fa433f1504afdd) | 67,889,847 | 26,000 (21,000) |
| fund validator A (1.55865 MON, to 2 MON) | [`0x4a15f7b0…5033054`](https://monad-testnet.socialscan.io/tx/0x4a15f7b034693dbc9a57e73cadc7437350de88ce9d48d6b3b9cc081015033054) | 67,889,852 | 26,000 (21,000) |
| `setMandate(1984, mandate)` | [`0x0b961153…ff5f167`](https://monad-testnet.socialscan.io/tx/0x0b9611534dbec9b2c0b348c495f495a5d6c0d85bc60e3728855042aa5ff5f167) | 67,890,013 | 306,000 (254,362) |

- **Checked afterwards (`cast call`/`cast balance`):** `getApproved(1984) == getApproved(1985) == forwarder`;
  `isApprovedForAll(deployer, forwarder) == false`; validator A's balance is exactly 2 MON. A forwarder.request
  simulation (eth_call, not sent) from agent 1984's hot key still estimates successfully under the per-token
  approval (251,903 gas, under the SDK's 315,000 limit).
- **Agent 1984's mandate** (`getMandate(1984)` on the MandateRegistry `0x2523197373ef813E19b5b14Ef2984130868cD17c`):
  `allowedTargets = [0x3EFEB3Cf2FB54A7D99abE90AaB786cE5A831a8CF]` (the deployer only), `allowedSelectors =
  [0x00000000]` (plain MON transfers only), `maxValuePerTx = 0.002 MON`, `maxValuePerDay = 0.005 MON`, `validUntil =
  1,793,404,800` (2026-10-31T00:00:00Z). `mandateHash`
  `0xf6da3f3fff691ad9baca0d193f3c1754e462f08f54ef460ebb95acb5e7cfbdfe`, `owner` the deployer, `setAtBlock`
  **67,890,013** — after the per-token approvals (67,889,819 / 67,889,825) and the blanket-approval revoke
  (67,889,831) above, so those permission changes predate the mandate.
- Check it yourself:
  `cast call 0x2523197373ef813E19b5b14Ef2984130868cD17c "getMandate(uint256)((address[],bytes4[],uint256,uint256,uint64),bytes32,address,uint64)" 1984 --rpc-url https://testnet-rpc.monad.xyz`

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
the P2 `DemoAgentVault` (now superseded) for agent 1982. It checks that the SDK's `actionHash` and `requestHash` equal the vault's own
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

## Verified end-to-end runs (P3)

`scripts/src/e2e.ts` (`pnpm --filter @attest8004/scripts e2e`) runs the whole P3 path for demo agent 1984: its **hot
key** requests validation through the **AgentRequestForwarder** with the SDK client (`Attest8004Client`), a
**StubValidator** built on the SDK's `ValidatorBase` polls `eth_getLogs` up to the finalized block and responds once,
a second, freshly started validator re-reads the same blocks and must skip the request (`ALREADY_RESPONDED`),
`awaitVerdict` and `isValidated` confirm the verdict, and the deployer submits `execute` through the agent-1984
`DemoAgentVault` (execution is permissionless). The stub's check passes everything: tag `attest8004-e2e-stub`, and
its evidence says no checks ran. Refusals are **simulated**, never sent: the owner and agent 1985's hot key calling
the forwarder for agent 1984 (`NotAgentKey`), and a replay (`ActionAlreadyConsumed`). The script reads each sent
transaction back to confirm its sender and its explicit gas limit.

| Date | Agent | Vault | forwarder.request tx (hot key) | validationResponse tx (validator A) | execute tx (deployer) |
|---|---|---|---|---|---|
| 2026-10-03 | 1984 | `0x23BfBD12…212a96` | [`0xe2b7df42…0ed554b`](https://monad-testnet.socialscan.io/tx/0xe2b7df42a9f71be25c920e6d2cf70974490c1880af847dd0dc503bd380ed554b) (block 67,784,991) | [`0x8dada3c3…9924e18`](https://monad-testnet.socialscan.io/tx/0x8dada3c3e1ae4a800576c21e027ae78899cfd44bdeb4385369a2420d39924e18) | [`0x6f694020…b1336a8`](https://monad-testnet.socialscan.io/tx/0x6f6940203907d8d759e1887953d1170015be7f0c6d27b39c4e22090bbb1336a8) (block 67,785,016) |

- `requestHash` `0xd90141778d12c963f4b463b0aefacef342ef8f2e196a6f70a29d8bcd050e62b2` (validator A);
  `actionHash` `0x69a1ce190fc0e671b632161a46434983292b2edbad7ab672705c05e82b17ae4d` (consumed). The action moved
  0.001 MON from the vault to the deployer.
- The vault was funded with 0.01 MON first: [`0xd5f96da1…9b63d90`](https://monad-testnet.socialscan.io/tx/0xd5f96da1b562fbd9131e08df7f0ef9173a7212717e38cb94c73b0d3199b63d90).
- **An earlier attempt stopped after its request.** The request [`0x247cf931…b2a38b0`](https://monad-testnet.socialscan.io/tx/0x247cf931c8342d2e911000d9c4faab3b7000e19d60830eab08d935d3cb2a38b0)
  (`requestHash` `0x5e8f22b3…7d4122`) landed correctly, but a script check compared the sender in the wrong letter
  case and stopped the run. That request was never answered and its deadline has passed, so a validator ignores it
  (`DEADLINE_PASSED`).
- Gas limits (all explicit; each read back from the sent transaction): forwarder.request 315,000; validationResponse
  140,000 (provisional; the estimate was 86,765, and the script now uses 105,000); execute 106,000 (estimate 87,626);
  fund 26,000 (estimate 21,212).
- After the run, agent 1984's hot key holds 0.088 MON (two requests' worth at the current fee).

## Verified end-to-end runs with `mandate-v1` (P4)

From P4, `scripts/src/e2e.ts` (`pnpm --filter @attest8004/scripts e2e`) runs validator A as **`mandate-v1`**. The P3
stub validator is deleted, so validator A's key signs only `mandate-v1` verdicts. Demo agent 1984's **hot key**
requests validation of two actions through the **AgentRequestForwarder** before any validator runs. Both are checked
against agent 1984's mandate (above):

- **A:** 0.001 MON from the vault to the deployer. This is inside the mandate.
- **B:** 0.003 MON to `0xFdD9ffc1e3D8E0f391C03DB8Dc25Db7D5367671F` (`keccak256("attest8004.e2e.unlisted")[12:]`, an
  address no mandate lists). It breaks the mandate twice: the target isn't listed, and the value is over the
  0.002 MON per-tx cap.

One `MandateValidator` answered both. It ran in memory from just before A's block, with reader concurrency 8, the
vault as its only gate, the service's admission defaults, and response gas set to the estimate × 1.2, capped at
400,000.

- **A scored 100** with no reasons.
- **B scored 0** with `[TARGET_NOT_ALLOWED, VALUE_OVER_TX_CAP]`. B's pin waited for A's approval, so B's evidence
  lists A in its spend (0.001 MON, `counted: true`).
- `execute(B)` was then **simulated**, and the gate refused it with `ScoreTooLow(validator A, requestHash B, 0,
  100)`. `isValidated(B)` is false.
- A freshly started validator re-read the same blocks and skipped both (`ALREADY_RESPONDED`). Exactly one
  `ValidationResponse` exists for each request.
- The deployer submitted `execute(A)` (permissionless).
- `verifyRequest` re-ran both verdicts at their pinned blocks with a fresh reader. Both **match**, with the same score
  and the same `responseHash`.

The other refusals are simulated too: the owner and agent 1985's hot key calling the forwarder for agent 1984
(`NotAgentKey`), and a replay of A (`ActionAlreadyConsumed`). The script reads each sent transaction back to confirm
its sender and its explicit gas limit.

| Date | Step | Tx | Block | Gas limit (estimate) |
|---|---|---|---|---|
| 2026-10-03 | forwarder.request, A (hot key) | [`0xdf56b446…c79649e`](https://monad-testnet.socialscan.io/tx/0xdf56b446bdb4c38d773b08bda8a7e59cd50b82badcabbbb6eb614ac52c79649e) | 67,896,188 | 315,000 (SDK default) |
| 2026-10-03 | forwarder.request, B (hot key) | [`0x4be3145c…147f664`](https://monad-testnet.socialscan.io/tx/0x4be3145ced73603023bbbf1ff224189af9daab3503171bcede134fa8f147f664) | 67,896,193 | 315,000 (SDK default) |
| 2026-10-03 | validationResponse, A → 100 (validator A) | [`0xef94ea65…76ce73b`](https://monad-testnet.socialscan.io/tx/0xef94ea6509f6605345be1d18761e02abd997adf0d20bc3799a021f69d76ce73b) | 67,896,224 | 153,338 (127,781) |
| 2026-10-03 | validationResponse, B → 0 (validator A) | [`0xc429d953…c38df2a`](https://monad-testnet.socialscan.io/tx/0xc429d9537acece99359add70a914fd2e1434b3d65e31a2957cffa73a0c38df2a) | 67,896,251 | 178,142 (148,451) |
| 2026-10-03 | execute(A) (deployer) | [`0xb666247e…60c84f9`](https://monad-testnet.socialscan.io/tx/0xb666247e2ac448a233c1bac336c19d65373aa908a2656b2f6e999408f60c84f9) | 67,896,267 | 106,000 (87,626) |

- **A:** `requestHash` `0xd0ca15eae05d88cc58f404494ae58ad70055f84b7f72573fd60acfc43c6cd283`. `actionHash`
  `0x54b8b568a71766d1312a396ffd580d6fa047aedfd5b0c30f1822f0078b28d4a9` (consumed). Pinned block 67,896,198.
  `responseHash` `0x6f2011dccc9b2e8e235d9e80d585c6750d63ffbac0791f7200b2f048b9fbc08a`.
- **B:** `requestHash` `0x85b92cb27c06a013bd63c9ee51e29b6329570ccd784a3e2941496f2c4a5965e9`. `actionHash`
  `0x28d36fc7ceb8f0aa1f3b9156bef8daadccfbfa67919d70acb8d1ca9e20706dce` (never executable). Pinned block 67,896,225.
  `responseHash` `0x7631feb99772d89d3fad805f691da4ee79cd8b48ddc32e0087d38fa4a26bf4bd`.
- **`verify` from the CLI.** Both were re-checked afterwards from the repo root with
  `pnpm attest8004 verify <requestHash>`. Each exited 0 and printed `match`:
  - A: posted 100, recomputed 100; no spend in the window.
  - B: posted 0, recomputed 0; `TARGET_NOT_ALLOWED, VALUE_OVER_TX_CAP`; one counted approval, A's 0.001 MON.
  - Both: 0 permission events in the window.
- **Gas.** Each response's limit is its own estimate × 1.2, capped at 400,000. B's evidence is larger than A's (its
  reasons and spend entry), so it costs more. Each receipt's `gasUsed` equals its limit: Monad charges the limit.
- **Daily cap.** Each run adds an approved 0.001 MON to agent 1984's spend (cap 0.005 MON; 25 h window on approval
  time). B keeps exactly its two reasons for the first two runs in any 25 h; from the third, B also gets
  `DAILY_CAP_EXCEEDED`. The script derives B's expected reasons from B's own evidence (its spend total plus
  0.003 MON against the cap), and its preflight stops a run before sending anything if A itself wouldn't fit
  (the sixth in 25 h), saying when the oldest counted approval leaves the window.
- **Balances after the run:**
  - Agent 1984's hot key holds 0.08946 MON. That is one more run's two requests at the current maximum fee (122 gwei,
    0.07686 MON); top it up with `setup-demo-agents -- --fund`.
  - Validator A holds 1.966 MON.
  - The vault holds 0.007 MON.
- Check it yourself (read-only, public RPC by default):
  `pnpm attest8004 verify 0x85b92cb27c06a013bd63c9ee51e29b6329570ccd784a3e2941496f2c4a5965e9`

### Second run, after the review fixes (2026-10-03, 19:15 UTC)

The same script, re-run once after the final-review fixes changed live behaviour: `mandate-v1` now pins 5 blocks
below the finalized head (`PIN_LAG_BLOCKS`), answers only (gate, agent) pairs (here the vault with agent 1984), and
waits until its pin's time is within 3,600 s of the action's deadline; the e2e now derives B's expected reasons from
B's own evidence and checks agent 1984's counted spend before sending anything. `e2e OK`.

- Preflight: agent 1984's counted spend at block 67,910,164 was 0.001 MON (run 1's A), so A fit under the cap.
- **A scored 100** with no reasons. Its spend lists run 1's A (0.001 MON, counted).
- **B scored 0** with `[TARGET_NOT_ALLOWED, VALUE_OVER_TX_CAP]`: its spend counts both As (0.002 MON), and
  0.002 + 0.003 MON is exactly the 0.005 MON cap, not over it. B's pin waited for A's approval (the floor was A's
  response block, 67,910,223, so the pin was 67,910,224).
- `execute(B)` was simulated and refused (`ScoreTooLow`); a fresh validator skipped both (`ALREADY_RESPONDED`);
  exactly one `ValidationResponse` exists for each; the deployer executed A, and a replay reverts
  `ActionAlreadyConsumed` (simulated).
- `verifyRequest` in the script, and then `pnpm --loglevel silent attest8004 verify` from the repo root, re-ran both:
  both **match** (exit 0). Run 1's two verdicts (`0xd0ca15ea…`, `0x85b92cb2…`) were re-verified with the same code
  afterwards and still match (exit 0).

| Date | Step | Tx | Block | Gas limit (estimate) |
|---|---|---|---|---|
| 2026-10-03 | forwarder.request, A (hot key) | [`0x0c2fe788…46f7dbe`](https://monad-testnet.socialscan.io/tx/0x0c2fe788391bd72f233b78c48414d174a0723f85ef9d470cf825238d546f7dbe) | 67,910,183 | 315,000 (SDK default) |
| 2026-10-03 | forwarder.request, B (hot key) | [`0x84b56a7e…b8b8168`](https://monad-testnet.socialscan.io/tx/0x84b56a7e1b00106ce693509e24607c82c20d0e8954d17e67c0cc65f3ab8b8168) | 67,910,189 | 315,000 (SDK default) |
| 2026-10-03 | validationResponse, A → 100 (validator A) | [`0xd48cde82…1db03dc3`](https://monad-testnet.socialscan.io/tx/0xd48cde8231d5eaf9cf426cddf7e81553ee6d60a12453d5360a80fad41db03dc3) | 67,910,223 | 163,460 (136,216) |
| 2026-10-03 | validationResponse, B → 0 (validator A) | [`0xe0048865…a1bace53`](https://monad-testnet.socialscan.io/tx/0xe004886500c4b833b70d1d89d6f6a7ac0183ff129bb598768c02684ca1bace53) | 67,910,257 | 174,556 (145,463) |
| 2026-10-03 | execute(A) (deployer) | [`0x533bdb52…05da690b`](https://monad-testnet.socialscan.io/tx/0x533bdb529cf9f88aaa2c906d2e00bc0369a67917ed3e662b9c19925905da690b) | 67,910,274 | 106,000 (87,626) |

- **A:** `requestHash` `0x045967497d48f435b896716b1e00734175cb85e0be6ae5ac5e4d811934ad263f`. `actionHash`
  `0x11592099551498b1c4a10513fa8c9c0a4836cf809fc0e093251bb42187dedbde` (consumed). Pinned block 67,910,189.
  `responseHash` `0x532498873dd3fba9f2432e2c6988690d8d8a484df4200169e27f9c4b3503b6ef`.
- **B:** `requestHash` `0xbe4e1c24ed0255fa8d958e887b3e65bd2e067883865682f911dc01b04778bce5`. `actionHash`
  `0x33fc61a757c7d9c125f41882453ac99625aaa7f276cac90dc59563a854b12c54` (never executable). Pinned block 67,910,224.
  `responseHash` `0xa1e33a5c261524dbd7dfab9e08293f06b99506c0aeef100e9aa20e9fbc27548d`.
- **Gas.** A's evidence now carries one spend entry, so its response cost more than in run 1 (163,460 against
  153,338). Each receipt's `gasUsed` equals its limit.
- **Daily cap.** Two approved As (0.002 MON) now count, until 19:05:37 and 20:16:04 UTC on 4 Oct (25 h after each
  approval). A third run while both count gives B `DAILY_CAP_EXCEEDED` too (the script expects it from B's
  evidence); A fits for three more runs in that window.
- **Balances after the run:** agent 1984's hot key 0.0252 MON (no run left at the 122 gwei maximum fee: top it up
  with `setup-demo-agents -- --fund`), validator A 1.9317 MON, the vault 0.006 MON.
- Check it yourself: `pnpm attest8004 verify 0xbe4e1c24ed0255fa8d958e887b3e65bd2e067883865682f911dc01b04778bce5`

## Canonical contracts used (not deployed by us)

| Contract | Monad testnet (10143) | Monad mainnet (143) |
|---|---|---|
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| P256VERIFY precompile | `0x0100` | `0x0100` |
