# EIP-8004 spec notes

EIP-8004 is a Draft. Before the ValidationRegistry is written or changed, re-read
[the EIP text](https://eips.ethereum.org/EIPS/eip-8004) and
[erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts),
then record here every difference from the interface in SPEC §4.1.

## Check of 2 Oct 2026 (P1)

**Sources checked:**

| Source | Version | Notes |
|---|---|---|
| EIP text, [`ethereum/ERCs` `ERCS/erc-8004.md`](https://github.com/ethereum/ERCs/blob/503591a6e80e6e1affdd6403341e25269141f046/ERCS/erc-8004.md) | commit `503591a` (25 Jan 2026), status **Draft** | The "Validation Registry" section |
| [`erc-8004/erc-8004-contracts`](https://github.com/erc-8004/erc-8004-contracts/tree/b9e466c250744a7e06b13dff9d3c2844ed64f825) | commit `b9e466c` (15 Aug 2026) | `contracts/ValidationRegistryUpgradeable.sol`, `getVersion()` = `"2.0.0"` (the "reference" below) |

**Result:** the interface in SPEC §4.1 matches the EIP exactly: the same six
functions and the same two events, with the same parameter types, order and
indexing. Our `ValidationRegistry` behaves like the reference contract, with
the differences listed below.

**Still no Validation Registry on Monad.** The `erc-8004-contracts` README lists
only the Identity and Reputation registries for Monad mainnet and testnet. It
also says the Validation Registry part of the spec "is still under active update
and discussion with the TEE community". Re-check both before any interface change.

### Selectors and event topics (pinned by `test_Interface_MatchesEip8004Signatures`)

| Selector / topic0 | Signature |
|---|---|
| `0xaaf400c4` | `validationRequest(address,uint256,string,bytes32)` |
| `0x3d659a96` | `validationResponse(bytes32,uint8,string,bytes32,string)` |
| `0xff2febfc` | `getValidationStatus(bytes32)` |
| `0x1b7cabd6` | `getSummary(uint256,address[],string)` |
| `0x8d5d0c2d` | `getAgentValidations(uint256)` |
| `0x4bf3158c` | `getValidatorRequests(address)` |
| `0xbc4d861b` | `getIdentityRegistry()` |
| `0x530436c3…a48a5059` | `event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)` |
| `0xafddf629…2326349ae` | `event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)` |

### Differences and decisions

| # | Topic | EIP | Reference (`b9e466c`) | Attest8004 | Decision |
|---|---|---|---|---|---|
| 1 | Deployment | `initialize(address identityRegistry_)` sets the Identity Registry; `getIdentityRegistry()` reads it | UUPS proxy, `Ownable`, `initialize` is `onlyOwner` | **Constructor argument, stored `immutable`**. No proxy, no owner, no `initialize`. `getIdentityRegistry()` is kept. | ARCHITECTURE §3 and §9 require no admin and no upgradeability. Consumers see the same read interface. |
| 2 | `getVersion()` | Not in the EIP | Returns `"2.0.0"` | Not implemented | SPEC §4.1: no non-spec extensions. |
| 3 | `getSummary` return names | `(uint64 count, uint8 averageResponse)` | `(count, avgResponse)` | `(count, averageResponse)` | Follow the EIP. Only the ABI parameter name differs; the encoding is identical. |
| 4 | Revert data | Not specified | `require` strings: `"bad validator"`, `"exists"`, `"Not authorized"`, `"unknown"`, `"not validator"`, `"resp>100"` | Custom errors: `ZeroValidator`, `RequestExists`, `NotAgentOwnerOrOperator`, `UnknownRequest`, `NotRequestedValidator`, `ResponseOutOfRange` | The same conditions revert. Only the revert data differs. |
| 5 | One validator per `requestHash` | "*requestHash … identifies the request*". `getValidationStatus(requestHash)` returns a single `validatorAddress`. | A second `validationRequest` with an existing `requestHash` reverts (`"exists"`), whichever validator it names | Same: reverts `RequestExists` | **Impact on ARCHITECTURE §5.2**, which sends the *same* `requestHash` to `mandate-v1` and `risk-qwen-v1`: the second request would revert. **To decide in P2** (recommended): add `validatorAddress` to the `requestHash` preimage, so the gate recomputes one hash per trusted validator. The gate must then (a) mark consumption on a **validator-independent action hash**, so one action can't execute twice using different validators' verdicts; and (b) check the **stored `agentId` and `validatorAddress`** returned by `getValidationStatus`, not just the score. |
| 6 | What `requestHash` commits to | "*a commitment to this data (`keccak256` of the request payload)*", i.e. the data at `requestURI` | Not checked onchain | Not checked onchain | **Decided in P2 (3 Oct): `requestHash` stays an ABI-encoded action hash.** The "request payload" it commits to is the ABI encoding `abi.encode(chainId, gate, validatorAddress, agentId, target, value, keccak256(data), deadline, salt)` (SPEC §4.3), not the bytes of the request JSON at `requestURI`. The JSON carries the same fields, and validators recompute the hash from it (ARCHITECTURE §6), so its formatting doesn't matter. The registry treats `requestHash` as an opaque key either way. A gate can recompute this hash from the call; it couldn't recompute a hash of JSON bytes. |
| 7 | Pending versus a response of 0 | Not specified | `getValidationStatus` returns `response = 0`, `tag = ""`, `lastUpdate =` request time before any response. An internal `hasResponse` flag excludes pending requests from `getSummary`. | Same | The EIP read interface can't tell "pending" from "responded 0". **Consumers (the P2 gate) must use `minScore >= 1`.** |
| 8 | Unknown `requestHash` | Not specified | `getValidationStatus` and `validationResponse` revert | Same (`UnknownRequest`) | Match the reference. |
| 9 | Mandatory request fields | "*All other fields are mandatory*" | Only `validatorAddress != 0` is enforced; an empty `requestURI` or a zero `requestHash` is accepted | Same | Match the reference. Rejecting them would make our registry stricter than the canonical code. |
| 10 | Who may request | "*MUST be called by the owner or operator of agentId*" | `ownerOf`, `isApprovedForAll`, `getApproved` | Same. The `agentWallet` metadata address is **not** authorised (it is neither owner nor operator). | Follow the EIP. P3 has to decide how an agent's hot key submits requests (see STATUS). |
| 11 | `getSummary` maths | "*aggregated validation statistics*"; filters optional | Counts requests with a response; uses each request's **latest** response; the average is **floored** (`total / count`); `(0, 0)` when none match; empty filter = no filter | Same | Match the reference. Duplicate addresses in the validator filter don't count a request twice. |
| 12 | `requestHash` squatting | Global key | Global key | Global key | Inherent to the EIP: the owner of *any* agent can claim a `requestHash` first (e.g. by copying a pending transaction), and the legitimate request then reverts. The cost is denial of service for that hash, but it is **repeatable**: someone watching pending transactions can squat every retry (about 236k gas each on Monad testnet), so a determined griefer can keep an agent from getting a validation recorded. The registry can't prevent this, because it treats `requestHash` as an opaque key and never recomputes it. The squatter's entry records *its own* `agentId` and validator, which is why gates must check both (row 5). Mitigations (for example, not exposing a request before it lands, which the future BTX note is about) belong in P2 and the P10/P11 threat model. |
| 13 | Unbounded arrays | Not specified | `getAgentValidations` and `getValidatorRequests` return whole arrays; `getSummary` loops over every request of the agent | Same | Only an agent's owner or operator can grow that agent's list, but **anyone** can grow a validator's list. These are views meant for offchain reads; onchain consumers should call `getValidationStatus(requestHash)`. |

## Log

| Date | Source (EIP commit or repo commit) | Difference | Decision |
|---|---|---|---|
| 2026-10-02 | EIP `503591a`, repo `b9e466c` | The 13 rows above | As above. Interface identical; behaviour matches the reference. |
