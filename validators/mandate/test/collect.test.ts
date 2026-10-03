import {
  canonicalJson,
  computeActionHashFromParts,
  computeRequestHashFromParts,
  encodeCanonicalJsonDataUri,
  toBase64,
  type RequestParts,
  type ValidationStatus,
} from "@attest8004/sdk";
import { getAddress, keccak256, stringToBytes, toHex, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import {
  collectInputs,
  collectSpend,
  countsTowardSpend,
  MandateSetLogNotFoundError,
  parseApprovalParts,
  SpendLogNotFoundError,
  type PreimageCache,
} from "../src/collect.ts";
import { MANDATE_V1 } from "../src/params.ts";
import type { MandateReader } from "../src/reader.ts";
import type { MandateInputs, MandateRecord, PermissionEvent, PinnedBlock, Simulation } from "../src/types.ts";

const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const OTHER_VALIDATOR = getAddress("0x00000000000000000000000000000000000000b0");
const GATE = getAddress("0x23bfbd12545ccd1501dda1b65a54518fd6212a96");
const OTHER_GATE = getAddress("0x00000000000000000000000000000000000000d4");
const OWNER = getAddress("0x3efeb3cf2fb54a7d99abe90aab786ce5a831a8cf");
const TARGET = getAddress("0x00000000000000000000000000000000000000b2");
const AGENT = 1_984n;
const CHAIN_ID = 10_143;
const P: PinnedBlock = { number: 70_000_000n, hash: keccak256(toHex("block P")), timestamp: 1_790_000_000n };
const SINCE = P.timestamp - MANDATE_V1.spendWindowSeconds;
const EMPTY_DATA_HASH = keccak256("0x");

type EvidenceAnswer = string | null | (() => string | null);

/** A scripted `MandateReader` that records every block it is asked to read at. */
class FakeReader implements MandateReader {
  readonly reads: Array<{ method: string; at: bigint }> = [];
  readonly logRanges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  readonly evidenceCalls: Array<{ requestHash: Hex; timestamp: bigint; notAfter: bigint }> = [];
  readonly consumedCalls: Array<{ gate: Address; actionHash: Hex }> = [];
  readonly simulateCalls: Array<{ from: Address; to: Address; value: bigint; data: Hex; gas: bigint }> = [];
  mandateRecord: MandateRecord | null = mandateAt(P.number - 10_000n);
  owner: Address = OWNER;
  validations: Hex[] = [];
  readonly statuses = new Map<Hex, ValidationStatus>();
  readonly evidence = new Map<Hex, EvidenceAnswer>();
  readonly consumedByAction = new Map<Hex, boolean | null>();
  permissionEvents: Array<Omit<PermissionEvent, "afterMandate">> = [];
  simulation: Simulation | Error = { ok: true };

  async chainId() {
    return CHAIN_ID;
  }
  async finalized() {
    return P;
  }
  async block(number: bigint) {
    return { number, hash: keccak256(toHex(number)), timestamp: P.timestamp };
  }
  async mandate(agentId: bigint, at: bigint) {
    this.reads.push({ method: "mandate", at });
    expect(agentId).toBe(AGENT);
    return this.mandateRecord;
  }
  async ownerOf(agentId: bigint, at: bigint) {
    this.reads.push({ method: "ownerOf", at });
    expect(agentId).toBe(AGENT);
    return this.owner;
  }
  async agentValidations(agentId: bigint, at: bigint) {
    this.reads.push({ method: "agentValidations", at });
    expect(agentId).toBe(AGENT);
    return [...this.validations];
  }
  async status(requestHash: Hex, at: bigint) {
    this.reads.push({ method: "status", at });
    const status = this.statuses.get(requestHash);
    if (!status) throw new Error(`FakeReader: no status for ${requestHash}`);
    return status;
  }
  async consumed(gate: Address, actionHash: Hex, at: bigint) {
    this.reads.push({ method: "consumed", at });
    this.consumedCalls.push({ gate, actionHash });
    const consumed = this.consumedByAction.get(actionHash);
    if (consumed === undefined) throw new Error(`FakeReader: no consumed() answer for ${actionHash}`);
    return consumed;
  }
  async permissionLogs(fromBlock: bigint, toBlock: bigint, filter: { agentId: bigint; owner: Address }) {
    this.logRanges.push({ fromBlock, toBlock });
    expect(filter).toEqual({ agentId: AGENT, owner: this.owner });
    return this.permissionEvents.map((event) => ({ ...event }));
  }
  async simulate(call: { from: Address; to: Address; value: bigint; data: Hex; gas: bigint }, at: bigint) {
    this.reads.push({ method: "simulate", at });
    this.simulateCalls.push(call);
    if (this.simulation instanceof Error) throw this.simulation;
    return this.simulation;
  }
  async responseEvidence(requestHash: Hex, timestamp: bigint, notAfter: bigint) {
    this.evidenceCalls.push({ requestHash, timestamp, notAfter });
    const answer = this.evidence.get(requestHash);
    if (answer === undefined) throw new Error(`FakeReader: no evidence scripted for ${requestHash}`);
    return typeof answer === "function" ? answer() : answer;
  }
  async requestUri(): Promise<string | null> {
    throw new Error("FakeReader: collectInputs never reads a request URI");
  }
}

function mandateAt(setAtBlock: bigint): MandateRecord {
  return {
    allowedTargets: [TARGET],
    allowedSelectors: [MANDATE_V1.plainTransferSelector],
    maxValuePerTx: 2_000n,
    maxValuePerDay: 5_000n,
    validUntil: P.timestamp + 86_400n,
    mandateHash: keccak256(toHex("mandate")),
    owner: OWNER,
    setAtBlock,
  };
}

function request(): MandateInputs["request"] {
  const parts = {
    chainId: CHAIN_ID,
    gate: GATE,
    agentId: AGENT,
    target: TARGET,
    value: 1_000n,
    dataHash: EMPTY_DATA_HASH,
    deadline: P.timestamp + 600n,
    salt: keccak256(toHex("current salt")),
  };
  return {
    block: P.number - 5n,
    requestHash: computeRequestHashFromParts({ ...parts, validator: VALIDATOR }),
    chainId: CHAIN_ID,
    gate: GATE,
    agentId: AGENT,
    target: TARGET,
    value: parts.value,
    data: "0x",
    deadline: parts.deadline,
    salt: parts.salt,
  };
}

/** The evidence document a `mandate-v1` approval carries (only the keys the collector reads, plus a few). */
function evidenceDoc(parts: Omit<RequestParts, "validator">, requestHash: Hex): Record<string, unknown> {
  return {
    schema: "attest8004.evidence.v1",
    validator: "mandate-v1",
    requestHash,
    score: 100,
    reasons: [],
    block: { number: (P.number - 1_000n).toString(), hash: keccak256(toHex("approval block")), timestamp: "1789999000" },
    request: {
      block: (P.number - 1_001n).toString(),
      chainId: Number(parts.chainId),
      gate: parts.gate,
      agentId: parts.agentId.toString(),
      target: parts.target,
      value: parts.value.toString(),
      dataHash: parts.dataHash,
      selector: MANDATE_V1.plainTransferSelector,
      deadline: parts.deadline.toString(),
      salt: parts.salt,
    },
    simulation: { ok: true },
  };
}

interface Approval {
  requestHash: Hex;
  parts: Omit<RequestParts, "validator">;
  actionHash: Hex;
  uri: string;
  status: ValidationStatus;
}

let saltCounter = 0;

/** A `mandate-v1` approval by VALIDATOR of one of AGENT's actions, with authentic evidence. */
function approval(o: {
  value: bigint;
  deadline: bigint;
  lastUpdate?: bigint;
  gate?: Address;
  validator?: Address;
  tag?: string;
  response?: number;
}): Approval {
  const validator = o.validator ?? VALIDATOR;
  const parts = {
    chainId: CHAIN_ID,
    gate: o.gate ?? GATE,
    agentId: AGENT,
    target: TARGET,
    value: o.value,
    dataHash: EMPTY_DATA_HASH,
    deadline: o.deadline,
    salt: keccak256(toHex(`salt ${saltCounter++}`)),
  };
  const requestHash = computeRequestHashFromParts({ ...parts, validator });
  const { uri, hash } = encodeCanonicalJsonDataUri(evidenceDoc(parts, requestHash));
  return {
    requestHash,
    parts,
    actionHash: computeActionHashFromParts(parts),
    uri,
    status: {
      validator,
      agentId: AGENT,
      response: o.response ?? 100,
      responseHash: hash,
      tag: o.tag ?? MANDATE_V1.tag,
      lastUpdate: o.lastUpdate ?? P.timestamp - 3_600n,
    },
  };
}

function add(reader: FakeReader, a: Approval, consumed: boolean | null = true): Approval {
  reader.validations.push(a.requestHash);
  reader.statuses.set(a.requestHash, a.status);
  reader.evidence.set(a.requestHash, a.uri);
  reader.consumedByAction.set(a.actionHash, consumed);
  return a;
}

/** A base64 data: URI of `text`, plus keccak256 of its bytes. */
function rawUri(text: string): { uri: string; hash: Hex } {
  const bytes = stringToBytes(text);
  return { uri: `data:application/json;base64,${toBase64(bytes)}`, hash: keccak256(bytes) };
}

let reader: FakeReader;
let cache: PreimageCache;
beforeEach(() => {
  reader = new FakeReader();
  cache = new Map();
});

function collect() {
  return collectInputs({ reader, validator: VALIDATOR, request: request(), pinned: P, cache });
}

async function spendOf(): Promise<Extract<MandateInputs["spend"], { entries: unknown }>> {
  const { spend } = await collect();
  if (spend === null || "unreadable" in spend) throw new Error(`expected a spend document, got ${JSON.stringify(spend)}`);
  return spend;
}

describe("countsTowardSpend", () => {
  // P.ts = 1,000
  it.each([
    { consumed: true, deadline: 500n, counts: true, why: "consumed, whatever its deadline" },
    { consumed: false, deadline: 1_000n, counts: true, why: "unconsumed with deadline == P.ts: it can still execute" },
    { consumed: false, deadline: 999n, counts: false, why: "expired unconsumed: it can never execute" },
    { consumed: null, deadline: 999n, counts: true, why: "unknown: fail closed" },
    { consumed: false, deadline: 1_001n, counts: true, why: "unconsumed with deadline after P.ts" },
    { consumed: true, deadline: 2_000n, counts: true, why: "consumed before its deadline" },
    { consumed: null, deadline: 5_000n, counts: true, why: "unknown and still live" },
  ])("$why → $counts", ({ consumed, deadline, counts }) => {
    expect(countsTowardSpend(consumed, deadline, 1_000n)).toBe(counts);
  });
});

describe("collectInputs: which entries count toward spend", () => {
  it("an expired unconsumed approval appears with counted: false and is not in total", async () => {
    const spent = add(reader, approval({ value: 700n, deadline: P.timestamp - 1n }), true);
    const expired = add(reader, approval({ value: 1_500n, deadline: P.timestamp - 1n }), false);
    const live = add(reader, approval({ value: 300n, deadline: P.timestamp }), false);
    const unknown = add(reader, approval({ value: 50n, deadline: P.timestamp - 100n }), null);

    const spend = await spendOf();
    expect(spend.since).toBe(SINCE);
    expect(spend.entries).toEqual([
      { requestHash: spent.requestHash, approvedAt: spent.status.lastUpdate, gate: GATE, value: 700n, deadline: P.timestamp - 1n, consumed: true, counted: true },
      { requestHash: expired.requestHash, approvedAt: expired.status.lastUpdate, gate: GATE, value: 1_500n, deadline: P.timestamp - 1n, consumed: false, counted: false },
      { requestHash: live.requestHash, approvedAt: live.status.lastUpdate, gate: GATE, value: 300n, deadline: P.timestamp, consumed: false, counted: true },
      { requestHash: unknown.requestHash, approvedAt: unknown.status.lastUpdate, gate: GATE, value: 50n, deadline: P.timestamp - 100n, consumed: null, counted: true },
    ]);
    expect(spend.total).toBe(700n + 300n + 50n);
  });

  it("reads consumed() on each approval's own gate, with its action hash", async () => {
    const a = add(reader, approval({ value: 1n, deadline: P.timestamp, gate: OTHER_GATE }), true);
    const b = add(reader, approval({ value: 2n, deadline: P.timestamp }), true);
    await spendOf();
    expect(reader.consumedCalls).toEqual([
      { gate: OTHER_GATE, actionHash: a.actionHash },
      { gate: GATE, actionHash: b.actionHash },
    ]);
  });
});

describe("collectInputs: which approvals are entries", () => {
  it("only this validator's mandate-v1 approvals (response 100) inside the 25 h window, in getAgentValidations order", async () => {
    const otherValidator = add(reader, approval({ value: 1n, deadline: P.timestamp, validator: OTHER_VALIDATOR }));
    const otherTag = add(reader, approval({ value: 2n, deadline: P.timestamp, tag: "attest8004-e2e-stub" }));
    const rejected = add(reader, approval({ value: 4n, deadline: P.timestamp, response: 0 }));
    const atEdge = add(reader, approval({ value: 8n, deadline: P.timestamp, lastUpdate: P.timestamp - 90_000n }));
    const justInside = add(reader, approval({ value: 16n, deadline: P.timestamp, lastUpdate: P.timestamp - 89_999n }));
    const recent = add(reader, approval({ value: 32n, deadline: P.timestamp, lastUpdate: P.timestamp }));

    const spend = await spendOf();
    expect(spend.entries.map((e) => e.requestHash)).toEqual([justInside.requestHash, recent.requestHash]);
    expect(spend.total).toBe(48n);
    // Non-entries never cost an evidence lookup.
    const looked = reader.evidenceCalls.map((c) => c.requestHash);
    for (const skipped of [otherValidator, otherTag, rejected, atEdge]) expect(looked).not.toContain(skipped.requestHash);
  });

  it("matches the validator address case-insensitively", async () => {
    const a = approval({ value: 5n, deadline: P.timestamp });
    a.status = { ...a.status, validator: VALIDATOR.toLowerCase() as Address };
    add(reader, a);
    expect((await spendOf()).total).toBe(5n);
  });

  it("skips the request being evaluated", async () => {
    const current = request();
    reader.validations.push(current.requestHash);
    const other = add(reader, approval({ value: 9n, deadline: P.timestamp }));
    const spend = await spendOf();
    expect(spend.entries.map((e) => e.requestHash)).toEqual([other.requestHash]);
    // Its status was never read (the fake has none for it, and would have thrown).
    expect(reader.reads.filter((r) => r.method === "status")).toHaveLength(1);
  });

  it("an agent with no validations has an empty spend", async () => {
    await expect(spendOf()).resolves.toEqual({ since: SINCE, entries: [], total: 0n });
  });
});

describe("collectSpend: an agent's spend at P for no request in particular (a check before requesting)", () => {
  it("is the spend collectInputs records for a verdict at the same P, with the same entries and total", async () => {
    add(reader, approval({ value: 700n, deadline: P.timestamp - 1n }), true);
    add(reader, approval({ value: 1_500n, deadline: P.timestamp - 1n }), false);
    add(reader, approval({ value: 300n, deadline: P.timestamp }), false);
    add(reader, approval({ value: 9n, deadline: P.timestamp, response: 0 }));

    const spend = await collectSpend({ reader, validator: VALIDATOR, agentId: AGENT, pinned: P, cache: new Map() });

    expect(spend).toEqual((await collect()).spend);
    expect(spend).toMatchObject({ since: SINCE, total: 1_000n });
  });

  it("skips nothing unless told which request to leave out", async () => {
    const a = add(reader, approval({ value: 40n, deadline: P.timestamp }));
    const b = add(reader, approval({ value: 2n, deadline: P.timestamp }));

    const all = await collectSpend({ reader, validator: VALIDATOR, agentId: AGENT, pinned: P, cache });
    const withoutA = await collectSpend({ reader, validator: VALIDATOR, agentId: AGENT, pinned: P, cache, exclude: a.requestHash });

    expect(all).toMatchObject({ total: 42n, entries: [{ requestHash: a.requestHash }, { requestHash: b.requestHash }] });
    expect(withoutA).toMatchObject({ total: 2n, entries: [{ requestHash: b.requestHash }] });
  });

  it("reads every input at P, and a missing approval log still throws (never a smaller spend)", async () => {
    const a = add(reader, approval({ value: 40n, deadline: P.timestamp }));
    reader.evidence.set(a.requestHash, null);

    await expect(collectSpend({ reader, validator: VALIDATOR, agentId: AGENT, pinned: P, cache })).rejects.toBeInstanceOf(SpendLogNotFoundError);
    expect(reader.reads.every((r) => r.at === P.number)).toBe(true);
  });
});

describe("collectInputs: preimage cache and evidence authentication", () => {
  it("a cache hit makes no responseEvidence call", async () => {
    const a = approval({ value: 400n, deadline: P.timestamp });
    add(reader, a);
    reader.evidence.delete(a.requestHash); // would throw if asked
    cache.set(a.requestHash, a.parts);
    const spend = await spendOf();
    expect(reader.evidenceCalls).toEqual([]);
    expect(spend.total).toBe(400n);
  });

  it("a miss looks the evidence up by the approval's lastUpdate, never past P, and caches the authenticated parts", async () => {
    const a = add(reader, approval({ value: 400n, deadline: P.timestamp, lastUpdate: P.timestamp - 7_000n }));
    await spendOf();
    expect(reader.evidenceCalls).toEqual([{ requestHash: a.requestHash, timestamp: P.timestamp - 7_000n, notAfter: P.number }]);
    expect(cache.get(a.requestHash)).toEqual(a.parts);
  });

  it("evidence whose keccak isn't the approval's responseHash is unreadable", async () => {
    const a = approval({ value: 400n, deadline: P.timestamp });
    const evidenceHash = a.status.responseHash;
    const posted = keccak256(toHex("something else"));
    a.status = { ...a.status, responseHash: posted };
    add(reader, a);
    const { spend } = await collect();
    expect(spend).toEqual({ unreadable: `${a.requestHash}: evidence hash ${evidenceHash} is not the responseHash ${posted}` });
    expect(cache.has(a.requestHash)).toBe(false);
  });

  it("evidence that hashes correctly but isn't mandate-v1 evidence is unreadable", async () => {
    const a = approval({ value: 400n, deadline: P.timestamp });
    const notMandate = rawUri(canonicalJson({ schema: "attest8004.evidence.v1", validator: "risk-qwen-v1", requestHash: a.requestHash, score: 100, reasons: [] }));
    a.uri = notMandate.uri;
    a.status = { ...a.status, responseHash: notMandate.hash };
    add(reader, a);
    const { spend } = await collect();
    expect(spend).toEqual({ unreadable: `${a.requestHash}: not mandate-v1 evidence (invalid at validator)` });
  });

  it("evidence that hashes correctly but isn't JSON is unreadable", async () => {
    const a = approval({ value: 400n, deadline: P.timestamp });
    const notJson = rawUri("not json at all");
    a.uri = notJson.uri;
    a.status = { ...a.status, responseHash: notJson.hash };
    add(reader, a);
    const { spend } = await collect();
    expect(spend).toEqual({ unreadable: `${a.requestHash}: not mandate-v1 evidence (not JSON)` });
  });

  it("a response URI that isn't a JSON data: URI is unreadable", async () => {
    const a = approval({ value: 400n, deadline: P.timestamp });
    a.uri = "https://example.com/evidence.json";
    add(reader, a);
    const { spend } = await collect();
    expect(spend).toEqual({ unreadable: `${a.requestHash}: response URI rejected (URI_NOT_DATA)` });
  });

  it("request parts that hash to another requestHash are unreadable", async () => {
    const a = approval({ value: 400n, deadline: P.timestamp });
    // Same evidence, but the logged value was edited down: it hashes fine, the parts don't.
    const doc = evidenceDoc({ ...a.parts, value: 1n }, a.requestHash);
    const edited = encodeCanonicalJsonDataUri(doc);
    a.uri = edited.uri;
    a.status = { ...a.status, responseHash: edited.hash };
    add(reader, a);
    const { spend } = await collect();
    const recomputed = computeRequestHashFromParts({ ...a.parts, value: 1n, validator: VALIDATOR });
    expect(spend).toEqual({ unreadable: `${a.requestHash}: evidence request parts recompute to requestHash ${recomputed}` });
  });

  it("evidence that names another requestHash is unreadable", async () => {
    const a = approval({ value: 400n, deadline: P.timestamp });
    const other = approval({ value: 400n, deadline: P.timestamp });
    const doc = evidenceDoc(a.parts, other.requestHash);
    const edited = encodeCanonicalJsonDataUri(doc);
    a.uri = edited.uri;
    a.status = { ...a.status, responseHash: edited.hash };
    add(reader, a);
    const { spend } = await collect();
    expect(spend).toEqual({ unreadable: `${a.requestHash}: evidence names requestHash ${other.requestHash}` });
  });

  it("reports the first unreadable approval in getAgentValidations order", async () => {
    add(reader, approval({ value: 1n, deadline: P.timestamp }));
    const first = approval({ value: 2n, deadline: P.timestamp });
    const firstEvidenceHash = first.status.responseHash;
    first.status = { ...first.status, responseHash: keccak256(toHex("x")) };
    add(reader, first);
    const second = approval({ value: 3n, deadline: P.timestamp });
    second.status = { ...second.status, responseHash: keccak256(toHex("y")) };
    add(reader, second);
    const { spend } = await collect();
    expect(spend).toEqual({
      unreadable: `${first.requestHash}: evidence hash ${firstEvidenceHash} is not the responseHash ${keccak256(toHex("x"))}`,
    });
  });

  it("test_SpendLogLookupFailsTransiently_Throws_ThenSucceeds", async () => {
    const a = add(reader, approval({ value: 600n, deadline: P.timestamp }), true);
    let calls = 0;
    reader.evidence.set(a.requestHash, () => (++calls === 1 ? null : a.uri));

    // First cycle: the log isn't found (RPC or log-index lag). That's not evidence: it throws, nothing is unreadable.
    const error = await collect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpendLogNotFoundError);
    expect((error as SpendLogNotFoundError).requestHash).toBe(a.requestHash);
    expect(cache.has(a.requestHash)).toBe(false);

    // Next cycle: the log is there, and the approval counts.
    const { spend } = await collect();
    expect(spend).toEqual({
      since: SINCE,
      entries: [
        { requestHash: a.requestHash, approvedAt: a.status.lastUpdate, gate: GATE, value: 600n, deadline: P.timestamp, consumed: true, counted: true },
      ],
      total: 600n,
    });
    expect(calls).toBe(2);
  });

  it("a missing log throws even when another approval is unreadable", async () => {
    const bad = approval({ value: 1n, deadline: P.timestamp });
    bad.status = { ...bad.status, responseHash: keccak256(toHex("x")) };
    add(reader, bad);
    const missing = add(reader, approval({ value: 2n, deadline: P.timestamp }));
    reader.evidence.set(missing.requestHash, null);
    await expect(collect()).rejects.toBeInstanceOf(SpendLogNotFoundError);
  });

  it("a reader failure (consumed, status) throws rather than becoming a verdict", async () => {
    const a = add(reader, approval({ value: 1n, deadline: P.timestamp }));
    reader.consumedByAction.delete(a.actionHash); // the fake throws
    await expect(collect()).rejects.toThrow(/consumed/);
  });
});

describe("parseApprovalParts", () => {
  const a = approval({ value: 123n, deadline: P.timestamp });
  const valid = () => evidenceDoc(a.parts, a.requestHash) as Record<string, unknown> & { request: Record<string, unknown> };

  it("returns the evidence's requestHash and its request parts", () => {
    expect(parseApprovalParts(canonicalJson(valid()))).toEqual({ requestHash: a.requestHash, parts: a.parts });
  });

  // The error text is ours, never a library's: it can end up in hashed evidence (`unreadable`), so
  // it must not change when a dependency is upgraded. With several faults, the first field in a fixed
  // order is the one named.
  it.each<[string, (doc: ReturnType<typeof valid>) => unknown, string]>([
    ["not JSON", () => "{", "not JSON"],
    ["a JSON array", () => "[1,2]", "not a JSON object"],
    ["JSON null", () => "null", "not a JSON object"],
    ["another schema", (doc) => ({ ...doc, schema: "attest8004.evidence.v2" }), "invalid at schema"],
    ["another validator tag", (doc) => ({ ...doc, validator: "risk-qwen-v1" }), "invalid at validator"],
    ["no request", (doc) => ({ ...doc, request: undefined }), "invalid at request"],
    ["request as an array", (doc) => ({ ...doc, request: [] }), "invalid at request"],
    ["no score", (doc) => ({ ...doc, score: undefined }), "invalid at score"],
    ["a fractional score", (doc) => ({ ...doc, score: 99.5 }), "invalid at score"],
    ["reasons that aren't strings", (doc) => ({ ...doc, reasons: [1] }), "invalid at reasons"],
    ["an unknown key in request", (doc) => ({ ...doc, request: { ...doc.request, data: "0x" } }), "unknown key in request"],
    ["a missing request key", (doc) => ({ ...doc, request: { ...doc.request, salt: undefined } }), "invalid at request.salt"],
    ["value as a JSON number", (doc) => ({ ...doc, request: { ...doc.request, value: 123 } }), "invalid at request.value"],
    ["value with a leading zero", (doc) => ({ ...doc, request: { ...doc.request, value: "0123" } }), "invalid at request.value"],
    ["chainId as a string", (doc) => ({ ...doc, request: { ...doc.request, chainId: "10143" } }), "invalid at request.chainId"],
    ["a deadline above uint64", (doc) => ({ ...doc, request: { ...doc.request, deadline: (2n ** 64n).toString() } }), "invalid at request.deadline"],
    ["a bad address checksum", (doc) => ({ ...doc, request: { ...doc.request, gate: "0x23bfbd12545ccd1501dda1b65a54518fd6212A96" } }), "invalid at request.gate"],
    ["a short salt", (doc) => ({ ...doc, request: { ...doc.request, salt: "0x1234" } }), "invalid at request.salt"],
    ["a malformed selector", (doc) => ({ ...doc, request: { ...doc.request, selector: "0x1234" } }), "invalid at request.selector"],
    ["a malformed requestHash", (doc) => ({ ...doc, requestHash: "0x1234" }), "invalid at requestHash"],
    ["a bad value and a bad gate (gate comes first)", (doc) => ({ ...doc, request: { ...doc.request, value: "x", gate: "0x12" } }), "invalid at request.gate"],
    ["a bad request field and a bad requestHash (requestHash comes first)", (doc) => ({ ...doc, requestHash: "0x", request: { ...doc.request, value: "x" } }), "invalid at requestHash"],
    ["an unknown key and a bad value (known fields come first)", (doc) => ({ ...doc, request: { ...doc.request, value: "x", extra: 1 } }), "invalid at request.value"],
  ])("rejects %s", (_, edit, error) => {
    const edited = edit(valid());
    const text = typeof edited === "string" ? edited : JSON.stringify(edited);
    expect(parseApprovalParts(text)).toEqual({ error });
  });

  it("accepts a null selector (data too short for one)", () => {
    const doc = valid();
    doc.request.selector = null;
    expect(parseApprovalParts(JSON.stringify(doc))).toEqual({ requestHash: a.requestHash, parts: a.parts });
  });
});

describe("collectInputs: permission ordering against the current mandate", () => {
  const S = P.number - 100n;
  const event = (block: bigint, logIndex: number, e: PermissionEvent["event"], emitter: PermissionEvent["emitter"]) => ({
    block,
    logIndex,
    txHash: keccak256(toHex(`${block}:${logIndex}`)),
    emitter,
    event: e,
  });

  it("compares (block, logIndex) with the mandate's own MandateSet log; that log is not after itself", async () => {
    reader.mandateRecord = mandateAt(S);
    reader.permissionEvents = [
      event(S - 1n, 9, "Approval", "IdentityRegistry"),
      event(S, 4, "Transfer", "IdentityRegistry"),
      event(S, 5, "MandateSet", "MandateRegistry"),
      event(S, 6, "AgentKeySet", "AgentRequestForwarder"),
      event(S + 1n, 0, "ApprovalForAll", "IdentityRegistry"),
    ];
    const { permissions } = await collect();
    expect(permissions.events.map((e) => [e.block, e.logIndex, e.afterMandate])).toEqual([
      [S - 1n, 9, false],
      [S, 4, false],
      [S, 5, false],
      [S, 6, true],
      [S + 1n, 0, true],
    ]);
    expect(permissions.events[3]).toEqual({ ...event(S, 6, "AgentKeySet", "AgentRequestForwarder"), afterMandate: true });
  });

  it("with two MandateSet logs in setAtBlock, the last one is the current mandate", async () => {
    reader.mandateRecord = mandateAt(S);
    reader.permissionEvents = [
      event(S, 2, "MandateSet", "MandateRegistry"),
      event(S, 5, "ApprovalForAll", "IdentityRegistry"),
      event(S, 7, "MandateSet", "MandateRegistry"),
      event(S, 8, "Transfer", "IdentityRegistry"),
    ];
    const { permissions } = await collect();
    expect(permissions.events.map((e) => e.afterMandate)).toEqual([false, false, false, true]);
  });

  it("a mandate set before the window: every event in the window is after it", async () => {
    reader.mandateRecord = mandateAt(P.number - MANDATE_V1.permissionWindowBlocks); // just outside (P - N, P]
    reader.permissionEvents = [
      event(P.number - MANDATE_V1.permissionWindowBlocks + 1n, 0, "Transfer", "IdentityRegistry"),
      event(P.number, 3, "MandateRevoked", "MandateRegistry"),
    ];
    const { permissions } = await collect();
    expect(permissions.events.map((e) => e.afterMandate)).toEqual([true, true]);
  });

  it("with no mandate, every event is after it, and spend is null with no spend reads", async () => {
    reader.mandateRecord = null;
    reader.permissionEvents = [event(S, 1, "MandateRevoked", "MandateRegistry"), event(S + 1n, 0, "Transfer", "IdentityRegistry")];
    const inputs = await collect();
    expect(inputs.mandate).toBeNull();
    expect(inputs.spend).toBeNull();
    expect(inputs.permissions.events.map((e) => e.afterMandate)).toEqual([true, true]);
    expect(reader.reads.map((r) => r.method)).not.toContain("agentValidations");
  });

  it("a mandate set inside the window whose MandateSet log isn't found throws, never a verdict", async () => {
    reader.mandateRecord = mandateAt(S);
    reader.permissionEvents = [event(S - 1n, 0, "MandateSet", "MandateRegistry"), event(S, 1, "Transfer", "IdentityRegistry")];
    await expect(collect()).rejects.toBeInstanceOf(MandateSetLogNotFoundError);
  });

  it("a mandate set after P is inconsistent and throws", async () => {
    reader.mandateRecord = mandateAt(P.number + 1n);
    await expect(collect()).rejects.toBeInstanceOf(MandateSetLogNotFoundError);
  });
});

describe("collectInputs: the pin", () => {
  it("every reader call reads at P, and every log range ends at or before P", async () => {
    add(reader, approval({ value: 10n, deadline: P.timestamp }), false);
    const cached = add(reader, approval({ value: 20n, deadline: P.timestamp }), true);
    cache.set(cached.requestHash, cached.parts);
    reader.mandateRecord = mandateAt(P.number - 50n);
    reader.permissionEvents = [
      { block: P.number - 50n, logIndex: 0, txHash: keccak256(toHex("tx")), emitter: "MandateRegistry", event: "MandateSet" },
    ];
    await collect();

    const methods = new Set(reader.reads.map((r) => r.method));
    for (const method of ["mandate", "ownerOf", "agentValidations", "status", "consumed", "simulate"]) expect(methods).toContain(method);
    for (const read of reader.reads) expect(read.at).toBe(P.number);
    expect(reader.logRanges).toEqual([{ fromBlock: P.number - MANDATE_V1.permissionWindowBlocks + 1n, toBlock: P.number }]);
    for (const call of reader.evidenceCalls) expect(call.notAfter).toBe(P.number);
  });

  it("records the permission window it read, (P - N, P] as an inclusive [fromBlock, toBlock]", async () => {
    const { permissions } = await collect();
    expect(permissions.fromBlock).toBe(P.number - MANDATE_V1.permissionWindowBlocks + 1n);
    expect(permissions.toBlock).toBe(P.number);
  });

  it("clamps the window at block 0", async () => {
    const early: PinnedBlock = { number: 1_000n, hash: keccak256(toHex("early")), timestamp: P.timestamp };
    reader.mandateRecord = mandateAt(10n);
    reader.permissionEvents = [{ block: 10n, logIndex: 0, txHash: keccak256(toHex("tx")), emitter: "MandateRegistry", event: "MandateSet" }];
    const inputs = await collectInputs({ reader, validator: VALIDATOR, request: request(), pinned: early, cache });
    expect(reader.logRanges).toEqual([{ fromBlock: 0n, toBlock: 1_000n }]);
    expect(inputs.permissions.fromBlock).toBe(0n);
  });

  it("simulates the action from its gate at P with the simulation gas cap, and passes the outcome through", async () => {
    reader.simulation = { ok: false, error: "REVERTED", revertSelector: "0x12345678" };
    const inputs = await collect();
    const r = request();
    expect(reader.simulateCalls).toEqual([{ from: GATE, to: TARGET, value: r.value, data: r.data, gas: MANDATE_V1.simulationGas }]);
    expect(inputs.simulation).toEqual({ ok: false, error: "REVERTED", revertSelector: "0x12345678" });
  });

  it("a simulation that throws (a transient RPC failure) rejects collectInputs", async () => {
    reader.simulation = new Error("HTTP request failed. Status: 429");
    await expect(collect()).rejects.toThrow(/429/);
  });

  it("returns the pinned block, the owner at P, the request and the mandate as read", async () => {
    const inputs = await collect();
    expect(inputs.pinned).toEqual(P);
    expect(inputs.owner).toBe(OWNER);
    expect(inputs.request).toEqual(request());
    expect(inputs.mandate).toEqual(reader.mandateRecord);
  });
});
