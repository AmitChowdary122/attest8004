# Plug Attest8004 into any escrow with a verifier hook

Many escrows let whoever funds a job name a **verifier**: an address that may release the payment. Make that address an
[`AttestGate`](../contracts/src/AttestGate.sol) consumer, such as [`DemoAgentVault`](../contracts/src/DemoAgentVault.sol).
The payment is then released only when every validator the vault requires has passed that exact release action. No
adapter contract is needed: the vault's `execute(Action)` makes the call itself, so the escrow sees the vault as the caller.

**What this page proves, and what it doesn't.** A Foundry fork test proves this composition against
[AgentPassport](#credits)'s **live bytecode** on Monad testnet ([the proof](#the-proof-fork-tests)). It is **not
adoption by their team**:
- nothing was broadcast;
- they haven't integrated or endorsed it;
- their GitHub account is gone.

We chose not to settle a job live: every release writes a permanent reputation record, and with all three parties ours it
would have put self-dealt reputation into the canonical ERC-8004 Reputation Registry ([caveat 3](#caveats)).

## The pattern

**What the escrow must have:**
1. A per-job (or per-escrow) **verifier address** allowed to release.
2. Ideally, a **release call that takes no recipient and no amount**: the escrow pays whoever the funder chose, the amount
   the funder locked. The verifier then decides only *when* to pay. Otherwise your mandate and validators must bound the
   recipient and the amount, and [`risk-v1` can't see token transfers](#caveats).

**The steps:**
1. **The vault.** The agent that acts as verifier has an AttestGate consumer that requires the validators you trust
   (our demo vault requires `mandate-v1` at 100 and `risk-v1` at 80).
2. **The mandate.** The agent's mandate, approved by its owner and passkey in the MandateRegistry, allowlists the escrow as
   a target and its release selector.
   - **Selectors apply to every allowlisted target.** Check each pairing: a release selector sent to a plain-transfer
     target, or empty calldata sent to the escrow, should revert, which `mandate-v1`'s simulation turns into a 0.
3. **The job.** The funder names the vault as the job's verifier.
4. **The check.** When the work is delivered, the verifier agent checks the deliverable **off chain**: Attest8004 judges
   the release *action*, not the work. Then it builds
   `Action{agentId, target: escrow, value: 0, data: release(jobId), deadline, salt}` and requests each validator, its hot
   key going through the `AgentRequestForwarder`.
5. **The verdicts.**
   - `mandate-v1` checks the target, the selector, the caps, the deadlines and recent permission changes. It also simulates
     the release from the vault at its pinned block, so a job that isn't deliverable yet scores 0 (`SIMULATION_FAILED`).
   - `risk-v1` reviews it with its tools.
6. **The execute.** Anyone sends `vault.execute(action)`. The gate recomputes each `requestHash`, checks every verdict
   (validator, agent, score, tag), marks the action consumed, then calls the escrow.

```ts
import { Attest8004Client, buildAction, writeWithGasGuard } from "@attest8004/sdk";
import { encodeFunctionData, parseAbi } from "viem";

const escrowAbi = parseAbi(["function release(uint256 jobId)"]);
const vaultAbi = parseAbi([
  "struct Action { uint256 agentId; address target; uint256 value; bytes data; uint64 deadline; bytes32 salt; }",
  "function execute(Action action) returns (bytes result)",
]);

const action = buildAction({
  agentId: 1984n, // the vault's agent
  target: JOB_ESCROW,
  value: 0n,
  data: encodeFunctionData({ abi: escrowAbi, functionName: "release", args: [jobId] }),
  deadline: nowSeconds + 3600n, // mandate-v1 accepts at most 1 h ahead
});

// The verifier agent's hot key, through the forwarder: one request per validator.
const agent = new Attest8004Client({ publicClient, walletClient: hotKeyWallet, validationRegistry, forwarder });
const requests = await agent.requestValidation({ gate: VAULT, validators: [validatorA, validatorB], action });
for (const r of requests) await agent.awaitVerdict({ requestHash: r.requestHash, fromBlock: r.blockNumber });

if (await agent.isValidated({ gate: VAULT, action })) {
  // Anyone may send it. Monad charges the gas limit, so size it from a live estimate.
  await writeWithGasGuard({ publicClient, walletClient: anyWallet, address: VAULT, abi: vaultAbi,
    functionName: "execute", args: [action], gasLimit: { headroomPercent: 20, max: 800_000n }, label: "execute" });
}
```

## Worked example: AgentPassport's JobEscrow v2 (Monad testnet)

AgentPassport, by **agentfromzero** (an autonomous AI agent, disclosed), is escrow-backed reputation for ERC-8004 agents:
- a hirer locks USDC against an agent's ERC-8004 id;
- the agent delivers a content-addressed result;
- the release pays the agent and stamps both AgentPassport and the canonical ERC-8004 ReputationRegistry.

| Contract | Address (Monad testnet, 10143) | Source |
|---|---|---|
| JobEscrow v2 | [`0x41Cb9b1a7Ebe2e1a420d8Cd96D02a9009AC54355`](https://monad-testnet.socialscan.io/address/0x41cb9b1a7ebe2e1a420d8cd96d02a9009ac54355) | [Sourcify, exact match](https://sourcify.dev/server/v2/contract/10143/0x41Cb9b1a7Ebe2e1a420d8Cd96D02a9009AC54355) |
| AgentPassport | [`0xd01EC5Fd5A9A4335D64600aDA4E010AA6fAF9d0A`](https://monad-testnet.socialscan.io/address/0xd01ec5fd5a9a4335d64600ada4e010aa6faf9d0a) | [Sourcify, exact match](https://sourcify.dev/server/v2/contract/10143/0xd01EC5Fd5A9A4335D64600aDA4E010AA6fAF9d0A) |
| Settlement token: Circle's testnet USDC (6 decimals) | [`0x534b2f3A21130d7a60830c2Df862319e593943A3`](https://monad-testnet.socialscan.io/address/0x534b2f3a21130d7a60830c2df862319e593943a3) | Circle (FiatToken) |

**How we checked the verified source (5 Oct 2026):**
- Sourcify's recorded on-chain code equals `eth_getCode`.
- The recompiled runtime equals it with only the immutables masked, the metadata hash included.
- Neither contract is a proxy.
- JobEscrow's immutables are the canonical Identity Registry, AgentPassport and USDC.

**The parts that matter here:**

| Call | Who | Notes |
|---|---|---|
| `open(OpenParams)` | the hirer, after a USDC `approve` | `OpenParams {agentId, token, amount, deadline, reviewWindow, verifier, specHash, endpoint}`. `verifier` is a free per-job address (zero means none); `token` must be the settlement token; `reviewWindow ≤ 30 days`. |
| `deliver(jobId, deliverableHash, uri)` | the agent's owner, an approved operator or its `agentWallet` | Only while `Open` and before the deadline. |
| `release(jobId)`, selector **`0x37bdc99b`** | **the hirer or the verifier**, any time after delivery; **anyone** once `deliveredAt + reviewWindow` has passed | Pays the agent's `agentWallet` (else its owner) the escrowed amount. **No recipient or amount argument.** |
| `releaseWithPasskey`, `dispute`, `refund` | the hirer | The hirer's own paths: a passkey release, a refund plus a dispute stamp during the review window, a refund of an undelivered job. |

**For the vault's agent, the mandate adds the escrow and the selector.** For example, our e2e terms plus JobEscrow:

```json
{
  "allowedTargets": ["<agent owner>", "0xEEEBBa55620afC42E9c88b5d962476367b8da338", "0x41Cb9b1a7Ebe2e1a420d8Cd96D02a9009AC54355"],
  "allowedSelectors": ["0x00000000", "0x37bdc99b"],
  "maxValuePerTx": "2000000000000000",
  "maxValuePerDay": "5000000000000000",
  "validUntil": "1793404800"
}
```

**The selector cross product is harmless here:**
- empty calldata to JobEscrow reverts (it has no `receive`);
- `release` calldata to `DemoPassThrough` reverts (it has no `fallback`);
- `release` calldata to the owner is at most a capped MON payment to the owner.

Agent 1984's live mandate was **not** changed: this mandate is the shape, not a record.

**How the validators treat a release:**
- **`mandate-v1`:** the target and selector are allowlisted and the value is 0, so it scores 100 once the job is
  `Delivered`. Before delivery, its simulation reverts (`InvalidStatus`) and it scores 0. **Its caps count native MON
  only,** so the escrowed USDC is never counted against them.
- **`risk-v1`:** it sees the release as a value-0 call to the escrow, then a value-0 call to the token with selector
  `0xa9059cbb`. **Its tools never show the token transfer's recipient or amount** (caveat 4).
  - **In theory:** its `FUNDS_FORWARDED` rule ("value reaches an address that is not the target and not in the mandate's
    allowedTargets") would make every release to a third-party worker high.
  - **What it does instead:** it doesn't reach the payout at all.
  - **The rubric has no notion of** "an escrow paying the agent the funder chose".

## The proof: fork tests

[`contracts/test/fork/AgentPassportIntegration.fork.t.sol`](../contracts/test/fork/AgentPassportIntegration.fork.t.sol) runs
on a fork of Monad testnet's latest block, in CI's `contracts-fork` job.
- **Ours:** the live `DemoAgentVault` (agent 1984, `mandate-v1` 100 and `risk-v1` 80) is the verifier.
- **Theirs, as deployed:** JobEscrow, AgentPassport, the USDC and the ERC-8004 registries.
- **Made in the fork:**
  - a hirer and a freshly registered worker agent;
  - the hirer's USDC, funded with forge-std's `deal` (which handles FiatToken's packed balance slot);
  - the verdicts, posted on the real `ValidationRegistry` by pranking the vault's two validators.

```bash
cd contracts && MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz forge test --match-path test/fork/AgentPassportIntegration.fork.t.sol -vv
```

| Test | Shows |
|---|---|
| `testFork_LiveWiring` | JobEscrow is v2, settles in that USDC, attests to that AgentPassport (still an allowed attester) and uses the canonical Identity Registry. Our copied selectors are theirs. The vault requires A at 100 (`mandate-v1`) and B at 80 (`risk-v1`). |
| `testFork_VaultReleasesDeliveredJob` | With both verdicts, `vault.execute(release(jobId))` emits `JobReleased(jobId, worker, vault, amount)`. The worker's wallet gains the amount, the escrow loses it, the job is `Released`, the passport counts a settlement, and the action is consumed. |
| `testFork_ReleaseWithoutVerdictsReverts` | No verdicts: `ValidationNotFound(A, …)`, and the job stays `Delivered`. |
| `testFork_ReleaseWithOnlyMandateVerdictReverts` | Only `mandate-v1` answered: `ValidationNotFound(B, …)`. |
| `testFork_LowRiskScoreReverts` | `risk-v1` scored 40: `ScoreTooLow(B, …, 40, 80)`. |
| `testFork_ReplayRevertsActionAlreadyConsumed` | The same action again: `ActionAlreadyConsumed(actionHash)`. |
| `testFork_SecondReleaseFailsAtEscrow` | Fresh verdicts for a new action on a released job: the escrow refuses (`CallFailed(InvalidStatus(jobId, Released))`). |
| `testFork_StrangerCannotRelease` | Before the review window ends, a third party's `release` reverts `NotAuthorizedToRelease`. |
| `testFork_ReleaseFitsMandateV1SimulationCap` | The release itself, called from the vault, fits `mandate-v1`'s 1,000,000-gas simulation cap. |

**Gas.** In forge's Monad gas model, on an agent's first settlement (its passport record and first feedback entry are new
storage):
- the release frame is **559,476**;
- the whole `execute` frame is **623,360**, before the 21,000 intrinsic and the calldata.

On chain, AgentPassport's own first release (job 1, a direct `release` by its hirer,
[`0x413fb905…5bd5eb`](https://monad-testnet.socialscan.io/tx/0x413fb905565e43c6c758d500d32124f71ce3b8e3e26e69c35a4a3db4415bd5eb))
used 374,088 gas in total. Monad charges the gas limit, so size live limits from `eth_estimateGas`, not from these numbers.

## Caveats

1. **The verifier isn't exclusive** (JobEscrow's design, not a flaw):
   - the hirer can release, or release with a passkey;
   - anyone can release once the review window ends.

   Validated release is guaranteed only while the hirer holds back and the window is open. A hirer who wants
   validator-gated release *only* would have to be a gated contract itself, which isn't built.
2. **AgentPassport has an owner** (an EOA at the time of writing) who can remove JobEscrow as an attester. Every release,
   dispute and accepted refund would then revert, and escrowed funds would be stuck. `testFork_LiveWiring` re-checks the
   attester on every CI run.
3. **A real settlement writes permanent public records:**
   - a stamp on the worker's AgentPassport;
   - a feedback entry in the **canonical** ERC-8004 ReputationRegistry.

   That is why this integration is proven on a fork only. A test run by one party in all three roles would be
   self-dealt reputation.
4. **`risk-v1` can't see ERC-20 transfers.** Its simulation reports MON movements, and each inner call's selector without
   its arguments or logs. So a token payout or drain made inside the call shows it no recipient and no amount, and no rule
   of its rubric reads token value ([README, Limitations](../README.md#limitations)).
   - **Why this integration is safe anyway:** `release` takes no recipient or amount.
   - **For an escrow whose release takes a payee,** that safety would have to come from the mandate (and `mandate-v1`'s
     caps count only native MON).
   - **The fix is roadmap work:** a `risk-v2` that decodes `Transfer` logs from the call trace
     ([ARCHITECTURE §12](../ARCHITECTURE.md#12-extension-points-and-roadmap)).
5. **Their maintainer is unreachable through GitHub.** The repository and its account return 404 as of 5 Oct 2026.
   Their contracts are immutable, so nothing here depends on them; the fork test fails loudly if the wiring above changes.

## Doing the same for another escrow

1. **Read the escrow's release rules.** Who may release, and when? Does the caller choose the payee or the amount? Can its
   owner pause it?
2. **Copy the signatures, not the code:** a minimal interface in a fork test, as ours does.
3. **Write the fork test first,** against the live bytecode:
   - open, deliver, and release through your vault with verdicts;
   - refused without verdicts, refused on a replay;
   - the release's gas under `mandate-v1`'s simulation cap.
4. **Approve the mandate** with the passkey on [`/approve`](https://attest8004.vercel.app/approve) (paste the JSON; check
   the hash), then submit it with `submit-approval`.
5. **Run it live only with a real counterparty.**

## Credits

**AgentPassport** (JobEscrow, AgentPassport) is by **agentfromzero**, an autonomous AI agent (Anthropic Claude), disclosed.
It is **MIT**-licensed: every verified source file carries `SPDX-License-Identifier: MIT`.
- **The source:** the Sourcify-verified records for
  [JobEscrow](https://sourcify.dev/server/v2/contract/10143/0x41Cb9b1a7Ebe2e1a420d8Cd96D02a9009AC54355) and
  [AgentPassport](https://sourcify.dev/server/v2/contract/10143/0xd01EC5Fd5A9A4335D64600aDA4E010AA6fAF9d0A).
- **Their SDK:** [`@agentfromzero/agentpassport-sdk`](https://www.npmjs.com/package/@agentfromzero/agentpassport-sdk) (MIT).
- **Their site:** [agentfromzero.netlify.app/agentpassport](https://agentfromzero.netlify.app/agentpassport/).
- **Their GitHub is gone:** `github.com/agent-from-zero/agentpassport` and the account return 404 (5 Oct 2026).

Our fork test copies only function, event and error signatures from their `IJobEscrow` and `IAgentPassport`. Their
contracts are called on a fork, never changed or redeployed, and no code of theirs is in this repository.
