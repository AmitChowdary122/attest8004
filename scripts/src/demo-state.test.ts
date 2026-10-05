import { e2eMandate, type Mandate } from "@attest8004/sdk";
import { getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  approvalFileName,
  classifyAgentKey,
  cursorIsFresh,
  demoMandateProblems,
  findServiceProcesses,
  pickApprovalFile,
  sceneBlockers,
  unexpectedOutcome,
  type DemoState,
} from "./demo-state.ts";

const OWNER = "0x3EFEB3Cf2FB54A7D99abE90AaB786cE5A831a8CF" as Address;
const FORMER = getAddress("0x00000000000000000000000000000000000000f0");
const HOT = "0xa43427fF51eEE66cc67C94Cb55f04C9432a96787" as Address;
const ROGUE = getAddress("0x00000000000000000000000000000000000000Ee");
const UNKNOWN = getAddress("0x00000000000000000000000000000000000000Aa");
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const PASS_THROUGH = "0xEEEBBa55620afC42E9c88b5d962476367b8da338" as Address;

describe("classifyAgentKey", () => {
  const o = { setBy: OWNER, owner: OWNER, hotKey: HOT, rogueKey: ROGUE };
  it("names the hot key, the rogue key, no key, a stale key and an unknown one", () => {
    expect(classifyAgentKey({ ...o, key: HOT })).toEqual({ kind: "hot" });
    expect(classifyAgentKey({ ...o, key: ROGUE })).toEqual({ kind: "rogue" });
    expect(classifyAgentKey({ ...o, key: ZERO })).toEqual({ kind: "none" });
    expect(classifyAgentKey({ ...o, key: HOT, setBy: FORMER })).toEqual({ kind: "stale", key: HOT });
    expect(classifyAgentKey({ ...o, key: UNKNOWN })).toEqual({ kind: "other", key: UNKNOWN });
    expect(classifyAgentKey({ ...o, key: ROGUE, rogueKey: null })).toEqual({ kind: "other", key: ROGUE });
  });
});

/** A state every scene can run from: the hot key, the demo mandate, funded keys, room under the cap. */
function ready(): DemoState {
  return {
    agentKey: { kind: "hot" },
    passkeySet: true,
    mandate: { present: true, demoTerms: true, expired: false, setByOwner: true },
    permissionChangedAfterMandate: false,
    rogueConfigured: true,
    shortKeys: [],
    spendFitsBenign: true,
  };
}
const none = { afterApproval: false };

describe("sceneBlockers", () => {
  it("lets every scene run from a ready state", () => {
    for (const scene of ["1", "2", "3", "3b", "4", "5"] as const) expect(sceneBlockers(scene, ready(), none)).toEqual([]);
  });

  it("blocks scene 2 while the rogue key is registered", () => {
    const blockers = sceneBlockers("2", { ...ready(), agentKey: { kind: "rogue" }, permissionChangedAfterMandate: true }, none);
    expect(blockers.some((b) => b.includes("pnpm demo --scene 3b") && b.includes("rogue"))).toBe(true);
    // Re-approving in scene 1 doesn't restore the key, so a full run is blocked too.
    expect(sceneBlockers("2", { ...ready(), agentKey: { kind: "rogue" } }, { afterApproval: true })).toHaveLength(1);
  });

  it("blocks scene 2 when mandate-v1 would fail PERMISSION_CHANGED_AFTER_MANDATE, unless scene 1 approves first", () => {
    const state = { ...ready(), permissionChangedAfterMandate: true };
    const blockers = sceneBlockers("2", state, none);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("PERMISSION_CHANGED_AFTER_MANDATE");
    expect(blockers[0]).toContain("pnpm demo --scene 3b");
    expect(sceneBlockers("2", state, { afterApproval: true })).toEqual([]);
  });

  it("blocks scene 2 on a missing, non-demo, expired or former owner's mandate, each naming scene 1, unless scene 1 approves first", () => {
    for (const mandate of [
      { present: false, demoTerms: false, expired: false, setByOwner: false },
      { present: true, demoTerms: false, expired: false, setByOwner: true },
      { present: true, demoTerms: true, expired: true, setByOwner: true },
      { present: true, demoTerms: true, expired: false, setByOwner: false },
    ]) {
      const blockers = sceneBlockers("2", { ...ready(), mandate }, none);
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toContain("pnpm demo --scene 1");
      expect(sceneBlockers("2", { ...ready(), mandate }, { afterApproval: true })).toEqual([]);
    }
  });

  it("blocks scene 2 on a short hot key, deployer or validator, naming --fund, and on a full daily cap", () => {
    for (const key of ["hotKey", "deployer", "validatorA", "validatorB"] as const) {
      const blockers = sceneBlockers("2", { ...ready(), shortKeys: [key] }, none);
      expect(blockers).toHaveLength(1);
      expect(blockers[0]).toContain("pnpm demo --fund");
    }
    expect(sceneBlockers("2", { ...ready(), shortKeys: ["rogueKey"] }, none)).toEqual([]);
    const cap = sceneBlockers("2", { ...ready(), spendFitsBenign: false }, none);
    expect(cap).toHaveLength(1);
    expect(cap[0]).toContain("pnpm demo --preflight");
  });

  it("lets scene 3 resume with the rogue key already registered after the mandate", () => {
    expect(sceneBlockers("3", { ...ready(), agentKey: { kind: "rogue" }, permissionChangedAfterMandate: true }, none)).toEqual([]);
  });

  it("blocks scene 3 when the rogue key is registered but no permission change follows the mandate", () => {
    const blockers = sceneBlockers("3", { ...ready(), agentKey: { kind: "rogue" }, permissionChangedAfterMandate: false }, none);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("--scene 3b");
  });

  it("blocks scene 3 without a configured rogue key, naming hot-keys and --fund, and on a short rogue key, deployer or validator", () => {
    const blockers = sceneBlockers("3", { ...ready(), rogueConfigured: false }, none);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("hot-keys");
    expect(blockers[0]).toContain("pnpm demo --fund");
    for (const key of ["rogueKey", "deployer", "validatorA", "validatorB"] as const) {
      expect(sceneBlockers("3", { ...ready(), shortKeys: [key] }, none)).toHaveLength(1);
    }
    expect(sceneBlockers("3", { ...ready(), shortKeys: ["hotKey"] }, none)).toEqual([]);
  });

  it("blocks scenes 1 and 3b only without a passkey or with a short deployer", () => {
    for (const scene of ["1", "3b"] as const) {
      expect(sceneBlockers(scene, { ...ready(), passkeySet: false }, none)[0]).toContain("set-passkey");
      expect(sceneBlockers(scene, { ...ready(), shortKeys: ["deployer"] }, none)[0]).toContain("pnpm demo --fund");
      const messy: DemoState = {
        ...ready(),
        agentKey: { kind: "rogue" },
        permissionChangedAfterMandate: true,
        mandate: { present: false, demoTerms: false, expired: false, setByOwner: false },
        shortKeys: ["hotKey", "rogueKey", "validatorB"],
        spendFitsBenign: false,
      };
      expect(sceneBlockers(scene, messy, none)).toEqual([]);
    }
  });

  it("never blocks scenes 4 and 5", () => {
    const worst: DemoState = {
      agentKey: { kind: "none" },
      passkeySet: false,
      mandate: { present: false, demoTerms: false, expired: true, setByOwner: false },
      permissionChangedAfterMandate: true,
      rogueConfigured: false,
      shortKeys: ["deployer", "hotKey", "rogueKey", "validatorA", "validatorB"],
      spendFitsBenign: false,
    };
    expect(sceneBlockers("4", worst, none)).toEqual([]);
    expect(sceneBlockers("5", worst, none)).toEqual([]);
  });

  it("names a command in every message", () => {
    const states: DemoState[] = [
      { ...ready(), agentKey: { kind: "rogue" } },
      { ...ready(), agentKey: { kind: "none" } },
      { ...ready(), agentKey: { kind: "stale", key: HOT } },
      { ...ready(), agentKey: { kind: "other", key: UNKNOWN } },
      { ...ready(), permissionChangedAfterMandate: true },
      { ...ready(), rogueConfigured: false },
      { ...ready(), passkeySet: false },
      { ...ready(), spendFitsBenign: false },
      { ...ready(), shortKeys: ["deployer", "hotKey", "rogueKey", "validatorA", "validatorB"] },
    ];
    for (const state of states) {
      for (const scene of ["1", "2", "3", "3b"] as const) {
        for (const message of sceneBlockers(scene, state, none)) expect(message).toMatch(/`pnpm [^`]+`/);
      }
    }
  });
});

describe("demoMandateProblems", () => {
  const expected = e2eMandate({ owner: OWNER, demoPassThrough: PASS_THROUGH });
  it("finds none in the same mandate with other letter case", () => {
    const lower: Mandate = {
      ...expected,
      allowedTargets: expected.allowedTargets.map((t) => t.toLowerCase() as Address),
      allowedSelectors: expected.allowedSelectors.map((s) => s.toUpperCase().replace("0X", "0x") as Hex),
    };
    expect(demoMandateProblems(lower, expected)).toEqual([]);
  });
  it("names one problem each for reordered targets, an extra selector, each cap and validUntil", () => {
    const one = (m: Partial<Mandate>) => demoMandateProblems({ ...expected, ...m }, expected);
    expect(one({ allowedTargets: [...expected.allowedTargets].reverse() })).toEqual([expect.stringMatching(/^TARGETS: /)]);
    expect(one({ allowedSelectors: [...expected.allowedSelectors, "0xa9059cbb"] })).toEqual([expect.stringMatching(/^SELECTORS: /)]);
    expect(one({ maxValuePerTx: 1n })).toEqual([expect.stringMatching(/^MAX_VALUE_PER_TX: /)]);
    expect(one({ maxValuePerDay: 1n })).toEqual([expect.stringMatching(/^MAX_VALUE_PER_DAY: /)]);
    expect(one({ validUntil: 1n })).toEqual([expect.stringMatching(/^VALID_UNTIL: /)]);
  });
});

describe("approval files", () => {
  const o = { agentId: 1984n, nonce: 7n, notBeforeMs: 0 };
  const name = approvalFileName(1984n, 7n);
  it("names the file the way /approve saves it", () => {
    expect(name).toBe("attest8004-approval-agent1984-nonce7.json");
  });
  it("picks the newest of Chrome's duplicates", () => {
    expect(pickApprovalFile([{ name, mtimeMs: 1 }, { name: "attest8004-approval-agent1984-nonce7 (1).json", mtimeMs: 2 }], o)).toEqual({
      file: "attest8004-approval-agent1984-nonce7 (1).json",
      ignoredOlder: 0,
    });
  });
  it("ignores an approval saved before the wait began (the boundary is inclusive)", () => {
    expect(pickApprovalFile([{ name, mtimeMs: 5 }], { ...o, notBeforeMs: 10 })).toEqual({ file: null, ignoredOlder: 1 });
    expect(pickApprovalFile([{ name, mtimeMs: 5 }, { name: "attest8004-approval-agent1984-nonce7 (1).json", mtimeMs: 10 }], { ...o, notBeforeMs: 10 })).toEqual({
      file: "attest8004-approval-agent1984-nonce7 (1).json",
      ignoredOlder: 1,
    });
  });
  it("ignores other nonces, other agents, the inbox approval and partial downloads", () => {
    const others = [
      "attest8004-approval-agent1984-nonce70.json",
      "attest8004-approval-agent19840-nonce7.json",
      "attest8004-inbox-approval-agent1984-nonce7.json",
      "attest8004-approval-agent1984-nonce7.json.crdownload",
      "attest8004-approval-agent1984-nonce6.json",
      "xattest8004-approval-agent1984-nonce7.json",
    ].map((n) => ({ name: n, mtimeMs: 100 }));
    expect(pickApprovalFile(others, o)).toEqual({ file: null, ignoredOlder: 0 });
  });
});

describe("findServiceProcesses", () => {
  it("finds the validator services by their entry point", () => {
    expect(
      findServiceProcesses([
        { pid: 11, argv: ["node", "--conditions=@attest8004/source", "--env-file=../../.env", "src/main.ts"], cwd: "/x/attest8004/validators/mandate" },
        { pid: 12, argv: ["/usr/bin/node", "/x/attest8004/validators/risk/src/main.ts"], cwd: "/" },
      ]),
    ).toEqual([
      { pid: 11, service: "mandate-v1" },
      { pid: 12, service: "risk-v1" },
    ]);
  });
  it("ignores editors, the demo itself, vitest and other node processes", () => {
    expect(
      findServiceProcesses([
        { pid: 1, argv: ["nvim", "validators/risk/src/main.ts"], cwd: "/x/attest8004" },
        { pid: 2, argv: ["node", "/x/attest8004/scripts/src/demo.ts"], cwd: "/x/attest8004" },
        { pid: 3, argv: ["node", "/x/attest8004/node_modules/vitest/vitest.mjs", "run"], cwd: "/x/attest8004/validators/risk" },
        { pid: 4, argv: ["node", "src/main.ts"], cwd: "/x/other-project" },
        { pid: 5, argv: [], cwd: null },
      ]),
    ).toEqual([]);
  });
});

describe("cursorIsFresh", () => {
  it("is true for a cursor written in the last 2 minutes", () => {
    expect(cursorIsFresh(1_000_000 - 119_000, 1_000_000)).toBe(true);
    expect(cursorIsFresh(1_000_000 - 121_000, 1_000_000)).toBe(false);
    expect(cursorIsFresh(null, 1_000_000)).toBe(false);
  });
});

describe("unexpectedOutcome", () => {
  const H = `0x${"11".repeat(32)}` as Hex;
  it("accepts a response", () => {
    expect(unexpectedOutcome("A", { kind: "responded", requestHash: H, score: 0, txHash: H, blockNumber: 1n })).toBeNull();
  });
  it("says another validator process answered first, and to stop the services, on ALREADY_RESPONDED", () => {
    const message = unexpectedOutcome("A", { kind: "skipped", requestHash: H, reason: "ALREADY_RESPONDED" });
    expect(message).toContain("another validator process answered first");
    expect(message).toContain("stop");
  });
  it("names any other skip's reason, and a missing outcome", () => {
    const declined = unexpectedOutcome("B", { kind: "skipped", requestHash: H, reason: "DECLINED", detail: "GATE_NOT_SERVED" });
    expect(declined).toContain("DECLINED");
    expect(declined).toContain("GATE_NOT_SERVED");
    expect(unexpectedOutcome("B", undefined)).toContain("no outcome");
  });
});
