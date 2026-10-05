/**
 * The demo's state and what it allows (P9, Decisions 6, 8 and 9): which forwarder key agent 1984 has, which scenes may
 * run from here and what fixes the rest, whether an approval is exactly the demo mandate, which downloaded approval
 * file to submit, and whether a validator service is running. Pure: the runner reads the chain, the approvals folder
 * and the process list, and passes them in.
 */
import type { Mandate, Outcome } from "@attest8004/sdk";
import { formatEther, getAddress, type Address } from "viem";
import type { SceneId } from "./demo-args.ts";
import type { KeyRole } from "./demo-budget.ts";

export type AgentKeyState =
  | { kind: "hot" }
  | { kind: "rogue" }
  | { kind: "none" }
  /** Set by a former owner of the agent: the forwarder refuses it (StaleAgentKey). */
  | { kind: "stale"; key: Address }
  | { kind: "other"; key: Address };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** What `agentKeyOf(agentId)` holds, in the demo's terms. */
export function classifyAgentKey(o: { key: Address; setBy: Address; owner: Address; hotKey: Address; rogueKey: Address | null }): AgentKeyState {
  const key = getAddress(o.key);
  if (key === ZERO_ADDRESS) return { kind: "none" };
  if (getAddress(o.setBy) !== getAddress(o.owner)) return { kind: "stale", key };
  if (key === getAddress(o.hotKey)) return { kind: "hot" };
  if (o.rogueKey !== null && key === getAddress(o.rogueKey)) return { kind: "rogue" };
  return { kind: "other", key };
}

/** What the scenes need to know, read just before they run (or once, for the preflight). */
export interface DemoState {
  agentKey: AgentKeyState;
  passkeySet: boolean;
  mandate: { present: boolean; demoTerms: boolean; expired: boolean; setByOwner: boolean };
  /** mandate-v1's permission rule fails now: a permission event came after the mandate's own MandateSet in the window. */
  permissionChangedAfterMandate: boolean;
  /** DEMO_ROGUE_PRIVATE_KEY and DEMO_ROGUE_ADDRESS are set and agree. */
  rogueConfigured: boolean;
  /** Keys that can't pay for one take at the current max fee. */
  shortKeys: KeyRole[];
  /** Scene 2's benign value still fits under the daily cap with the spend counted now. */
  spendFitsBenign: boolean;
}

const RESET = "reset with `pnpm demo --scene 3b`";
const KEY_NAMES: Record<KeyRole, string> = {
  deployer: "the deployer",
  hotKey: "agent 1984's hot key",
  rogueKey: "the demo rogue key",
  validatorA: "validator A",
  validatorB: "validator B",
};
const short = (role: KeyRole) =>
  `${KEY_NAMES[role]} can't pay for a take: top it up with \`pnpm demo --fund\`, or paste its address (the preflight prints it) into https://faucet.monad.xyz`;

/** The mandate's own problems, unless scene 1 approves a fresh demo mandate before this scene runs. */
function mandateBlockers(s: DemoState, afterApproval: boolean): string[] {
  if (afterApproval) return [];
  const approve = "approve the e2e mandate in scene 1 (`pnpm demo --scene 1`)";
  const m = s.mandate;
  if (!m.present) return [`agent 1984 has no mandate: ${approve}`];
  if (!m.setByOwner) return [`agent 1984's mandate was set by a former owner: ${approve}`];
  if (!m.demoTerms) return [`agent 1984's mandate isn't the demo's (the e2e mandate): ${approve}`];
  if (m.expired) return [`agent 1984's mandate has expired: ${approve}`];
  return [];
}

/**
 * Why `scene` must not run from state `s`, each message naming the command that fixes it; empty means run.
 * `afterApproval`: scene 1 lands a fresh demo mandate before this scene (a full run's preflight), so the stored
 * mandate's problems and a permission change before it don't count.
 */
export function sceneBlockers(scene: SceneId, s: DemoState, o: { afterApproval: boolean }): string[] {
  const blockers: string[] = [];
  const shortOf = (roles: KeyRole[]) => {
    for (const role of roles) if (s.shortKeys.includes(role)) blockers.push(short(role));
  };
  switch (scene) {
    case "1":
    case "3b":
      if (!s.passkeySet) {
        blockers.push("agent 1984 has no passkey: register one on /approve and submit it with `pnpm --filter @attest8004/scripts set-passkey`");
      }
      shortOf(["deployer"]);
      return blockers;
    case "2": {
      if (s.agentKey.kind === "rogue") {
        blockers.push(`the demo rogue key is still agent 1984's forwarder key (an interrupted scene 3): ${RESET}`);
      } else if (s.agentKey.kind !== "hot") {
        blockers.push(`agent 1984's forwarder key isn't its hot key (${s.agentKey.kind}): ${RESET}, which restores it`);
      } else if (s.permissionChangedAfterMandate && !o.afterApproval) {
        blockers.push(`a permission change came after agent 1984's mandate, so mandate-v1 would score PERMISSION_CHANGED_AFTER_MANDATE: ${RESET}`);
      }
      blockers.push(...mandateBlockers(s, o.afterApproval));
      shortOf(["hotKey", "deployer", "validatorA", "validatorB"]);
      if (!s.spendFitsBenign) {
        blockers.push(
          "agent 1984's counted spend leaves no room for scene 2's action under the daily cap: wait for older approvals to leave the 25 h window (`pnpm demo --preflight` re-checks)",
        );
      }
      return blockers;
    }
    case "3":
      if (!s.rogueConfigured) {
        blockers.push(
          "the demo rogue key isn't in .env: run `pnpm --filter @attest8004/scripts hot-keys` (it writes DEMO_ROGUE_* and prints only the address), then `pnpm demo --fund`",
        );
      }
      if (s.agentKey.kind === "rogue" && !s.permissionChangedAfterMandate && !o.afterApproval) {
        blockers.push(
          `the rogue key is registered, but agent 1984's mandate is newer than it, so mandate-v1 wouldn't see the replay's permission change: ${RESET}, then run scene 3 again`,
        );
      }
      blockers.push(...mandateBlockers(s, o.afterApproval));
      shortOf(["rogueKey", "deployer", "validatorA", "validatorB"]);
      return blockers;
    case "4":
    case "5":
      return [];
  }
}

/** Why `m` isn't exactly `expected` (the demo's e2e mandate), each as `CODE: detail`; letter case doesn't count. */
export function demoMandateProblems(m: Mandate, expected: Mandate): string[] {
  const problems: string[] = [];
  const targets = (x: Mandate) => x.allowedTargets.map((t) => getAddress(t)).join(", ");
  const selectors = (x: Mandate) => x.allowedSelectors.map((s) => s.toLowerCase()).join(", ");
  if (targets(m) !== targets(expected)) problems.push(`TARGETS: [${targets(m)}], expected [${targets(expected)}] in that order`);
  if (selectors(m) !== selectors(expected)) problems.push(`SELECTORS: [${selectors(m)}], expected [${selectors(expected)}]`);
  if (m.maxValuePerTx !== expected.maxValuePerTx) {
    problems.push(`MAX_VALUE_PER_TX: ${formatEther(m.maxValuePerTx)} MON, expected ${formatEther(expected.maxValuePerTx)} MON`);
  }
  if (m.maxValuePerDay !== expected.maxValuePerDay) {
    problems.push(`MAX_VALUE_PER_DAY: ${formatEther(m.maxValuePerDay)} MON, expected ${formatEther(expected.maxValuePerDay)} MON`);
  }
  if (m.validUntil !== expected.validUntil) problems.push(`VALID_UNTIL: ${m.validUntil}, expected ${expected.validUntil}`);
  return problems;
}

/** The file name /approve's "Download approval" gives a mandate approval (web/src/approve/ApproveChange.tsx). */
export function approvalFileName(agentId: bigint, nonce: bigint): string {
  return `attest8004-approval-agent${agentId}-nonce${nonce}.json`;
}

/**
 * The approval to submit from a folder listing: exactly this agent's mandate approval at this nonce, or one of
 * Chrome's ` (n)` duplicates of it, saved at or after `notBeforeMs` (when the wait began: an older one is left over
 * from an interrupted take, never signed on camera); the newest wins.
 */
export function pickApprovalFile(
  entries: readonly { name: string; mtimeMs: number }[],
  o: { agentId: bigint; nonce: bigint; notBeforeMs: number },
): { file: string | null; ignoredOlder: number } {
  const base = approvalFileName(o.agentId, o.nonce).replace(/\.json$/, "");
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\(\\d+\\))?\\.json$`);
  let file: { name: string; mtimeMs: number } | null = null;
  let ignoredOlder = 0;
  for (const entry of entries) {
    if (!pattern.test(entry.name)) continue;
    if (entry.mtimeMs < o.notBeforeMs) {
      ignoredOlder += 1;
      continue;
    }
    if (file === null || entry.mtimeMs > file.mtimeMs) file = entry;
  }
  return { file: file?.name ?? null, ignoredOlder };
}

const SERVICE_OF = { mandate: "mandate-v1", risk: "risk-v1" } as const;

/**
 * The validator services among running processes: a `node` process running `validators/(mandate|risk)/src/main.ts`,
 * by path or as `src/main.ts` from that directory. The demo's in-process validators would race them.
 */
export function findServiceProcesses(
  procs: readonly { pid: number; argv: readonly string[]; cwd: string | null }[],
): { pid: number; service: "mandate-v1" | "risk-v1" }[] {
  const found: { pid: number; service: "mandate-v1" | "risk-v1" }[] = [];
  for (const proc of procs) {
    const exe = proc.argv[0];
    if (exe === undefined || !(exe.split("/").pop() ?? "").startsWith("node")) continue;
    let which: "mandate" | "risk" | null = null;
    for (const arg of proc.argv.slice(1)) {
      const byPath = /(?:^|\/)validators\/(mandate|risk)\/src\/main\.ts$/.exec(arg);
      if (byPath) which = byPath[1] as "mandate" | "risk";
      else if (/^(?:\.\/)?src\/main\.ts$/.test(arg)) {
        const byCwd = /(?:^|\/)validators\/(mandate|risk)\/?$/.exec(proc.cwd ?? "");
        if (byCwd) which = byCwd[1] as "mandate" | "risk";
      }
      if (which) break;
    }
    if (which) found.push({ pid: proc.pid, service: SERVICE_OF[which] });
  }
  return found;
}

/** A service's cursor file written in the last `maxAgeMs` (2 minutes): a service is probably running somewhere. */
export function cursorIsFresh(mtimeMs: number | null, nowMs: number, maxAgeMs = 120_000): boolean {
  return mtimeMs !== null && nowMs - mtimeMs <= maxAgeMs;
}

/** Why a scene must stop on this outcome of one of its own fresh requests, or `null` for a response. */
export function unexpectedOutcome(label: string, outcome: Outcome | undefined): string | null {
  if (outcome === undefined) return `${label}: no outcome from the validator`;
  switch (outcome.kind) {
    case "responded":
      return null;
    case "skipped":
      if (outcome.reason === "ALREADY_RESPONDED") {
        return `${label}: another validator process answered first (ALREADY_RESPONDED): stop the validator services, then run this scene again`;
      }
      return `${label}: the validator didn't answer (${outcome.reason}${outcome.detail ? `: ${outcome.detail}` : ""})`;
    case "gave-up":
      return `${label}: the validator gave up (${outcome.error})`;
  }
}
