import { getAddress, keccak256, toHex, zeroHash, type Address, type Hash, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  REPORT_SCHEMA_V1,
  deriveInboxPrivateKey,
  encodeReport,
  findInboxEntries,
  isTrustedPost,
  openInbox,
  sealEnvelope,
  x25519PublicKey,
  type FindingsPost,
  type InboxEntry,
  type InboxReader,
  type InboxStatus,
  type OperatorReport,
} from "../src/index.ts";
import { expectAllZero, recordingTracker } from "./helpers/secrets.ts";

const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const STRANGER = getAddress("0x00000000000000000000000000000000000057a1");
const BOARD = getAddress("0xa7d52b3b08fab0cd0527c6242ca678f9feee6a1c");
const REGISTRY = getAddress("0xc4a4d0ceb3971cbe7a2536494ac106f2cd9f9a8f");
const AGENT = 1984n;
const FIRST = 1_000n;
const HEAD = 100_000n;
const BASE_TS = 1_790_000_000n;
/** Three blocks a second, like Monad: block n's timestamp. */
const ts = (n: bigint) => BASE_TS + n / 3n;
/** The first block carrying `ts(n)`. */
const firstAt = (n: bigint) => (n / 3n) * 3n;

const hashOf = (label: string): Hex => keccak256(toHex(label));

function status(label: string, responseBlock: bigint, over: Partial<InboxStatus> = {}): InboxStatus {
  return {
    requestHash: hashOf(label),
    validator: VALIDATOR,
    agentId: AGENT,
    response: 100,
    responseHash: hashOf(`evidence ${label}`),
    tag: "mandate-v1",
    lastUpdate: ts(responseBlock),
    ...over,
  };
}

function post(label: string, block: bigint, over: Partial<FindingsPost> = {}): FindingsPost {
  return {
    requestHash: hashOf(label),
    agentId: AGENT,
    validator: VALIDATOR,
    envelope: "0x01",
    blockNumber: block,
    txHash: hashOf(`post ${label} ${block}`),
    logIndex: 0,
    ...over,
  };
}

/**
 * A scripted chain. `findingsLogs` honours the block range and the requestHash, but ignores the
 * validator and agent topics unless `honourTopics` is set, so the code's own trust rule is what's tested.
 */
class FakeReader implements InboxReader {
  readonly statusList: InboxStatus[] = [];
  readonly posts: FindingsPost[] = [];
  readonly windows: Array<{ requestHash: Hex; fromBlock: bigint; toBlock: bigint }> = [];
  head_ = HEAD;
  async head() {
    return this.head_;
  }
  async blockTimestamp(block: bigint) {
    if (block > this.head_) throw new Error(`block ${block} is above the head`);
    return ts(block);
  }
  async agentValidations(agentId: bigint) {
    expect(agentId).toBe(AGENT);
    return this.statusList.map((s) => s.requestHash);
  }
  async statuses(hashes: Hex[]) {
    return hashes.map((h) => this.statusList.find((s) => s.requestHash === h) as InboxStatus);
  }
  async findingsLogs(f: { requestHash: Hex; agentId: bigint; validator: Address; fromBlock: bigint; toBlock: bigint }) {
    expect(f.toBlock - f.fromBlock).toBeLessThan(100n);
    expect(f.toBlock).toBeLessThanOrEqual(this.head_);
    this.windows.push({ requestHash: f.requestHash, fromBlock: f.fromBlock, toBlock: f.toBlock });
    return this.posts.filter((p) => p.requestHash === f.requestHash && p.blockNumber >= f.fromBlock && p.blockNumber <= f.toBlock);
  }
  async responseTx(f: { requestHash: Hex; fromBlock: bigint; toBlock: bigint }): Promise<Hash | null> {
    return f.toBlock - f.fromBlock < 10n ? hashOf(`response ${f.requestHash}`) : null;
  }
}

const board = { address: BOARD, fromBlock: FIRST };

describe("findInboxEntries", () => {
  it("finds one trusted post per answered response since the board's block, newest first, at most 20", async () => {
    const reader = new FakeReader();
    for (let i = 0; i < 25; i++) {
      const block = 5_000n + BigInt(i) * 1_000n;
      reader.statusList.push(status(`r${i}`, block));
      reader.posts.push(post(`r${i}`, block + 3n));
    }

    const entries = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board });

    expect(entries).toHaveLength(20);
    expect(entries.map((e) => e.status.requestHash)).toEqual(Array.from({ length: 20 }, (_, k) => hashOf(`r${24 - k}`)));
    for (const entry of entries) {
      expect(entry.posts).toHaveLength(1);
      expect(entry.responseTx).toBe(hashOf(`response ${entry.status.requestHash}`));
    }
  });

  it("a post from a non-validator is ignored", async () => {
    const reader = new FakeReader();
    reader.statusList.push(status("r", 5_000n));
    reader.posts.push(post("r", 5_001n, { validator: STRANGER, txHash: hashOf("stranger") }), post("r", 5_002n));

    const [entry] = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board });

    expect(entry?.posts.map((p) => p.validator)).toEqual([VALIDATOR]);
    expect(entry?.posts.map((p) => p.blockNumber)).toEqual([5_002n]);
  });

  it("a post naming another agent is ignored", async () => {
    const reader = new FakeReader();
    reader.statusList.push(status("r", 5_000n));
    reader.posts.push(post("r", 5_001n, { agentId: 1985n }));

    const [entry] = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board });

    expect(entry?.posts).toEqual([]);
  });

  it("a status whose agentId isn't the agent (a squatted hash) is skipped", async () => {
    const reader = new FakeReader();
    reader.statusList.push(status("squatted", 5_000n, { agentId: 1985n }), status("ours", 6_000n));

    const entries = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board });

    expect(entries.map((e) => e.status.requestHash)).toEqual([hashOf("ours")]);
  });

  it("a response before the board's deploy time, or still pending, is skipped", async () => {
    const reader = new FakeReader();
    reader.statusList.push(
      status("old", 900n),
      status("pending", 5_000n, { response: 0, responseHash: zeroHash, tag: "" }),
      status("ours", 6_000n),
    );

    const entries = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board });

    expect(entries.map((e) => e.status.requestHash)).toEqual([hashOf("ours")]);
  });

  it("stops at the first window with a post, reads at most 600 blocks, never past the head", async () => {
    const reader = new FakeReader();
    reader.statusList.push(status("later", 20_000n), status("nearHead", HEAD - 50n));
    const start = firstAt(20_000n);
    reader.posts.push(post("later", start + 250n));

    const entries = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board });

    const windowsFor = (label: string) => reader.windows.filter((w) => w.requestHash === hashOf(label)).map((w) => [w.fromBlock, w.toBlock]);
    expect(windowsFor("later")).toEqual([
      [start, start + 99n],
      [start + 100n, start + 199n],
      [start + 200n, start + 299n],
    ]);
    const nearStart = firstAt(HEAD - 50n);
    expect(windowsFor("nearHead")).toEqual([[nearStart, HEAD]]);
    expect(entries.find((e) => e.status.requestHash === hashOf("nearHead"))?.searchedTo).toBe(HEAD);
  });

  it("no post within 600 blocks → posts: [] with searchedTo", async () => {
    const reader = new FakeReader();
    reader.statusList.push(status("late", 30_000n));
    const start = firstAt(30_000n);
    reader.posts.push(post("late", start + 700n));

    const [entry] = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board });

    expect(entry?.posts).toEqual([]);
    expect(entry?.searchedTo).toBe(start + 599n);
    expect(reader.windows).toHaveLength(6);
  });

  it("reports progress, and an agent with no validations has no entries", async () => {
    const reader = new FakeReader();
    expect(await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board })).toEqual([]);
    reader.statusList.push(status("a", 5_000n), status("b", 6_000n));
    const seen: Array<[number, number]> = [];
    await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board, onProgress: (done, total) => seen.push([done, total]) });
    expect(seen).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });
});

describe("isTrustedPost", () => {
  it("needs the status's validator, agent and requestHash", () => {
    const s = status("r", 5_000n);
    expect(isTrustedPost(post("r", 1n), s)).toBe(true);
    expect(isTrustedPost(post("r", 1n, { validator: getAddress(VALIDATOR.toLowerCase()) }), s)).toBe(true);
    expect(isTrustedPost(post("r", 1n, { validator: STRANGER }), s)).toBe(false);
    expect(isTrustedPost(post("r", 1n, { agentId: 1985n }), s)).toBe(false);
    expect(isTrustedPost(post("other", 1n), s)).toBe(false);
  });
});

describe("openInbox", () => {
  const PRF = new Uint8Array(32).fill(9);
  const privateKey = deriveInboxPrivateKey(PRF.slice());
  const publicKey = x25519PublicKey(privateKey);
  const otherKey = x25519PublicKey(deriveInboxPrivateKey(new Uint8Array(32).fill(10)));

  function reportFor(s: InboxStatus, over: Partial<OperatorReport> = {}): OperatorReport {
    return {
      schema: REPORT_SCHEMA_V1,
      tag: s.tag,
      requestHash: s.requestHash,
      agentId: s.agentId.toString(),
      score: s.response,
      responseHash: s.responseHash,
      summary: "Approved.",
      items: [],
      notes: [],
      ...over,
    };
  }

  function sealedPost(s: InboxStatus, report: OperatorReport, recipient: Hex = publicKey): FindingsPost {
    const envelope = sealEnvelope({
      plaintext: encodeReport(report),
      context: {
        chainId: 10143,
        findingsBoard: BOARD,
        validationRegistry: REGISTRY,
        requestHash: s.requestHash,
        agentId: s.agentId,
        validator: s.validator,
        recipient,
      },
    });
    return post("x", 5_001n, { requestHash: s.requestHash, envelope });
  }

  const common = { privateKey, publicKey, chainId: 10143, findingsBoard: BOARD, validationRegistry: REGISTRY };
  const entry = (s: InboxStatus, posts: FindingsPost[]): InboxEntry => ({ status: s, responseTx: null, posts, searchedTo: 5_100n });

  it("KEY_MISMATCH when publicKey ≠ onchainInboxKey, and no envelope is opened", () => {
    const s = status("r", 5_000n);
    const tracker = recordingTracker();
    const result = openInbox({ ...common, entries: [entry(s, [sealedPost(s, reportFor(s))])], onchainInboxKey: otherKey, tracker });
    expect(result).toEqual({ ok: false, problem: "KEY_MISMATCH" });
    expect(tracker.buffers).toHaveLength(0);
  });

  it("NO_INBOX_KEY for a zero key", () => {
    expect(openInbox({ ...common, entries: [], onchainInboxKey: zeroHash })).toEqual({ ok: false, problem: "NO_INBOX_KEY" });
  });

  it("opens each post: a match, an earlier response, another key, a mismatched report, a malformed envelope", () => {
    const s = status("r", 5_000n);
    const earlier = reportFor(s, { score: 0, responseHash: hashOf("earlier evidence") });
    const posts = [
      sealedPost(s, reportFor(s)),
      sealedPost(s, earlier),
      sealedPost(s, reportFor(s), otherKey),
      sealedPost(s, reportFor(s, { requestHash: hashOf("another request") })),
      post("r", 5_009n, { envelope: "0x0102" }),
    ];
    const tracker = recordingTracker();

    const result = openInbox({ ...common, entries: [entry(s, posts)], onchainInboxKey: publicKey, tracker });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reports.map((r) => r.opened)).toEqual([
      { ok: true, report: reportFor(s), matchesOnchain: true },
      { ok: true, report: earlier, matchesOnchain: false },
      { ok: false, problem: "DECRYPT_FAILED" },
      { ok: false, problem: "REPORT_MISMATCH" },
      { ok: false, problem: "MALFORMED" },
    ]);
    expect(tracker.buffers.length).toBeGreaterThanOrEqual(3);
    expectAllZero(tracker.buffers);
  });

  it("a report whose tag differs from the status → REPORT_MISMATCH", () => {
    const s = status("r", 5_000n);
    const result = openInbox({ ...common, entries: [entry(s, [sealedPost(s, reportFor(s, { tag: "risk-v1" }))])], onchainInboxKey: publicKey });
    expect(result.ok && result.reports[0]?.opened).toEqual({ ok: false, problem: "REPORT_MISMATCH" });
  });
});
