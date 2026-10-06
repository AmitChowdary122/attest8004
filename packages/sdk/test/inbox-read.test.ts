import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, zeroHash, type Address, type Hash, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  REPORT_SCHEMA_V1,
  deriveInboxPrivateKey,
  discoverInbox,
  encodeReport,
  findInboxEntries,
  findInboxEntriesViaIndexer,
  findingsPostedEvent,
  isTrustedPost,
  MAX_OTHER_VALIDATOR_RESPONSES,
  openInbox,
  reportText,
  sealEnvelope,
  x25519PublicKey,
  type FindingsPost,
  type InboxEntry,
  type InboxReader,
  type InboxStatus,
  type OperatorReport,
  type ReceiptLog,
  type TrustApiOptions,
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
  /** The receipt logs of a transaction among `posts` (the chain's posts), or null for an unknown transaction. */
  async receiptLogs(txHash: Hash): Promise<ReceiptLog[] | null> {
    const logs = this.posts.filter((p) => p.txHash === txHash).map(receiptLog);
    return logs.length > 0 ? logs : null;
  }
}

function receiptLog(p: FindingsPost): ReceiptLog {
  return {
    address: BOARD,
    topics: encodeEventTopics({ abi: [findingsPostedEvent], eventName: "FindingsPosted", args: { requestHash: p.requestHash, agentId: p.agentId, validator: p.validator } }) as Hex[],
    data: encodeAbiParameters([{ type: "bytes" }], [p.envelope]),
    logIndex: p.logIndex,
  };
}

const board = { address: BOARD, fromBlock: FIRST };

describe("P12 AUD-03: a validator the reader doesn't know can't crowd out the known ones", () => {
  const VALIDATOR_B = getAddress("0x780df855b48aec7a3907433b0b5984a2fe5dca5e");

  it("a flood of newer verdicts from an unknown validator: the known validator's verdicts come first, the others are capped and marked", async () => {
    const reader = new FakeReader();
    for (let i = 0; i < 3; i++) reader.statusList.push(status(`a${i}`, 5_000n + BigInt(i) * 100n));
    for (let i = 0; i < 25; i++) reader.statusList.push(status(`rogue${i}`, 9_000n + BigInt(i) * 100n, { validator: STRANGER }));

    const entries = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR] });

    expect(entries.slice(0, 3).map((e) => [e.status.requestHash, e.validatorKnown])).toEqual([
      [hashOf("a2"), true],
      [hashOf("a1"), true],
      [hashOf("a0"), true],
    ]);
    const others = entries.slice(3);
    expect(others).toHaveLength(MAX_OTHER_VALIDATOR_RESPONSES);
    expect(others.every((e) => !e.validatorKnown && e.status.validator === STRANGER)).toBe(true);
    expect(others[0]?.status.requestHash).toBe(hashOf("rogue24"));
  });

  it("each known validator keeps its own newest 20", async () => {
    const reader = new FakeReader();
    for (let i = 0; i < 25; i++) reader.statusList.push(status(`a${i}`, 5_000n + BigInt(i) * 100n));
    for (let i = 0; i < 2; i++) reader.statusList.push(status(`b${i}`, 1_100n + BigInt(i) * 100n, { validator: VALIDATOR_B, tag: "risk-v1" }));

    const entries = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR, VALIDATOR_B] });

    expect(entries.filter((e) => e.status.validator === VALIDATOR)).toHaveLength(20);
    expect(entries.filter((e) => e.status.validator === VALIDATOR_B)).toHaveLength(2);
    expect(entries.every((e) => e.validatorKnown)).toBe(true);
  });
});

describe("reportText: a decrypted report's strings as plain text (P12 AUD-03)", () => {
  it("replaces bidi controls, zero-width characters and C0/C1 controls, keeping ordinary Unicode", () => {
    const hostile = "pay \u202Eevil\u202C now\u200B\u2066x\u2069 \u0007\u009b — 0.002\u202FMON";
    expect(reportText(hostile)).toBe("pay ?evil? now??x? ?? — 0.002\u202FMON");
    expect(reportText("line one\nline two\ttab")).toBe("line one line two tab");
    expect(reportText("plain ascii, ünïcödé and 日本")).toBe("plain ascii, ünïcödé and 日本");
  });
});

describe("findInboxEntries", () => {
  it("finds one trusted post per answered response since the board's block, newest first, at most 20", async () => {
    const reader = new FakeReader();
    for (let i = 0; i < 25; i++) {
      const block = 5_000n + BigInt(i) * 1_000n;
      reader.statusList.push(status(`r${i}`, block));
      reader.posts.push(post(`r${i}`, block + 3n));
    }

    const entries = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR] });

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

    const [entry] = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR] });

    expect(entry?.posts.map((p) => p.validator)).toEqual([VALIDATOR]);
    expect(entry?.posts.map((p) => p.blockNumber)).toEqual([5_002n]);
  });

  it("a post naming another agent is ignored", async () => {
    const reader = new FakeReader();
    reader.statusList.push(status("r", 5_000n));
    reader.posts.push(post("r", 5_001n, { agentId: 1985n }));

    const [entry] = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR] });

    expect(entry?.posts).toEqual([]);
  });

  it("a status whose agentId isn't the agent (a squatted hash) is skipped", async () => {
    const reader = new FakeReader();
    reader.statusList.push(status("squatted", 5_000n, { agentId: 1985n }), status("ours", 6_000n));

    const entries = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR] });

    expect(entries.map((e) => e.status.requestHash)).toEqual([hashOf("ours")]);
  });

  it("a response before the board's deploy time, or still pending, is skipped", async () => {
    const reader = new FakeReader();
    reader.statusList.push(
      status("old", 900n),
      status("pending", 5_000n, { response: 0, responseHash: zeroHash, tag: "" }),
      status("ours", 6_000n),
    );

    const entries = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR] });

    expect(entries.map((e) => e.status.requestHash)).toEqual([hashOf("ours")]);
  });

  it("stops at the first window with a post, reads at most 600 blocks, never past the head", async () => {
    const reader = new FakeReader();
    reader.statusList.push(status("later", 20_000n), status("nearHead", HEAD - 50n));
    const start = firstAt(20_000n);
    reader.posts.push(post("later", start + 250n));

    const entries = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR] });

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

    const [entry] = await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR] });

    expect(entry?.posts).toEqual([]);
    expect(entry?.searchedTo).toBe(start + 599n);
    expect(reader.windows).toHaveLength(6);
  });

  it("reports progress, and an agent with no validations has no entries", async () => {
    const reader = new FakeReader();
    expect(await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR] })).toEqual([]);
    reader.statusList.push(status("a", 5_000n), status("b", 6_000n));
    const seen: Array<[number, number]> = [];
    await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR], onProgress: (done, total) => seen.push([done, total]) });
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
  const entry = (s: InboxStatus, posts: FindingsPost[]): InboxEntry => ({ status: s, responseTx: null, posts, searchedTo: 5_100n, source: "chain", validatorKnown: true });

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

/** A fake trust API serving `rows` as FindingsPost answers (filtered by the requested hashes), indexed to `indexedTo`. */
function fakeTrustApi(rows: (FindingsPost & { trusted?: boolean })[], indexedTo: bigint, answer?: () => Response | Promise<Response>): TrustApiOptions & { calls: number } {
  const o = {
    url: "https://indexer.example/x/v1/graphql",
    calls: 0,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      o.calls += 1;
      if (answer) return answer();
      const { variables } = JSON.parse(String(init.body)) as {
        variables: { where: { requestHash?: { _in: string[] }; _or?: { requestHash: { _eq: string }; validator: { _eq: string } }[] }; limit: number };
      };
      const where = variables.where;
      const wanted = (r: FindingsPost) =>
        where._or
          ? where._or.some((p) => p.requestHash._eq === r.requestHash.toLowerCase() && p.validator._eq === r.validator.toLowerCase())
          : new Set(where.requestHash?._in ?? []).has(r.requestHash.toLowerCase());
      const FindingsPost = rows
        .filter(wanted)
        .slice(0, variables.limit)
        .map((r) => ({
          requestHash: r.requestHash,
          agentId: r.agentId.toString(),
          validator: r.validator.toLowerCase(),
          envelope: r.envelope,
          block: r.blockNumber.toString(),
          tx: r.txHash,
          logIndex: r.logIndex,
          trusted: r.trusted ?? true,
          trustProblem: r.trusted === false ? "WRONG_VALIDATOR" : null,
        }));
      return new Response(JSON.stringify({ data: { FindingsPost, _meta: [{ chainId: 10143, progressBlock: Number(indexedTo), isReady: true }] } }), { status: 200 });
    }) as unknown as typeof fetch,
  };
  return o;
}

describe("findInboxEntriesViaIndexer", () => {
  it("finds a report 5,000 blocks after its verdict, beyond the chain scan's 600", async () => {
    const reader = new FakeReader();
    reader.statusList.push(status("r", 10_000n));
    const p = post("r", 15_000n);
    reader.posts.push(p);
    const api = fakeTrustApi([p], 20_000n);

    const { entries, rejected, indexedTo } = await findInboxEntriesViaIndexer(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR], trustApi: api });

    expect(api.calls).toBe(1);
    expect(indexedTo).toBe(20_000n);
    expect(rejected).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "indexer", searchedTo: 20_000n, responseTx: hashOf(`response ${hashOf("r")}`) });
    expect(entries[0]?.posts).toEqual([p]);
    expect(reader.windows).toEqual([]);
    expect((await findInboxEntries(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR] }))[0]?.posts).toEqual([]);
  });

  it("keeps only posts the chain's status trusts, whatever the indexer says", async () => {
    const reader = new FakeReader();
    reader.statusList.push(status("r", 10_000n));
    const stranger = post("r", 10_005n, { validator: STRANGER, txHash: hashOf("stranger post") });
    reader.posts.push(stranger);
    const { entries, rejected } = await findInboxEntriesViaIndexer(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR], trustApi: fakeTrustApi([{ ...stranger, trusted: true }], 20_000n) });
    expect(entries[0]?.posts).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it("drops a post its receipt doesn't carry", async () => {
    const reader = new FakeReader();
    reader.statusList.push(status("r", 10_000n));
    const forged = post("r", 10_005n, { envelope: "0x01beef", txHash: hashOf("forged") });
    const altered = post("r", 10_006n, { envelope: "0x01cafe", txHash: hashOf("altered"), logIndex: 1 });
    reader.posts.push({ ...altered, envelope: "0x01f00d" });
    const { entries, rejected } = await findInboxEntriesViaIndexer(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR], trustApi: fakeTrustApi([forged, altered], 20_000n) });
    expect(entries[0]?.posts).toEqual([]);
    expect(rejected.map((r) => [r.post.txHash, r.problem])).toEqual([
      [hashOf("forged"), "NOT_ON_CHAIN"],
      [hashOf("altered"), "NOT_ON_CHAIN"],
    ]);
  });

  it("chain-scans verdicts newer than the indexer's progress block", async () => {
    const reader = new FakeReader();
    // Indexed to 10,200: the verdict at 10,000 still has 400 unindexed blocks of its 600-block window; the one at
    // 5,000 is fully indexed and has no report.
    reader.statusList.push(status("old", 5_000n), status("recent", 10_000n));
    const p = post("recent", firstAt(10_000n) + 400n);
    reader.posts.push(p);
    const { entries } = await findInboxEntriesViaIndexer(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR], trustApi: fakeTrustApi([], 10_200n) });
    const byLabel = (label: string) => entries.find((e) => e.status.requestHash === hashOf(label));
    expect(byLabel("recent")).toMatchObject({ source: "chain", posts: [p] });
    expect(byLabel("old")).toMatchObject({ source: "indexer", posts: [], searchedTo: 10_200n });
    expect(reader.windows.every((w) => w.requestHash === hashOf("recent"))).toBe(true);
  });
});

describe("discoverInbox", () => {
  const setup = () => {
    const reader = new FakeReader();
    reader.statusList.push(status("a", 5_000n), status("b", 6_000n));
    reader.posts.push(post("a", 5_003n), post("b", 6_004n));
    return reader;
  };

  it("uses the indexer when it answers", async () => {
    const reader = setup();
    const result = await discoverInbox(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR], trustApi: fakeTrustApi(reader.posts, 50_000n) });
    expect(result).toMatchObject({ via: "indexer", fallbackReason: null, indexedTo: 50_000n });
    expect(result.entries.map((e) => [e.source, e.posts.length])).toEqual([
      ["indexer", 1],
      ["indexer", 1],
    ]);
  });

  it("falls back to the chain scan when the indexer fails", async () => {
    const answers: [string, () => Response | Promise<Response>][] = [
      ["RATE_LIMITED", () => new Response("{}", { status: 429 })],
      ["NETWORK", () => Promise.reject(new TypeError("fetch failed"))],
      ["SHAPE", () => new Response(JSON.stringify({ data: { FindingsPost: [{ requestHash: "<script>" }], _meta: [] } }), { status: 200 })],
      ["HTTP", () => new Response("{}", { status: 502 })],
    ];
    const expected = await findInboxEntries(setup(), { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR] });
    for (const [kind, answer] of answers) {
      const result = await discoverInbox(setup(), { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR], trustApi: fakeTrustApi([], 50_000n, answer) });
      expect(result.via, kind).toBe("chain");
      expect(result.fallbackReason, kind).toContain(kind);
      expect(result.indexedTo).toBeNull();
      expect(result.entries, kind).toEqual(expected);
    }
  });

  it("times out a hanging indexer and falls back", async () => {
    const hang = fakeTrustApi([], 50_000n);
    const trustApi = {
      ...hang,
      timeoutMs: 20,
      fetchImpl: ((_u: string, init: RequestInit) =>
        new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch,
    };
    const result = await discoverInbox(setup(), { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR], trustApi });
    expect(result.via).toBe("chain");
    expect(result.fallbackReason).toContain("TIMEOUT");
  });

  it("uses the chain scan when no trust API is recorded", async () => {
    const result = await discoverInbox(setup(), { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR], trustApi: null });
    expect(result).toMatchObject({ via: "chain", fallbackReason: null, indexedTo: null });
    expect(result.entries.every((e) => e.source === "chain" && e.posts.length === 1)).toBe(true);
  });
});

describe("strangers' posts on a request (review I3)", () => {
  it("200 junk posts on the request don't hide the validator's report", async () => {
    const reader = new FakeReader();
    reader.statusList.push(status("r", 10_000n));
    const junk = Array.from({ length: 200 }, (_, i) => post("r", 10_001n, { validator: STRANGER, txHash: hashOf(`junk ${i}`), logIndex: i }));
    const real = post("r", 10_005n);
    reader.posts.push(...junk, real);
    const result = await discoverInbox(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR], trustApi: fakeTrustApi([...junk, real], 20_000n) });
    expect(result.via).toBe("indexer");
    expect(result.entries[0]?.posts).toEqual([real]);
  });

  it("an answer that hit the limit falls back to the chain scan", async () => {
    const reader = new FakeReader();
    reader.statusList.push(status("r", 10_000n));
    const real = post("r", 10_005n);
    reader.posts.push(real);
    // 200 posts by the requested validator itself: a full page, so the answer may be missing some.
    const full = Array.from({ length: 200 }, (_, i) => post("r", 10_006n, { txHash: hashOf(`more ${i}`), logIndex: i }));
    const result = await discoverInbox(reader, { agentId: AGENT, findingsBoard: board, knownValidators: [VALIDATOR], trustApi: fakeTrustApi(full, 20_000n) });
    expect(result.via).toBe("chain");
    expect(result.fallbackReason).toContain("INCOMPLETE");
    expect(result.entries[0]?.posts).toEqual([real]);
  });
});
