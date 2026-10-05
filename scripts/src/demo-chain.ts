/**
 * `pnpm demo`'s reads (P9): its keys from the environment, the demo's state on chain (one batch of reads, mandate-v1's
 * permission rule and the counted spend), Groq's use in the last 24 h from validator B's own recorded verdicts, running
 * validator services, the approval file the browser saves, the setMandate trace, and the indexer's progress.
 *
 * Keys come from the environment and are never printed; neither is the RPC URL or the LLM endpoint's URL or key.
 */
import { execFile } from "node:child_process";
import { readFile, readdir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DEPLOYMENTS,
  agentRequestForwarderAbi,
  approvalSchema,
  currentMandateRegistry,
  decodeJsonDataUri,
  e2eMandate,
  getIndexedVerdicts,
  identityRegistryAbi,
  mandateRegistryAbi,
  validationResponseEvent,
  type Approval,
  type Deployment,
  type Mandate,
} from "@attest8004/sdk";
import { MANDATE_V1, MAX_EVIDENCE_URI_BYTES, collectSpend, mandateContractsFor, viemMandateReader } from "@attest8004/validator-mandate";
import { getAbiItem, getAddress, keccak256, slice, toBytes, zeroHash, type AbiEvent, type Account, type Address, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, publicClient, requireAddress, requireEnv } from "./common.ts";
import { DEMO_VALUES, perTakeGas, takesAffordable, type KeyRole } from "./demo-budget.ts";
import {
  classifyAgentKey,
  cursorIsFresh,
  demoMandateProblems,
  findServiceProcesses,
  pickApprovalFile,
  type DemoState,
} from "./demo-state.ts";
import { plainText, printableError, type TraceFrame } from "./demo-text.ts";
import { READER_CONCURRENCY, llmSettingsFromEnv, type LlmSettings } from "./live-validators.ts";
import { checkPermissionWindow } from "./permission-window.ts";

/** The demo's contracts and agent on this chain. */
export const deployment: Deployment = DEPLOYMENTS[chain.id];
export const AGENT_ID = (deployment.demoAgents as readonly bigint[])[0] as bigint;
export const VAULT = getAddress(deployment.demoAgentVault);
export const FORWARDER = getAddress(deployment.agentRequestForwarder);
export const REGISTRY = getAddress(deployment.validationRegistry);
export const IDENTITY_REGISTRY = getAddress(deployment.identityRegistry);
export const PASS_THROUGH = getAddress(deployment.demoPassThrough);
/** The MandateRegistry agent 1984's mandate is read from and set on now. */
export const MANDATE_REGISTRY = getAddress(currentMandateRegistry(deployment).address);
export const MANDATE_CONTRACTS = mandateContractsFor(chain.id);
/** Scene 3's target: an address nobody controls, derived from a fixed label so every take sends to the same place. */
export const UNKNOWN_TARGET = getAddress(slice(keccak256(toBytes("attest8004.demo.unknown")), 12));

export interface DemoEnv {
  owner: Account;
  hotKey: Account;
  /** `null` until `hot-keys` writes DEMO_ROGUE_*. */
  rogue: Account | null;
  validatorA: Account;
  validatorB: Account;
  llm: LlmSettings;
  nansenApiKey?: string;
}

function accountFor(keyName: string, addressName: string): Account {
  const account = privateKeyToAccount(requireEnv(keyName) as Hex);
  const recorded = process.env[addressName]?.trim();
  if (recorded && getAddress(recorded) !== account.address) throw new Error(`${addressName} does not match ${keyName}`);
  return account;
}

/**
 * The runner's keys and settings from the environment. A missing rogue key is `null` (scene 3's blocker says how to
 * make it); a key that disagrees with its recorded address, or a validator key that isn't DEPLOYMENTS' validator,
 * throws.
 */
export function demoEnvFromProcess(): DemoEnv {
  const owner = accountFor("DEPLOYER_PRIVATE_KEY", "DEPLOYER_ADDRESS");
  const hotKey = accountFor("DEMO_AGENT_1_HOT_PRIVATE_KEY", "DEMO_AGENT_1_HOT_ADDRESS");
  if (requireAddress("DEMO_AGENT_1_HOT_ADDRESS") !== hotKey.address) throw new Error("DEMO_AGENT_1_HOT_ADDRESS does not match its key");
  const rogue = process.env.DEMO_ROGUE_PRIVATE_KEY?.trim() ? accountFor("DEMO_ROGUE_PRIVATE_KEY", "DEMO_ROGUE_ADDRESS") : null;
  const validatorA = accountFor("VALIDATOR_A_PRIVATE_KEY", "VALIDATOR_A_ADDRESS");
  const validatorB = accountFor("VALIDATOR_B_PRIVATE_KEY", "VALIDATOR_B_ADDRESS");
  if (validatorA.address !== getAddress(deployment.validators.mandateV1)) throw new Error("VALIDATOR_A_PRIVATE_KEY isn't the recorded validator A");
  if (validatorB.address !== getAddress(deployment.validators.riskV1)) throw new Error("VALIDATOR_B_PRIVATE_KEY isn't the recorded validator B");
  const nansenApiKey = process.env.NANSEN_API_KEY?.trim() || undefined;
  return { owner, hotKey, rogue, validatorA, validatorB, llm: llmSettingsFromEnv(process.env), ...(nansenApiKey ? { nansenApiKey } : {}) };
}

/** The demo's e2e mandate for this owner: the owner and the DemoPassThrough, plain transfers, the e2e caps. */
export function demoMandate(env: DemoEnv): Mandate {
  return e2eMandate({ owner: env.owner.address, demoPassThrough: PASS_THROUGH });
}

/** Everything the preflight and the scenes read from the chain, in one batch. */
export interface Snapshot {
  addresses: Record<KeyRole, Address | null>;
  balances: Record<KeyRole, bigint>;
  vaultBalance: bigint;
  maxFeePerGas: bigint;
  latest: { number: bigint; timestamp: bigint };
  agentOwner: Address;
  agentKey: { key: Address; setBy: Address };
  mandate: { terms: Mandate; hash: Hex; owner: Address; setAtBlock: bigint } | null;
  passkeySet: boolean;
  nonce: bigint;
  inboxKey: Hex;
  /** mandate-v1's permission rule now: `null` when no event follows the mandate, else the rule's message. */
  permissionChange: string | null;
  /** `null` when not read (`spend: false`: only scene 2 and the preflight need it; the read takes about 12 s). */
  spend: { total: bigint; counted: number; block: bigint } | { unreadable: string } | null;
}

const PERMISSION_VIOLATION = "mandate-v1 would score PERMISSION_CHANGED_AFTER_MANDATE";

/**
 * The demo's state now: one batch of reads, mandate-v1's permission rule, then (unless `spend: false`) the counted spend
 * at the finalized head. Without the spend, `spendFitsBenign` is `true`: only scene 2 checks it, and it reads the spend.
 */
export async function readDemoState(env: DemoEnv, o: { spend?: boolean } = {}): Promise<{ state: DemoState; snapshot: Snapshot }> {
  const addresses: Record<KeyRole, Address | null> = {
    deployer: env.owner.address,
    hotKey: env.hotKey.address,
    rogueKey: env.rogue?.address ?? null,
    validatorA: env.validatorA.address,
    validatorB: env.validatorB.address,
  };
  const balanceOf = (a: Address | null) => (a === null ? Promise.resolve(0n) : publicClient.getBalance({ address: a }));
  const onRegistry = { address: MANDATE_REGISTRY, abi: mandateRegistryAbi } as const;
  const [deployerBalance, hotBalance, rogueBalance, aBalance, bBalance, vaultBalance, fees, latest, agentOwner, agentKey, stored, passkey, nonce, inboxKey] =
    await Promise.all([
      balanceOf(addresses.deployer),
      balanceOf(addresses.hotKey),
      balanceOf(addresses.rogueKey),
      balanceOf(addresses.validatorA),
      balanceOf(addresses.validatorB),
      publicClient.getBalance({ address: VAULT }),
      publicClient.estimateFeesPerGas(),
      publicClient.getBlock(),
      publicClient.readContract({ address: IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: "ownerOf", args: [AGENT_ID] }),
      publicClient.readContract({ address: FORWARDER, abi: agentRequestForwarderAbi, functionName: "agentKeyOf", args: [AGENT_ID] }),
      publicClient.readContract({ ...onRegistry, functionName: "getMandate", args: [AGENT_ID] }),
      publicClient.readContract({ ...onRegistry, functionName: "passkeyOf", args: [AGENT_ID] }),
      publicClient.readContract({ ...onRegistry, functionName: "nonceOf", args: [AGENT_ID] }),
      publicClient.readContract({ ...onRegistry, functionName: "inboxKeyOf", args: [AGENT_ID] }),
    ]);
  const [terms, hash, mandateOwner, setAtBlock] = stored;
  const mandate =
    hash === zeroHash
      ? null
      : {
          terms: { ...terms, allowedTargets: terms.allowedTargets.map((t) => getAddress(t)), allowedSelectors: [...terms.allowedSelectors] },
          hash,
          owner: getAddress(mandateOwner),
          setAtBlock,
        };

  let permissionChange: string | null = null;
  if (mandate !== null) {
    try {
      await checkPermissionWindow(
        { publicClient, identityRegistry: IDENTITY_REGISTRY, forwarder: FORWARDER, mandateRegistry: MANDATE_REGISTRY },
        { agentId: AGENT_ID, owner: getAddress(agentOwner), setAtBlock, windowBlocks: MANDATE_V1.permissionWindowBlocks },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith(PERMISSION_VIOLATION)) throw error;
      permissionChange = message;
    }
  }

  let spend: Snapshot["spend"] = null;
  if (o.spend !== false) {
    const reader = viemMandateReader({ publicClient, contracts: MANDATE_CONTRACTS, concurrency: READER_CONCURRENCY });
    const head = await reader.finalized();
    const collected = await collectSpend({ reader, validator: env.validatorA.address, agentId: AGENT_ID, pinned: head, cache: new Map() });
    spend =
      "unreadable" in collected
        ? { unreadable: String(collected.unreadable) }
        : { total: collected.total, counted: collected.entries.filter((e) => e.counted).length, block: head.number };
  }

  const balances: Record<KeyRole, bigint> = { deployer: deployerBalance, hotKey: hotBalance, rogueKey: rogueBalance, validatorA: aBalance, validatorB: bBalance };
  const gas = perTakeGas();
  const shortKeys = (Object.keys(balances) as KeyRole[]).filter(
    (role) => addresses[role] !== null && takesAffordable(balances[role], gas[role], fees.maxFeePerGas) < 1,
  );
  const cap = mandate?.terms.maxValuePerDay ?? demoMandate(env).maxValuePerDay;
  const state: DemoState = {
    agentKey: classifyAgentKey({ key: agentKey[0], setBy: agentKey[1], owner: agentOwner, hotKey: env.hotKey.address, rogueKey: env.rogue?.address ?? null }),
    passkeySet: BigInt(passkey[0]) !== 0n,
    mandate: {
      present: mandate !== null,
      demoTerms: mandate !== null && demoMandateProblems(mandate.terms, demoMandate(env)).length === 0,
      expired: mandate !== null && mandate.terms.validUntil <= latest.timestamp,
      setByOwner: mandate !== null && mandate.owner === getAddress(agentOwner),
    },
    permissionChangedAfterMandate: permissionChange !== null,
    rogueConfigured: env.rogue !== null,
    shortKeys,
    spendFitsBenign: spend === null || ("total" in spend && spend.total + DEMO_VALUES.benign <= cap),
  };
  return {
    state,
    snapshot: {
      addresses,
      balances,
      vaultBalance,
      maxFeePerGas: fees.maxFeePerGas,
      latest: { number: latest.number, timestamp: latest.timestamp },
      agentOwner: getAddress(agentOwner),
      agentKey: { key: getAddress(agentKey[0]), setBy: getAddress(agentKey[1]) },
      mandate,
      passkeySet: state.passkeySet,
      nonce,
      inboxKey,
      permissionChange,
      spend,
    },
  };
}

/** `llm.usage.total` of a risk-v1 evidence document, or `null` when it isn't a non-negative integer there. */
function recordedTokens(doc: unknown): number | null {
  const total = (doc as { llm?: { usage?: { total?: unknown } } } | null)?.llm?.usage?.total;
  return typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : null;
}
const MAX_VERDICT_PAGES = 20;

/**
 * The tokens validator B recorded (`llm.usage.total` in its public risk-v1 evidence) for every response in the last
 * 24 h before `now`: the indexer lists B's verdicts with their response block, and each response's own log carries the
 * evidence. A row whose evidence can't be read is `tokens: null`. The indexer is fine here: this is a budget estimate,
 * never a verdict.
 */
export async function riskTokensLastDay(o: {
  validatorB: Address;
  now: bigint;
}): Promise<{ rows: { time: bigint; tokens: number | null }[] } | { unknown: string }> {
  const since = o.now - 86_400n;
  const inWindow: { requestHash: Hex; block: bigint; time: bigint }[] = [];
  try {
    for (let page = 0; page < MAX_VERDICT_PAGES; page++) {
      const { verdicts } = await getIndexedVerdicts({ validator: o.validatorB, limit: 200, offset: page * 200 });
      for (const v of verdicts) {
        if (v.responseTime !== null && v.responseBlock !== null && BigInt(v.responseTime) > since) {
          inWindow.push({ requestHash: v.requestHash as Hex, block: BigInt(v.responseBlock), time: BigInt(v.responseTime) });
        }
      }
      if (verdicts.length < 200) break;
    }
  } catch (error) {
    return { unknown: `the indexer didn't answer (${error instanceof Error ? error.message.slice(0, 120) : "error"})` };
  }
  const rows: { time: bigint; tokens: number | null }[] = [];
  for (const row of inWindow) {
    let tokens: number | null = null;
    try {
      const logs = await publicClient.getLogs({
        address: REGISTRY,
        event: validationResponseEvent,
        args: { requestHash: row.requestHash },
        fromBlock: row.block,
        toBlock: row.block,
      });
      const uri = logs.at(-1)?.args.responseURI;
      if (uri !== undefined) {
        const decoded = decodeJsonDataUri(uri, MAX_EVIDENCE_URI_BYTES);
        if (decoded.ok) tokens = recordedTokens(JSON.parse(decoded.text));
      }
    } catch {
      tokens = null;
    }
    rows.push({ time: row.time, tokens });
  }
  return { rows };
}

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** Each service's cursor file, as its config resolves it (validators/{mandate,risk}/src/config.ts): the env override, else the default. */
const CURSORS = [
  { service: "mandate-v1", env: "MANDATE_V1_CURSOR", path: "validators/mandate/.state/cursor.json" },
  { service: "risk-v1", env: "RISK_V1_CURSOR", path: "validators/risk/.state/cursor.json" },
] as const;

/** The running node processes on this machine: /proc on Linux, `ps` elsewhere (no cwd there). */
async function processes(): Promise<{ pid: number; argv: string[]; cwd: string | null }[]> {
  try {
    const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
    const found = await Promise.all(
      pids.map(async (pid) => {
        try {
          const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
          const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
          return { pid: Number(pid), argv, cwd };
        } catch {
          return null;
        }
      }),
    );
    return found.filter((p): p is { pid: number; argv: string[]; cwd: string | null } => p !== null);
  } catch {
    const { stdout } = await promisify(execFile)("ps", ["-eo", "pid=,args="]);
    return stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length > 1)
      .map(([pid, ...argv]) => ({ pid: Number(pid), argv, cwd: null }));
  }
}

/** Validator services that would race the runner's in-process validators: running processes, and cursors written in the last 2 minutes. */
export async function scanServices(): Promise<{ processes: { pid: number; service: string }[]; freshCursors: string[] }> {
  const found = findServiceProcesses(await processes()).filter((p) => p.pid !== process.pid);
  const freshCursors: string[] = [];
  for (const cursor of CURSORS) {
    const configured = process.env[cursor.env]?.trim();
    const path = configured ? (configured.startsWith("/") ? configured : join(REPO_ROOT, configured)) : join(REPO_ROOT, cursor.path);
    const mtimeMs = await stat(path).then((s) => s.mtimeMs, () => null);
    if (cursorIsFresh(mtimeMs, Date.now())) freshCursors.push(cursor.service);
  }
  return { processes: found, freshCursors };
}

/**
 * Waits for the approval /approve downloads for `agentId` at `nonce` into `dir`, saved after the wait began, and parses
 * it. On a TTY, `ask` races it: a typed path is read instead, `skip` returns "skip". Throws after `timeoutMs`.
 */
export async function waitForApproval(o: {
  dir: string;
  agentId: bigint;
  nonce: bigint;
  timeoutMs: number;
  ask: ((question: string, signal: AbortSignal) => Promise<string>) | null;
  say: (line: string) => void;
}): Promise<Approval | "skip"> {
  const notBeforeMs = Date.now();
  const giveUpAt = notBeforeMs + o.timeoutMs;
  const stop = new AbortController();
  const parse = async (path: string) => approvalSchema.parse(JSON.parse(await readFile(path, "utf8")));

  const typed = async (): Promise<Approval | "skip"> => {
    if (o.ask === null) return new Promise<never>(() => {});
    for (;;) {
      const answer = (await o.ask("  …or type the approval file's path (or `skip`): ", stop.signal)).trim();
      if (answer === "skip") return "skip";
      if (answer === "") continue;
      try {
        return await parse(answer);
      } catch (error) {
        o.say(`  couldn't read that file (${printableError(error).split("\n")[0]}); try again`);
      }
    }
  };

  const polled = async (): Promise<Approval> => {
    let reportedOlder = false;
    let firstParseError: number | null = null;
    while (!stop.signal.aborted) {
      if (Date.now() > giveUpAt) throw new Error(`no approval file appeared in ${o.dir} within ${Math.round(o.timeoutMs / 60_000)} minutes`);
      const names = await readdir(o.dir).catch(() => {
        throw new Error(`the approvals folder ${o.dir} can't be read (pass --approvals <dir>)`);
      });
      const entries = await Promise.all(
        names
          .filter((name) => name.startsWith("attest8004-approval-agent"))
          .map(async (name) => ({ name, mtimeMs: await stat(join(o.dir, name)).then((s) => s.mtimeMs, () => 0) })),
      );
      const { file, ignoredOlder } = pickApprovalFile(entries, { agentId: o.agentId, nonce: o.nonce, notBeforeMs });
      if (ignoredOlder > 0 && !reportedOlder) {
        o.say(`  ignoring ${ignoredOlder} approval file(s) for this nonce saved before this scene started`);
        reportedOlder = true;
      }
      if (file !== null) {
        try {
          return await parse(join(o.dir, file));
        } catch (error) {
          firstParseError ??= Date.now();
          if (Date.now() - firstParseError > 5_000) {
            o.say(`  couldn't read ${plainText(file, 120)} (${printableError(error).split("\n")[0]}); still waiting`);
            firstParseError = Number.POSITIVE_INFINITY;
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return new Promise<never>(() => {});
  };

  try {
    return await Promise.race([polled(), typed()]);
  } finally {
    stop.abort();
  }
}

/** The `callTracer` frames of a transaction, or `null` when the RPC doesn't serve traces. */
export async function traceFrames(hash: Hash): Promise<TraceFrame | null> {
  try {
    return (await publicClient.request({ method: "debug_traceTransaction" as never, params: [hash, { tracer: "callTracer" }] as never })) as TraceFrame;
  } catch {
    return null;
  }
}

/** The block the hosted indexer has processed, or `null` when it doesn't answer. */
export async function indexedTo(): Promise<bigint | null> {
  try {
    return (await getIndexedVerdicts({ agentId: AGENT_ID, limit: 1 })).indexedTo;
  } catch {
    return null;
  }
}

/** The MandateSet log that stored the mandate at `setAtBlock`: its transaction, for scene 1's link and trace. */
export async function mandateSetTx(setAtBlock: bigint): Promise<Hash | null> {
  const logs = await publicClient.getLogs({
    address: MANDATE_REGISTRY,
    event: getAbiItem({ abi: mandateRegistryAbi, name: "MandateSet" }) as AbiEvent,
    args: { agentId: AGENT_ID },
    fromBlock: setAtBlock,
    toBlock: setAtBlock,
  });
  return logs.at(-1)?.transactionHash ?? null;
}

