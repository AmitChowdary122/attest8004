/**
 * SPEC §5, scene by scene, for `pnpm demo` (P9): what each scene sends, waits for and prints. Every send carries an
 * explicit gas limit (the SDK's gas guard), every transaction is printed as an explorer link, refusals are simulated
 * and never sent, and every wait is marked for the edit (Decision 23). Each scene re-reads the chain and checks its own
 * preconditions just before it sends anything.
 */
import {
  Attest8004Client,
  approvalChange,
  buildAction,
  buildRequestJson,
  decodeJsonDataUri,
  findInboxEntries,
  mandateRegistryAbi,
  requestHashOfJson,
  sendWithGasGuard,
  viemInboxReader,
  writeWithGasGuard,
  agentRequestForwarderAbi,
  attestGateAbi,
  type Action,
  type Outcome,
  type RequestedValidation,
  type Verdict,
} from "@attest8004/sdk";
import {
  MANDATE_V1,
  MAX_EVIDENCE_URI_BYTES,
  mandateAddressesAt,
  mandateReport,
  mandateRequestOf,
  runMandateV1,
  verifyContextFor,
  verifyRequest,
  viemMandateReader,
} from "@attest8004/validator-mandate";
import { RISK_V1, parseRiskEvidence, riskReport } from "@attest8004/validator-risk";
import { getAddress, parseAbi, parseEther, parseEventLogs, type Account, type Address, type Hash, type Hex } from "viem";
import { approvalProblems } from "./approval-plan.ts";
import { readApprovalChainState, sendMandateApproval } from "./approval-submit.ts";
import { chain, mon, publicClient, walletFor } from "./common.ts";
import type { SceneId } from "./demo-args.ts";
import { DEMO_GAS, DEMO_VALUES, expectedRogueReasons } from "./demo-budget.ts";
import {
  AGENT_ID,
  FORWARDER,
  IDENTITY_REGISTRY,
  MANDATE_CONTRACTS,
  MANDATE_REGISTRY,
  PASS_THROUGH,
  REGISTRY,
  UNKNOWN_TARGET,
  VAULT,
  demoMandate,
  deployment,
  indexedTo,
  mandateSetTx,
  readDemoState,
  traceFrames,
  waitForApproval,
  type DemoEnv,
} from "./demo-chain.ts";
import { demoMandateProblems, sceneBlockers, unexpectedOutcome } from "./demo-state.ts";
import { elapsed, findP256Calls, mandateLines, monShort, narrateLog, palette, plainText, txLine, verdictLines } from "./demo-text.ts";
import { waitCloseLine, waitOpenLine, type Timeline, type WaitKind } from "./demo-timing.ts";
import { GAS, READER_CONCURRENCY, counted, pollAll, revertOf, type LiveValidators } from "./live-validators.ts";
import { checkPermissionWindow } from "./permission-window.ts";
import { retryUntil } from "./e2e-preflight.ts";

export const WEB = "https://attest8004.vercel.app";
/** The vault is topped up to this much when it can't cover the take's actions. */
export const VAULT_FUND_TARGET = parseEther("0.01");
/** How long the validators may take for one scene's two requests (risk-v1's check takes 1-2 minutes on the free tier). */
const VALIDATORS_TIMEOUT_MS = 12 * 60_000;
/** How long the runner waits for you to approve on /approve. */
const APPROVAL_TIMEOUT_MS = 15 * 60_000;
/** Every action expires this long after the latest block (inside both validators' 3,600 s horizon). */
const DEADLINE_SECONDS = 1_800n;
/** mandate-v1 pins this far below the finalized head (validators/mandate/src/validator.ts). */
const PIN_DEPTH = 5n;
const MIN_SCORE_A = 100;
const MIN_SCORE_B = 80;

const vaultAbi = [
  ...attestGateAbi,
  ...parseAbi([
    "struct Action { uint256 agentId; address target; uint256 value; bytes data; uint64 deadline; bytes32 salt; }",
    "function execute(Action action) returns (bytes result)",
  ]),
] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const short = (hash: string) => `${hash.slice(0, 10)}…`;

/** Where the runner prints: plain lines, colour on a TTY, explorer links, and an elapsed ticker that never garbles a line. */
export interface Out {
  line(s?: string): void;
  ok(s: string): void;
  bad(s: string): void;
  dim(s: string): void;
  bold(s: string): void;
  tx(label: string, hash: Hash): void;
  /** On a TTY, redraws `label m:ss` every second until the returned function is called; elsewhere a no-op. */
  ticker(label: string): () => void;
}

export function makeOut(o: { color: boolean; tty: boolean; write: (s: string) => void }): Out {
  const c = palette(o.color);
  let ticking: { label: string; start: number } | null = null;
  const draw = () => {
    if (ticking) o.write(`\r\u001b[2K${c.dim(`  ${ticking.label} ${elapsed(Date.now() - ticking.start)}`)}`);
  };
  const print = (s: string) => {
    if (ticking) o.write("\r\u001b[2K");
    o.write(`${s}\n`);
    draw();
  };
  return {
    line: (s = "") => print(s),
    ok: (s) => print(c.ok(s)),
    bad: (s) => print(c.bad(s)),
    dim: (s) => print(c.dim(s)),
    bold: (s) => print(c.bold(s)),
    tx: (label, hash) => print(txLine(label, hash)),
    ticker(label) {
      if (!o.tty) return () => {};
      ticking = { label, start: Date.now() };
      draw();
      const timer = setInterval(draw, 1_000);
      return () => {
        clearInterval(timer);
        if (ticking) o.write("\r\u001b[2K");
        ticking = null;
      };
    },
  };
}

/** What one run of the runner did, for the summary at the end. */
export interface Take {
  requests: { label: string; requestHash: Hex }[];
  txs: { label: string; hash: Hash }[];
  /** risk-v1's main-model tokens this run (its own counted calls). */
  tokens: number;
  /** The newest block this run wrote to, for scene 4's indexer wait. */
  lastBlock: bigint;
}

export interface SceneContext {
  env: DemoEnv;
  live: LiveValidators;
  out: Out;
  timeline: Timeline;
  fast: boolean;
  approvalsDir: string;
  /** Reads a line on a TTY (aborted by `signal`); `null` off a TTY. */
  ask: ((question: string, signal?: AbortSignal) => Promise<string>) | null;
  take: Take;
}

/** A scene that can't run from the chain's state now; the runner prints the messages and exits 1. */
export class SceneBlocked extends Error {
  readonly blockers: string[];
  constructor(scene: SceneId, blockers: string[]) {
    super(`scene ${scene} can't run now:\n  ${blockers.join("\n  ")}`);
    this.name = "SceneBlocked";
    this.blockers = blockers;
  }
}

async function requireReady(ctx: SceneContext, scene: SceneId) {
  ctx.out.dim(`  reading agent ${AGENT_ID}'s state on chain…`);
  // Only scene 2 needs the counted spend (its daily-cap blocker); the read takes about 12 s.
  const read = await readDemoState(ctx.env, { spend: scene === "2" });
  const blockers = sceneBlockers(scene, read.state, { afterApproval: false });
  if (blockers.length > 0) throw new SceneBlocked(scene, blockers);
  return read;
}

function record(ctx: SceneContext, label: string, sent: { hash: Hash; receipt: { blockNumber: bigint } }) {
  ctx.out.tx(label, sent.hash);
  ctx.take.txs.push({ label, hash: sent.hash });
  if (sent.receipt.blockNumber > ctx.take.lastBlock) ctx.take.lastBlock = sent.receipt.blockNumber;
}

/** Runs `work` as a marked wait of `kind`: the cut-from line, the work, then the cut-to line (even if it throws). */
async function waiting<T>(ctx: SceneContext, kind: WaitKind, what: string, work: () => Promise<T>): Promise<T> {
  ctx.out.dim(waitOpenLine(what));
  const end = ctx.timeline.wait(kind, what);
  try {
    return await work();
  } finally {
    ctx.out.dim(waitCloseLine(end()));
  }
}

/** Tops the vault up to 0.01 MON from the owner when it holds less than `atLeast`. */
async function ensureVault(ctx: SceneContext, atLeast: bigint): Promise<bigint> {
  const balance = await publicClient.getBalance({ address: VAULT });
  if (balance >= atLeast) return balance;
  const sent = await sendWithGasGuard({
    publicClient,
    walletClient: walletFor(ctx.env.owner),
    to: VAULT,
    value: VAULT_FUND_TARGET - balance,
    gasLimit: GAS.fund,
    label: "fund vault",
  });
  record(ctx, "owner tops up the vault", sent);
  return VAULT_FUND_TARGET;
}

/** The owner sets agent 1984's forwarder key (a permission change: AgentKeySet). */
async function setAgentKey(ctx: SceneContext, key: Address, label: string) {
  const sent = await writeWithGasGuard({
    publicClient,
    walletClient: walletFor(ctx.env.owner),
    address: FORWARDER,
    abi: agentRequestForwarderAbi,
    functionName: "setAgentKey",
    args: [AGENT_ID, key],
    gasLimit: DEMO_GAS.setAgentKey,
    label: `setAgentKey ${AGENT_ID}`,
  });
  record(ctx, label, sent);
}

function mandateLabels(env: DemoEnv): Record<string, string> {
  return {
    [env.owner.address]: "its owner",
    [PASS_THROUGH]: "DemoPassThrough: forwards every payment to a sink nobody controls",
  };
}

/**
 * The passkey approval of the demo mandate (scenes 1 and 3b): you approve on /approve, the runner picks the file up,
 * checks it against the chain and against the demo mandate exactly, and submits it from the owner's wallet. `null`
 * when you typed `skip`.
 */
async function approveMandate(ctx: SceneContext): Promise<{ hash: Hash; setAtBlock: bigint } | null> {
  const { out, env } = ctx;
  const { snapshot } = await readDemoState(env, { spend: false });
  out.line("Switch to the browser (laptop Chrome):");
  out.bold(`  ${WEB}/approve → 3 · Approve a mandate change → agent ${AGENT_ID}`);
  out.line("  Read agent from chain → Preset: e2e mandate → Prepare approval → Sign with passkey → Download approval");
  out.dim(`  (the runner picks up attest8004-approval-agent${AGENT_ID}-nonce${snapshot.nonce}.json from ${ctx.approvalsDir})`);
  const approval = await waiting(ctx, "browser", "your passkey approval on /approve", () =>
    waitForApproval({
      dir: ctx.approvalsDir,
      agentId: AGENT_ID,
      nonce: snapshot.nonce,
      timeoutMs: APPROVAL_TIMEOUT_MS,
      ask: ctx.ask === null ? null : (q, signal) => (ctx.ask as NonNullable<SceneContext["ask"]>)(q, signal),
      say: (line) => out.line(line),
    }),
  );
  if (approval === "skip") return null;

  const chainState = await readApprovalChainState({
    publicClient,
    chainId: chain.id,
    registry: MANDATE_REGISTRY,
    identityRegistry: IDENTITY_REGISTRY,
    approval,
    sender: env.owner.address,
  });
  const problems = await approvalProblems(approval, chainState);
  const change = approvalChange(approval);
  if (change.kind !== "setMandate") problems.push("NOT_A_MANDATE: this approval changes the inbox key, not the mandate");
  else problems.push(...demoMandateProblems(change.mandate, demoMandate(env)));
  if (problems.length > 0 || change.kind !== "setMandate") throw new Error(`refusing to submit this approval:\n  ${problems.join("\n  ")}`);
  out.ok(`✓ The approval checks out: agent ${AGENT_ID}'s passkey signed exactly the demo mandate, at nonce ${approval.nonce}.`);
  if (ctx.ask) await ctx.ask("  Press Enter to submit it from the owner's wallet… ");
  const sent = await sendMandateApproval({
    publicClient,
    walletClient: walletFor(env.owner),
    owner: env.owner.address,
    registry: MANDATE_REGISTRY,
    identityRegistry: IDENTITY_REGISTRY,
    forwarder: FORWARDER,
    approval,
    mandate: change.mandate,
    nonce: chainState.nonce,
    onSent: (s) => record(ctx, "setMandate (passkey-approved)", s),
  });
  return { hash: sent.hash, setAtBlock: sent.setAtBlock };
}

/** The mandate as stored on chain, in plain words, and the P256VERIFY call in the transaction that set it. */
async function showMandate(ctx: SceneContext, setMandateTx: Hash) {
  const { out, env } = ctx;
  const [terms, , owner, setAtBlock] = await publicClient.readContract({
    address: MANDATE_REGISTRY,
    abi: mandateRegistryAbi,
    functionName: "getMandate",
    args: [AGENT_ID],
  });
  out.line();
  out.line(`Agent ${AGENT_ID}'s mandate, read back from the chain (set at block ${setAtBlock} by ${getAddress(owner)}):`);
  const mandate = { ...terms, allowedTargets: terms.allowedTargets.map((t) => getAddress(t)), allowedSelectors: [...terms.allowedSelectors] };
  for (const line of mandateLines(mandate, mandateLabels(env))) out.line(line);
  out.line();
  const trace = await traceFrames(setMandateTx);
  const calls = trace === null ? [] : findP256Calls(trace);
  if (trace === null) out.dim("  (this RPC doesn't serve traces: open the transaction on the explorer to see the 0x0100 call)");
  for (const call of calls) {
    const verdict = call.valid ? "returned …01: the passkey signature is valid" : "returned nothing: the signature is invalid";
    (call.valid ? out.ok : out.bad)(`  P256VERIFY (0x0100): ${call.gasUsed.toLocaleString("en-US")} gas, ${verdict}`);
  }
  if (trace !== null && calls.length === 0) out.bad("  no P256VERIFY call in this transaction's trace");
  out.tx("the transaction (its trace shows the STATICCALL)", setMandateTx);
}

/** One request per validator, A then B, from `account` through the forwarder. */
async function requestBoth(ctx: SceneContext, account: Account, action: Action, who: string) {
  const client = new Attest8004Client({ publicClient, walletClient: walletFor(account), validationRegistry: REGISTRY, forwarder: FORWARDER });
  const requested: RequestedValidation[] = [];
  for (const [side, validator] of [
    ["mandate-v1", ctx.env.validatorA.address],
    ["risk-v1", ctx.env.validatorB.address],
  ] as const) {
    const [one] = await client.requestValidation({ gate: VAULT, validators: [validator], action });
    if (!one) throw new Error(`requestValidation returned nothing for ${side}`);
    requested.push(one);
    ctx.out.tx(`${who} asks ${side}`, one.txHash);
    ctx.take.txs.push({ label: `${who} asks ${side}`, hash: one.txHash });
    ctx.take.requests.push({ label: `${who} → ${side}`, requestHash: one.requestHash });
    if (one.blockNumber > ctx.take.lastBlock) ctx.take.lastBlock = one.blockNumber;
  }
  const [a, b] = requested as [RequestedValidation, RequestedValidation];
  return { client, a, b };
}

interface Answered {
  verdictA: Verdict;
  verdictB: Verdict;
  /** A's evidence: its reasons, and the spend it counted. */
  evidenceA: { reasons: unknown; spendTotal: bigint };
}

/** The verdict a response posted, from its own log, with its evidence decoded. */
async function verdictOf(client: Attest8004Client, outcome: Extract<Outcome, { kind: "responded" }>) {
  const verdict = await client.awaitVerdict({ requestHash: outcome.requestHash, fromBlock: outcome.blockNumber, timeoutMs: 60_000 });
  const decoded = decodeJsonDataUri(verdict.responseURI, MAX_EVIDENCE_URI_BYTES);
  if (!decoded.ok) throw new Error(`the response to ${short(outcome.requestHash)} isn't inline JSON (${decoded.reason})`);
  return { verdict, text: decoded.text };
}

/**
 * Both validators answer the two requests, in this process, as their services would: mandate-v1 first (after its pin),
 * then risk-v1 (which waits for it, then checks with its model). Each verdict is printed as it lands, in the operator
 * report's words, with its link; the validators' own log lines are narrated.
 */
async function answer(ctx: SceneContext, client: Attest8004Client, a: RequestedValidation, b: RequestedValidation): Promise<Answered> {
  const { out, live, timeline } = ctx;
  const main = counted(live.llm);
  const guard = counted(live.guard);
  const seen = new Set<string>();
  const log = (entry: Record<string, unknown>) => {
    const line = narrateLog(entry, seen);
    if (line !== null) out.dim(`    ${line}`);
  };
  const fromBlock = a.blockNumber < b.blockNumber ? a.blockNumber : b.blockNumber;
  const pinWhat = "mandate-v1 pins 5 blocks below finalized, then answers";
  const riskWhat = "risk-v1's check: its tools at the pinned block, then the model";

  let open: { end: () => number; stopTicker: () => void } | null = null;
  const openWait = (kind: WaitKind, what: string, tick: string) => {
    out.dim(waitOpenLine(what));
    open = { end: timeline.wait(kind, what), stopTicker: out.ticker(tick) };
  };
  const closeWait = () => {
    if (open === null) return;
    const { end, stopTicker } = open;
    open = null;
    stopTicker();
    out.dim(waitCloseLine(end()));
  };

  let printing: Promise<void> = Promise.resolve();
  const found: { A?: { verdict: Verdict; text: string }; B?: { verdict: Verdict; text: string } } = {};
  const show = async (side: "A" | "B", outcome: Extract<Outcome, { kind: "responded" }>) => {
    const got = await verdictOf(client, outcome);
    found[side] = got;
    const evidence = JSON.parse(got.text) as Record<string, unknown>;
    const report = side === "A" ? mandateReport({ evidence, responseHash: got.verdict.responseHash }) : riskReport({ evidence, responseHash: got.verdict.responseHash });
    out.line();
    for (const line of verdictLines({ report, minScore: side === "A" ? MIN_SCORE_A : MIN_SCORE_B })) out.line(line);
    if (side === "B") {
      const parsed = parseRiskEvidence(got.text);
      if (parsed.ok) {
        const tools = [...new Set(parsed.doc.toolCalls.map((call) => call.name))];
        const nansen = parsed.doc.tools.nansen.available ? "available" : `not configured (${plainText(parsed.doc.tools.nansen.reason ?? "unavailable", 80)})`;
        out.dim(`    tools it called: ${tools.length > 0 ? tools.join(", ") : "none"}; Nansen: ${nansen}`);
        out.dim(`    model: ${plainText(parsed.doc.llm.servedModels.join(", "), 80)}, ${parsed.doc.llm.usage.total.toLocaleString("en-US")} tokens (recorded in the public evidence)`);
      }
    }
    out.tx(`${side === "A" ? MANDATE_V1.tag : RISK_V1.tag}'s verdict`, outcome.txHash);
    ctx.take.txs.push({ label: `${side === "A" ? MANDATE_V1.tag : RISK_V1.tag}'s verdict`, hash: outcome.txHash });
    if (outcome.blockNumber > ctx.take.lastBlock) ctx.take.lastBlock = outcome.blockNumber;
  };

  openWait("pin", pinWhat, "waiting for mandate-v1");
  try {
    await pollAll(
      [
        { name: "A", validator: live.mandate(fromBlock, log), requestHashes: [a.requestHash] },
        { name: "B", validator: live.risk(fromBlock, { llm: main.client, guard: guard.client }, log), requestHashes: [b.requestHash] },
      ],
      VALIDATORS_TIMEOUT_MS,
      `${VALIDATORS_TIMEOUT_MS / 60_000} minutes`,
      (job, outcome) => {
        const problem = unexpectedOutcome(job === "A" ? MANDATE_V1.tag : RISK_V1.tag, outcome);
        if (problem !== null || outcome.kind !== "responded") throw new Error(problem ?? "unreachable");
        closeWait();
        if (job === "A") openWait("risk-v1", riskWhat, "risk-v1 working");
        printing = printing.then(() => show(job as "A" | "B", outcome));
      },
    );
  } finally {
    closeWait();
    ctx.take.tokens += main.stats.usage.total;
  }
  await printing;
  if (!found.A || !found.B) throw new Error("a verdict was answered but not read back");
  const docA = JSON.parse(found.A.text) as { reasons?: unknown; spend?: { total?: unknown } };
  const spend = docA.spend?.total;
  return {
    verdictA: found.A.verdict,
    verdictB: found.B.verdict,
    evidenceA: { reasons: docA.reasons, spendTotal: typeof spend === "string" && /^\d+$/.test(spend) ? BigInt(spend) : 0n },
  };
}

function deadlineAfter(latest: bigint): bigint {
  return latest + DEADLINE_SECONDS;
}

/** Scene 1: a passkey approves the mandate; the runner shows it from chain, and the 0x0100 call in its transaction. */
export async function scene1(ctx: SceneContext): Promise<void> {
  const { snapshot } = await requireReady(ctx, "1");
  ctx.out.line(`The owner of agent ${AGENT_ID} approves its mandate with a passkey: what the agent may do, signed on the device.`);
  const approved = await approveMandate(ctx);
  if (approved !== null) return showMandate(ctx, approved.hash);
  if (snapshot.mandate === null) throw new Error(`agent ${AGENT_ID} has no mandate to show`);
  const tx = await mandateSetTx(snapshot.mandate.setAtBlock);
  if (tx === null) throw new Error(`no MandateSet log at block ${snapshot.mandate.setAtBlock}`);
  ctx.out.dim("  skipped: showing the current mandate (no new approval)");
  await showMandate(ctx, tx);
}

/** Scene 2: a benign action, inside the mandate: both validators pass it, the vault executes it. */
export async function scene2(ctx: SceneContext): Promise<void> {
  const { out, env } = ctx;
  const { snapshot } = await requireReady(ctx, "2");
  await ensureVault(ctx, DEMO_VALUES.benign + DEMO_VALUES.rogue);
  const action = buildAction({ agentId: AGENT_ID, target: env.owner.address, value: DEMO_VALUES.benign, deadline: deadlineAfter(snapshot.latest.timestamp) });
  out.line(`Agent ${AGENT_ID} proposes: send ${mon(DEMO_VALUES.benign)} from its vault to its owner (inside the mandate).`);
  out.line("Its hot key asks both validators through the forwarder:");
  const { client, a, b } = await requestBoth(ctx, env.hotKey, action, "hot key");
  const { verdictA, verdictB } = await answer(ctx, client, a, b);
  if (verdictA.response !== MIN_SCORE_A) throw new Error(`mandate-v1 scored the benign action ${verdictA.response} (needs ${MIN_SCORE_A})`);
  if (verdictB.response < MIN_SCORE_B) {
    throw new Error(`risk-v1 scored the benign action ${verdictB.response}, below the vault's ${MIN_SCORE_B} (R1: see the plan's Decision 22)`);
  }
  out.line();
  if (!(await client.isValidated({ gate: VAULT, action }))) throw new Error("the vault doesn't see the action as validated");
  const before = await publicClient.getBalance({ address: VAULT });
  const executed = await writeWithGasGuard({
    publicClient,
    walletClient: walletFor(env.owner),
    address: VAULT,
    abi: vaultAbi,
    functionName: "execute",
    args: [action],
    gasLimit: GAS.execute,
    label: "execute",
  });
  const consumed = parseEventLogs({ abi: vaultAbi, eventName: "ActionConsumed", logs: executed.receipt.logs }).filter((l) => getAddress(l.address) === VAULT);
  if (consumed.length !== 1) throw new Error("execute landed without the vault's ActionConsumed");
  out.ok(`✓ Both verdicts pass, so the vault executes it (anyone may send execute; the gate checks the verdicts).`);
  record(ctx, "vault executes the action", executed);
  const after = await publicClient.getBalance({ address: VAULT });
  out.line(`  Vault balance: ${monShort(before)} → ${monShort(after)} (${monShort(before - after)} sent to the owner)`);
  out.dim(`  Anyone can re-check mandate-v1's verdict from chain data alone: pnpm attest8004 verify ${a.requestHash}`);
}

/** Scene 3: the Grok/Bankr replay: a permission change outside the mandate, then a transfer to an unknown address. */
export async function scene3(ctx: SceneContext): Promise<void> {
  const { out, env } = ctx;
  const { state, snapshot } = await requireReady(ctx, "3");
  const rogue = env.rogue;
  if (rogue === null) throw new SceneBlocked("3", ["the demo rogue key isn't configured"]);
  if (snapshot.mandate === null) throw new SceneBlocked("3", ["agent 1984 has no mandate"]);
  await ensureVault(ctx, DEMO_VALUES.rogue);
  if (state.agentKey.kind !== "rogue") {
    out.line(`The owner's wallet registers a new forwarder key for agent ${AGENT_ID}: ${rogue.address}.`);
    out.line("Nobody approved this with the passkey: it's a permission change outside the mandate.");
    await setAgentKey(ctx, rogue.address, "setAgentKey (the rogue key)");
  } else {
    out.dim(`  the rogue key ${rogue.address} is already agent ${AGENT_ID}'s forwarder key (resuming)`);
  }
  const action = buildAction({ agentId: AGENT_ID, target: UNKNOWN_TARGET, value: DEMO_VALUES.rogue, deadline: deadlineAfter(snapshot.latest.timestamp) });
  out.line();
  out.line(`The new key asks to send ${mon(DEMO_VALUES.rogue)} to ${UNKNOWN_TARGET}, an address nobody has seen:`);
  const { client, a, b } = await requestBoth(ctx, rogue, action, "rogue key");
  const { verdictA, verdictB, evidenceA } = await answer(ctx, client, a, b);
  const expected = expectedRogueReasons({
    spendTotal: evidenceA.spendTotal,
    value: DEMO_VALUES.rogue,
    maxValuePerTx: snapshot.mandate.terms.maxValuePerTx,
    maxValuePerDay: snapshot.mandate.terms.maxValuePerDay,
  });
  if (verdictA.response !== 0 || JSON.stringify(evidenceA.reasons) !== JSON.stringify(expected)) {
    throw new Error(`mandate-v1 gave ${verdictA.response} with ${JSON.stringify(evidenceA.reasons)}; expected 0 with ${JSON.stringify(expected)}`);
  }
  if (verdictB.response >= MIN_SCORE_B) out.bad(`! risk-v1 scored it ${verdictB.response}; the gate still refuses it at mandate-v1`);

  out.line();
  const refusal = await revertOf(publicClient, "execute(rogue action)", { address: VAULT, abi: vaultAbi, functionName: "execute", args: [action] }, env.owner.address);
  const [validator, requestHash, score, minScore] = refusal.args;
  const isScoreTooLow =
    refusal.name === "ScoreTooLow" &&
    typeof validator === "string" &&
    getAddress(validator) === env.validatorA.address &&
    String(requestHash).toLowerCase() === a.requestHash.toLowerCase() &&
    score === 0 &&
    minScore === MIN_SCORE_A;
  if (!isScoreTooLow) throw new Error(`execute should revert ScoreTooLow at mandate-v1; it gave ${refusal.detail}`);
  out.bad(`✗ execute reverts: ScoreTooLow(mandate-v1 ${short(env.validatorA.address)}, request ${short(a.requestHash)}, score 0, needs ${MIN_SCORE_A})`);
  out.dim("  (simulated with eth_call: nothing sent, nothing moved)");
  if (await client.isValidated({ gate: VAULT, action })) throw new Error("isValidated says the rogue action passes");

  if (ctx.fast) {
    out.dim(`  verify it yourself: pnpm attest8004 verify ${a.requestHash}`);
    return;
  }
  const report = await verifyRequest({
    reader: viemMandateReader({ publicClient, contracts: MANDATE_CONTRACTS, concurrency: READER_CONCURRENCY }),
    requestHash: a.requestHash,
    ...verifyContextFor(chain.id),
  });
  if (report.verdict !== "match") throw new Error(`verify gave ${report.verdict} on mandate-v1's verdict`);
  out.ok(`✓ verify re-ran mandate-v1 at block ${report.pinnedBlock} from chain data alone: same score, same responseHash`);
  out.dim(`  (pnpm attest8004 verify ${a.requestHash})`);
}

/**
 * Scene 3b: recovery, which is also the reset between takes. Revoke the rogue key (the hot key back), approve the
 * mandate again with the passkey, and prove mandate-v1 passes again at once: its permission rule compares events with
 * the newest MandateSet, so a mandate newer than the changes is clean.
 */
export async function scene3b(ctx: SceneContext): Promise<void> {
  const { out, env } = ctx;
  const first = await requireReady(ctx, "3b");
  if (first.state.agentKey.kind !== "hot") {
    out.line(`The owner revokes the rogue key: agent ${AGENT_ID}'s forwarder key is its own hot key again.`);
    await setAgentKey(ctx, env.hotKey.address, "setAgentKey (the hot key back)");
  } else {
    out.dim(`  agent ${AGENT_ID}'s forwarder key is already its hot key`);
  }

  const { state, snapshot } = await readDemoState(env, { spend: false });
  let setAtBlock = snapshot.mandate?.setAtBlock ?? 0n;
  if (state.permissionChangedAfterMandate || !state.mandate.present || !state.mandate.demoTerms) {
    out.line("The key changes came after the mandate, so mandate-v1 refuses everything until the owner approves again:");
    const approved = await approveMandate(ctx);
    if (approved === null) throw new Error("skipped: the demo isn't reset (approve the mandate again to reset it)");
    setAtBlock = approved.setAtBlock;
  } else {
    out.dim("  nothing to re-approve: no permission change follows the mandate");
  }

  const reader = viemMandateReader({ publicClient, contracts: MANDATE_CONTRACTS, concurrency: READER_CONCURRENCY });
  const pinned = await waiting(ctx, "pin", "the pinned block (5 below finalized) passing the new mandate", async () => {
    for (;;) {
      const head = await reader.finalized();
      if (head.number - PIN_DEPTH >= setAtBlock) return reader.block(head.number - PIN_DEPTH);
      await sleep(500);
    }
  });
  const window = await checkPermissionWindow(
    { publicClient, identityRegistry: IDENTITY_REGISTRY, forwarder: FORWARDER, mandateRegistry: MANDATE_REGISTRY },
    { agentId: AGENT_ID, owner: env.owner.address, setAtBlock, windowBlocks: MANDATE_V1.permissionWindowBlocks },
  );
  out.ok(`✓ mandate-v1's permission rule: no change after the mandate's MandateSet (blocks ${window.scanFrom}..${window.head})`);

  const latest = await publicClient.getBlock();
  const action = buildAction({ agentId: AGENT_ID, target: env.owner.address, value: DEMO_VALUES.benign, deadline: deadlineAfter(latest.timestamp) });
  const json = buildRequestJson({ chainId: chain.id, gate: VAULT, validator: env.validatorA.address, action });
  const result = await runMandateV1({
    reader,
    addresses: mandateAddressesAt(MANDATE_CONTRACTS, pinned.number),
    validator: env.validatorA.address,
    request: mandateRequestOf(json, requestHashOfJson(json), pinned.number),
    pinned,
    cache: new Map(),
  });
  if (result.score !== 100) throw new Error(`the reset didn't take: mandate-v1 would give ${result.score} (${result.reasons.join(", ")})`);
  out.ok(`✓ dry run, nothing posted: mandate-v1 scores scene 2's benign action 100, no reasons (pinned at block ${pinned.number})`);
  out.line("  Agent 1984 is trusted again, at once: the take can start over.");
}

/** Scene 4: the dashboard shows the record (it reads the indexer; the runner waits until it has this take's blocks). */
export async function scene4(ctx: SceneContext): Promise<void> {
  const { out } = ctx;
  out.line("Switch to the browser:");
  out.bold(`  ${WEB}/dashboard`);
  out.line("  Recent verdicts: this take's four, newest first: mandate-v1 and risk-v1 refusing the rogue transfer, then both passing the");
  out.line("  benign one. Each card has its verify line. Then Agent trust → agent 1984 → Look up: the two AgentKeySet events (the rogue");
  out.line("  key, then the hot key back) under Recent permission events, and the fresh mandate.");
  if (ctx.take.lastBlock === 0n) {
    const at = await indexedTo();
    out.dim(at === null ? "  the indexer doesn't answer: /dashboard shows its offline view" : `  the indexer is at block ${at}`);
    return;
  }
  const target = ctx.take.lastBlock;
  const reached = await waiting(ctx, "indexer", `the indexer reaching block ${target}`, async () => {
    const giveUpAt = Date.now() + 90_000;
    for (;;) {
      const at = await indexedTo();
      if (at !== null && at >= target) return at;
      if (Date.now() > giveUpAt) return at;
      await sleep(5_000);
    }
  });
  if (reached === null) out.bad("  the indexer doesn't answer: /dashboard shows its offline view (every verdict is still on chain)");
  else if (reached >= target) out.ok(`✓ indexed: the dashboard has this take (indexer at block ${reached})`);
  else out.bad(`  the indexer is ${target - reached} block(s) behind this take; the dashboard says so and fills in shortly`);
}

/** Scene 5: the phone decrypts the private findings with the same passkey (in person); the runner confirms the reports exist. */
export async function scene5(ctx: SceneContext): Promise<void> {
  const { out } = ctx;
  const board = deployment.findingsBoard;
  if (board === null) {
    out.bad("  no FindingsBoard recorded: operator reports are off on this chain");
  } else {
    const wanted = ctx.take.requests.map((r) => r.requestHash.toLowerCase());
    const discover = () =>
      findInboxEntries(viemInboxReader({ publicClient, deployment }), { agentId: AGENT_ID, findingsBoard: board, maxResponses: Math.max(4, wanted.length) });
    const complete = (found: Awaited<ReturnType<typeof discover>>) =>
      wanted.every((hash) => found.find((e) => e.status.requestHash.toLowerCase() === hash)?.posts.length === 1);
    const entries = await retryUntil(discover, complete, { attempts: 4, delayMs: 5_000 });
    const shown = wanted.length > 0 ? entries.filter((e) => wanted.includes(e.status.requestHash.toLowerCase())) : entries;
    for (const entry of shown) {
      const post = entry.posts[0];
      if (post === undefined) out.bad(`  no encrypted report yet for ${plainText(entry.status.tag, 32)}'s verdict on ${short(entry.status.requestHash)}`);
      else out.ok(`✓ encrypted report for ${plainText(entry.status.tag, 32)}'s verdict (${entry.status.response}) on ${short(entry.status.requestHash)}`);
    }
    if (wanted.length > 0 && !complete(entries)) out.bad("  a report is missing: the inbox shows what is there");
  }
  out.line();
  out.line("On the phone (Android Chrome, the same Google account and passkey):");
  out.bold(`  ${WEB}/inbox → agent ${AGENT_ID} → Find reports → Decrypt with passkey`);
  out.line("  Each report says \"Matches the verdict onchain\": the same words as above, decrypted on the device.");
}

export const SCENE_RUNNERS: Record<SceneId, (ctx: SceneContext) => Promise<void>> = {
  "1": scene1,
  "2": scene2,
  "3": scene3,
  "3b": scene3b,
  "4": scene4,
  "5": scene5,
};
