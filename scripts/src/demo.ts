/**
 * `pnpm demo` (P9): SPEC §5 on Monad testnet, scene by scene, for a screen recording.
 *
 *   1  the mandate: you approve it with the passkey on /approve; the runner submits it and shows it from chain, with the
 *      P256VERIFY (0x0100) call in its transaction
 *   2  a benign action: both validators pass it, the vault executes it
 *   3  the Grok/Bankr replay: a new forwarder key outside the mandate asks to send MON to an unknown address;
 *      mandate-v1 scores it 0, risk-v1 explains why, the gate refuses it (simulated)
 *   3b recovery, which is also the reset between takes: the rogue key revoked, the mandate approved again
 *   4  the dashboard; 5 the phone decrypting the private findings (in person)
 *
 * Run: pnpm demo [--scene <1|2|3|3b|4|5>] [--fast] [--approvals <dir>]
 *      pnpm demo --preflight        checks only, sends nothing
 *      pnpm demo --fund             tops the keys up to 4 takes from the deployer, then checks
 * For a recording, `pnpm --loglevel silent demo` hides pnpm's own command line.
 *
 * Both validators run in this process, as the e2e runs them: stop the validator services first (the preflight
 * refuses while one runs). Keys come from .env and are never printed, nor is the RPC URL or the LLM endpoint's URL
 * or key. Every transaction carries an explicit gas limit; refusals are simulated, never sent.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { sendWithGasGuard } from "@attest8004/sdk";
import { MANDATE_V1 } from "@attest8004/validator-mandate";
import { RISK_V1 } from "@attest8004/validator-risk";
import { assertChain, chain, mon, publicClient, walletFor } from "./common.ts";
import { SCENES, SCENE_TITLES, parseDemoArgs, pausePolicy, type DemoArgs, type SceneId } from "./demo-args.ts";
import {
  CHECKS_PER_TAKE,
  DEMO_VALUES,
  FUNDED_TAKES,
  TOKENS_PER_CHECK_FALLBACK,
  fundingPlan,
  groqRoom,
  perTakeGas,
  takesAffordable,
  takesByCap,
  takesLeft,
  tokensInWindow,
  type KeyRole,
} from "./demo-budget.ts";
import {
  AGENT_ID,
  VAULT,
  demoEnvFromProcess,
  deployment,
  indexedTo,
  readDemoState,
  riskTokensLastDay,
  scanServices,
  type DemoEnv,
} from "./demo-chain.ts";
import { SCENE_RUNNERS, SceneBlocked, VAULT_FUND_TARGET, makeOut, type Out, type SceneContext, type Take } from "./demo-scenes.ts";
import { sceneBlockers } from "./demo-state.ts";
import { monShort, plainText, printableError, redactUrls, sceneHeader, shortKeyLine, txLine } from "./demo-text.ts";
import { Timeline, timingTable } from "./demo-timing.ts";
import { checkModelsEndpoint, reportsExpected } from "./e2e-preflight.ts";
import { GAS, liveValidators } from "./live-validators.ts";

const KEY_NAMES: Record<KeyRole, string> = {
  deployer: "deployer",
  hotKey: "hot key",
  rogueKey: "rogue key",
  validatorA: "validator A",
  validatorB: "validator B",
};
const ROLES: readonly KeyRole[] = ["deployer", "hotKey", "rogueKey", "validatorA", "validatorB"];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Tops every key up to FUNDED_TAKES takes from the deployer, unless that would leave the deployer short (Decision 10). */
async function fund(env: DemoEnv, out: Out): Promise<boolean> {
  out.bold("Funding the demo's keys from the deployer");
  if (env.rogue === null) {
    out.bad("  make the rogue key first: `pnpm --filter @attest8004/scripts hot-keys` (it writes DEMO_ROGUE_* and prints only the address)");
    return false;
  }
  const { snapshot } = await readDemoState(env, { spend: false });
  const plan = fundingPlan({
    balances: snapshot.balances,
    maxFeePerGas: snapshot.maxFeePerGas,
    takes: FUNDED_TAKES,
    vaultTopUp: VAULT_FUND_TARGET,
    transferGas: GAS.fund,
  });
  if (plan.refused !== null) {
    out.bad(`  ${plan.refused}: paste the deployer's address ${env.owner.address} into https://faucet.monad.xyz, then run this again`);
    return false;
  }
  if (plan.topUps.length === 0) out.line(`  every key already holds ${FUNDED_TAKES} takes`);
  for (const { role, amount } of plan.topUps) {
    const to = snapshot.addresses[role];
    if (to === null) continue;
    const sent = await sendWithGasGuard({ publicClient, walletClient: walletFor(env.owner), to, value: amount, gasLimit: GAS.fund, label: `fund ${role}` });
    out.line(txLine(`${KEY_NAMES[role]} +${mon(amount)}`, sent.hash));
  }
  out.line(`  the deployer keeps about ${monShort(plan.deployerAfter)}`);
  return true;
}

interface Preflight {
  blocked: boolean;
  groqUsed: number | null;
  perCheck: number;
}

/** Everything the runner checks before it sends anything, printed for you to read (Decisions 8, 9, 15, 16 and 24). */
async function preflight(env: DemoEnv, out: Out, args: DemoArgs): Promise<Preflight> {
  out.bold("Preflight");
  const [{ state, snapshot }, services, endpoint, indexed] = await Promise.all([
    readDemoState(env),
    scanServices(),
    checkModelsEndpoint({ baseUrl: env.llm.baseUrl, apiKey: env.llm.apiKey, models: [env.llm.model, RISK_V1.guardModel], fetch, timeoutMs: 10_000 }),
    indexedTo(),
  ]);
  const tokens = await riskTokensLastDay({ validatorB: env.validatorB.address, now: snapshot.latest.timestamp });
  const gas = perTakeGas();
  const fee = snapshot.maxFeePerGas;

  out.line(`  chain ${chain.id} · agent ${AGENT_ID} · vault ${VAULT} · max fee ${(Number(fee) / 1e9).toFixed(1)} gwei`);
  out.line(`  keys (a take at the gas caps; Monad charges the limit):`);
  const keyTakes: { name: string; takes: number | null }[] = [];
  for (const role of ROLES) {
    const address = snapshot.addresses[role];
    if (address === null) {
      out.line(`    ${KEY_NAMES[role].padEnd(12)} not configured`);
      continue;
    }
    const takes = takesAffordable(snapshot.balances[role], gas[role], fee);
    keyTakes.push({ name: KEY_NAMES[role], takes });
    out.line(`    ${KEY_NAMES[role].padEnd(12)} ${address}  ${monShort(snapshot.balances[role]).padEnd(13)} ${plural(takes, "take")}`);
  }
  out.line(`  vault: ${monShort(snapshot.vaultBalance)} (scene 2 tops it up to ${mon(VAULT_FUND_TARGET)} when it can't cover a take)`);

  let capTakes: number | null = null;
  const cap = snapshot.mandate?.terms.maxValuePerDay ?? null;
  if (snapshot.spend === null) out.dim("  daily cap: not read");
  else if ("unreadable" in snapshot.spend) out.bad(`  daily cap: the counted spend is unreadable (${plainText(snapshot.spend.unreadable, 120)})`);
  else if (cap !== null) {
    capTakes = takesByCap({ spend: snapshot.spend.total, cap, benign: DEMO_VALUES.benign, rogue: DEMO_VALUES.rogue });
    out.line(
      `  daily cap: ${monShort(snapshot.spend.total)} of ${monShort(cap)} counted (${plural(snapshot.spend.counted, "approval")} in 25 h): ` +
        `${plural(capTakes, "take")} before the rogue transfer also trips DAILY_CAP_EXCEEDED`,
    );
  }

  let groqUsed: number | null = null;
  let perCheck = TOKENS_PER_CHECK_FALLBACK;
  if ("unknown" in tokens) {
    out.bad(`  ${groqRoom({ used: null, perCheck, checksPerTake: CHECKS_PER_TAKE }).line} (${plainText(redactUrls(tokens.unknown), 160)})`);
  } else {
    const window = tokensInWindow(tokens.rows, snapshot.latest.timestamp, 86_400n);
    groqUsed = window.used;
    perCheck = window.average ?? TOKENS_PER_CHECK_FALLBACK;
    const room = groqRoom({ used: window.used, perCheck, checksPerTake: CHECKS_PER_TAKE });
    (room.warn ? out.bad : out.line)(`  ${room.line}`);
    out.dim(
      `    from validator B's ${plural(window.checks, "recorded check")} in the last 24 h${window.unread > 0 ? ` (${window.unread} unreadable)` : ""}; ` +
        "Groq has no daily-token header, and other uses of the key aren't counted",
    );
  }
  out.line(`  Nansen: ${env.nansenApiKey ? "key set: risk-v1's two Nansen tools are available" : "not configured (no NANSEN_API_KEY): risk-v1's Nansen tools answer \"unavailable\""}`);
  if (endpoint.ok) out.line(`  risk-v1's model endpoint answers GET /models (no tokens spent)${endpoint.listed ? ` and lists ${env.llm.model}` : ""}`);
  else out.bad(`  risk-v1's model endpoint: ${plainText(endpoint.message, 200)}`);

  const running = [...services.processes.map((p) => `${p.service} (pid ${p.pid})`), ...services.freshCursors.map((s) => `${s} (cursor written in the last 2 min)`)];
  if (running.length === 0) out.line("  validator services: none running");
  else out.bad(`  validator services running: ${running.join(", ")}`);

  const keyState = state.agentKey.kind === "hot" ? "its hot key" : state.agentKey.kind === "rogue" ? "the demo rogue key" : state.agentKey.kind;
  out.line(`  agent ${AGENT_ID}: forwarder key = ${keyState}; passkey ${state.passkeySet ? "set" : "not set"}; nonce ${snapshot.nonce}`);
  if (snapshot.mandate === null) out.line("  mandate: none");
  else {
    const m = state.mandate;
    out.line(
      `  mandate: ${m.demoTerms ? "the demo's e2e mandate" : "NOT the demo's"}, set at block ${snapshot.mandate.setAtBlock}` +
        `${m.setByOwner ? " by the owner" : " by a former owner"}${m.expired ? ", EXPIRED" : ""}; ` +
        `${snapshot.permissionChange === null ? "no permission change after it" : "a permission change came after it (mandate-v1 would refuse)"}`,
    );
  }
  out.line(`  ${reportsExpected({ inboxKey: snapshot.inboxKey, findingsBoard: deployment.findingsBoard }).line}`);
  out.line(indexed === null ? "  indexer: doesn't answer (/dashboard shows its offline view)" : `  indexer: at block ${indexed} (${snapshot.latest.number - indexed} behind the head)`);

  const short = ROLES.filter((role) => state.shortKeys.includes(role));
  if (short.length > 0) {
    out.line("  short keys (paste an address into the faucet, or run `pnpm demo --fund`):");
    for (const role of short) {
      const address = snapshot.addresses[role];
      if (address !== null) out.bad(`    ${shortKeyLine({ name: KEY_NAMES[role], address, balance: snapshot.balances[role], need: gas[role] * fee, takes: 1 })}`);
    }
  }

  const scenes = args.mode === "run" ? args.scenes : SCENES;
  const approvalFirst = scenes.indexOf("1");
  const blockers: string[] = [];
  for (const [i, scene] of scenes.entries()) {
    const found = sceneBlockers(scene, state, { afterApproval: approvalFirst >= 0 && i > approvalFirst });
    if (scene === "2" || scene === "3") {
      if (running.length > 0) found.push("stop the validator services first (the runner runs both validators itself; `pnpm demo --preflight` re-checks)");
      if (!endpoint.ok) found.push("risk-v1's model endpoint doesn't answer: check LLM_BASE_URL and LLM_API_KEY in .env (`pnpm demo --preflight` re-checks)");
    }
    for (const message of found) blockers.push(`scene ${scene}: ${message}`);
  }
  if (blockers.length > 0) {
    out.bad("  blockers:");
    for (const b of blockers) out.bad(`    ${b}`);
  }

  const groq = groqUsed === null ? null : groqRoom({ used: groqUsed, perCheck, checksPerTake: CHECKS_PER_TAKE }).takes;
  const left = takesLeft([{ name: "Groq", takes: groq }, { name: "the daily cap", takes: capTakes }, ...keyTakes]);
  out.bold(
    `  Takes left today: ${left.takes ?? "unknown"}${left.limitedBy ? ` (limited by ${left.limitedBy})` : ""}` +
      `${left.unknown.length > 0 ? `; unknown: ${left.unknown.join(", ")}` : ""}`,
  );
  return { blocked: blockers.length > 0, groqUsed, perCheck };
}

function summary(out: Out, take: Take, timeline: Timeline, pre: Preflight) {
  out.line();
  out.bold("This run");
  for (const tx of take.txs) out.line(txLine(tx.label, tx.hash));
  for (const r of take.requests) out.dim(`  request ${r.label}: ${r.requestHash}`);
  out.line(`  risk-v1 used ${take.tokens.toLocaleString("en-US")} tokens this run`);
  if (pre.groqUsed !== null) out.line(`  ${groqRoom({ used: pre.groqUsed + take.tokens, perCheck: pre.perCheck, checksPerTake: CHECKS_PER_TAKE }).line}`);
  out.line();
  out.bold("Timing (cut the pin, risk-v1 and indexer waits; show \"waiting time cut\" on screen at each cut)");
  for (const line of timingTable(timeline.scenes())) out.line(line);
}

/** Set once the first scene starts: only then can a failure have left the rogue key registered. */
let scenesStarted = false;

async function main(): Promise<void> {
  const args = parseDemoArgs(process.argv.slice(2));
  const tty = process.stdout.isTTY === true;
  const out = makeOut({ color: tty && !process.env.NO_COLOR, tty, write: (s) => process.stdout.write(s) });
  await assertChain();
  const env = demoEnvFromProcess();

  const policy = pausePolicy({ stdinIsTty: process.stdin.isTTY === true, fast: args.fast });
  const rl = policy.typedInput ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const interrupted = () => {
    out.line();
    out.bad("Interrupted. If scene 3 set the rogue key, reset with `pnpm demo --scene 3b`.");
    process.exit(130);
  };
  process.on("SIGINT", interrupted);
  rl?.on("SIGINT", interrupted);
  const ask = rl === null ? null : (question: string, signal?: AbortSignal) => rl.question(question, signal ? { signal } : {});

  try {
    if (args.mode === "fund" && !(await fund(env, out))) {
      process.exitCode = 1;
      return;
    }
    const pre = await preflight(env, out, args);
    if (args.mode !== "run" || pre.blocked) {
      if (pre.blocked) process.exitCode = 1;
      return;
    }

    const timeline = new Timeline(() => Date.now());
    const take: Take = { requests: [], txs: [], tokens: 0, lastBlock: 0n };
    const live = liveValidators({
      publicClient,
      walletFor,
      chainId: chain.id,
      validatorA: env.validatorA,
      validatorB: env.validatorB,
      vault: VAULT,
      agentId: AGENT_ID,
      llm: env.llm,
      ...(env.nansenApiKey ? { nansenApiKey: env.nansenApiKey } : {}),
    });
    const ctx: SceneContext = {
      env,
      live,
      out,
      timeline,
      fast: args.fast,
      approvalsDir: args.approvalsDir ?? join(homedir(), "Downloads"),
      ask,
      take,
    };
    out.dim(`  validators: ${MANDATE_V1.tag} and ${RISK_V1.tag} run in this process; approvals are read from ${ctx.approvalsDir}`);
    scenesStarted = true;
    for (const [i, scene] of args.scenes.entries()) {
      if (i > 0 && policy.betweenScenes && ask) await ask(`\nPress Enter for scene ${scene}… `);
      for (const line of sceneHeader(scene as SceneId, SCENE_TITLES[scene])) out.bold(line);
      timeline.begin(scene);
      try {
        await SCENE_RUNNERS[scene](ctx);
      } finally {
        timeline.end();
      }
    }
    summary(out, take, timeline, pre);
  } finally {
    rl?.close();
  }
}

// viem's shortMessage leaves out request details such as the RPC URL.
main().catch((error: unknown) => {
  if (error instanceof SceneBlocked) {
    console.error(error.message);
  } else {
    console.error(printableError(error));
    if (scenesStarted) console.error("If scene 3 set the rogue key, reset with `pnpm demo --scene 3b`.");
  }
  process.exitCode = 1;
});
