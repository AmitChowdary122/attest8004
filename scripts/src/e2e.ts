/**
 * End to end on Monad testnet with both reference validators (SPEC §4.4 to §4.6, GAMEPLAN P5): demo agent 1984's
 * hot key requests validation of three actions through the AgentRequestForwarder, each from validator A (`mandate-v1`,
 * deterministic) and validator B (`risk-v1`, agentic: onchain tools at a pinned block, a Groq-hosted model through an
 * OpenAI-compatible endpoint, Prompt Guard screening, code-derived score). The two-validator DemoAgentVault requires A
 * at 100 under `mandate-v1`, then B at 80 under `risk-v1`, and checks them in that order.
 *
 *   S  0.001 MON to the deployer: inside the mandate and safe. A 100, B at least 80: it executes.
 *   R  0.001 MON to the DemoPassThrough, which the mandate allowlists but which forwards every payment to SINK, an
 *      address nobody controls. A 100 (allowlisted target, plain transfer, within the caps, the simulation
 *      succeeds); B 0 with a high finding (the value leaves for an address outside the mandate). Refused at B.
 *   O  0.003 MON to an address no mandate lists (P4's out-of-mandate action). A 0; B runs anyway, to explain why.
 *      Refused at A, the first requirement.
 *
 *   1. Preflight: the vault (agent 1984; requirements exactly A at 100 with keccak256("mandate-v1"), then B at 80 with
 *      keccak256("risk-v1")), the forwarder, the per-token approval (and no blanket approval), agent 1984's registered
 *      hot key and its mandate (the e2e mandate: the deployer and the DemoPassThrough, unexpired, set by the agent's
 *      current owner), the DemoPassThrough and its sink, both validators' keys against DEPLOYMENTS.validators, the
 *      balances (A at least 1 MON, B at least 0.5 MON, the hot key 6 forwarded requests at the current max fee, the
 *      deployer the vault's top-up plus the fund's and execute(S)'s gas with a 50% margin), the mandate's age (set at
 *      least 6,000 blocks ago, about 31 minutes, so risk-v1's recent_permission_events doesn't show its MandateSet),
 *      the LLM settings and a zero-token GET /models on B's endpoint (the key works and both models are listed;
 *      never a completion), and agent 1984's counted spend: S and R must both still fit under the daily cap. P7:
 *      agent 1984's inbox key says whether operator reports are expected (a key and a recorded FindingsBoard), and
 *      when they are, each validator's balance must also cover its three reports at OPERATOR_REPORT_GAS_CAP and the
 *      current max fee, so a low validator B stops the run here. Any failure stops the run before it sends anything.
 *   2. Fund the vault up to 0.01 MON if it holds less than the three actions' values together (0.005 MON).
 *   3. Build S, R and O, all expiring 1,800 s after the latest block.
 *   4. Simulate (never send) two refused requests: the owner, and agent 1985's hot key, calling the forwarder for
 *      agent 1984.
 *   5. Agent 1984's hot key requests validation of S, R and O through the forwarder (Attest8004Client), from A then B
 *      for each action: 6 requests, before either validator runs.
 *   6. Both validators run in this process as their services run them, from the first request's block, and poll
 *      concurrently until each has answered its three, with one shared 25-minute deadline (risk-v1 is paced to
 *      Groq's free tier, so each of its checks takes a few minutes; it waits for A's verdict on the same action
 *      first). A: S 100 and R 100 with no reasons; O 0 with [TARGET_NOT_ALLOWED, VALUE_OVER_TX_CAP], plus
 *      DAILY_CAP_EXCEEDED when its own evidence's spend (which must count S and R) plus 0.003 MON is over the
 *      0.005 MON daily cap. B: S at least 80; R 0 with at least one high finding; O answered. Both validators'
 *      evidence (A's reasons; B's findings, models, tokens and sizes) is printed before any score is asserted.
 *      With reports on, each response's encrypted operator report is found the way /inbox finds it (the agent's
 *      verdicts, then FindingsPosted with the trust rule): exactly one trusted post per request, a version-1 envelope
 *      of 62 to 8,192 bytes, sent by that validator with a gas limit at most OPERATOR_REPORT_GAS_CAP. With reports
 *      off, none exists.
 *   7. Simulate execute(R): ScoreTooLow(validator B, R's request to B, 0, 80); and execute(O): ScoreTooLow(validator A,
 *      O's request to A, 0, 100). Freshly started validators re-read the same blocks and must skip all 6
 *      (ALREADY_RESPONDED), validator B without a single model or guard call; exactly one response exists for each.
 *      The restart may take at most 5 minutes, and never past S's deadline minus 120 s (left for execute(S)).
 *   8. awaitVerdict and isValidated confirm S; the deployer submits execute(S) (permissionless), never with less
 *      than 60 s before S's deadline. Check the ActionConsumed event, the vault's balance and consumed(); a replay
 *      must be refused (ActionAlreadyConsumed). Then the reports again: the restart posted none (still exactly one each).
 *   9. verifyRequest re-runs A's three verdicts at their pinned blocks, and verifyRiskRequest re-checks B's three
 *      from their public evidence (the score from the recorded findings, every onchain tool call re-run at the
 *      pinned block, A's verdict there; the model output is recorded, not re-run). All six must match.
 *
 * Run: pnpm --filter @attest8004/scripts e2e   (Node loads ../.env into the environment)
 * Stop both validator services first: this process signs with validator A's and validator B's keys, and two
 * processes answering the same requests would race (each validator's pinned block also assumes one process per key).
 *
 * Keys come from environment variables and are never printed, nor is the RPC URL, the LLM endpoint's URL or its key
 * (only its host). Every transaction carries an explicit gas limit, checked against a fresh estimate before it is
 * sent, and the script reads each sent transaction back to confirm the limit it carried. Refusals are simulated,
 * never sent. Each run makes three risk-v1 checks, about 20,000 tokens each of the main model's 200,000 a day.
 *
 * Each run adds an approved 0.001 MON (S, executed) to agent 1984's daily spend (0.005 MON cap, 25 h window on
 * approval time), and an approved 0.001 MON (R, never executed) until R's deadline passes. O's spend counts both, so
 * O also gets DAILY_CAP_EXCEEDED whenever anything earlier is counted, which the script expects from O's own
 * evidence. With nothing else counted, S and R fit under the cap for four runs in any 25 h (at least 30 minutes
 * apart, so the last run's R no longer counts); the preflight stops a fifth before it sends anything and says when
 * the oldest counted approval leaves the window.
 */
import {
  getAddress,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  slice,
  stringToBytes,
  toBytes,
  zeroHash,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  Attest8004Client,
  DEFAULT_GAS,
  DEPLOYMENTS,
  ENVELOPE_OVERHEAD_BYTES,
  ENVELOPE_VERSION,
  MAX_ENVELOPE_BYTES,
  OPERATOR_REPORT_GAS_CAP,
  agentRequestForwarderAbi,
  attestGateAbi,
  blockWindows,
  buildAction,
  buildRequestJson,
  computeActionHash,
  currentMandateRegistry,
  E2E_MANDATE_TERMS,
  decodeJsonDataUri,
  encodeJsonDataUri,
  findInboxEntries,
  identityRegistryAbi,
  mandateRegistryAbi,
  requestHashOfJson,
  sendWithGasGuard,
  validationRegistryAbi,
  validationResponseEvent,
  viemInboxReader,
  writeWithGasGuard,
  type Action,
  type Deployment,
  type RequestedValidation,
  type ValidatorBase,
  type Verdict,
  knownValidatorsOf,
} from "@attest8004/sdk";
import {
  MANDATE_V1,
  MAX_EVIDENCE_URI_BYTES,
  MandateValidator,
  collectSpend,
  mandateContractsFor,
  verifyContextFor,
  verifyRequest,
  viemMandateReader,
  type VerifyReport,
} from "@attest8004/validator-mandate";
import {
  RISK_V1,
  RiskValidator,
  parseRiskEvidence,
  riskContractsFor,
  verifyRiskRequest,
  viemRiskReader,
  type ChatClient,
  type RiskEvidence,
  type RiskVerifyReport,
} from "@attest8004/validator-risk";
import { assertChain, chain, check, mon, printTx, publicClient, requireAddress, requireEnv, walletFor } from "./common.ts";
import { GAS, GUARD_PACING, MANDATE_RESPONSE_GAS, READER_CONCURRENCY, RISK_RESPONSE_GAS, counted, liveValidators, llmSettingsFromEnv, pollAll, revertOf, type Call } from "./live-validators.ts";
import { dailyCapShortfall, expectedReasonsO } from "./e2e-cap.ts";
import {
  checkModelsEndpoint,
  deployerNeed,
  deployerShortfall,
  executeTimeLeft,
  permissionWindowWait,
  reportsExpected,
  restartBudget,
  retryUntil,
  validatorNeed,
} from "./e2e-preflight.ts";

/** How often the report check looks again for a report a lagging RPC node didn't show yet, and how long it waits between. */
const REPORT_DISCOVERY_ATTEMPTS = 4;
const REPORT_DISCOVERY_DELAY_MS = 5_000;

const VALUE_S = parseEther("0.001");
const VALUE_R = parseEther("0.001");
const VALUE_O = parseEther("0.003");
/** O's target: an address no mandate lists, derived from a fixed label so every run sends O to the same place (P4's B). */
const UNLISTED = getAddress(slice(keccak256(toBytes("attest8004.e2e.unlisted")), 12));
/** Where the DemoPassThrough forwards every payment: `address(uint160(uint256(keccak256("attest8004.demo.sink"))))`. */
const SINK = getAddress(slice(keccak256(toBytes("attest8004.demo.sink")), 12));
/** The vault is topped up to this much when it holds less than FUND_BELOW. */
const FUND_TARGET = parseEther("0.01");
/** The three actions' values together: each is simulated at its own pinned block, before S executes. */
const FUND_BELOW = VALUE_S + VALUE_R + VALUE_O;
const MIN_VALIDATOR_A_BALANCE = parseEther("1");
const MIN_VALIDATOR_B_BALANCE = parseEther("0.5");
const MIN_SCORE_A = 100;
const MIN_SCORE_B = 80;
/** Every action expires this long after the latest block (well inside both validators' 3,600 s horizon). */
const DEADLINE_SECONDS = 1_800n;
/** The forwarded requests the hot key pays for: three actions, each from both validators. */
const REQUESTS = 6n;
/** One deadline for both validators to answer all six (risk-v1's three checks take a few minutes each). */
const TIMEOUT_MS = 25 * 60_000;
/**
 * The restarted validators only re-read the same blocks and skip, but by then the head is some 5,000 blocks past the
 * first request (0.3 s blocks), about 50 eth_getLogs windows each. Capped further so EXECUTE_MARGIN_SECONDS still
 * remain before S's deadline.
 */
const RESTART_TIMEOUT_MS = 300_000;
/** The restart check stops this long before S's deadline, leaving the time for execute(S). */
const EXECUTE_MARGIN_SECONDS = 120n;
/** execute(S) is never sent with less than this left before S's deadline. */
const EXECUTE_MIN_SECONDS = 60n;
/** The deployer must hold the vault top-up plus the fund's and execute(S)'s gas at the max fee, with this much on the gas. */
const DEPLOYER_GAS_MARGIN_PERCENT = 50;
/** The zero-token LLM endpoint check (GET /models) gives up after this long. */
const LLM_PREFLIGHT_TIMEOUT_MS = 10_000;
/** Monad testnet's block time, measured on 3 Oct 2026: only to say about how many minutes a wait in blocks is. */
const MS_PER_BLOCK = 305n;

/**
 * Agent 1984's e2e mandate terms (the SDK's E2E_MANDATE_TERMS, the /approve page's "e2e mandate" preset): the expected
 * verdicts depend on exactly these values.
 */
const E2E_MANDATE = E2E_MANDATE_TERMS;

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
const passThroughAbi = parseAbi(["function sink() view returns (address)"]);

const deployment = DEPLOYMENTS[chain.id];
/** The contracts the validators and verify read, the whole MandateRegistry history included (each read resolves its block's). */
const contracts = mandateContractsFor(chain.id);
const riskContracts = riskContractsFor(chain.id);
const registry = getAddress(deployment.validationRegistry);
const forwarder = getAddress(deployment.agentRequestForwarder);
/** The current MandateRegistry: the one agent 1984's mandate is read from now (the validators resolve theirs at P). */
const mandateRegistry = getAddress(currentMandateRegistry(deployment).address);
const vault = getAddress(deployment.demoAgentVault);
const passThrough = getAddress(deployment.demoPassThrough);
const identityRegistry = getAddress(deployment.identityRegistry);
const [agentId, otherAgentId] = deployment.demoAgents as readonly [bigint, bigint];

const owner = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);
const hotKey = privateKeyToAccount(requireEnv("DEMO_AGENT_1_HOT_PRIVATE_KEY") as Hex);
const otherHotKey = requireAddress("DEMO_AGENT_2_HOT_ADDRESS");
const validatorA = privateKeyToAccount(requireEnv("VALIDATOR_A_PRIVATE_KEY") as Hex);
const validatorB = privateKeyToAccount(requireEnv("VALIDATOR_B_PRIVATE_KEY") as Hex);
if (requireAddress("DEMO_AGENT_1_HOT_ADDRESS") !== hotKey.address) {
  throw new Error("DEMO_AGENT_1_HOT_ADDRESS does not match DEMO_AGENT_1_HOT_PRIVATE_KEY");
}
for (const [name, account] of [
  ["VALIDATOR_A", validatorA],
  ["VALIDATOR_B", validatorB],
] as const) {
  const address = process.env[`${name}_ADDRESS`];
  if (address && getAddress(address) !== account.address) throw new Error(`${name}_ADDRESS does not match ${name}_PRIVATE_KEY`);
}

/** Validator B's model endpoint and pacing, as its service reads them. Never printed but the host. */
const LLM = llmSettingsFromEnv(process.env);

/** JSON with bigints as decimal strings. */
const json = (value: unknown, space?: number) =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), space);
const lower = (hash: Hex) => hash.toLowerCase() as Hex;

const LABELS = ["S", "R", "O"] as const;
type Label = (typeof LABELS)[number];
type Side = "A" | "B";

/** Simulates a call and checks that it reverts with `errorName`. Sends nothing. */
async function expectRevert(label: string, call: Call, account: Address, errorName: string): Promise<void> {
  const { name, detail } = await revertOf(publicClient, label, call, account);
  check(`${label} reverts ${errorName} (simulated)`, name === errorName, detail);
}

/** Simulates execute(action) and checks the gate refuses it with ScoreTooLow(validator, requestHash, score, minScore). */
async function expectScoreTooLow(label: string, action: Action, validator: Address, requestHash: Hex, score: number, minScore: number) {
  const refusal = await revertOf(publicClient, `execute(${label})`, { address: vault, abi: vaultAbi, functionName: "execute", args: [action] }, owner.address);
  const [refusedValidator, refusedHash, refusedScore, refusedMin] = refusal.args;
  check(
    `the gate refuses ${label}: ScoreTooLow(${validator}, ${requestHash}, ${score}, ${minScore}) (simulated)`,
    refusal.name === "ScoreTooLow" &&
      typeof refusedValidator === "string" &&
      getAddress(refusedValidator) === validator &&
      typeof refusedHash === "string" &&
      lower(refusedHash as Hex) === requestHash &&
      refusedScore === score &&
      refusedMin === minScore,
    refusal.detail,
  );
}

/** Confirms a sent transaction carried exactly the explicit limit, and came from `from`. */
async function checkSent(label: string, hash: Hash, from: Address, gasLimit: bigint): Promise<void> {
  const tx = await publicClient.getTransaction({ hash });
  const sender = getAddress(tx.from); // the RPC returns it lower-case
  check(`${label} was sent by ${from} with gas limit ${gasLimit}`, sender === from && tx.gas === gasLimit, `${sender}, ${tx.gas}`);
}

/** Prints a validator's log entries, indented and labelled. Entries never carry keys or URLs. */
const logAs = (name: string) => (entry: Record<string, unknown>) => console.log(`    ${name}: ${json(entry)}`);

/** Both validators as their services run them, for the vault and agent 1984 only (live-validators.ts). */
const live = liveValidators({ publicClient, walletFor, chainId: chain.id, validatorA, validatorB, vault, agentId, llm: LLM, nansenApiKey: process.env.NANSEN_API_KEY });
const { nansen, responseGas } = live;
const mandateValidator = (fromBlock: bigint, name: string): MandateValidator => live.mandate(fromBlock, logAs(name));
const riskValidator = (fromBlock: bigint, name: string, clients: { llm: ChatClient; guard: ChatClient }): RiskValidator =>
  live.risk(fromBlock, clients, logAs(name));

/** The evidence document a response posted, as decoded text from its inline `data:` URI. */
function evidenceText(label: string, responseURI: string): string {
  const decoded = decodeJsonDataUri(responseURI, MAX_EVIDENCE_URI_BYTES);
  if (!decoded.ok) throw new Error(`${label}'s response URI is not inline JSON: ${decoded.reason}`);
  return decoded.text;
}

/** A `mandate-v1` evidence document, read only for the fields the run checks. */
function postedMandateEvidence(
  label: string,
  responseURI: string,
): { reasons?: unknown; spend?: { total?: unknown; entries?: { requestHash: string; counted: boolean }[] } } {
  return JSON.parse(evidenceText(label, responseURI)) as ReturnType<typeof postedMandateEvidence>;
}

/** A `risk-v1` evidence document, parsed strictly, with its size: canonical JSON bytes and the `data:` URI's length. */
function postedRiskEvidence(label: string, responseURI: string): { doc: RiskEvidence; jsonBytes: number; uriBytes: number } {
  const text = evidenceText(label, responseURI);
  const parsed = parseRiskEvidence(text);
  if (!parsed.ok) throw new Error(`${label}'s evidence is not risk-v1 evidence: ${parsed.error}`);
  return { doc: parsed.doc, jsonBytes: stringToBytes(text).length, uriBytes: stringToBytes(responseURI).length };
}

/** The forwarder's estimate for the request the SDK is about to send, from the hot key (the SDK checks it again). */
async function estimateRequest(action: Action, validator: Address): Promise<bigint> {
  const request = buildRequestJson({ chainId: chain.id, gate: vault, validator, action });
  return publicClient.estimateContractGas({
    address: forwarder,
    abi: agentRequestForwarderAbi,
    functionName: "request",
    args: [validator, agentId, encodeJsonDataUri(request).uri, requestHashOfJson(request)],
    account: hotKey.address,
  });
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
    passThroughCode,
    passThroughSink,
    validatorABalance,
    validatorBBalance,
    hotBalance,
    ownerBalance,
    vaultBalance,
    fees,
    latest,
    inboxKey,
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
    publicClient.getCode({ address: passThrough }),
    publicClient.readContract({ address: passThrough, abi: passThroughAbi, functionName: "sink" }),
    publicClient.getBalance({ address: validatorA.address }),
    publicClient.getBalance({ address: validatorB.address }),
    publicClient.getBalance({ address: hotKey.address }),
    publicClient.getBalance({ address: owner.address }),
    publicClient.getBalance({ address: vault }),
    publicClient.estimateFeesPerGas(),
    publicClient.getBlock(),
    publicClient.readContract({ address: mandateRegistry, abi: mandateRegistryAbi, functionName: "inboxKeyOf", args: [agentId] }),
  ]);

  // Validator B's two model clients, each with its own free-tier pacer, as the service builds them. Built before
  // anything is sent, so a malformed LLM_BASE_URL stops the run here; nothing is called until B's first check.
  const llm = live.llm;
  const guardClient = live.guard;

  console.log(`DemoAgentVault        ${vault} (chain ${chain.id})`);
  console.log(`AgentRequestForwarder ${forwarder}`);
  console.log(`ValidationRegistry    ${registry}`);
  console.log(`MandateRegistry       ${mandateRegistry}`);
  console.log(`agent                 ${agentId}, owner ${owner.address} (deployer), hot key ${hotKey.address}`);
  console.log(`validator A           ${validatorA.address} (${MANDATE_V1.tag})`);
  console.log(`validator B           ${validatorB.address} (${RISK_V1.tag})`);
  console.log(`B's model             ${LLM.model} at ${llm.host}; guard ${RISK_V1.guardModel}`);
  console.log(`B's pacing            main ${LLM.pacing.requestsPerMinute} RPM / ${LLM.pacing.tokensPerMinute} TPM, guard ${GUARD_PACING.requestsPerMinute} RPM / ${GUARD_PACING.tokensPerMinute} TPM`);
  console.log(`B's Nansen            ${nansen.available ? "available" : `unavailable (${nansen.reason})`}`);
  console.log(`pass-through          ${passThrough} (forwards to sink ${SINK})`);
  console.log(`unlisted target       ${UNLISTED}\n`);
  console.log("preflight");
  check(
    `validator A's key is the recorded validator A (${deployment.validators.mandateV1})`,
    validatorA.address === getAddress(deployment.validators.mandateV1),
    validatorA.address,
  );
  check(
    `validator B's key is the recorded validator B (${deployment.validators.riskV1})`,
    validatorB.address === getAddress(deployment.validators.riskV1),
    validatorB.address,
  );
  check("vault reads the ValidationRegistry", getAddress(vaultRegistry) === registry, vaultRegistry);
  check(`vault is bound to agent ${agentId}`, vaultAgent === agentId, String(vaultAgent));
  const [requirementA, requirementB] = requirements;
  check(
    `vault requires exactly validator A at ${MIN_SCORE_A} under ${MANDATE_V1.tag}, then validator B at ${MIN_SCORE_B} under ${RISK_V1.tag}`,
    requirements.length === 2 &&
      requirementA !== undefined &&
      getAddress(requirementA.validator) === validatorA.address &&
      requirementA.minScore === MIN_SCORE_A &&
      requirementA.tagHash === keccak256(toBytes(MANDATE_V1.tag)) &&
      requirementB !== undefined &&
      getAddress(requirementB.validator) === validatorB.address &&
      requirementB.minScore === MIN_SCORE_B &&
      requirementB.tagHash === keccak256(toBytes(RISK_V1.tag)),
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
  const targets = mandate.allowedTargets.map((target) => getAddress(target));
  check(
    "the mandate is the e2e one: the deployer and the DemoPassThrough only, plain transfers, 0.002 MON per tx, 0.005 MON per day",
    targets.length === 2 &&
      targets.includes(owner.address) &&
      targets.includes(passThrough) &&
      json(mandate.allowedSelectors.map((s) => s.toLowerCase())) === json(E2E_MANDATE.allowedSelectors) &&
      mandate.maxValuePerTx === E2E_MANDATE.maxValuePerTx &&
      mandate.maxValuePerDay === E2E_MANDATE.maxValuePerDay,
    json(mandate),
  );
  check("the DemoPassThrough has code", passThroughCode !== undefined && passThroughCode !== "0x", "no code");
  check(`the DemoPassThrough forwards to ${SINK}`, getAddress(passThroughSink) === SINK, passThroughSink);
  // Operator reports (P7): on when agent 1984 has an inbox key and a FindingsBoard is recorded. Then each validator
  // also pays for its three reports, so its floor grows by three reports at the cap and the current max fee.
  const reports = reportsExpected({ inboxKey, findingsBoard: (deployment as Deployment).findingsBoard });
  console.log(`  ${reports.line}`);
  const reportNote = reports.expected ? " (its floor plus three reports at OPERATOR_REPORT_GAS_CAP and the max fee)" : "";
  const needA = validatorNeed({ floor: MIN_VALIDATOR_A_BALANCE, reports: reports.expected, maxFeePerGas: fees.maxFeePerGas });
  const needB = validatorNeed({ floor: MIN_VALIDATOR_B_BALANCE, reports: reports.expected, maxFeePerGas: fees.maxFeePerGas });
  check(`validator A holds at least ${mon(needA)}${reportNote}`, validatorABalance >= needA, mon(validatorABalance));
  check(`validator B holds at least ${mon(needB)}${reportNote}`, validatorBBalance >= needB, mon(validatorBBalance));
  const requestsCost = REQUESTS * DEFAULT_GAS.forwarderRequest * fees.maxFeePerGas;
  check(`the hot key can pay for ${REQUESTS} requests (${mon(requestsCost)})`, hotBalance >= requestsCost, mon(hotBalance));
  // The deployer pays for the vault's top-up (if any) and execute(S).
  const deployerCost = deployerNeed({
    vaultBalance,
    fundBelow: FUND_BELOW,
    fundTarget: FUND_TARGET,
    fundGas: GAS.fund,
    executeGas: GAS.execute,
    maxFeePerGas: fees.maxFeePerGas,
    marginPercent: DEPLOYER_GAS_MARGIN_PERCENT,
  });
  const deployerShort = deployerShortfall({ held: ownerBalance, need: deployerCost, marginPercent: DEPLOYER_GAS_MARGIN_PERCENT });
  if (deployerShort !== null) throw new Error(`check failed: ${deployerShort}`);
  check(
    `the deployer can pay for the vault top-up and execute(S) (${mon(deployerCost.total)} with a ${DEPLOYER_GAS_MARGIN_PERCENT}% gas margin)`,
    ownerBalance >= deployerCost.total,
    mon(ownerBalance),
  );
  // risk-v1's recent_permission_events would show a MandateSet from the last window: S could get a finding for it.
  const permissionWait = permissionWindowWait({
    agentId,
    latestBlock: latest.number,
    setAtBlock,
    windowBlocks: MANDATE_V1.permissionWindowBlocks,
    msPerBlock: MS_PER_BLOCK,
  });
  if (permissionWait !== null) throw new Error(`check failed: ${permissionWait}`);
  check(
    `the mandate was set at least ${MANDATE_V1.permissionWindowBlocks} blocks ago (block ${setAtBlock}, latest ${latest.number})`,
    latest.number - setAtBlock >= MANDATE_V1.permissionWindowBlocks,
    String(latest.number - setAtBlock),
  );
  // Validator B's endpoint and key, without spending a token: GET /models, never a completion.
  const endpoint = await checkModelsEndpoint({
    baseUrl: LLM.baseUrl,
    apiKey: LLM.apiKey,
    models: [LLM.model, RISK_V1.guardModel],
    fetch,
    timeoutMs: LLM_PREFLIGHT_TIMEOUT_MS,
  });
  if (!endpoint.ok) throw new Error(`check failed: ${endpoint.message}`);
  check(
    endpoint.listed
      ? `B's LLM endpoint answered GET /models and lists ${LLM.model} and ${RISK_V1.guardModel}`
      : "B's LLM endpoint answered GET /models (its answer isn't a model listing, so the models weren't checked)",
    true,
    "",
  );

  // The daily cap, before anything is sent: agent 1984's counted spend as mandate-v1 reads it (the same collector),
  // at the finalized head. S and R must both still fit under the cap (A checks R with S's approval counted), or
  // every later check would fail.
  const spendReader = viemMandateReader({ publicClient, contracts, concurrency: READER_CONCURRENCY });
  const spendHead = await spendReader.finalized();
  const spend = await collectSpend({ reader: spendReader, validator: validatorA.address, agentId, pinned: spendHead, cache: new Map() });
  if ("unreadable" in spend) throw new Error(`check failed: agent ${agentId}'s spend is unreadable at block ${spendHead.number} (${spend.unreadable})`);
  const counted0 = spend.entries.filter((entry) => entry.counted).length;
  console.log(`  agent ${agentId}'s counted ${MANDATE_V1.tag} spend at block ${spendHead.number}: ${mon(spend.total)} (${counted0} approval(s))`);
  const shortfall = dailyCapShortfall({ spend, inMandateValues: [VALUE_S, VALUE_R], maxValuePerDay: mandate.maxValuePerDay });
  if (shortfall !== null) throw new Error(`check failed: ${shortfall}`);
  check(
    `S and R (${mon(VALUE_S + VALUE_R)}) fit under the daily cap (${mon(spend.total)} of ${mon(mandate.maxValuePerDay)} counted)`,
    spend.total + VALUE_S + VALUE_R <= mandate.maxValuePerDay,
    mon(spend.total),
  );

  // 2. Fund the vault if it can't cover all three actions (each is simulated at its own pinned block, before S executes).
  const txs: Record<string, Hash> = {};
  const ownerWallet = walletFor(owner);
  let fundGas: { estimate: bigint; limit: bigint } | undefined;
  if (vaultBalance < FUND_BELOW) {
    const sent = await sendWithGasGuard({
      publicClient,
      walletClient: ownerWallet,
      to: vault,
      value: FUND_TARGET - vaultBalance,
      gasLimit: GAS.fund,
      label: "fund vault",
    });
    printTx("fund vault", sent);
    await checkSent("fund vault", sent.hash, owner.address, GAS.fund);
    txs.fund = sent.hash;
    fundGas = { estimate: sent.estimate, limit: sent.gasLimit };
  }
  const balanceBefore = await publicClient.getBalance({ address: vault });
  console.log(`  vault balance ${mon(balanceBefore)}`);
  check(`the vault holds at least ${mon(FUND_BELOW)}`, balanceBefore >= FUND_BELOW, mon(balanceBefore));

  // 3. The actions.
  const deadline = (await publicClient.getBlock()).timestamp + DEADLINE_SECONDS;
  const actions: Record<Label, Action> = {
    S: buildAction({ agentId, target: owner.address, value: VALUE_S, deadline }),
    R: buildAction({ agentId, target: passThrough, value: VALUE_R, deadline }),
    O: buildAction({ agentId, target: UNLISTED, value: VALUE_O, deadline }),
  };
  const actionHashes = Object.fromEntries(
    LABELS.map((label) => [label, computeActionHash({ chainId: chain.id, gate: vault, action: actions[label] })]),
  ) as Record<Label, Hex>;

  // 4. Only the agent's own key may request through the forwarder.
  console.log("\nforwarder refusals");
  const forwarded = (args: readonly unknown[]) =>
    ({ address: forwarder, abi: agentRequestForwarderAbi, functionName: "request", args }) as const;
  const sample = [validatorA.address, agentId, "data:application/json,{}", actionHashes.S] as const;
  await expectRevert("the owner calling forwarder.request", forwarded(sample), owner.address, "NotAgentKey");
  await expectRevert(`agent ${otherAgentId}'s hot key requesting for agent ${agentId}`, forwarded(sample), otherHotKey, "NotAgentKey");

  // 5. The hot key requests validation of every action from A, then B, through the forwarder, before any validator runs.
  console.log("\nrequests (agent hot key -> forwarder -> registry)");
  const client = new Attest8004Client({
    publicClient,
    walletClient: walletFor(hotKey),
    validationRegistry: registry,
    forwarder,
  });
  const validatorOf: Record<Side, Address> = { A: validatorA.address, B: validatorB.address };
  const requests = new Map<string, RequestedValidation & { estimate: bigint }>();
  for (const label of LABELS) {
    for (const side of ["A", "B"] as const) {
      const estimate = await estimateRequest(actions[label], validatorOf[side]);
      check(
        `${label} -> ${side}: the forwarder's estimate is within DEFAULT_GAS.forwarderRequest`,
        estimate <= DEFAULT_GAS.forwarderRequest,
        `${estimate} > ${DEFAULT_GAS.forwarderRequest}`,
      );
      const [requested] = await client.requestValidation({ gate: vault, validators: [validatorOf[side]], action: actions[label] });
      if (!requested) throw new Error(`requestValidation returned nothing for ${label} -> ${side}`);
      requests.set(`${label}${side}`, { ...requested, estimate });
      txs[`request${label}${side}`] = requested.txHash;
      console.log(
        `forwarder.request (${label} -> ${side})  ${requested.txHash}  block ${requested.blockNumber}, gas limit ${DEFAULT_GAS.forwarderRequest} (estimate ${estimate})`,
      );
    }
  }
  const req = (label: Label, side: Side) => {
    const found = requests.get(`${label}${side}`);
    if (!found) throw new Error(`no request recorded for ${label} -> ${side}`);
    return found;
  };
  const hashOf = (label: Label, side: Side) => lower(req(label, side).requestHash);
  for (const label of LABELS) {
    for (const side of ["A", "B"] as const) {
      const requested = req(label, side);
      const [onchainRequestHash, status] = await Promise.all([
        publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "requestHashOf", args: [actions[label], validatorOf[side]] }),
        publicClient.readContract({
          address: registry,
          abi: validationRegistryAbi,
          functionName: "getValidationStatus",
          args: [requested.requestHash],
        }),
      ]);
      check(`${label} -> ${side}: the SDK's requestHash equals the vault's`, requested.requestHash === onchainRequestHash, onchainRequestHash);
      check(
        `${label} -> ${side}: the registry recorded validator ${side} and agent ${agentId}`,
        status[0] === validatorOf[side] && status[1] === agentId,
        `${status[0]}, ${status[1]}`,
      );
      await checkSent(`${label} -> ${side}'s request`, requested.txHash, hotKey.address, DEFAULT_GAS.forwarderRequest);
    }
  }
  const firstBlock = req("S", "A").blockNumber;
  const hashesA = LABELS.map((label) => hashOf(label, "A"));
  const hashesB = LABELS.map((label) => hashOf(label, "B"));

  // 6. Both validators answer their three, concurrently.
  console.log(
    `\nvalidators (${MANDATE_V1.tag} and ${RISK_V1.tag} on the SDK's ValidatorBase, polling eth_getLogs up to the finalized block; ` +
      `${RISK_V1.tag} waits for ${MANDATE_V1.tag}'s verdict on the same action, then takes a few minutes per check)`,
  );
  const mainModel = counted(llm);
  const guardModel = counted(guardClient);
  const outcomes = await pollAll(
    [
      { name: "A", validator: mandateValidator(firstBlock, "A"), requestHashes: hashesA },
      { name: "B", validator: riskValidator(firstBlock, "B", { llm: mainModel.client, guard: guardModel.client }), requestHashes: hashesB },
    ],
    TIMEOUT_MS,
    `the shared ${TIMEOUT_MS / 60_000}-minute deadline`,
  );
  const outcome = (label: Label, side: Side) => outcomes.get(hashOf(label, side));
  // Each validator answered each of its requests (a decline is printed with its reason); the scores are checked
  // below, after each verdict's evidence is printed, so a wrong score still shows why.
  console.log("\nresponses");
  const pairs = LABELS.flatMap((label) => (["A", "B"] as const).map((side) => [label, side] as const));
  for (const [label, side] of pairs) {
    const found = outcome(label, side);
    check(`${side} answered ${label}`, found?.kind === "responded", json(found));
  }

  /**
   * Each request's encrypted operator report, found the way /inbox finds it (the SDK's discovery: the agent's six
   * newest verdicts, then FindingsPosted near each, kept by the trust rule): exactly one per request when reports are
   * on, none when they are off. The run can't decrypt them (no passkey); /inbox does, in person.
   */
  const checkReports = async (heading: string): Promise<void> => {
    console.log(`\n${heading}`);
    const board = (deployment as Deployment).findingsBoard;
    const discover = async () =>
      board === null ? [] : await findInboxEntries(viemInboxReader({ publicClient, deployment }), { agentId, findingsBoard: board, knownValidators: knownValidatorsOf(deployment as Deployment), maxResponses: 6 });
    // The last report lands moments before this runs: a node a block or two behind would answer short, so a missing
    // report is looked for again (up to 4 tries, 5 s apart) before it fails the run.
    const complete = (found: Awaited<ReturnType<typeof discover>>) =>
      !reports.expected || pairs.every(([label, side]) => found.find((e) => e.status.requestHash === hashOf(label, side))?.posts.length === 1);
    const entries = await retryUntil(discover, complete, { attempts: REPORT_DISCOVERY_ATTEMPTS, delayMs: REPORT_DISCOVERY_DELAY_MS });
    for (const [label, side] of pairs) {
      const entry = entries.find((e) => e.status.requestHash === hashOf(label, side));
      const posts = entry?.posts ?? [];
      if (!reports.expected) {
        check(`${label} <- ${side}: no report (reports are off)`, posts.length === 0, String(posts.length));
        continue;
      }
      const post = posts[0];
      check(`${label} <- ${side}: exactly one trusted report`, entry !== undefined && posts.length === 1 && post !== undefined, String(posts.length));
      if (post === undefined) throw new Error("unreachable");
      const bytes = (post.envelope.length - 2) / 2;
      check(
        `${label} <- ${side}'s report is a version-${ENVELOPE_VERSION} envelope of ${ENVELOPE_OVERHEAD_BYTES + 1} to ${MAX_ENVELOPE_BYTES} bytes`,
        post.envelope.slice(0, 4) === "0x01" && bytes > ENVELOPE_OVERHEAD_BYTES && bytes <= MAX_ENVELOPE_BYTES,
        `${post.envelope.slice(0, 4)}, ${bytes} bytes`,
      );
      const tx = await publicClient.getTransaction({ hash: post.txHash });
      check(
        `${label} <- ${side}'s report was sent by ${validatorOf[side]} with a gas limit at most ${OPERATOR_REPORT_GAS_CAP}`,
        getAddress(tx.from) === validatorOf[side] && tx.gas <= OPERATOR_REPORT_GAS_CAP,
        `${tx.from}, ${tx.gas}`,
      );
      console.log(`report (${label} <- ${side}) ${post.txHash}  block ${post.blockNumber}, gas limit ${tx.gas}, envelope ${bytes} bytes`);
      txs[`report${label}${side}`] = post.txHash;
    }
  };
  await checkReports("operator reports (found as /inbox finds them: the agent's verdicts, then FindingsPosted kept by the trust rule)");

  // Every response, read back: who sent it, its limit, and Monad's estimate for it; then the SDK's awaitVerdict for
  // each, scanning from its request's block (all six at once: B's responses land minutes after the requests).
  for (const [label, side] of pairs) {
    const found = outcome(label, side);
    if (found?.kind !== "responded") throw new Error("unreachable");
    const gas = responseGas.get(lower(found.requestHash));
    if (!gas) throw new Error(`no gas recorded for ${label} -> ${side}'s response`);
    const max = side === "A" ? MANDATE_RESPONSE_GAS.max : RISK_RESPONSE_GAS.max;
    txs[`response${label}${side}`] = found.txHash;
    console.log(
      `validationResponse (${label} <- ${side}) ${found.txHash}  block ${found.blockNumber}, gas limit ${gas.limit} (estimate ${gas.estimate})`,
    );
    check(`${label} <- ${side}'s response limit is at most ${max}`, gas.limit <= max, String(gas.limit));
    await checkSent(`${label} <- ${side}'s response`, found.txHash, validatorOf[side], gas.limit);
  }
  const awaited = await Promise.all(
    pairs.map(([label, side]) => client.awaitVerdict({ requestHash: hashOf(label, side), fromBlock: req(label, side).blockNumber, timeoutMs: 60_000 })),
  );
  const verdicts = new Map<string, Verdict>();
  for (const [i, [label, side]] of pairs.entries()) {
    const found = outcome(label, side);
    const verdict = awaited[i];
    if (found?.kind !== "responded" || verdict === undefined) throw new Error("unreachable");
    const tag = side === "A" ? MANDATE_V1.tag : RISK_V1.tag;
    check(
      `awaitVerdict ${label} <- ${side}: ${found.score} from validator ${side}, tag ${tag}`,
      verdict.response === found.score && verdict.validator === validatorOf[side] && verdict.tag === tag,
      json({ response: verdict.response, validator: verdict.validator, tag: verdict.tag }),
    );
    verdicts.set(`${label}${side}`, verdict);
  }
  const verdictOf = (label: Label, side: Side) => {
    const found = verdicts.get(`${label}${side}`);
    if (!found) throw new Error(`no verdict recorded for ${label} <- ${side}`);
    return found;
  };

  // Both validators' verdicts and evidence are printed first, before any score is asserted, so a failed check
  // still leaves everything on screen: A's reasons, and B's findings, models, tokens and sizes.
  console.log(`\n${MANDATE_V1.tag} verdicts (validator A)`);
  const mandateDocs = new Map<Label, ReturnType<typeof postedMandateEvidence>>();
  for (const label of LABELS) {
    const evidence = postedMandateEvidence(`${label} <- A`, verdictOf(label, "A").responseURI);
    mandateDocs.set(label, evidence);
    console.log(
      `  ${label} <- A: score ${verdictOf(label, "A").response}, reasons ${json(evidence.reasons)}, counted spend ${json(evidence.spend?.total)}`,
    );
  }

  console.log(`\n${RISK_V1.tag} verdicts (validator B)`);
  const riskDocs = new Map<Label, ReturnType<typeof postedRiskEvidence>>();
  for (const label of LABELS) {
    const evidence = postedRiskEvidence(`${label} <- B`, verdictOf(label, "B").responseURI);
    riskDocs.set(label, evidence);
    const { doc } = evidence;
    const gas = responseGas.get(hashOf(label, "B"));
    const flagged = doc.classifier.results.filter((result) => result.flagged).length;
    console.log(`  ${label} <- B: score ${doc.score}, reasons ${json(doc.reasons)}, pinned block ${doc.block.number}`);
    console.log(`    prerequisite: ${MANDATE_V1.tag} ${doc.prerequisite.score} on ${doc.prerequisite.requestHash}, reasons ${json(doc.prerequisite.reasons)}`);
    console.log(
      `    model: requested ${doc.llm.model} at ${doc.llm.host}, served ${json(doc.llm.servedModels)}, fingerprints ${json(doc.llm.systemFingerprints)}, ` +
        `prompt ${doc.llm.promptVersion}, ${doc.modelOutputs.length} model call(s), final answer after ${doc.finalOutput.attempts} attempt(s)`,
    );
    console.log(`    tokens: prompt ${doc.llm.usage.prompt}, completion ${doc.llm.usage.completion}, total ${doc.llm.usage.total}`);
    console.log(
      `    tools: ${doc.toolCalls.length} call(s) ${json(doc.toolCalls.map((call) => call.name))}; nansen ${doc.tools.nansen.available ? "available" : `unavailable (${doc.tools.nansen.reason})`}; ` +
        `guard: ${doc.classifier.results.length} chunk(s) screened, ${flagged} flagged`,
    );
    console.log(
      `    evidence: ${evidence.jsonBytes} bytes of canonical JSON (limit ${RISK_V1.maxEvidenceBytes}), data: URI ${evidence.uriBytes} bytes; ` +
        `response gas limit ${gas?.limit} (estimate ${gas?.estimate})`,
    );
    if (doc.findings.length === 0) console.log("    findings: none");
    for (const finding of doc.findings) {
      // The explanation is the model's text: printed as a JSON string, so it can't carry terminal control characters.
      console.log(`    finding [${finding.severity}] ${finding.code} (${finding.origin}; sources ${json(finding.sources)}): ${json(finding.explanation)}`);
    }
  }
  console.log(
    `  B's model calls this run: main ${mainModel.stats.calls} (served ${json(mainModel.stats.servedModels)}, ${mainModel.stats.usage.total} tokens), ` +
      `guard ${guardModel.stats.calls} (served ${json(guardModel.stats.servedModels)}, ${guardModel.stats.usage.total} tokens)`,
  );
  const mandateDoc = (label: Label) => {
    const found = mandateDocs.get(label);
    if (!found) throw new Error(`no evidence recorded for ${label} <- A`);
    return found;
  };
  const riskDoc = (label: Label) => {
    const found = riskDocs.get(label);
    if (!found) throw new Error(`no evidence recorded for ${label} <- B`);
    return found.doc;
  };

  // A: S and R pass cleanly; O's reasons follow from O's own spend, which counts S and R.
  console.log(`\n${MANDATE_V1.tag} checks`);
  for (const [label, score] of [
    ["S", 100],
    ["R", 100],
  ] as const) {
    const { reasons } = mandateDoc(label);
    check(`A on ${label}: ${score}, reasons []`, verdictOf(label, "A").response === score && json(reasons) === "[]", json(reasons));
  }
  const evidenceOA = mandateDoc("O");
  check("A on O: 0", verdictOf("O", "A").response === 0, String(verdictOf("O", "A").response));
  const spendTotalO = evidenceOA.spend?.total;
  check("O <- A's evidence: a readable spend total", typeof spendTotalO === "string" && /^(0|[1-9]\d*)$/.test(spendTotalO), json(evidenceOA.spend));
  for (const label of ["S", "R"] as const) {
    const spent = evidenceOA.spend?.entries?.find((entry) => entry.requestHash.toLowerCase() === hashOf(label, "A"));
    check(`O <- A's evidence: its spend counts ${label}`, spent?.counted === true, json(evidenceOA.spend));
  }
  const reasonsO = expectedReasonsO({ spendTotal: BigInt(spendTotalO as string), value: VALUE_O, maxValuePerDay: E2E_MANDATE.maxValuePerDay });
  check(
    `O <- A's evidence: reasons ${json(reasonsO)} (spend ${mon(BigInt(spendTotalO as string))} + ${mon(VALUE_O)}, cap ${mon(E2E_MANDATE.maxValuePerDay)})`,
    json(evidenceOA.reasons) === json(reasonsO),
    json(evidenceOA.reasons),
  );

  // B: each verdict ran on A's verdict for the same action; then the scores.
  console.log(`\n${RISK_V1.tag} checks`);
  for (const label of LABELS) {
    const doc = riskDoc(label);
    const verdict = verdictOf(label, "B");
    check(`${label} <- B's evidence: the score is the posted ${verdict.response}`, doc.score === verdict.response, String(doc.score));
    check(
      `${label} <- B's evidence: it ran on A's verdict on the same action (${verdictOf(label, "A").response})`,
      lower(doc.prerequisite.requestHash) === hashOf(label, "A") && doc.prerequisite.score === verdictOf(label, "A").response,
      json(doc.prerequisite),
    );
  }
  check(`B on S: at least ${MIN_SCORE_B}`, verdictOf("S", "B").response >= MIN_SCORE_B, String(verdictOf("S", "B").response));
  const findingsR = riskDoc("R").findings;
  check(
    "B on R: 0, with at least one high finding",
    verdictOf("R", "B").response === 0 && findingsR.some((finding) => finding.severity === "high"),
    json({ score: verdictOf("R", "B").response, findings: findingsR.map((finding) => `${finding.severity} ${finding.code}`) }),
  );
  console.log(`  B on O: ${verdictOf("O", "B").response} (not asserted: B runs on O to explain A's refusal)`);

  // 7. The gate refuses R at B and O at A (A's requirement is checked first).
  console.log("\nrefusals (simulated)");
  await expectScoreTooLow("R", actions.R, validatorB.address, hashOf("R", "B"), 0, MIN_SCORE_B);
  await expectScoreTooLow("O", actions.O, validatorA.address, hashOf("O", "A"), 0, MIN_SCORE_A);
  check("isValidated(R) is false", !(await client.isValidated({ gate: vault, action: actions.R })), "true");
  check("isValidated(O) is false", !(await client.isValidated({ gate: vault, action: actions.O })), "true");

  console.log("\nrestart (fresh validators re-read the same blocks)");
  // The restart check must leave execute(S) its time before S's deadline (chain time).
  const restartAt = await publicClient.getBlock();
  const restart = restartBudget({
    deadline: actions.S.deadline,
    now: restartAt.timestamp,
    executeMarginSeconds: EXECUTE_MARGIN_SECONDS,
    maxMs: RESTART_TIMEOUT_MS,
  });
  if (!restart.ok) throw new Error(`check failed: ${restart.message}`);
  const restartModel = counted(llm);
  const restartGuard = counted(guardClient);
  const again = await pollAll(
    [
      { name: "A (restarted)", validator: mandateValidator(firstBlock, "A (restarted)"), requestHashes: hashesA },
      {
        name: "B (restarted)",
        validator: riskValidator(firstBlock, "B (restarted)", { llm: restartModel.client, guard: restartGuard.client }),
        requestHashes: hashesB,
      },
    ],
    restart.ms,
    `the restart's ${restart.ms} ms (S's deadline minus ${EXECUTE_MARGIN_SECONDS} s for execute(S), at most ${RESTART_TIMEOUT_MS} ms)`,
  );
  for (const label of LABELS) {
    for (const side of ["A", "B"] as const) {
      const found = again.get(hashOf(label, side));
      check(
        `the restarted validator ${side} skips ${label}: ALREADY_RESPONDED`,
        found?.kind === "skipped" && found.reason === "ALREADY_RESPONDED",
        json(found),
      );
    }
  }
  check(
    "the restarted validator B made no model or guard call",
    restartModel.stats.calls === 0 && restartGuard.stats.calls === 0,
    `main ${restartModel.stats.calls}, guard ${restartGuard.stats.calls}`,
  );
  const head = await publicClient.getBlockNumber();
  const responses = [];
  for (const window of blockWindows(firstBlock, head)) {
    responses.push(
      ...(await publicClient.getLogs({ address: registry, event: validationResponseEvent, args: { requestHash: [...hashesA, ...hashesB] }, ...window })),
    );
  }
  for (const label of LABELS) {
    for (const side of ["A", "B"] as const) {
      const count = responses.filter((log) => log.args.requestHash?.toLowerCase() === hashOf(label, side)).length;
      check(`exactly one ValidationResponse for ${label} <- ${side}`, count === 1, String(count));
    }
  }

  // 8. Anyone may execute the approved action.
  console.log("\nexecute S");
  const tooLate = executeTimeLeft({ deadline: actions.S.deadline, now: (await publicClient.getBlock()).timestamp, minSeconds: EXECUTE_MIN_SECONDS });
  if (tooLate !== null) throw new Error(`check failed: ${tooLate}`);
  check("isValidated(S) before execute (both verdicts, both tags)", await client.isValidated({ gate: vault, action: actions.S }), "false");
  const executed = await writeWithGasGuard({
    publicClient,
    walletClient: ownerWallet,
    address: vault,
    abi: vaultAbi,
    functionName: "execute",
    args: [actions.S],
    gasLimit: GAS.execute,
    label: "execute",
  });
  printTx("execute (S)", executed);
  txs.execute = executed.hash;
  await checkSent("execute", executed.hash, owner.address, GAS.execute);

  const consumedLogs = parseEventLogs({ abi: vaultAbi, eventName: "ActionConsumed", logs: executed.receipt.logs }).filter(
    (log) => getAddress(log.address) === vault,
  );
  check(
    `ActionConsumed(actionHash S, ${agentId}) emitted by the vault`,
    consumedLogs.length === 1 && consumedLogs[0]?.args.actionHash === actionHashes.S && consumedLogs[0].args.agentId === agentId,
    `${consumedLogs.length} log(s)`,
  );
  const balanceAfter = await publicClient.getBalance({ address: vault });
  check("vault balance fell by exactly S's value", balanceBefore - balanceAfter === VALUE_S, `${balanceBefore} -> ${balanceAfter}`);
  const consumed = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "consumed", args: [actionHashes.S] });
  check("consumed(actionHash S) is true", consumed, String(consumed));
  await expectRevert("a replay of S", { address: vault, abi: vaultAbi, functionName: "execute", args: [actions.S] }, owner.address, "ActionAlreadyConsumed");
  check("isValidated(S) after execute is false", !(await client.isValidated({ gate: vault, action: actions.S })), "true");

  // After the restart (which answered nothing), still exactly one report per request: checked here, after execute(S),
  // so the discovery's reads never eat into S's deadline margin.
  await checkReports("operator reports after the restart (still exactly one per request)");

  // 9. verify: A's verdicts re-run at their pinned blocks; B's re-checked from their evidence and the chain.
  console.log(`\nverify ${MANDATE_V1.tag} (a fresh reader and an empty cache per verdict)`);
  const reportsA: Partial<Record<Label, VerifyReport>> = {};
  for (const label of LABELS) {
    const verdict = verdictOf(label, "A");
    const report = await verifyRequest({
      reader: viemMandateReader({ publicClient, contracts, concurrency: READER_CONCURRENCY }),
      requestHash: hashOf(label, "A"),
      ...verifyContextFor(chain.id),
    });
    reportsA[label] = report;
    const detail = json({ verdict: report.verdict, problems: report.problems, differingKeys: report.differingKeys });
    check(`verify ${label} <- A: match (P = block ${report.pinnedBlock})`, report.verdict === "match", detail);
    check(
      `verify ${label} <- A: the recomputed score equals the posted ${verdict.response}`,
      report.recomputed?.score === verdict.response && report.posted.score === verdict.response,
      json(report.recomputed),
    );
    check(
      `verify ${label} <- A: the recomputed responseHash equals the onchain one`,
      report.recomputed?.responseHash === lower(verdict.responseHash),
      `${report.recomputed?.responseHash} vs ${verdict.responseHash}`,
    );
  }
  check(
    `verify O <- A: the recomputed reasons are ${json(reasonsO)}`,
    json(reportsA.O?.recomputed?.reasons) === json(reasonsO),
    json(reportsA.O?.recomputed?.reasons),
  );

  console.log(`\nverify ${RISK_V1.tag} (a fresh reader per verdict; model output: recorded, not re-run)`);
  const riskContext = { ...verifyContextFor(chain.id), contracts: riskContracts, mandateValidator: getAddress(deployment.validators.mandateV1) };
  const reportsB: Partial<Record<Label, RiskVerifyReport>> = {};
  for (const label of LABELS) {
    const verdict = verdictOf(label, "B");
    const report = await verifyRiskRequest({
      reader: viemRiskReader({ publicClient, contracts: riskContracts, concurrency: READER_CONCURRENCY }),
      requestHash: hashOf(label, "B"),
      context: riskContext,
    });
    reportsB[label] = report;
    const detail = json({ verdict: report.verdict, problems: report.problems, mismatchedToolCalls: report.mismatchedToolCalls });
    check(
      `verify ${label} <- B: match (P = block ${report.pinnedBlock}; ${report.checkedToolCalls.length} onchain tool call(s) re-run, ` +
        `${report.uncheckedToolCalls.length} Nansen call(s) unchecked)`,
      report.verdict === "match",
      detail,
    );
    check(
      `verify ${label} <- B: the recomputed score equals the posted ${verdict.response}`,
      report.recomputed?.score === verdict.response && report.posted.score === verdict.response,
      json(report.recomputed),
    );
    check(
      `verify ${label} <- B: the recomputed reasons are the evidence's`,
      json(report.recomputed?.reasons) === json(riskDocs.get(label)?.doc.reasons),
      json(report.recomputed?.reasons),
    );
    check(
      `verify ${label} <- B: the responseHash is the onchain one`,
      report.posted.responseHash === lower(verdict.responseHash),
      `${report.posted.responseHash} vs ${verdict.responseHash}`,
    );
  }

  console.log("\ne2e OK");
  const gasOf = (label: Label, side: Side) => {
    const gas = responseGas.get(hashOf(label, side));
    return { estimate: gas?.estimate, limit: gas?.limit };
  };
  const perAction = <T>(f: (label: Label) => T) => Object.fromEntries(LABELS.map((label) => [label, f(label)])) as Record<Label, T>;
  console.log(
    json(
      {
        chainId: chain.id,
        vault,
        forwarder,
        validationRegistry: registry,
        mandateRegistry,
        passThrough,
        sink: SINK,
        agentId,
        hotKey: hotKey.address,
        validators: { A: validatorA.address, B: validatorB.address },
        actions: perAction((label) => ({
          target: actions[label].target,
          value: actions[label].value,
          deadline: actions[label].deadline,
          actionHash: actionHashes[label],
          requestHash: { A: hashOf(label, "A"), B: hashOf(label, "B") },
        })),
        verdicts: perAction((label) => {
          const evidence = riskDocs.get(label);
          return {
            A: { score: verdictOf(label, "A").response, pinnedBlock: reportsA[label]?.pinnedBlock },
            B: {
              score: verdictOf(label, "B").response,
              reasons: evidence?.doc.reasons,
              findings: evidence?.doc.findings.map((finding) => ({ code: finding.code, severity: finding.severity, origin: finding.origin })),
              pinnedBlock: evidence?.doc.block.number,
              servedModels: evidence?.doc.llm.servedModels,
              usage: evidence?.doc.llm.usage,
              toolCalls: evidence?.doc.toolCalls.map((call) => call.name),
              evidenceBytes: evidence?.jsonBytes,
              uriBytes: evidence?.uriBytes,
            },
          };
        }),
        blocks: {
          requests: perAction((label) => ({ A: req(label, "A").blockNumber, B: req(label, "B").blockNumber })),
          responses: perAction((label) => ({ A: verdictOf(label, "A").blockNumber, B: verdictOf(label, "B").blockNumber })),
          execute: executed.receipt.blockNumber,
        },
        txs,
        gas: {
          ...(fundGas ? { fund: fundGas } : {}),
          forwarderRequest: perAction((label) => ({
            A: { limit: DEFAULT_GAS.forwarderRequest, estimate: req(label, "A").estimate },
            B: { limit: DEFAULT_GAS.forwarderRequest, estimate: req(label, "B").estimate },
          })),
          validationResponse: perAction((label) => ({ A: gasOf(label, "A"), B: gasOf(label, "B") })),
          execute: { limit: GAS.execute, estimate: executed.estimate },
        },
        llm: { host: llm.host, model: LLM.model, main: mainModel.stats, guard: guardModel.stats, nansen: nansen.available },
        verify: perAction((label) => ({ A: reportsA[label]?.verdict, B: reportsB[label]?.verdict })),
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
