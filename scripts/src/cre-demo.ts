// pnpm cre:demo (P11, docs/cre.md): validator C, a Chainlink CRE workflow orchestrating mandate-v1, on two live
// requests from agent 1984's hot key: one benign (expect 100), one to a target outside the mandate (expect 0). For each
// it prints the exact `cre workflow simulate --broadcast` command, runs it, waits for C's verdict on chain, re-executes
// it with verify and prints the explorer links. C is a CRE workflow (simulation forwarder, not a trust root): no gate
// requires it, and the preflight refuses to run if the live vault ever did.
//
//   pnpm cre:demo               the two scenes
//   pnpm cre:demo -- --preflight  the checks only (balances, takes left, the vault, the mandate, the CLI)
//
// The only key that reaches the CRE CLI is CRE_ETH_PRIVATE_KEY, through the CLI's environment (cre-demo-plan.ts
// childEnv). The /evaluate service runs in this process on 127.0.0.1:8787, read-only, sharing this process's
// rate-limited RPC client. Nothing prints a key.
import { Attest8004Client, buildAction, CRE_VALIDATOR_LABEL, DEFAULT_GAS, DEPLOYMENTS, attestGateAbi, mandateRegistryAbi, validationRegistryAbi } from "@attest8004/sdk";
import {
  collectSpend,
  EVALUATE_DEFAULTS,
  MANDATE_V1,
  parseGateList,
  startEvaluateService,
  verifyContextFor,
  verifyRequest,
  viemMandateReader,
  type VerifyReport,
} from "@attest8004/validator-mandate";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEventLog, getAddress, parseAbi, zeroHash, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertChain, chain, publicClient, requireAddress, requireEnv, walletFor } from "./common.ts";
import {
  alreadyAnsweredLines,
  childEnv,
  creBudget,
  creExcludedFromVault,
  CRE_WORKFLOW,
  findCreCli,
  landedVerdict,
  printableCommand,
  requestLogIndex,
  simulateArgv,
  simulationDecision,
  verifyWhenFinal,
  parseResultLine,
  simulationFailure,
} from "./cre-demo-plan.ts";
import { DEMO_VALUES } from "./demo-budget.ts";
import { AGENT_ID, FORWARDER, IDENTITY_REGISTRY, MANDATE_CONTRACTS, MANDATE_REGISTRY, REGISTRY, UNKNOWN_TARGET, VAULT } from "./demo-chain.ts";
import { addressLink, palette, txLine } from "./demo-text.ts";
import { waitCloseLine, waitOpenLine } from "./demo-timing.ts";
import { checkPermissionWindow } from "./permission-window.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CRE_DIR = join(REPO_ROOT, CRE_WORKFLOW.projectDir);
const deployment = DEPLOYMENTS[chain.id];
const C = getAddress(deployment.validators.creMandateV1);
/** A report's gas limit for the budget: ~4 kB of evidence needs about 420k (the floor-aware model); this leaves room. */
const REPORT_GAS_BUDGET = 600_000n;
/** The actions' deadline: half the 3,600 s horizon after the latest block. */
const DEADLINE_SECONDS = 1_800n;
const FINALITY_TIMEOUT_MS = 90_000;
const SIMULATE_TIMEOUT_MS = 5 * 60_000;
const EXPECTED_CLI = "v1.37";
const EXPECTED_BUN = "1.3.14";

const creAbi = parseAbi(["function forwarder() view returns (address)", "function registry() view returns (address)"]);
const forwarderAbi = parseAbi(["event ReportProcessed(address indexed receiver, bytes32 indexed workflowExecutionId, bytes2 indexed reportId, bool result)"]);

const argv = process.argv.slice(2);
const PREFLIGHT_ONLY = argv.includes("--preflight");
const color = palette(process.stdout.isTTY === true && !process.env.NO_COLOR && !argv.includes("--no-color"));
const say = (line = "") => console.log(line);

/** Fails the run with a reason the reader can act on. */
class Stop extends Error {}

function cli(creCli: string, args: string[], env: Record<string, string>): string {
  return execFileSync("mise", ["exec", "--", creCli, ...args], { cwd: CRE_DIR, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function readStatus(requestHash: Hex) {
  const [validator, agentId, response, responseHash, tag, lastUpdate] = await publicClient.readContract({
    address: REGISTRY,
    abi: validationRegistryAbi,
    functionName: "getValidationStatus",
    args: [requestHash],
  });
  return { validator: getAddress(validator), agentId, response, responseHash, tag, lastUpdate };
}

async function verify(requestHash: Hex): Promise<VerifyReport> {
  const reader = viemMandateReader({ publicClient, contracts: MANDATE_CONTRACTS, concurrency: 8 });
  return verifyRequest({ reader, requestHash, ...verifyContextFor(chain.id) });
}

function verifyLines(report: VerifyReport): string[] {
  const reasons = report.recomputed?.reasons.length ? report.recomputed.reasons.join(", ") : "none";
  const head =
    report.verdict === "match"
      ? color.ok(`match: re-running mandate-v1 at block ${report.pinnedBlock} gives the posted score and responseHash`)
      : report.verdict === "mismatch"
        ? color.bad(`MISMATCH (${report.problems.join(", ")}): the posted verdict doesn't reproduce`)
        : color.bad(`could not verify (${report.problems.join(", ")}): nothing is proven either way`);
  return [`  verify   ${head}`, `           reasons ${reasons}`, color.dim(`           (by hand: pnpm attest8004 verify ${report.requestHash})`)];
}

// ---------- preflight ----------

interface Preflight {
  hotKey: ReturnType<typeof privateKeyToAccount>;
  owner: Address;
  creCli: string;
  latest: { number: bigint; timestamp: bigint };
}

async function preflight(): Promise<Preflight> {
  say(color.bold("Preflight"));
  const problems: string[] = [];
  const ok = (line: string) => say(`  ${color.ok("✓")} ${line}`);
  const bad = (line: string) => {
    say(`  ${color.bad("✗")} ${line}`);
    problems.push(line);
  };

  await assertChain();
  const hotKey = privateKeyToAccount(requireEnv("DEMO_AGENT_1_HOT_PRIVATE_KEY") as Hex);
  if (hotKey.address !== requireAddress("DEMO_AGENT_1_HOT_ADDRESS")) throw new Stop("DEMO_AGENT_1_HOT_ADDRESS does not match its key");
  const owner = requireAddress("DEPLOYER_ADDRESS");
  const broadcaster = requireAddress("CRE_BROADCAST_ADDRESS");
  const creKey = childEnv(process.env).CRE_ETH_PRIVATE_KEY;
  if (privateKeyToAccount((creKey.startsWith("0x") ? creKey : `0x${creKey}`) as Hex).address !== broadcaster) {
    throw new Stop("CRE_BROADCAST_ADDRESS does not match CRE_ETH_PRIVATE_KEY");
  }

  // Validator C and the trust rule.
  const code = await publicClient.getCode({ address: C });
  const [cForwarder, cRegistry, requirements] =
    code === undefined || code === "0x"
      ? [null, null, null]
      : await Promise.all([
          publicClient.readContract({ address: C, abi: creAbi, functionName: "forwarder" }),
          publicClient.readContract({ address: C, abi: creAbi, functionName: "registry" }),
          publicClient.readContract({ address: VAULT, abi: attestGateAbi, functionName: "requirements" }),
        ]);
  if (cForwarder === null) bad(`validator C (CreValidator ${C}) has no code`);
  else if (getAddress(cForwarder) !== getAddress(deployment.creForwarder) || getAddress(cRegistry as Address) !== REGISTRY) bad("CreValidator's forwarder or registry isn't the recorded one");
  else ok(`validator C is CreValidator ${C}: ${CRE_VALIDATOR_LABEL}`);
  if (requirements !== null) {
    if (creExcludedFromVault(requirements, C)) ok(`the vault requires ${requirements.map((r) => r.validator).join(" and ")}; never C`);
    else bad("the live DemoAgentVault requires validator C: no gate may require C (its forwarder lets anyone deliver)");
  }

  // Agent 1984's mandate, as mandate-v1 will read it.
  const [[terms, mandateHash, mandateOwner, setAtBlock], agentOwner, latest, fees] = await Promise.all([
    publicClient.readContract({ address: MANDATE_REGISTRY, abi: mandateRegistryAbi, functionName: "getMandate", args: [AGENT_ID] }),
    publicClient.readContract({ address: IDENTITY_REGISTRY, abi: parseAbi(["function ownerOf(uint256) view returns (address)"]), functionName: "ownerOf", args: [AGENT_ID] }),
    publicClient.getBlock(),
    publicClient.estimateFeesPerGas(),
  ]);
  if (mandateHash === zeroHash) bad(`agent ${AGENT_ID} has no mandate`);
  else if (terms.validUntil <= latest.timestamp) bad(`agent ${AGENT_ID}'s mandate expired`);
  else if (getAddress(mandateOwner) !== getAddress(agentOwner)) bad(`agent ${AGENT_ID}'s mandate was set by a previous owner`);
  else {
    try {
      await checkPermissionWindow(
        { publicClient, identityRegistry: IDENTITY_REGISTRY, forwarder: FORWARDER, mandateRegistry: MANDATE_REGISTRY },
        { agentId: AGENT_ID, owner: getAddress(agentOwner), setAtBlock, windowBlocks: MANDATE_V1.permissionWindowBlocks },
      );
      ok(`agent ${AGENT_ID}'s mandate is in force, with no permission change after it`);
    } catch (error) {
      bad(`${error instanceof Error ? error.message.split("\n")[0] : String(error)} (pnpm demo -- --scene 3b resets it)`);
    }
    const reader = viemMandateReader({ publicClient, contracts: MANDATE_CONTRACTS, concurrency: 8 });
    const head = await reader.finalized();
    const spend = await collectSpend({ reader, validator: C, agentId: AGENT_ID, pinned: head, cache: new Map() });
    if ("unreadable" in spend) bad(`C's spend is unreadable: ${String(spend.unreadable)}`);
    else if (spend.total + DEMO_VALUES.benign > terms.maxValuePerDay) bad(`C's approvals in the last 25 h (${spend.total} wei) leave no room for the benign action under the daily cap`);
    else ok(`C's own 25 h spend for agent ${AGENT_ID} is ${spend.total} wei of ${terms.maxValuePerDay}: the benign action fits`);
  }

  // Money: two forwarder requests from the hot key, two reports from the broadcast key.
  const [hotBalance, creBalance] = await Promise.all([publicClient.getBalance({ address: hotKey.address }), publicClient.getBalance({ address: broadcaster })]);
  const hotNeed = 2n * DEFAULT_GAS.forwarderRequest * fees.maxFeePerGas;
  if (hotBalance < hotNeed) bad(`agent ${AGENT_ID}'s hot key ${hotKey.address} holds ${hotBalance} wei; two requests need ${hotNeed} (faucet.monad.xyz)`);
  else ok(`agent ${AGENT_ID}'s hot key can pay for ${hotBalance / (hotNeed / 2n)} requests`);
  const budget = creBudget({ balance: creBalance, reportGas: REPORT_GAS_BUDGET, maxFeePerGas: fees.maxFeePerGas });
  if (budget.takesLeft < 1n) bad(`CRE_BROADCAST_ADDRESS ${broadcaster} holds ${creBalance} wei; one take needs ${2n * budget.perReport} (faucet.monad.xyz)`);
  else ok(`the CRE broadcast key can pay for ${budget.takesLeft} take(s) (2 reports each, ≤ ${REPORT_GAS_BUDGET} gas at the current max fee)`);

  // The CLI, Bun and the port.
  let creCli = "";
  try {
    creCli = findCreCli(process.env, existsSync);
    const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
    const version = cli(creCli, ["version"], env).trim();
    if (!version.includes(EXPECTED_CLI)) bad(`${version}; this workflow was built with CRE CLI ${EXPECTED_CLI}`);
    else ok(version);
    const bun = execFileSync("mise", ["exec", "--", "bun", "--version"], { cwd: CRE_DIR, env, encoding: "utf8" }).trim();
    if (bun !== EXPECTED_BUN) bad(`Bun ${bun} in cre/; cre/mise.toml pins ${EXPECTED_BUN}`);
    else ok(`Bun ${bun} (cre/mise.toml)`);
  } catch (error) {
    bad(error instanceof Error ? error.message.split("\n")[0] ?? "the CRE CLI failed" : String(error));
  }
  if (await portFree(EVALUATE_DEFAULTS.port)) ok(`127.0.0.1:${EVALUATE_DEFAULTS.port} is free for /evaluate`);
  else bad(`127.0.0.1:${EVALUATE_DEFAULTS.port} is in use: stop the other /evaluate service`);

  if (problems.length > 0) throw new Stop(`the preflight found ${problems.length} problem(s); nothing was sent`);
  return { hotKey, owner, creCli, latest: { number: latest.number, timestamp: latest.timestamp } };
}

// ---------- one scene ----------

interface SceneResult {
  name: string;
  ok: boolean;
  ms: number;
}

async function waitFinal(block: bigint): Promise<void> {
  const start = Date.now();
  say(color.dim(waitOpenLine(`block ${block} + 5 to finalize`)));
  for (;;) {
    const finalized = await publicClient.getBlock({ blockTag: "finalized" });
    if (finalized.number >= block + 5n) break;
    if (Date.now() - start > FINALITY_TIMEOUT_MS) throw new Stop(`block ${block} didn't finalize within ${FINALITY_TIMEOUT_MS / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  say(color.dim(waitCloseLine(Date.now() - start)));
}

/** Runs the CLI, echoing the workflow's own log lines; returns the exit code and the workflow's result line. */
function simulate(creCli: string, args: string[]): Promise<{ code: number | null; result: string | null; tail: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn("mise", ["exec", "--", creCli, ...args], { cwd: CRE_DIR, env: childEnv(process.env), stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGINT"), SIMULATE_TIMEOUT_MS);
    const tail: string[] = [];
    let result: string | null = null;
    let expectResult = false;
    let buffer = "";
    const onLine = (line: string) => {
      tail.push(line);
      if (tail.length > 30) tail.shift();
      const user = /\[USER LOG\] (.*)$/.exec(line);
      if (user) say(`  ${color.dim("CRE ▸")} ${user[1]}`);
      if (expectResult && line.trim().startsWith('"')) {
        result = parseResultLine(line); // never throws inside the stream handler (P12)
        expectResult = false;
      }
      if (line.includes("Workflow Simulation Result")) expectResult = true;
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer) onLine(buffer);
      resolve({ code, result, tail });
    });
  });
}

async function reportProcessed(txHash: Hash): Promise<{ result: boolean } | null> {
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(deployment.creForwarder)) continue;
    try {
      const event = decodeEventLog({ abi: forwarderAbi, data: log.data, topics: log.topics });
      if (getAddress(event.args.receiver) === C) return { result: event.args.result };
    } catch {
      // another event
    }
  }
  return null;
}

async function scene(o: {
  index: number;
  name: string;
  what: string;
  target: Address;
  value: bigint;
  expect: number;
  pre: Preflight;
  wasm: string;
}): Promise<SceneResult> {
  const started = Date.now();
  say();
  say(color.bold(`━━ ${o.index} · ${o.name}: ${o.what} (expect ${o.expect}) ━━`));
  const latest = await publicClient.getBlock();
  const action = buildAction({ agentId: AGENT_ID, target: o.target, value: o.value, deadline: latest.timestamp + DEADLINE_SECONDS });
  const client = new Attest8004Client({ publicClient, walletClient: walletFor(o.pre.hotKey), validationRegistry: REGISTRY, forwarder: FORWARDER });
  const [requested] = await client.requestValidation({ gate: VAULT, validators: [C], action });
  if (requested === undefined) throw new Stop("requestValidation returned nothing");
  const { requestHash, txHash, blockNumber } = requested;
  say(txLine("hot key asks validator C", txHash));
  say(`  request  ${requestHash} (block ${blockNumber})`);
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  const eventIndex = requestLogIndex(
    receipt.logs.map((l) => ({ address: getAddress(l.address), topics: l.topics as Hex[] })),
    REGISTRY,
    requestHash,
  );
  await waitFinal(blockNumber);

  const decision = simulationDecision(await readStatus(requestHash));
  if (!decision.simulate) {
    for (const line of alreadyAnsweredLines(await verify(requestHash), blockNumber)) say(`  ${line}`);
    return { name: o.name, ok: false, ms: Date.now() - started };
  }

  const args = simulateArgv({ txHash, eventIndex, wasm: o.wasm, broadcast: true });
  say("  the simulate command:");
  say(`    ${printableCommand(args)}`);
  say(color.dim(waitOpenLine("the CRE workflow: reads, /evaluate (~13 s), cross-checks, report, write")));
  const simStart = Date.now();
  const run = await simulate(o.pre.creCli, args);
  say(color.dim(waitCloseLine(Date.now() - simStart)));
  if (run.code !== 0 || run.result === null) {
    const failure = simulationFailure(run.tail);
    if (failure.kind === "NOT_LANDED") {
      say(color.bad(`  ✗ not landed: ${failure.detail}`));
    } else {
      for (const line of run.tail.slice(-8)) say(color.dim(`    ${line}`));
      say(color.bad(`  ✗ the simulation failed (exit ${run.code})`));
    }
    return { name: o.name, ok: false, ms: Date.now() - started };
  }
  const result = JSON.parse(run.result) as { declined?: string; detail?: string; score?: number; responseHash?: Hex; txHash?: Hash; gasLimit?: string };
  if (result.declined !== undefined) {
    say(color.bad(`  ✗ the workflow declined: ${result.declined}: ${result.detail}`));
    return { name: o.name, ok: false, ms: Date.now() - started };
  }

  const reportTx = result.txHash as Hash;
  const landed = landedVerdict({
    reportProcessed: await reportProcessed(reportTx),
    status: await readStatus(requestHash),
    expectedHash: result.responseHash ?? null,
    creValidator: C,
  });
  say(txLine("C's report through the forwarder", reportTx));
  // Monad charges, and its receipts and traces report, the whole limit: the workflow sized it from its own estimate.
  if (result.gasLimit !== undefined) say(color.dim(`  gas      limit ${result.gasLimit} (max(onReport estimate + routing, the calldata floor) × 1.2)`));
  if (!landed.landed) {
    say(color.bad(`  ✗ not landed: ${landed.why}`));
    return { name: o.name, ok: false, ms: Date.now() - started };
  }
  const scoreLine = `  verdict  C scored ${landed.score} under mandate-v1`;
  say(landed.score === o.expect ? color.ok(scoreLine) : color.bad(`${scoreLine} (expected ${o.expect})`));
  const reportBlock = (await publicClient.getTransactionReceipt({ hash: reportTx })).blockNumber;
  const report = await verifyWhenFinal({
    reportBlock,
    finalized: async () => (await publicClient.getBlock({ blockTag: "finalized" })).number,
    verify: () => verify(requestHash),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs: FINALITY_TIMEOUT_MS,
  });
  for (const line of verifyLines(report)) say(line);
  return { name: o.name, ok: landed.score === o.expect && report.verdict === "match", ms: Date.now() - started };
}

// ---------- main ----------

async function main(): Promise<void> {
  say(color.bold("Validator C · Chainlink CRE orchestrates mandate-v1 on Monad testnet"));
  say(color.dim(`  ${CRE_VALIDATOR_LABEL}. The vault never requires C; verify's re-execution is what makes its verdicts checkable.`));
  say();
  const pre = await preflight();
  if (PREFLIGHT_ONLY) return;

  say();
  say(color.bold("Building the workflow once (cre workflow build)"));
  const wasm = join(mkdtempSync(join(tmpdir(), "attest8004-cre-")), "validator-c.wasm");
  cli(pre.creCli, ["workflow", "build", CRE_WORKFLOW.folder, "-o", wasm], { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" });
  say(color.dim(`  ${wasm}`));

  const service = await startEvaluateService({
    publicClient,
    chainId: chain.id,
    gates: parseGateList(undefined, []),
    port: EVALUATE_DEFAULTS.port,
    log: (entry) => {
      if (entry.msg === "evaluated") say(`  ${color.dim("/evaluate ▸")} mandate-v1 ran at block ${String(entry.pinnedBlock)}: ${String(entry.status)}`);
      else if (entry.level === "error" || entry.level === "warn") say(`  ${color.dim("/evaluate ▸")} ${String(entry.msg)}${entry.error ? `: ${String(entry.error)}` : ""}`);
    },
  });
  say(color.dim(`  /evaluate (read-only, no keys) on http://${service.host}:${service.port}/evaluate`));

  const results: SceneResult[] = [];
  try {
    results.push(await scene({ index: 1, name: "benign", what: `${DEMO_VALUES.benign} wei to the owner, inside the mandate`, target: pre.owner, value: DEMO_VALUES.benign, expect: 100, pre, wasm }));
    results.push(await scene({ index: 2, name: "violating", what: `${DEMO_VALUES.rogue} wei to an address outside the mandate`, target: UNKNOWN_TARGET, value: DEMO_VALUES.rogue, expect: 0, pre, wasm }));
  } finally {
    await service.close();
  }

  say();
  say(color.bold("Summary"));
  for (const r of results) say(`  ${r.ok ? color.ok("✓") : color.bad("✗")} ${r.name.padEnd(10)} ${(r.ms / 1000).toFixed(1)} s`);
  say(`  validator C   ${addressLink(C)}`);
  say(`  dashboard     https://attest8004.vercel.app/dashboard`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.message.split("\n")[0] ?? "failed") : String(error);
  console.error(color.bad(`✗ ${message}`));
  process.exitCode = 1;
});
