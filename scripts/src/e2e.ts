/**
 * End to end on Monad testnet with the `mandate-v1` validator (SPEC §4.4 and §4.5, GAMEPLAN P4): demo agent
 * 1984's hot key requests validation of two actions through the AgentRequestForwarder. Validator A, running
 * `mandate-v1`, approves the one inside the agent's mandate and refuses the one outside it. The approved action
 * executes through the DemoAgentVault, the gate refuses the other, and `verify` re-runs both verdicts from chain
 * data alone.
 *
 *   1. Preflight: the vault (agent 1984, validator A at 100), the forwarder, the per-token approval (and no blanket
 *      approval), agent 1984's registered hot key and its mandate (the e2e mandate, unexpired, set by the agent's
 *      current owner), and the balances of validator A and the hot key.
 *   2. Fund the vault with 0.01 MON if it holds less than both actions' values together.
 *   3. Build two actions, both expiring in 10 minutes. A sends 0.001 MON to the deployer, inside the mandate. B sends
 *      0.003 MON to an address no mandate lists, so it breaks two rules: the target and the per-tx cap.
 *   4. Simulate (never send) two refused requests: the owner, and agent 1985's hot key, calling the forwarder for
 *      agent 1984.
 *   5. Agent 1984's hot key requests validation of A, then of B, through the forwarder (Attest8004Client).
 *   6. One MandateValidator polls from A's block until it has answered both. A gets 100 with no reasons. B gets 0
 *      with [TARGET_NOT_ALLOWED, VALUE_OVER_TX_CAP], and its evidence's spend counts A. Right after, execute(B) is
 *      simulated, and the gate refuses it (ScoreTooLow). A freshly started validator re-reads the same blocks and
 *      must not post again.
 *   7. awaitVerdict and isValidated confirm A's verdict; the deployer submits execute(A) (permissionless).
 *   8. Check the ActionConsumed event, the vault's balance and consumed(); a replay must be refused.
 *   9. verifyRequest re-runs both verdicts at their pinned blocks with a fresh reader. Both must match: the same
 *      score and the same responseHash.
 *
 * Run: pnpm --filter @attest8004/scripts e2e   (Node loads ../.env into the environment)
 *
 * Keys come from environment variables and are never printed, nor is the RPC URL. Every transaction carries an
 * explicit gas limit, checked against a fresh estimate before it is sent, and the script reads each sent
 * transaction back to confirm the limit it carried. Refusals are simulated, never sent.
 *
 * Each run adds an approved 0.001 MON to agent 1984's daily spend (0.005 MON cap, 25 h window on approval
 * time). B's spend includes it, so B stays exactly at TARGET_NOT_ALLOWED and VALUE_OVER_TX_CAP for the first two
 * runs in any 25 h; a third adds DAILY_CAP_EXCEEDED, and this script then stops at that check.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  slice,
  toBytes,
  zeroHash,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  Admission,
  Attest8004Client,
  DEFAULT_GAS,
  DEPLOYMENTS,
  MemoryCursorStore,
  agentRequestForwarderAbi,
  attestGateAbi,
  blockWindows,
  buildAction,
  computeActionHash,
  decodeJsonDataUri,
  identityRegistryAbi,
  mandateRegistryAbi,
  sendWithGasGuard,
  validationRegistryAbi,
  validationResponseEvent,
  viemValidatorChain,
  writeWithGasGuard,
  type Action,
  type Outcome,
  type ValidatorBase,
  type ValidatorChain,
} from "@attest8004/sdk";
import {
  MANDATE_V1,
  MAX_EVIDENCE_URI_BYTES,
  MandateValidator,
  mandateAddressesFor,
  verifyContextFor,
  verifyRequest,
  viemMandateReader,
  type VerifyReport,
} from "@attest8004/validator-mandate";
import { assertChain, chain, check, mon, printTx, publicClient, requireAddress, requireEnv, walletFor } from "./common.ts";

/**
 * Explicit gas limits (Monad charges for the limit): Monad testnet eth_estimateGas x 1.2, rounded up to 1k.
 * fund 21,212 and execute 87,626 (P2, and again on 3 Oct 2026 in P3). The forwarded request uses the SDK's
 * DEFAULT_GAS.forwarderRequest.
 */
const GAS = {
  fund: 26_000n,
  execute: 106_000n,
} as const;

/**
 * The service's response limit (validators/mandate/src/main.ts): mandate-v1's evidence varies in size with the
 * mandate and the agent's activity, so each response gets its own estimate x 1.2, capped at 400,000.
 */
const RESPONSE_GAS = { headroomPercent: 20, max: 400_000n } as const;
/** The service's admission defaults (validators/mandate/src/config.ts): 20 requests per agent per hour, 10,000,000 gas a day. */
const ADMISSION = {
  maxRequestsPerAgent: 20,
  agentWindowSeconds: 3_600n,
  dailyGasBudget: 10_000_000n,
  maxGasPerResponse: RESPONSE_GAS.max,
} as const;
/** JSON-RPC requests each mandate reader keeps in flight at once, as the service does. */
const READER_CONCURRENCY = 8;

const VALUE_A = parseEther("0.001");
const VALUE_B = parseEther("0.003");
/** B's target: an address no mandate lists, derived from a fixed label so every run sends B to the same place. */
const UNLISTED = getAddress(slice(keccak256(toBytes("attest8004.e2e.unlisted")), 12));
const B_REASONS = ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"] as const;
const FUND_VALUE = parseEther("0.01");
const MIN_VALIDATOR_BALANCE = parseEther("1");
const MIN_SCORE = 100;
const TIMEOUT_MS = 180_000;

/** Agent 1984's e2e mandate (scripts/src/set-mandate.ts): the expected verdicts depend on exactly these values. */
const E2E_MANDATE = {
  allowedSelectors: ["0x00000000"],
  maxValuePerTx: parseEther("0.002"),
  maxValuePerDay: parseEther("0.005"),
} as const;

const vaultAbi = [
  ...attestGateAbi,
  ...parseAbi([
    "struct Action { uint256 agentId; address target; uint256 value; bytes data; uint64 deadline; bytes32 salt; }",
    "function execute(Action action) returns (bytes result)",
    "function agentId() view returns (uint256)",
    "error NotVaultAgent(uint256 vaultAgentId, uint256 actionAgentId)",
    "error CallFailed(bytes returnData)",
    "error ReentrancyGuardReentrantCall()",
  ]),
] as const;

const deployment = DEPLOYMENTS[chain.id];
const addresses = mandateAddressesFor(chain.id);
const registry = getAddress(deployment.validationRegistry);
const forwarder = getAddress(deployment.agentRequestForwarder);
const mandateRegistry = getAddress(deployment.mandateRegistry);
const vault = getAddress(deployment.demoAgentVault);
const identityRegistry = getAddress(deployment.identityRegistry);
const [agentId, otherAgentId] = deployment.demoAgents as readonly [bigint, bigint];

const owner = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);
const hotKey = privateKeyToAccount(requireEnv("DEMO_AGENT_1_HOT_PRIVATE_KEY") as Hex);
const otherHotKey = requireAddress("DEMO_AGENT_2_HOT_ADDRESS");
const validator = privateKeyToAccount(requireEnv("VALIDATOR_A_PRIVATE_KEY") as Hex);
if (requireAddress("DEMO_AGENT_1_HOT_ADDRESS") !== hotKey.address) {
  throw new Error("DEMO_AGENT_1_HOT_ADDRESS does not match DEMO_AGENT_1_HOT_PRIVATE_KEY");
}
if (process.env.VALIDATOR_A_ADDRESS && getAddress(process.env.VALIDATOR_A_ADDRESS) !== validator.address) {
  throw new Error("VALIDATOR_A_ADDRESS does not match VALIDATOR_A_PRIVATE_KEY");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** JSON with bigints as decimal strings. */
const json = (value: unknown, space?: number) =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), space);
const lower = (hash: Hex) => hash.toLowerCase() as Hex;

type Call = { address: Address; abi: Abi; functionName: string; args: readonly unknown[] };

/**
 * Simulates a call that must revert, and returns the custom error it reverted with. Sends nothing. Throws if the
 * simulation succeeds. Only viem's short message is kept: the full one can carry the RPC URL.
 */
async function revertOf(label: string, call: Call, account: Address): Promise<{ name?: string; args: readonly unknown[]; detail: string }> {
  try {
    await publicClient.simulateContract({ ...call, account } as never);
  } catch (error) {
    const reverted = error instanceof BaseError ? error.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    if (reverted instanceof ContractFunctionRevertedError && reverted.data) {
      const { errorName, args = [] } = reverted.data;
      return { name: errorName, args, detail: `${errorName}(${args.map(String).join(", ")})` };
    }
    return { args: [], detail: error instanceof BaseError ? error.shortMessage : String(error) };
  }
  throw new Error(`check failed: ${label} (the simulation succeeded)`);
}

/** Simulates a call and checks that it reverts with `errorName`. Sends nothing. */
async function expectRevert(label: string, call: Call, account: Address, errorName: string): Promise<void> {
  const { name, detail } = await revertOf(label, call, account);
  check(`${label} reverts ${errorName} (simulated)`, name === errorName, detail);
}

/** Confirms a sent transaction carried exactly the explicit limit, and came from `from`. */
async function checkSent(label: string, hash: Hash, from: Address, gasLimit: bigint): Promise<void> {
  const tx = await publicClient.getTransaction({ hash });
  const sender = getAddress(tx.from); // the RPC returns it lower-case
  check(`${label} was sent by ${from} with gas limit ${gasLimit}`, sender === from && tx.gas === gasLimit, `${sender}, ${tx.gas}`);
}

/**
 * Polls `validator` until it has an outcome for every one of `requestHashes`, or times out. Outcomes for other
 * requests (anyone may ask validator A) are left to the validator; a request it gives up on fails the run.
 */
async function pollUntilAll(validator: ValidatorBase, requestHashes: readonly Hex[]): Promise<Map<Hex, Outcome>> {
  const wanted = new Set(requestHashes.map(lower));
  const found = new Map<Hex, Outcome>();
  const giveUpAt = Date.now() + TIMEOUT_MS;
  for (;;) {
    const { outcomes, caughtUp, retryAfterMs } = await validator.pollOnce();
    for (const outcome of outcomes) {
      const key = lower(outcome.requestHash);
      if (!wanted.has(key)) continue;
      if (outcome.kind === "gave-up") throw new Error(`the validator gave up on ${outcome.requestHash}: ${outcome.error}`);
      found.set(key, outcome);
    }
    if (found.size === wanted.size) return found;
    if (Date.now() > giveUpAt) throw new Error(`no outcome for every request within ${TIMEOUT_MS} ms (${found.size}/${wanted.size})`);
    if (retryAfterMs !== undefined) await sleep(retryAfterMs);
    else if (caughtUp) await sleep(500);
  }
}

/** What each response cost: Monad's estimate for its exact arguments, and the limit the validator actually sent. */
const responseGas = new Map<Hex, { estimate: bigint; limit: bigint }>();

/**
 * Validator A as the service runs it (validators/mandate/src/main.ts), from just before `fromBlock`, in memory:
 * the evidence-sized response limit, a reader at concurrency 8, the vault as its only gate and a fresh admission
 * policy with the service's defaults. Its chain port is wrapped only to record each response's gas.
 */
function mandateValidator(fromBlock: bigint, name: string): MandateValidator {
  const port = viemValidatorChain({
    publicClient,
    walletClient: walletFor(validator),
    validationRegistry: registry,
    gasLimit: RESPONSE_GAS,
  });
  const measured: ValidatorChain = {
    ...port,
    async respond(response) {
      const { requestHash, response: score, responseURI, responseHash, tag } = response;
      const estimate = await publicClient.estimateContractGas({
        address: registry,
        abi: validationRegistryAbi,
        functionName: "validationResponse",
        args: [requestHash, score, responseURI, responseHash, tag],
        account: validator.address,
      });
      const sent = await port.respond(response);
      responseGas.set(lower(requestHash), { estimate, limit: sent.gasLimit });
      return sent;
    },
  };
  return new MandateValidator({
    chain: measured,
    cursor: new MemoryCursorStore(fromBlock - 1n),
    reader: viemMandateReader({ publicClient, addresses, concurrency: READER_CONCURRENCY }),
    addresses,
    mandateRegistryDeployBlock: deployment.mandateRegistryDeployBlock,
    gates: [vault],
    admission: new Admission(ADMISSION),
    log: (entry) => console.log(`    ${name}: ${json(entry)}`),
  });
}

/** The evidence document a response posted, decoded from its inline `data:` URI. */
function postedEvidence(label: string, responseURI: string): { reasons?: unknown; spend?: { entries?: { requestHash: string; counted: boolean }[] } } {
  const decoded = decodeJsonDataUri(responseURI, MAX_EVIDENCE_URI_BYTES);
  if (!decoded.ok) throw new Error(`${label}'s response URI is not inline JSON: ${decoded.reason}`);
  return JSON.parse(decoded.text) as ReturnType<typeof postedEvidence>;
}

async function main(): Promise<void> {
  // 1. Preflight.
  await assertChain();
  const read = <const F extends "validationRegistry" | "requirements" | "agentId">(functionName: F) =>
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName });
  const [
    vaultRegistry,
    requirements,
    vaultAgent,
    forwarderRegistry,
    approvedForAll,
    approvedForToken,
    agentOwner,
    agentKey,
    [mandate, mandateHash, mandateOwner, setAtBlock],
    validatorBalance,
    hotBalance,
    fees,
    latest,
  ] = await Promise.all([
    read("validationRegistry"),
    read("requirements"),
    read("agentId"),
    publicClient.readContract({ address: forwarder, abi: agentRequestForwarderAbi, functionName: "validationRegistry" }),
    publicClient.readContract({
      address: identityRegistry,
      abi: identityRegistryAbi,
      functionName: "isApprovedForAll",
      args: [owner.address, forwarder],
    }),
    publicClient.readContract({ address: identityRegistry, abi: identityRegistryAbi, functionName: "getApproved", args: [agentId] }),
    publicClient.readContract({ address: identityRegistry, abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId] }),
    publicClient.readContract({ address: forwarder, abi: agentRequestForwarderAbi, functionName: "agentKeyOf", args: [agentId] }),
    publicClient.readContract({ address: mandateRegistry, abi: mandateRegistryAbi, functionName: "getMandate", args: [agentId] }),
    publicClient.getBalance({ address: validator.address }),
    publicClient.getBalance({ address: hotKey.address }),
    publicClient.estimateFeesPerGas(),
    publicClient.getBlock(),
  ]);

  console.log(`DemoAgentVault        ${vault} (chain ${chain.id})`);
  console.log(`AgentRequestForwarder ${forwarder}`);
  console.log(`ValidationRegistry    ${registry}`);
  console.log(`MandateRegistry       ${mandateRegistry}`);
  console.log(`agent                 ${agentId}, owner ${owner.address} (deployer), hot key ${hotKey.address}`);
  console.log(`validator             ${validator.address} (validator A, ${MANDATE_V1.tag})`);
  console.log(`unlisted target       ${UNLISTED}\n`);
  console.log("preflight");
  check("vault reads the ValidationRegistry", getAddress(vaultRegistry) === registry, vaultRegistry);
  check(`vault is bound to agent ${agentId}`, vaultAgent === agentId, String(vaultAgent));
  const [requirement] = requirements;
  check(
    `vault requires exactly validator A at ${MIN_SCORE}`,
    requirements.length === 1 && requirement?.validator === validator.address && requirement.minScore === MIN_SCORE,
    json(requirements),
  );
  check("forwarder serves the ValidationRegistry", getAddress(forwarderRegistry) === registry, forwarderRegistry);
  check(`agent ${agentId} is owned by the deployer`, agentOwner === owner.address, agentOwner);
  check(`getApproved(${agentId}) is the forwarder (per-token approval)`, getAddress(approvedForToken) === forwarder, approvedForToken);
  check("the deployer has no blanket approval for the forwarder", !approvedForAll, String(approvedForAll));
  check(
    `agent ${agentId}'s forwarder key is the hot key, set by the deployer`,
    agentKey[0] === hotKey.address && agentKey[1] === owner.address,
    agentKey.join(", "),
  );
  check(`agent ${agentId} has a mandate`, mandateHash !== zeroHash, mandateHash);
  check(
    `the mandate was set by the deployer, who owns agent ${agentId} (set at block ${setAtBlock})`,
    getAddress(mandateOwner) === owner.address && getAddress(mandateOwner) === agentOwner,
    mandateOwner,
  );
  check(`the mandate is unexpired (valid until ${mandate.validUntil})`, mandate.validUntil > latest.timestamp, `latest block time ${latest.timestamp}`);
  check(
    "the mandate is the e2e one: the deployer only, plain transfers, 0.002 MON per tx, 0.005 MON per day",
    mandate.allowedTargets.length === 1 &&
      getAddress(mandate.allowedTargets[0] as Address) === owner.address &&
      json(mandate.allowedSelectors.map((s) => s.toLowerCase())) === json(E2E_MANDATE.allowedSelectors) &&
      mandate.maxValuePerTx === E2E_MANDATE.maxValuePerTx &&
      mandate.maxValuePerDay === E2E_MANDATE.maxValuePerDay,
    json(mandate),
  );
  check(`validator A holds at least ${mon(MIN_VALIDATOR_BALANCE)}`, validatorBalance >= MIN_VALIDATOR_BALANCE, mon(validatorBalance));
  const requestsCost = 2n * DEFAULT_GAS.forwarderRequest * fees.maxFeePerGas;
  check(`the hot key can pay for 2 requests (${mon(requestsCost)})`, hotBalance >= requestsCost, mon(hotBalance));

  // 2. Fund the vault if it can't cover both actions (each is simulated at its own pinned block, before A executes).
  const txs: Record<string, Hash> = {};
  const ownerWallet = walletFor(owner);
  if ((await publicClient.getBalance({ address: vault })) < VALUE_A + VALUE_B) {
    const sent = await sendWithGasGuard({
      publicClient,
      walletClient: ownerWallet,
      to: vault,
      value: FUND_VALUE,
      gasLimit: GAS.fund,
      label: "fund vault",
    });
    printTx("fund vault", sent);
    txs.fund = sent.hash;
  }
  const balanceBefore = await publicClient.getBalance({ address: vault });
  console.log(`  vault balance ${mon(balanceBefore)}`);

  // 3. The actions.
  const deadline = (await publicClient.getBlock()).timestamp + 600n;
  const actionA = buildAction({ agentId, target: owner.address, value: VALUE_A, deadline });
  const actionB = buildAction({ agentId, target: UNLISTED, value: VALUE_B, deadline });
  const actionHashA = computeActionHash({ chainId: chain.id, gate: vault, action: actionA });
  const actionHashB = computeActionHash({ chainId: chain.id, gate: vault, action: actionB });

  // 4. Only the agent's own key may request through the forwarder.
  console.log("\nforwarder refusals");
  const forwarded = (args: readonly unknown[]) =>
    ({ address: forwarder, abi: agentRequestForwarderAbi, functionName: "request", args }) as const;
  const sample = [validator.address, agentId, "data:application/json,{}", actionHashA] as const;
  await expectRevert("the owner calling forwarder.request", forwarded(sample), owner.address, "NotAgentKey");
  await expectRevert(`agent ${otherAgentId}'s hot key requesting for agent ${agentId}`, forwarded(sample), otherHotKey, "NotAgentKey");

  // 5. The hot key requests validation of both actions through the forwarder, before any validator runs.
  console.log("\nrequests (agent hot key -> forwarder -> registry)");
  const client = new Attest8004Client({
    publicClient,
    walletClient: walletFor(hotKey),
    validationRegistry: registry,
    forwarder,
  });
  const request = async (label: "A" | "B", action: Action) => {
    const [requested] = await client.requestValidation({ gate: vault, validators: [validator.address], action });
    if (!requested) throw new Error(`requestValidation returned nothing for ${label}`);
    txs[`request${label}`] = requested.txHash;
    console.log(`forwarder.request (${label})  ${requested.txHash}  block ${requested.blockNumber}`);
    return requested;
  };
  const requestedA = await request("A", actionA);
  const requestedB = await request("B", actionB);
  const hashA = lower(requestedA.requestHash);
  const hashB = lower(requestedB.requestHash);
  for (const [label, action, requested] of [
    ["A", actionA, requestedA],
    ["B", actionB, requestedB],
  ] as const) {
    const [onchainRequestHash, status] = await Promise.all([
      publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "requestHashOf", args: [action, validator.address] }),
      publicClient.readContract({
        address: registry,
        abi: validationRegistryAbi,
        functionName: "getValidationStatus",
        args: [requested.requestHash],
      }),
    ]);
    check(`${label}: the SDK's requestHash equals the vault's`, requested.requestHash === onchainRequestHash, onchainRequestHash);
    check(
      `${label}: the registry recorded validator A and agent ${agentId}`,
      status[0] === validator.address && status[1] === agentId,
      `${status[0]}, ${status[1]}`,
    );
    await checkSent(`${label}'s request`, requested.txHash, hotKey.address, DEFAULT_GAS.forwarderRequest);
  }

  // 6. mandate-v1 answers both; the gate refuses B; a restarted validator doesn't answer again.
  console.log(`\nvalidator (${MANDATE_V1.tag} on the SDK's ValidatorBase, polling eth_getLogs up to the finalized block)`);
  const outcomes = await pollUntilAll(mandateValidator(requestedA.blockNumber, "validator"), [hashA, hashB]);
  const outcomeA = outcomes.get(hashA);
  const outcomeB = outcomes.get(hashB);
  check("A: responded 100", outcomeA?.kind === "responded" && outcomeA.score === 100, json(outcomeA));
  check("B: responded 0", outcomeB?.kind === "responded" && outcomeB.score === 0, json(outcomeB));
  if (outcomeA?.kind !== "responded" || outcomeB?.kind !== "responded") throw new Error("unreachable");

  const refusal = await revertOf("execute(B)", { address: vault, abi: vaultAbi, functionName: "execute", args: [actionB] }, owner.address);
  const [refusedValidator, refusedHash, refusedScore, refusedMin] = refusal.args;
  check(
    "the gate refuses B: ScoreTooLow (simulated)",
    refusal.name === "ScoreTooLow" &&
      typeof refusedValidator === "string" &&
      getAddress(refusedValidator) === validator.address &&
      typeof refusedHash === "string" &&
      lower(refusedHash as Hex) === hashB &&
      refusedScore === 0 &&
      refusedMin === MIN_SCORE,
    refusal.detail,
  );
  check("isValidated(B) is false", !(await client.isValidated({ gate: vault, action: actionB })), "true");

  for (const [label, outcome] of [
    ["A", outcomeA],
    ["B", outcomeB],
  ] as const) {
    const gas = responseGas.get(lower(outcome.requestHash));
    if (!gas) throw new Error(`no gas recorded for ${label}'s response`);
    txs[`response${label}`] = outcome.txHash;
    console.log(`validationResponse (${label}) ${outcome.txHash}  block ${outcome.blockNumber}, gas limit ${gas.limit} (estimate ${gas.estimate})`);
    check(`${label}'s response limit is at most ${RESPONSE_GAS.max}`, gas.limit <= RESPONSE_GAS.max, String(gas.limit));
    await checkSent(`${label}'s response`, outcome.txHash, validator.address, gas.limit);
  }

  const [verdictA, verdictB] = await Promise.all([
    client.awaitVerdict({ requestHash: hashA, fromBlock: requestedA.blockNumber, timeoutMs: 60_000 }),
    client.awaitVerdict({ requestHash: hashB, fromBlock: requestedB.blockNumber, timeoutMs: 60_000 }),
  ]);
  for (const [label, verdict, score] of [
    ["A", verdictA, 100],
    ["B", verdictB, 0],
  ] as const) {
    check(
      `awaitVerdict ${label}: ${score} from validator A, tag ${MANDATE_V1.tag}`,
      verdict.response === score && verdict.validator === validator.address && verdict.tag === MANDATE_V1.tag,
      json({ response: verdict.response, validator: verdict.validator, tag: verdict.tag }),
    );
  }
  const evidenceA = postedEvidence("A", verdictA.responseURI);
  const evidenceB = postedEvidence("B", verdictB.responseURI);
  check("A's evidence: reasons []", json(evidenceA.reasons) === "[]", json(evidenceA.reasons));
  check(`B's evidence: reasons ${json(B_REASONS)}`, json(evidenceB.reasons) === json(B_REASONS), json(evidenceB.reasons));
  const spentA = evidenceB.spend?.entries?.find((entry) => entry.requestHash.toLowerCase() === hashA);
  check("B's evidence: its spend counts A", spentA?.counted === true, json(evidenceB.spend));

  console.log("\nrestart (a fresh validator re-reads the same blocks)");
  const again = await pollUntilAll(mandateValidator(requestedA.blockNumber, "restarted"), [hashA, hashB]);
  for (const [label, hash] of [
    ["A", hashA],
    ["B", hashB],
  ] as const) {
    const outcome = again.get(hash);
    check(
      `the restarted validator skips ${label}: ALREADY_RESPONDED`,
      outcome?.kind === "skipped" && outcome.reason === "ALREADY_RESPONDED",
      json(outcome),
    );
  }
  const head = await publicClient.getBlockNumber();
  const responses = [];
  for (const window of blockWindows(requestedA.blockNumber, head)) {
    responses.push(
      ...(await publicClient.getLogs({ address: registry, event: validationResponseEvent, args: { requestHash: [hashA, hashB] }, ...window })),
    );
  }
  for (const [label, hash] of [
    ["A", hashA],
    ["B", hashB],
  ] as const) {
    const count = responses.filter((log) => log.args.requestHash?.toLowerCase() === hash).length;
    check(`exactly one ValidationResponse for ${label}`, count === 1, String(count));
  }

  // 7. Anyone may execute the approved action.
  console.log("\nexecute A");
  check("isValidated(A) before execute", await client.isValidated({ gate: vault, action: actionA }), "false");
  const executed = await writeWithGasGuard({
    publicClient,
    walletClient: ownerWallet,
    address: vault,
    abi: vaultAbi,
    functionName: "execute",
    args: [actionA],
    gasLimit: GAS.execute,
    label: "execute",
  });
  printTx("execute (A)", executed);
  txs.execute = executed.hash;
  await checkSent("execute", executed.hash, owner.address, GAS.execute);

  // 8. Effects, and a replay.
  const consumedLogs = parseEventLogs({ abi: vaultAbi, eventName: "ActionConsumed", logs: executed.receipt.logs }).filter(
    (log) => getAddress(log.address) === vault,
  );
  check(
    `ActionConsumed(actionHash A, ${agentId}) emitted by the vault`,
    consumedLogs.length === 1 && consumedLogs[0]?.args.actionHash === actionHashA && consumedLogs[0].args.agentId === agentId,
    `${consumedLogs.length} log(s)`,
  );
  const balanceAfter = await publicClient.getBalance({ address: vault });
  check("vault balance fell by exactly A's value", balanceBefore - balanceAfter === VALUE_A, `${balanceBefore} -> ${balanceAfter}`);
  const consumed = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "consumed", args: [actionHashA] });
  check("consumed(actionHash A) is true", consumed, String(consumed));
  await expectRevert("a replay of A", { address: vault, abi: vaultAbi, functionName: "execute", args: [actionA] }, owner.address, "ActionAlreadyConsumed");
  check("isValidated(A) after execute is false", !(await client.isValidated({ gate: vault, action: actionA })), "true");

  // 9. verify re-runs each verdict at its pinned block, from chain data alone.
  console.log("\nverify (a fresh reader and an empty cache per verdict)");
  const reports: Record<string, VerifyReport> = {};
  for (const [label, hash, verdict] of [
    ["A", hashA, verdictA],
    ["B", hashB, verdictB],
  ] as const) {
    const report = await verifyRequest({
      reader: viemMandateReader({ publicClient, addresses, concurrency: READER_CONCURRENCY }),
      requestHash: hash,
      ...verifyContextFor(chain.id),
    });
    reports[label] = report;
    const detail = json({ verdict: report.verdict, problems: report.problems, differingKeys: report.differingKeys });
    check(`verify ${label}: match (P = block ${report.pinnedBlock})`, report.verdict === "match", detail);
    check(
      `verify ${label}: the recomputed score equals the posted ${verdict.response}`,
      report.recomputed?.score === verdict.response && report.posted.score === verdict.response,
      json(report.recomputed),
    );
    check(
      `verify ${label}: the recomputed responseHash equals the onchain one`,
      report.recomputed?.responseHash === lower(verdict.responseHash),
      `${report.recomputed?.responseHash} vs ${verdict.responseHash}`,
    );
  }
  check(
    `verify B: the recomputed reasons are ${json(B_REASONS)}`,
    json(reports.B?.recomputed?.reasons) === json(B_REASONS),
    json(reports.B?.recomputed?.reasons),
  );

  console.log("\ne2e OK");
  const gasOf = (hash: Hex) => {
    const gas = responseGas.get(hash);
    return { estimate: gas?.estimate.toString(), limit: gas?.limit.toString() };
  };
  console.log(
    json(
      {
        chainId: chain.id,
        vault,
        forwarder,
        validationRegistry: registry,
        mandateRegistry,
        agentId,
        hotKey: hotKey.address,
        validator: validator.address,
        actions: {
          A: { target: actionA.target, value: actionA.value, actionHash: actionHashA, requestHash: hashA },
          B: { target: actionB.target, value: actionB.value, actionHash: actionHashB, requestHash: hashB },
        },
        blocks: {
          requestA: requestedA.blockNumber,
          requestB: requestedB.blockNumber,
          responseA: outcomeA.blockNumber,
          responseB: outcomeB.blockNumber,
          execute: executed.receipt.blockNumber,
          pinnedA: reports.A?.pinnedBlock,
          pinnedB: reports.B?.pinnedBlock,
        },
        txs,
        gas: {
          forwarderRequest: { limit: DEFAULT_GAS.forwarderRequest },
          validationResponse: { A: gasOf(hashA), B: gasOf(hashB) },
          execute: { limit: GAS.execute, estimate: executed.estimate },
        },
        verify: { A: reports.A?.verdict, B: reports.B?.verdict },
      },
      2,
    ),
  );
}

// viem's shortMessage leaves out request details such as the RPC URL.
main().catch((error: unknown) => {
  const short = (error as { shortMessage?: string }).shortMessage;
  console.error(short ?? (error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
