import { describe, expect, it } from "vitest";
import { isAfter, permissionChangedMessage, permissionLogsIn } from "./permission-window.ts";

describe("permissionChangedMessage", () => {
  const message = permissionChangedMessage({
    violations: [{ label: "AgentKeySet", blockNumber: 68_000_100n, logIndex: 2 }],
    setAtBlock: 67_890_013n,
    baselineLogIndex: 0,
    windowBlocks: 6_000n,
  });

  it("names the event, the baseline and the block until which mandate-v1 would fail", () => {
    expect(message).toContain("mandate-v1 would score PERMISSION_CHANGED_AFTER_MANDATE until block 68006100");
    expect(message).toContain("AgentKeySet at block 68000100 (logIndex 2)");
    expect(message).toContain("after this mandate's own MandateSet at block 67890013 (logIndex 0)");
  });

  it("says how to fix it: approve the same mandate again (a new baseline), or wait", () => {
    expect(message).toContain("approve the same mandate again at https://attest8004.vercel.app/approve");
    expect(message).toContain("pnpm --filter @attest8004/scripts submit-approval <file>");
    expect(message).toContain("or wait until block 68006100");
    // set-mandate is gone: a v2 mandate needs the passkey.
    expect(message).not.toContain("set-mandate");
  });

  it("orders by (block, logIndex), as mandate-v1 does", () => {
    const at = (blockNumber: bigint, logIndex: number) => ({ label: "x", blockNumber, logIndex });
    expect(isAfter(at(10n, 0), at(9n, 5))).toBe(true);
    expect(isAfter(at(10n, 3), at(10n, 2))).toBe(true);
    expect(isAfter(at(10n, 2), at(10n, 2))).toBe(false);
    expect(isAfter(at(9n, 9), at(10n, 0))).toBe(false);
  });
});

describe("permissionLogsIn", () => {
  const IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
  const FORWARDER = "0x00000000000000000000000000000000000000f1" as const;
  const MANDATES = "0x00000000000000000000000000000000000000f2" as const;
  const OWNER = "0x3EFEB3Cf2FB54A7D99abE90AaB786cE5A831a8CF" as const;
  const OTHER = "0x00000000000000000000000000000000000000Ab" as const;

  type FakeLog = { address: string; eventName: string; args: Record<string, unknown>; blockNumber: bigint; logIndex: number };
  /** A client whose getLogs answers from `logs` by window, recording each call and how many ran at once. */
  function fakeClient(logs: FakeLog[]) {
    const calls: { address: unknown; events: unknown[]; fromBlock: bigint; toBlock: bigint }[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const client = {
      async getLogs(o: { address: unknown; events: unknown[]; fromBlock: bigint; toBlock: bigint }) {
        calls.push(o);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return logs.filter((l) => l.blockNumber >= o.fromBlock && l.blockNumber <= o.toBlock);
      },
    };
    return { client: client as never, calls, maxInFlight: () => maxInFlight };
  }
  const sources = (client: never) => ({ publicClient: client, identityRegistry: IDENTITY, forwarder: FORWARDER, mandateRegistry: MANDATES });

  it("reads each 100-block window once, for all three contracts and the eight permission events, at most 8 windows at a time", async () => {
    const fake = fakeClient([]);
    await permissionLogsIn(sources(fake.client), 1984n, OWNER, 1_000n, 2_999n);
    expect(fake.calls).toHaveLength(20);
    for (const call of fake.calls) {
      expect((call.address as string[]).map((a) => a.toLowerCase())).toEqual([IDENTITY, FORWARDER, MANDATES].map((a) => a.toLowerCase()));
      expect(call.events).toHaveLength(8);
    }
    expect(fake.maxInFlight()).toBeGreaterThan(1);
    expect(fake.maxInFlight()).toBeLessThanOrEqual(8);
  });

  it("keeps only this agent's events and this owner's ApprovalForAll, each from its own contract, oldest first", async () => {
    const log = (address: string, eventName: string, args: Record<string, unknown>, blockNumber: bigint, logIndex = 0): FakeLog => ({
      address: address.toLowerCase(),
      eventName,
      args,
      blockNumber,
      logIndex,
    });
    const fake = fakeClient([
      log(MANDATES, "MandateSet", { agentId: 1984n }, 1_300n, 4),
      log(IDENTITY, "Transfer", { tokenId: 1984n }, 1_010n),
      log(IDENTITY, "Transfer", { tokenId: 1985n }, 1_011n),
      log(IDENTITY, "Approval", { tokenId: 1984n }, 1_020n),
      log(IDENTITY, "ApprovalForAll", { owner: OWNER }, 1_030n),
      log(IDENTITY, "ApprovalForAll", { owner: OTHER }, 1_031n),
      log(FORWARDER, "AgentKeySet", { agentId: 1984n }, 1_200n, 1),
      log(FORWARDER, "AgentKeySet", { agentId: 1985n }, 1_201n),
      log(MANDATES, "AgentKeySet", { agentId: 1984n }, 1_202n),
      log(MANDATES, "MandateSet", { agentId: 1985n }, 1_301n),
      log(MANDATES, "MandateRevoked", { agentId: 1984n }, 1_400n),
      log(MANDATES, "PasskeySet", { agentId: 1984n }, 1_500n),
      log(MANDATES, "PasskeyRotated", { agentId: 1984n }, 1_600n),
      log(FORWARDER, "Transfer", { tokenId: 1984n }, 1_700n),
    ]);
    const found = await permissionLogsIn(sources(fake.client), 1984n, OWNER, 1_000n, 1_999n);
    expect(found).toEqual([
      { label: "Transfer", blockNumber: 1_010n, logIndex: 0 },
      { label: "Approval", blockNumber: 1_020n, logIndex: 0 },
      { label: "ApprovalForAll", blockNumber: 1_030n, logIndex: 0 },
      { label: "AgentKeySet", blockNumber: 1_200n, logIndex: 1 },
      { label: "MandateSet", blockNumber: 1_300n, logIndex: 4 },
      { label: "MandateRevoked", blockNumber: 1_400n, logIndex: 0 },
      { label: "PasskeySet", blockNumber: 1_500n, logIndex: 0 },
      { label: "PasskeyRotated", blockNumber: 1_600n, logIndex: 0 },
    ]);
  });

  it("reads nothing for an empty range", async () => {
    const fake = fakeClient([]);
    expect(await permissionLogsIn(sources(fake.client), 1984n, OWNER, 10n, 9n)).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});
