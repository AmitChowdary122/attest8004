import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  getAddress,
  keccak256,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENTS,
  TRUST_API_QUERIES,
  TrustApiError,
  confirmIndexedReport,
  confirmIndexedVerdict,
  findIndexedReports,
  findingsPostedEvent,
  getAgentTrust,
  getIndexedVerdicts,
  getTrustOverview,
  postMatchesReceipt,
  validationRegistryAbi,
  type IndexedReport,
  type IndexedVerdict,
} from "../src/index.ts";

// The SDK's client for the Envio trust API (plan Task 5). The indexer's answers are untrusted data: every one is
// validated, every result carries its onchain anchors, and the confirm* helpers re-check it from the chain.

const URL_ = "https://indexer.example/abc/v1/graphql";
const testnet = DEPLOYMENTS[10143];
const V1 = testnet.mandateRegistries[0]?.address.toLowerCase() as string;
const V2 = testnet.mandateRegistries[1]?.address.toLowerCase() as string;
const BOARD = testnet.findingsBoard.address.toLowerCase();
const A = testnet.validators.mandateV1.toLowerCase();
const B_ = testnet.validators.riskV1.toLowerCase();
const OWNER = "0x3efeb3cf2fb54a7d99abe90aab786ce5a831a8cf";
const hash = (label: string) => keccak256(toHex(label));

function verdictRow(over: Record<string, unknown> = {}) {
  return {
    id: hash("request"),
    agentId: "1984",
    validator: A,
    requestBlock: "68300000",
    requestTime: "1791173000",
    requestTx: hash("request tx"),
    requestStatus: "VERIFIED",
    gate: testnet.demoAgentVault.toLowerCase(),
    target: "0x00000000000000000000000000000000000000d4",
    value: "3000000000000000000000",
    deadline: "1791174845",
    actionHash: hash("action"),
    responses: 1,
    score: 0,
    tag: "mandate-v1",
    responseHash: hash("evidence"),
    reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"],
    evidenceStatus: "VERIFIED",
    responseBlock: 68300025,
    responseTime: "1791173115",
    responseTx: hash("response tx"),
    firstResponseBlock: "68300025",
    executedTx: null,
    executedBlock: null,
    ...over,
  };
}

const meta = (progressBlock: number | string = 68347114) => [{ chainId: 10143, progressBlock, isReady: true }];

function agentTrustBody(over: Record<string, unknown> = {}) {
  return {
    data: {
      Agent_by_pk: { id: "1984", owner: OWNER, firstSeenBlock: "67783775", hotKey: "0xa43427ff51eee66cc67c94cb55f04c9432a96787", hotKeyOwner: OWNER },
      AgentTrustSummary_by_pk: { requests: 31, answered: 27, executed: 7, trustedReports: 6, untrustedReports: 0, permissionChanges: 8, lastPermissionChangeBlock: "68296000", lastActivityBlock: "68300025" },
      AgentTagSummary: [
        { tag: "mandate-v1", verdicts: 16, scoreSum: "1000", avgScore: "62.5", zeroScores: 6, fullScores: 10, lastScore: 0, lastRequestHash: hash("request"), lastResponseBlock: "68300025" },
        { tag: "risk-v1", verdicts: 9, scoreSum: "300", avgScore: 33.333333333333336, zeroScores: 6, fullScores: 3, lastScore: 100, lastRequestHash: hash("r2"), lastResponseBlock: "68300100" },
      ],
      Mandate: [
        mandateRow(V1, "67900000"),
        mandateRow(V2, "68296500"),
      ],
      Passkey: [{ registry: V2, qx: hash("qx"), qy: hash("qy"), owner: OWNER, block: "68200000", tx: hash("passkey tx") }],
      InboxKey: [{ registry: V2, x25519Pub: hash("inbox"), owner: OWNER, changes: 1, block: "68290000", tx: hash("inbox tx") }],
      ValidationRequest: [verdictRow()],
      PermissionEvent: [
        { kind: "MANDATE_SET", source: V2, inEpoch: true, from: OWNER, to: null, approved: null, mandateHash: hash("mandate"), block: "68296500", time: "1791170000", tx: hash("set tx"), logIndex: 3 },
        { kind: "APPROVAL_FOR_ALL", source: testnet.identityRegistry.toLowerCase(), inEpoch: true, from: OWNER, to: testnet.agentRequestForwarder.toLowerCase(), approved: false, mandateHash: null, block: "67800000", time: "1791000000", tx: hash("afa tx"), logIndex: 0 },
      ],
      _meta: meta(),
      ...over,
    },
  };
}

function mandateRow(registry: string, setAtBlock: string) {
  return {
    registry,
    mandateHash: hash(`mandate ${registry}`),
    owner: OWNER,
    allowedTargets: [testnet.demoPassThrough.toLowerCase()],
    allowedSelectors: ["0x00000000"],
    maxValuePerTx: "2000000000000000",
    maxValuePerDay: "5000000000000000",
    validUntil: "1793404800",
    setAtBlock,
    active: true,
    changedBlock: setAtBlock,
    changedTx: hash(`tx ${registry}`),
  };
}

interface Call {
  url: string;
  init: RequestInit;
  body: { query: string; variables: Record<string, unknown> };
}
function fakeFetch(answer: (call: Call) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { url, init, body: JSON.parse(String(init.body)) as Call["body"] };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    if (error instanceof TrustApiError) return error.kind;
    throw error;
  }
  return "resolved";
}

describe("getAgentTrust", () => {
  it("parses a full answer: bigints, checksummed addresses, numbers given either way", async () => {
    const { fetchImpl } = fakeFetch(() => json(agentTrustBody()));
    const trust = await getAgentTrust(1984n, { url: URL_, fetchImpl });
    expect(trust).not.toBeNull();
    if (!trust) return;
    expect(trust.agentId).toBe(1984n);
    expect(trust.owner).toBe(getAddress(OWNER));
    expect(trust.firstSeenBlock).toBe(67_783_775n);
    expect(trust.indexedTo).toBe(68_347_114n);
    expect(trust.summary).toEqual({ requests: 31, answered: 27, executed: 7, trustedReports: 6, untrustedReports: 0, permissionChanges: 8, lastPermissionChangeBlock: 68_296_000n, lastActivityBlock: 68_300_025n });
    expect(trust.tags.map((t) => [t.tag, t.verdicts, t.avgScore])).toEqual([
      ["mandate-v1", 16, 62.5],
      ["risk-v1", 9, 33.333333333333336],
    ]);
    const [v] = trust.recentVerdicts;
    expect(v).toMatchObject({
      requestHash: hash("request"),
      agentId: 1984n,
      validator: getAddress(A),
      requestBlock: 68_300_000n,
      value: 3_000_000_000_000_000_000_000n,
      score: 0,
      reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"],
      responseBlock: 68_300_025n,
      responseTx: hash("response tx"),
      executedTx: null,
    });
    expect(trust.recentPermissionEvents.map((e) => e.kind)).toEqual(["MANDATE_SET", "APPROVAL_FOR_ALL"]);
    expect(trust.recentPermissionEvents[1]?.approved).toBe(false);
    expect(trust.inboxKey?.x25519Pub).toBe(hash("inbox"));
    expect(trust.passkey?.registry).toBe(getAddress(V2));
  });

  it("picks the mandate on the registry valid at indexedTo", async () => {
    const both = fakeFetch(() => json(agentTrustBody()));
    expect((await getAgentTrust(1984n, { url: URL_, fetchImpl: both.fetchImpl }))?.mandate?.registry).toBe(getAddress(V2));

    const onlyV1 = fakeFetch(() => json(agentTrustBody({ Mandate: [mandateRow(V1, "67900000")] })));
    expect((await getAgentTrust(1984n, { url: URL_, fetchImpl: onlyV1.fetchImpl }))?.mandate).toBeNull();

    const early = fakeFetch(() => json(agentTrustBody({ Mandate: [mandateRow(V1, "67900000")], _meta: meta(68_000_000) })));
    expect((await getAgentTrust(1984n, { url: URL_, fetchImpl: early.fetchImpl }))?.mandate?.registry).toBe(getAddress(V1));
  });

  it("returns null for an unindexed agent", async () => {
    const { fetchImpl } = fakeFetch(() => json(agentTrustBody({ Agent_by_pk: null, AgentTrustSummary_by_pk: null, AgentTagSummary: [], Mandate: [], Passkey: [], InboxKey: [], ValidationRequest: [], PermissionEvent: [] })));
    expect(await getAgentTrust(42n, { url: URL_, fetchImpl })).toBeNull();
  });

  it("rejects bad shapes as SHAPE", async () => {
    const bad: Record<string, unknown>[] = [
      { ValidationRequest: [verdictRow({ requestTx: "0x" + "a".repeat(63) })] },
      { ValidationRequest: [verdictRow({ reasons: ["<b>X</b>"] })] },
      { ValidationRequest: [verdictRow({ reasons: ["javascript:alert(1)"] })] },
      { ValidationRequest: [verdictRow({ score: 101 })] },
      { ValidationRequest: [verdictRow({ responseBlock: 1.5 })] },
      { ValidationRequest: [verdictRow({ responseBlock: 2 ** 60 })] },
      { ValidationRequest: [verdictRow({ requestStatus: "TRUST_ME" })] },
      { ValidationRequest: [verdictRow({ agentId: "01984" })] },
      { ValidationRequest: [verdictRow({ gate: "javascript:alert(1)" })] },
      { ValidationRequest: Array.from({ length: 21 }, () => verdictRow()) },
      { PermissionEvent: [{ kind: "SOMETHING_ELSE", source: V2, inEpoch: true, from: null, to: null, approved: null, mandateHash: null, block: "1", time: "1", tx: hash("t"), logIndex: 0 }] },
      { _meta: [] },
    ];
    for (const over of bad) {
      const { fetchImpl } = fakeFetch(() => json(agentTrustBody(over)));
      expect(await kindOf(getAgentTrust(1984n, { url: URL_, fetchImpl })), JSON.stringify(over).slice(0, 120)).toBe("SHAPE");
    }
  });

  it("shows any tag a validator chose, made printable and short", async () => {
    const { fetchImpl } = fakeFetch(() => json(agentTrustBody({ ValidationRequest: [verdictRow({ tag: "mandate-v1‮<script>" + "x".repeat(80) })] })));
    const tag = (await getAgentTrust(1984n, { url: URL_, fetchImpl }))?.recentVerdicts[0]?.tag ?? "";
    expect(tag.startsWith("mandate-v1?<script>")).toBe(true);
    expect(tag.length).toBeLessThanOrEqual(65);
    expect(/^[\x20-\x7e]*…?$/.test(tag)).toBe(true);
  });
});

describe("errors and requests", () => {
  it("maps each failure to one kind", async () => {
    const cases: [string, () => Response | Promise<Response>][] = [
      ["RATE_LIMITED", () => json({}, 429)],
      ["HTTP", () => json({}, 500)],
      ["NETWORK", () => Promise.reject(new TypeError("fetch failed"))],
      ["GRAPHQL", () => json({ errors: [{ message: "field 'x' not found" }] })],
      ["SHAPE", () => new Response("not json", { status: 200 })],
    ];
    for (const [kind, answer] of cases) {
      const { fetchImpl } = fakeFetch(answer);
      expect(await kindOf(getAgentTrust(1984n, { url: URL_, fetchImpl })), kind).toBe(kind);
    }
  });

  it("times out a request that never answers", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    expect(await kindOf(getAgentTrust(1984n, { url: URL_, fetchImpl, timeoutMs: 20 }))).toBe("TIMEOUT");
  });

  it("refuses with NOT_CONFIGURED when no trust API is recorded", async () => {
    expect(testnet.trustApi).toBeNull();
    const { fetchImpl, calls } = fakeFetch(() => json(agentTrustBody()));
    expect(await kindOf(getAgentTrust(1984n, { fetchImpl }))).toBe("NOT_CONFIGURED");
    expect(calls).toHaveLength(0);
  });

  it("sends one POST per call, without credentials or referrer, variables lowercased", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ data: { FindingsPost: [], _meta: meta() } }));
    await findIndexedReports({ url: URL_, fetchImpl, agentId: 1984n, requestHashes: [hash("one").toUpperCase().replace("0X", "0x") as Hex] });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(URL_);
    expect(call?.init).toMatchObject({ method: "POST", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error" });
    expect(call?.body.query).toBe(TRUST_API_QUERIES.findReports);
    expect(call?.body.variables).toEqual({ where: { agentId: { _eq: "1984" }, requestHash: { _in: [hash("one")] } }, limit: 200 });
  });
});

describe("findIndexedReports", () => {
  const post = (over: Record<string, unknown> = {}) => ({
    requestHash: hash("request"),
    agentId: "1984",
    validator: A,
    envelope: "0x01" + "ab".repeat(70),
    block: "68300030",
    tx: hash("post tx"),
    logIndex: 4,
    trusted: true,
    trustProblem: null,
    ...over,
  });

  it("returns trusted and untrusted posts with their flags and anchors", async () => {
    const { fetchImpl } = fakeFetch(() => json({ data: { FindingsPost: [post(), post({ validator: "0x00000000000000000000000000000000000057a1", trusted: false, trustProblem: "WRONG_VALIDATOR", logIndex: 5 })], _meta: meta() } }));
    const { reports, indexedTo } = await findIndexedReports({ url: URL_, fetchImpl, agentId: 1984n });
    expect(indexedTo).toBe(68_347_114n);
    expect(reports.map((r) => [r.trusted, r.trustProblem, r.logIndex])).toEqual([
      [true, null, 4],
      [false, "WRONG_VALIDATOR", 5],
    ]);
    expect(reports[0]).toMatchObject({ requestHash: hash("request"), agentId: 1984n, validator: getAddress(A), blockNumber: 68_300_030n, txHash: hash("post tx") });
  });

  it("refuses more than 50 request hashes before any fetch", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({}));
    const many = Array.from({ length: 51 }, (_, i) => hash(`r${i}`));
    await expect(findIndexedReports({ url: URL_, fetchImpl, requestHashes: many })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("rejects an envelope that isn't hex", async () => {
    const { fetchImpl } = fakeFetch(() => json({ data: { FindingsPost: [post({ envelope: "<img src=x>" })], _meta: meta() } }));
    expect(await kindOf(findIndexedReports({ url: URL_, fetchImpl, agentId: 1984n }))).toBe("SHAPE");
  });
});

describe("getTrustOverview", () => {
  it("merges both tags' verdicts newest first, with pending requests, validators and agents", async () => {
    const validator = (id: string, tags: string[]) => ({
      id,
      requests: 21,
      answered: 20,
      responseEvents: 20,
      scoreSum: "1400",
      avgScore: "70",
      score0: 6,
      score1to39: 0,
      score40to79: 0,
      score80to99: 0,
      score100: 14,
      latencyBlocksSum: "1831",
      latencyCount: 20,
      avgLatencyBlocks: "91.55",
      tags,
      firstSeenBlock: "67605700",
      lastActivityBlock: "68300025",
    });
    const { fetchImpl, calls } = fakeFetch(() =>
      json({
        data: {
          mandateV1: [verdictRow({ responseBlock: "68300025" })],
          riskV1: [verdictRow({ id: hash("r2"), validator: B_, tag: "risk-v1", responseBlock: "68300100", score: 40, reasons: ["FUNDS_FORWARDED"] })],
          pending: [verdictRow({ id: hash("p"), responses: 0, score: null, tag: null, responseHash: null, reasons: null, evidenceStatus: null, responseBlock: null, responseTime: null, responseTx: null, firstResponseBlock: null })],
          Validator: [validator(A, ["mandate-v1"]), validator(B_, ["risk-v1"])],
          AgentTrustSummary: [{ id: "1984" }, { id: "1985" }],
          _meta: meta(),
        },
      }),
    );
    const o = await getTrustOverview({ url: URL_, fetchImpl });
    expect(calls).toHaveLength(1);
    expect(o.verdicts.map((v) => v.tag)).toEqual(["risk-v1", "mandate-v1"]);
    expect(o.pending[0]?.score).toBeNull();
    expect(o.validators[0]).toMatchObject({ validator: getAddress(A), avgScore: 70, avgLatencyBlocks: 91.55, buckets: { score0: 6, score100: 14 } });
    expect(o.agents).toEqual([1984n, 1985n]);
    expect(o.agentsTruncated).toBe(false);
    expect(o.indexedTo).toBe(68_347_114n);
  });
});

describe("confirmIndexedVerdict", () => {
  const verdict = { requestHash: hash("request"), agentId: 1984n, validator: getAddress(A), score: 0, responseHash: hash("evidence"), tag: "mandate-v1", responses: 1 } as unknown as IndexedVerdict;
  const client = (status: readonly [Address, bigint, number, Hex, string, bigint]) =>
    ({ readContract: async () => status }) as unknown as PublicClient;

  it("is ok when the chain's status matches", async () => {
    const result = await confirmIndexedVerdict({ publicClient: client([getAddress(A), 1984n, 0, hash("evidence"), "mandate-v1", 1n]), deployment: testnet, verdict });
    expect(result).toEqual({ ok: true });
  });

  it("names each field that differs", async () => {
    expect(await confirmIndexedVerdict({ publicClient: client([getAddress(A), 1984n, 100, hash("evidence"), "mandate-v1", 1n]), deployment: testnet, verdict })).toEqual({ ok: false, problems: ["SCORE"] });
    expect(await confirmIndexedVerdict({ publicClient: client([getAddress(B_), 1985n, 0, hash("other"), "risk-v1", 1n]), deployment: testnet, verdict })).toEqual({
      ok: false,
      problems: ["VALIDATOR", "AGENT", "RESPONSE_HASH", "TAG"],
    });
    expect(await confirmIndexedVerdict({ publicClient: client([zeroAddress, 0n, 0, `0x${"00".repeat(32)}`, "", 0n]), deployment: testnet, verdict })).toEqual({ ok: false, problems: ["NOT_FOUND"] });
  });
});

describe("postMatchesReceipt and confirmIndexedReport", () => {
  const report: IndexedReport = {
    requestHash: hash("request"),
    agentId: 1984n,
    validator: getAddress(A),
    envelope: `0x01${"cd".repeat(40)}`,
    blockNumber: 68_300_030n,
    txHash: hash("post tx"),
    logIndex: 4,
    trusted: true,
    trustProblem: null,
  };
  const log = (over: { address?: string; envelope?: Hex; logIndex?: number; validator?: Address } = {}) => ({
    address: (over.address ?? BOARD) as Address,
    topics: encodeEventTopics({ abi: [findingsPostedEvent], eventName: "FindingsPosted", args: { requestHash: report.requestHash, agentId: report.agentId, validator: over.validator ?? report.validator } }) as Hex[],
    data: encodeAbiParameters([{ type: "bytes" }], [over.envelope ?? report.envelope]),
    logIndex: over.logIndex ?? 4,
  });
  const board = getAddress(BOARD);

  it("matches only the exact log", () => {
    expect(postMatchesReceipt(report, [log()], board)).toBe(true);
    expect(postMatchesReceipt(report, [log({ address: "0x00000000000000000000000000000000000000ee" })], board)).toBe(false);
    expect(postMatchesReceipt(report, [log({ envelope: `0x01${"ef".repeat(40)}` })], board)).toBe(false);
    expect(postMatchesReceipt(report, [log({ logIndex: 5 })], board)).toBe(false);
    expect(postMatchesReceipt(report, [log({ validator: getAddress(B_) })], board)).toBe(false);
    expect(postMatchesReceipt(report, [], board)).toBe(false);
  });

  it("confirms a report from the chain: the trust rule, then its receipt", async () => {
    const client = (status: readonly [Address, bigint], logs: ReturnType<typeof log>[]) =>
      ({
        readContract: async () => [status[0], status[1], 100, hash("evidence"), "mandate-v1", 1n],
        getTransactionReceipt: async () => ({ logs }),
      }) as unknown as PublicClient;
    expect(await confirmIndexedReport({ publicClient: client([getAddress(A), 1984n], [log()]), deployment: testnet, report })).toEqual({ ok: true });
    expect(await confirmIndexedReport({ publicClient: client([getAddress(B_), 1984n], [log()]), deployment: testnet, report })).toEqual({ ok: false, problems: ["UNTRUSTED"] });
    expect(await confirmIndexedReport({ publicClient: client([getAddress(A), 1984n], []), deployment: testnet, report })).toEqual({ ok: false, problems: ["NOT_ON_CHAIN"] });
  });
});

describe("getIndexedVerdicts", () => {
  it("pages through an agent's or a validator's verdicts, oldest first", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ data: { ValidationRequest: [verdictRow(), verdictRow({ id: hash("r2") })], _meta: meta() } }));
    const { verdicts, indexedTo } = await getIndexedVerdicts({ url: URL_, fetchImpl, agentId: 1984n, validator: getAddress(A), offset: 200 });
    expect(verdicts.map((v) => v.requestHash)).toEqual([hash("request"), hash("r2")]);
    expect(indexedTo).toBe(68_347_114n);
    expect(calls[0]?.body.query).toBe(TRUST_API_QUERIES.verdicts);
    expect(calls[0]?.body.variables).toEqual({ where: { agentId: { _eq: "1984" }, validator: { _eq: A } }, limit: 200, offset: 200 });
  });

  it("refuses a page over 200 or a negative offset before any fetch", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({}));
    await expect(getIndexedVerdicts({ url: URL_, fetchImpl, limit: 201 })).rejects.toThrow(RangeError);
    await expect(getIndexedVerdicts({ url: URL_, fetchImpl, offset: -1 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

// ---------- the review's fixes ----------

/** The revert viem raises when getValidationStatus meets a hash the registry never saw. */
function unknownRequestError(requestHash: Hex): Error {
  const data = encodeErrorResult({ abi: validationRegistryAbi, errorName: "UnknownRequest", args: [requestHash] });
  const reverted = new ContractFunctionRevertedError({ abi: validationRegistryAbi, data, functionName: "getValidationStatus" });
  return new ContractFunctionExecutionError(reverted, { abi: validationRegistryAbi, functionName: "getValidationStatus", args: [requestHash], contractAddress: getAddress(testnet.validationRegistry) });
}

describe("re-checks of a made-up hash (review I2)", () => {
  const forged = { requestHash: hash("forged"), agentId: 1984n, validator: getAddress(A), score: 100, responseHash: hash("ev"), tag: "mandate-v1", responses: 1 } as unknown as IndexedVerdict;

  it("confirmIndexedVerdict says NOT_FOUND when the registry reverts UnknownRequest", async () => {
    const publicClient = { readContract: async () => Promise.reject(unknownRequestError(hash("forged"))) } as unknown as PublicClient;
    expect(await confirmIndexedVerdict({ publicClient, deployment: testnet, verdict: forged })).toEqual({ ok: false, problems: ["NOT_FOUND"] });
    const raw = { readContract: async () => Promise.reject(Object.assign(new Error("execution reverted"), { code: 3, data: encodeErrorResult({ abi: validationRegistryAbi, errorName: "UnknownRequest", args: [hash("forged")] }) })) } as unknown as PublicClient;
    expect(await confirmIndexedVerdict({ publicClient: raw, deployment: testnet, verdict: forged })).toEqual({ ok: false, problems: ["NOT_FOUND"] });
  });

  it("confirmIndexedReport says UNTRUSTED for a post on a hash the registry never saw", async () => {
    const report = { requestHash: hash("forged"), agentId: 1984n, validator: getAddress(A), envelope: "0x01" as Hex, blockNumber: 1n, txHash: hash("t"), logIndex: 0, trusted: true, trustProblem: null } satisfies IndexedReport;
    const publicClient = { readContract: async () => Promise.reject(unknownRequestError(hash("forged"))) } as unknown as PublicClient;
    expect(await confirmIndexedReport({ publicClient, deployment: testnet, report })).toEqual({ ok: false, problems: ["UNTRUSTED"] });
  });

  it("still throws on an RPC failure, which isn't an answer", async () => {
    const publicClient = { readContract: async () => Promise.reject(new Error("fetch failed")) } as unknown as PublicClient;
    await expect(confirmIndexedVerdict({ publicClient, deployment: testnet, verdict: forged })).rejects.toThrow("fetch failed");
  });
});

describe("chain-controlled text can't take a whole answer down (review I1)", () => {
  it("accepts any number of tags and any tag length, showing 16 short printable ones", async () => {
    const many = Array.from({ length: 65 }, (_, i) => `tag-${i}`);
    const { fetchImpl } = fakeFetch(() =>
      json({
        data: {
          mandateV1: [verdictRow({ tag: "x".repeat(200_000) })],
          riskV1: [],
          pending: [],
          Validator: [
            {
              id: "0x00000000000000000000000000000000000057a1",
              requests: 65,
              answered: 1,
              responseEvents: 65,
              scoreSum: "0",
              avgScore: "0",
              score0: 1,
              score1to39: 0,
              score40to79: 0,
              score80to99: 0,
              score100: 0,
              latencyBlocksSum: "1",
              latencyCount: 1,
              avgLatencyBlocks: "1",
              tags: [...many, "y".repeat(200_000)],
              firstSeenBlock: "1",
              lastActivityBlock: "2",
            },
          ],
          AgentTrustSummary: [],
          _meta: meta(),
        },
      }),
    );
    const o = await getTrustOverview({ url: URL_, fetchImpl });
    expect(o.validators[0]?.tags).toEqual(many.slice(0, 16));
    expect(o.validators[0]?.tagCount).toBe(66);
    expect(o.verdicts[0]?.tag?.length).toBe(65);
  });
});

describe("findIndexedReports by request and validator (review I3)", () => {
  it("asks only for each request's own validator's posts", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ data: { FindingsPost: [], _meta: meta() } }));
    const r = await findIndexedReports({ url: URL_, fetchImpl, agentId: 1984n, requests: [{ requestHash: hash("one"), validator: getAddress(A) }, { requestHash: hash("two"), validator: getAddress(B_) }] });
    expect(r.truncated).toBe(false);
    expect(calls[0]?.body.variables).toEqual({
      where: {
        agentId: { _eq: "1984" },
        _or: [
          { requestHash: { _eq: hash("one") }, validator: { _eq: A } },
          { requestHash: { _eq: hash("two") }, validator: { _eq: B_ } },
        ],
      },
      limit: 200,
    });
  });

  it("says when an answer hit the limit and may be incomplete", async () => {
    const row = { requestHash: hash("one"), agentId: "1984", validator: A, envelope: "0x01", block: "5", tx: hash("t"), logIndex: 0, trusted: true, trustProblem: null };
    const { fetchImpl } = fakeFetch(() => json({ data: { FindingsPost: [row, row], _meta: meta() } }));
    expect((await findIndexedReports({ url: URL_, fetchImpl, agentId: 1984n, limit: 2 })).truncated).toBe(true);
    expect((await findIndexedReports({ url: URL_, fetchImpl, agentId: 1984n, limit: 3 })).truncated).toBe(false);
  });

  it("refuses more than 50 requests before any fetch", async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({}));
    const many = Array.from({ length: 51 }, (_, i) => ({ requestHash: hash(`r${i}`), validator: getAddress(A) }));
    await expect(findIndexedReports({ url: URL_, fetchImpl, requests: many })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});
