import {
  Admission,
  buildAction,
  buildRequestJson,
  decodeJsonDataUri,
  encodeCanonicalJsonDataUri,
  encodeJsonDataUri,
  MemoryCursorStore,
  requestHashOfJson,
  toBase64,
  validationRegistryAbi,
  type RequestEvent,
  type RequestJsonV1,
  type ValidationStatus,
  type ValidatorChain,
} from "@attest8004/sdk";
import {
  AbiDecodingZeroDataError,
  encodeErrorResult,
  getAddress,
  HttpRequestError,
  keccak256,
  RpcRequestError,
  stringToBytes,
  toHex,
  UnknownRpcError,
  zeroAddress,
  zeroHash,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeRpc, revert } from "../../../packages/sdk/test/helpers/fake-rpc.ts";
import { MAX_EVIDENCE_URI_BYTES, SpendLogNotFoundError } from "../src/collect.ts";
import { MANDATE_V1 } from "../src/params.ts";
import { mandateAddressesFor, viemMandateReader, type MandateAddresses, type ResponseLog, type VerifyReader } from "../src/reader.ts";
import type { MandateRecord, PermissionEvent, PinnedBlock, Simulation } from "../src/types.ts";
import { MandateValidator, PIN_LAG_BLOCKS } from "../src/validator.ts";
import { verifyContextFor, verifyRequest, type VerifyReport } from "../src/verify.ts";

const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const OTHER_VALIDATOR = getAddress("0x00000000000000000000000000000000000000b0");
const GATE = getAddress("0x23bfbd12545ccd1501dda1b65a54518fd6212a96");
const OWNER = getAddress("0x3efeb3cf2fb54a7d99abe90aab786ce5a831a8cf");
const UNLISTED = getAddress("0x00000000000000000000000000000000000000b2");
const OTHER_MANDATE_REGISTRY = getAddress("0x00000000000000000000000000000000000000c3");
/** An address with no code: a call to it succeeds with no data. */
const CODELESS_GATE = getAddress("0x0000000000000000000000000000000000000e0a");
const AGENT = 1_984n;
const CHAIN_ID = 10_143;
const BASE_TS = 1_790_000_000n;
/** One second per block, so every block has its own timestamp. */
const tsOf = (block: bigint): bigint => BASE_TS + block - 1_000n;
/** The SDK's recorded testnet deployment: what `verify` recomputes with. */
const ADDRESSES: MandateAddresses = mandateAddressesFor(CHAIN_ID);

function unknownRequest(requestHash: Hex): Error {
  // How a raw eth_call revert reaches the reader: JSON-RPC code 3 with the revert data.
  return Object.assign(new Error("execution reverted"), {
    code: 3,
    data: encodeErrorResult({ abi: validationRegistryAbi, errorName: "UnknownRequest", args: [requestHash] }),
  });
}

/**
 * The shapes the registry's `UnknownRequest` revert reaches the reader in: the raw provider error,
 * viem's HTTP `RpcRequestError` (code 3 at the top), and viem's `UnknownRpcError` wrapping a custom
 * transport's error (code -1, the revert as its cause).
 */
const UNKNOWN_REQUEST_SHAPES: Array<{ shape: string; wrap: (raw: Error) => unknown }> = [
  { shape: "a flat { code: 3, data }", wrap: (raw) => raw },
  {
    shape: "viem's HTTP RpcRequestError",
    wrap: (raw) =>
      new RpcRequestError({
        body: { method: "eth_call" },
        url: "https://rpc.example/key",
        error: { code: 3, message: raw.message, data: (raw as unknown as { data: Hex }).data },
      }),
  },
  { shape: "viem's UnknownRpcError around a custom transport's error", wrap: (raw) => new UnknownRpcError(raw) },
];

type Landed = { block: bigint; logIndex: number; uri: string; status: ValidationStatus };

/**
 * A scripted chain: the request events, and the responses that landed (each in the block after the
 * finalized head; the chain then moves on and finalizes `PIN_LAG_BLOCKS` past it, so the next pin can
 * see it). Hashes are keyed lower-case.
 */
class FakeChain implements ValidatorChain {
  readonly address = VALIDATOR;
  /** The base's cycle head: requests are polled up to it, deadlines checked against its time. */
  readonly headBlock = { number: 1_004n, timestamp: tsOf(1_004n) };
  /** The finalized head every reader reports: the validator's first pin is block 1,004. */
  finalized = 1_004n + PIN_LAG_BLOCKS;
  /**
   * The block the ValidationRegistry was deployed in. Before it the contract has no code, so a status
   * read returns no data (`"0x"`), which doesn't decode, rather than reverting `UnknownRequest`.
   */
  deployBlock = 900n;
  /** The block the MandateRegistry was deployed in; `getMandate` before it returns no data, likewise. */
  mandateDeployBlock = 950n;
  /** Gates with no code, so `consumed()` on them returns no data. Lower-case. */
  readonly codelessGates = new Set<string>();
  readonly events: RequestEvent[] = [];
  readonly landed = new Map<Hex, Landed>();

  async chainId() {
    return CHAIN_ID;
  }
  async head() {
    return this.headBlock;
  }
  async requestLogs(fromBlock: bigint, toBlock: bigint) {
    return this.events.filter((e) => e.blockNumber >= fromBlock && e.blockNumber <= toBlock);
  }
  async status(requestHash: Hex): Promise<ValidationStatus> {
    return this.statusAt(requestHash, 2n ** 64n);
  }
  /** `getValidationStatus` at block `at`: it reverts `UnknownRequest` before the request was made. */
  statusAt(requestHash: Hex, at: bigint): ValidationStatus {
    if (at < this.deployBlock) throw new AbiDecodingZeroDataError(); // what viem's decode of "0x" throws
    const key = requestHash.toLowerCase() as Hex;
    const event = this.events.find((e) => e.requestHash === key && e.blockNumber <= at);
    if (!event) throw unknownRequest(key);
    const landed = this.landed.get(key);
    if (landed !== undefined && landed.block <= at) return landed.status;
    return { validator: event.validator, agentId: event.agentId, response: 0, responseHash: zeroHash, tag: "", lastUpdate: tsOf(event.blockNumber) };
  }
  async respond(response: { requestHash: Hex; response: number; responseURI: string; responseHash: Hex; tag: string }): Promise<{
    txHash: Hash;
    blockNumber: bigint;
    gasLimit: bigint;
  }> {
    const block = this.finalized + 1n;
    const event = this.events.find((e) => e.requestHash === response.requestHash);
    if (!event) throw new Error(`FakeChain: no request ${response.requestHash}`);
    this.landed.set(response.requestHash, {
      block,
      logIndex: 0,
      uri: response.responseURI,
      status: {
        validator: this.address,
        agentId: event.agentId,
        response: response.response,
        responseHash: response.responseHash,
        tag: response.tag,
        lastUpdate: tsOf(block),
      },
    });
    this.finalized = block + PIN_LAG_BLOCKS;
    return { txHash: keccak256(toHex(`response tx ${block}`)), blockNumber: block, gasLimit: 84_010n };
  }
}

/** A reader over the fake chain, reading state at the block it is given. It holds no cache of its own. */
class FakeReader implements VerifyReader {
  readonly chain: FakeChain;
  mandateRecord: MandateRecord | null = mandate();
  owner: Address = OWNER;
  simulation: Simulation = { ok: true };
  permissionEvents: Array<Omit<PermissionEvent, "afterMandate">> = [
    { block: 500n, logIndex: 0, txHash: keccak256(toHex("MandateSet tx")), emitter: "MandateRegistry", event: "MandateSet" },
  ];
  /** Responses whose log this reader can't find (RPC or log-index lag). */
  readonly hiddenResponses = new Set<Hex>();
  /** Requests whose `ValidationRequest` log this reader can't find. */
  readonly hiddenRequests = new Set<Hex>();
  /** Every `responseLog` lookup, by requestHash (`responseEvidence` goes through it). */
  readonly responseLogCalls: Hex[] = [];
  /** Every block a status was read at. */
  readonly statusReads: bigint[] = [];
  /** Every block a request log was looked up in. */
  readonly requestUriCalls: bigint[] = [];
  /** Every block the mandate was read at. */
  readonly mandateReads: bigint[] = [];
  /** A failure for the status read at `at` (thrown instead of reading), or undefined to read. */
  statusFailure: ((at: bigint) => unknown) | undefined;
  /** How an `UnknownRequest` revert reaches the caller. */
  unknownRequestAs: (raw: Error) => unknown = (raw) => raw;

  constructor(chain: FakeChain) {
    this.chain = chain;
  }

  async chainId() {
    return CHAIN_ID;
  }
  async finalized(): Promise<PinnedBlock> {
    return this.block(this.chain.finalized);
  }
  async block(number: bigint): Promise<PinnedBlock> {
    return { number, hash: keccak256(toHex(`block ${number}`)), timestamp: tsOf(number) };
  }
  async mandate(_agentId: bigint, at: bigint) {
    this.mandateReads.push(at);
    if (at < this.chain.mandateDeployBlock) throw new AbiDecodingZeroDataError(); // what viem's decode of "0x" throws
    return this.mandateRecord;
  }
  async ownerOf() {
    return this.owner;
  }
  async agentValidations(agentId: bigint, at: bigint) {
    return this.chain.events.filter((e) => e.agentId === agentId && e.blockNumber <= at).map((e) => e.requestHash);
  }
  async status(requestHash: Hex, at: bigint): Promise<ValidationStatus> {
    this.statusReads.push(at);
    const failure = this.statusFailure?.(at);
    if (failure !== undefined) throw failure;
    try {
      return this.chain.statusAt(requestHash, at);
    } catch (error) {
      throw this.unknownRequestAs(error as Error);
    }
  }
  async consumed(gate: Address) {
    // What viemMandateReader returns when the pinned call to the gate yields no bool: unknown.
    return this.chain.codelessGates.has(gate.toLowerCase()) ? null : false;
  }
  async permissionLogs(fromBlock: bigint, toBlock: bigint) {
    return this.permissionEvents.filter((e) => e.block >= fromBlock && e.block <= toBlock).map((e) => ({ ...e }));
  }
  async simulate() {
    return this.simulation;
  }
  async responseEvidence(requestHash: Hex, timestamp: bigint, notAfter: bigint) {
    return (await this.responseLog(requestHash, timestamp, notAfter))?.uri ?? null;
  }
  async responseLog(requestHash: Hex, timestamp: bigint, notAfter: bigint): Promise<ResponseLog | null> {
    const key = requestHash.toLowerCase() as Hex;
    this.responseLogCalls.push(key);
    const landed = this.chain.landed.get(key);
    if (landed === undefined || this.hiddenResponses.has(key) || landed.block > notAfter || tsOf(landed.block) !== timestamp) return null;
    return { uri: landed.uri, block: landed.block, logIndex: landed.logIndex };
  }
  async requestUri(requestHash: Hex, block: bigint) {
    this.requestUriCalls.push(block);
    const key = requestHash.toLowerCase() as Hex;
    if (this.hiddenRequests.has(key)) return null;
    return this.chain.events.find((e) => e.requestHash === key && e.blockNumber === block)?.requestURI ?? null;
  }
}

function mandate(over: Partial<MandateRecord> = {}): MandateRecord {
  return {
    allowedTargets: [OWNER],
    allowedSelectors: [MANDATE_V1.plainTransferSelector],
    maxValuePerTx: 2_000n,
    maxValuePerDay: 2_500n,
    validUntil: tsOf(1_004n) + 86_400n,
    mandateHash: keccak256(toHex("mandate")),
    owner: OWNER,
    setAtBlock: 500n,
    ...over,
  };
}

let saltCounter = 0;

function requestJson(
  over: { chainId?: number; gate?: Address; target?: Address; value?: bigint; validator?: Address; deadline?: bigint } = {},
): RequestJsonV1 {
  return buildRequestJson({
    chainId: over.chainId ?? CHAIN_ID,
    gate: over.gate ?? GATE,
    validator: over.validator ?? VALIDATOR,
    action: buildAction({
      agentId: AGENT,
      target: over.target ?? OWNER,
      value: over.value ?? 1_000n,
      deadline: over.deadline ?? tsOf(1_004n) + 600n,
      salt: keccak256(toHex(`salt ${saltCounter++}`)),
    }),
  });
}

let chain: FakeChain;
/** The validator's own reader. `verify` always gets a new one, sharing only the chain. */
let validatorReader: FakeReader;

beforeEach(() => {
  chain = new FakeChain();
  validatorReader = new FakeReader(chain);
});

function addRequest(json: RequestJsonV1, block = 1_000n): RequestEvent {
  const event: RequestEvent = {
    validator: VALIDATOR,
    agentId: BigInt(json.agentId),
    requestURI: encodeJsonDataUri(json).uri,
    requestHash: requestHashOfJson(json),
    blockNumber: block,
    logIndex: chain.events.length,
    txHash: keccak256(toHex(`request tx ${chain.events.length}`)),
  };
  chain.events.push(event);
  return event;
}

/** Runs a real `MandateValidator` over the fakes for one poll cycle: every pending request is answered. */
async function runValidator(
  addresses: MandateAddresses = ADDRESSES,
  gates: Array<{ gate: Address; agentId: bigint }> = [{ gate: GATE, agentId: AGENT }],
): Promise<void> {
  const validator = new MandateValidator({
    chain,
    cursor: new MemoryCursorStore(999n),
    reader: validatorReader,
    addresses,
    mandateRegistryDeployBlock: chain.mandateDeployBlock,
    gates,
    admission: new Admission({ maxRequestsPerAgent: 20, agentWindowSeconds: 3_600n, dailyGasBudget: 10_000_000n, maxGasPerResponse: 400_000n }),
    retryDelayMs: 0,
    pollIntervalMs: 0,
    pinPollMs: 1,
    log: () => {},
  });
  const { outcomes } = await validator.pollOnce();
  for (const outcome of outcomes) if (outcome.kind !== "responded") throw new Error(`not answered: ${JSON.stringify(outcome)}`);
}

function landed(requestHash: Hex): Landed {
  const response = chain.landed.get(requestHash);
  if (!response) throw new Error(`no response for ${requestHash}`);
  return response;
}

/** Parsed evidence JSON, loosely typed for edits and assertions. */
type Doc = Record<string, any>;

/**
 * A response from validator A that no honest `MandateValidator` would post (the base refuses the request), landed by
 * hand in block 1,005 with minimal evidence pinned at `pinned`.
 */
function answerByHand(requestHash: Hex, pinned = 1_004n): void {
  const status = { validator: VALIDATOR, agentId: AGENT, response: 100, responseHash: zeroHash, tag: "mandate-v1", lastUpdate: tsOf(1_005n) };
  const { uri, hash } = encodeCanonicalJsonDataUri({
    block: { number: pinned.toString(), hash: keccak256(toHex(`block ${pinned}`)), timestamp: tsOf(pinned) },
    request: { block: "1000" },
  });
  chain.landed.set(requestHash, { block: 1_005n, logIndex: 0, uri, status: { ...status, responseHash: hash } });
  chain.finalized = 1_005n;
}

function evidenceText(requestHash: Hex): string {
  const decoded = decodeJsonDataUri(landed(requestHash).uri, 1_000_000);
  if (!decoded.ok) throw new Error(decoded.detail);
  return decoded.text;
}

/** The validator posts other evidence for `requestHash`: `edit` the document, then re-sign its hash onchain. */
function resign(requestHash: Hex, edit: (doc: Doc) => void): void {
  const doc = JSON.parse(evidenceText(requestHash)) as Doc;
  edit(doc);
  const { uri, hash } = encodeCanonicalJsonDataUri(doc);
  const response = landed(requestHash);
  response.uri = uri;
  response.status = { ...response.status, responseHash: hash };
}

function verify(requestHash: Hex, reader: FakeReader = new FakeReader(chain)): Promise<VerifyReport> {
  return verifyRequest({
    reader,
    requestHash,
    addresses: ADDRESSES,
    validationRegistryDeployBlock: chain.deployBlock,
    mandateRegistryDeployBlock: chain.mandateDeployBlock,
  });
}

describe("verifyRequest: an honest verdict reproduces", () => {
  it("an untouched approval: match, with the same score and responseHash", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    const posted = landed(e.requestHash).status;

    const report = await verify(e.requestHash);

    expect(report).toEqual({
      requestHash: e.requestHash,
      validator: VALIDATOR,
      pinnedBlock: 1_004n,
      pinned: { number: 1_004n, hash: keccak256(toHex("block 1004")), timestamp: tsOf(1_004n) },
      match: true,
      verdict: "match",
      posted: { score: 100, responseHash: posted.responseHash, tag: "mandate-v1" },
      recomputed: { score: 100, responseHash: posted.responseHash, reasons: [] },
      problems: [],
      differingKeys: [],
      spendEntries: [],
      permissionEvents: [
        { block: 500n, logIndex: 0, txHash: keccak256(toHex("MandateSet tx")), emitter: "MandateRegistry", event: "MandateSet", afterMandate: false },
      ],
    });
  });

  it("a refusal reproduces too, with its reasons", async () => {
    const e = addRequest(requestJson({ target: UNLISTED, value: 2_200n }));
    await runValidator();

    const report = await verify(e.requestHash);

    expect(report).toMatchObject({ verdict: "match", match: true, problems: [], posted: { score: 0 } });
    expect(report.recomputed).toEqual({
      score: 0,
      responseHash: landed(e.requestHash).status.responseHash,
      reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"],
    });
  });

  it("a fresh process's view: spend the validator served from its cache is rebuilt from the first approval's evidence", async () => {
    const first = addRequest(requestJson({ value: 1_000n }));
    const second = addRequest(requestJson({ value: 2_000n })); // 1,000 + 2,000 > the 2,500 daily cap
    await runValidator();

    // The validator answered both in one cycle and counted the first approval from its in-memory cache.
    expect(validatorReader.responseLogCalls).toEqual([]);
    const postedSecond = JSON.parse(evidenceText(second.requestHash)) as Doc;
    expect(postedSecond.reasons).toEqual(["DAILY_CAP_EXCEEDED"]);
    expect(postedSecond.spend.entries.map((entry: Doc) => entry.requestHash)).toEqual([first.requestHash]);

    // verify shares nothing with that process but the chain.
    const fresh = new FakeReader(chain);
    const report = await verify(second.requestHash, fresh);

    expect(fresh.responseLogCalls).toContain(first.requestHash);
    expect(report).toMatchObject({ verdict: "match", match: true, problems: [], differingKeys: [], pinnedBlock: 1_010n });
    expect(report.recomputed).toEqual({
      score: 0,
      responseHash: landed(second.requestHash).status.responseHash,
      reasons: ["DAILY_CAP_EXCEEDED"],
    });
    expect(report.posted.responseHash).toBe(report.recomputed?.responseHash);
    expect(report.spendEntries).toEqual([
      {
        requestHash: first.requestHash,
        approvedAt: tsOf(1_010n),
        gate: GATE,
        value: 1_000n,
        deadline: tsOf(1_004n) + 600n,
        consumed: false,
        counted: true,
      },
    ]);

    await expect(verify(first.requestHash)).resolves.toMatchObject({ verdict: "match", pinnedBlock: 1_004n });
  });

  it("reads a mixed-case requestHash as the same request", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    const report = await verify(`0x${e.requestHash.slice(2).toUpperCase()}` as Hex);
    expect(report).toMatchObject({ requestHash: e.requestHash, verdict: "match" });
  });

  it("an approval through a gate with no code counts as unknown (consumed: null, counted), and a later verdict verifies", async () => {
    chain.codelessGates.add(CODELESS_GATE.toLowerCase());
    const first = addRequest(requestJson({ gate: CODELESS_GATE, value: 1_000n }));
    const second = addRequest(requestJson({ value: 1_000n }));
    await runValidator(ADDRESSES, [
      { gate: GATE, agentId: AGENT },
      { gate: CODELESS_GATE, agentId: AGENT },
    ]);
    const expected = {
      requestHash: first.requestHash,
      approvedAt: tsOf(1_010n),
      gate: CODELESS_GATE,
      value: 1_000n,
      deadline: tsOf(1_004n) + 600n,
      consumed: null,
      counted: true,
    };
    expect((JSON.parse(evidenceText(second.requestHash)) as Doc).spend.entries).toEqual([
      { ...expected, approvedAt: expected.approvedAt.toString(), value: "1000", deadline: expected.deadline.toString() },
    ]);

    const report = await verify(second.requestHash);

    expect(report).toMatchObject({ verdict: "match", problems: [] });
    expect(report.spendEntries).toEqual([expected]);
  });

  it("an honest pin exactly at the MandateRegistry's deployment block: match", async () => {
    chain.mandateDeployBlock = 1_004n;
    const e = addRequest(requestJson());
    await runValidator();

    await expect(verify(e.requestHash)).resolves.toMatchObject({ verdict: "match", pinnedBlock: 1_004n });
  });

  it("verifyContextFor reads the SDK's recorded deployment: the contracts and both registries' deployment blocks", () => {
    expect(verifyContextFor(CHAIN_ID)).toEqual({
      addresses: mandateAddressesFor(CHAIN_ID),
      validationRegistryDeployBlock: 67_604_893n,
      mandateRegistryDeployBlock: 67_842_487n,
    });
    expect(() => verifyContextFor(1)).toThrow(/no Attest8004 deployment/);
  });

  it("reports the permission events the re-run found", async () => {
    const e = addRequest(requestJson());
    validatorReader.permissionEvents.push({
      block: 600n,
      logIndex: 3,
      txHash: keccak256(toHex("AgentKeySet tx")),
      emitter: "AgentRequestForwarder",
      event: "AgentKeySet",
    });
    await runValidator();
    const fresh = new FakeReader(chain);
    fresh.permissionEvents = validatorReader.permissionEvents;

    const report = await verify(e.requestHash, fresh);

    expect(report.verdict).toBe("match");
    expect(report.recomputed?.reasons).toEqual(["PERMISSION_CHANGED_AFTER_MANDATE"]);
    expect(report.permissionEvents).toEqual([
      expect.objectContaining({ block: 500n, event: "MandateSet", afterMandate: false }),
      expect.objectContaining({ block: 600n, event: "AgentKeySet", afterMandate: true }),
    ]);
  });
});

describe("verifyRequest: a tampered or drifted verdict is a mismatch", () => {
  it("a flipped onchain score: SCORE_MISMATCH; the evidence still hashes, so no key differs", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    const response = landed(e.requestHash);
    response.status = { ...response.status, response: 0 };

    const report = await verify(e.requestHash);

    expect(report).toMatchObject({ verdict: "mismatch", match: false, problems: ["SCORE_MISMATCH"], differingKeys: [] });
    expect(report.posted.score).toBe(0);
    expect(report.recomputed).toMatchObject({ score: 100, responseHash: response.status.responseHash });
  });

  it("one evidence byte changed: EVIDENCE_HASH_MISMATCH, with no re-run", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    const text = evidenceText(e.requestHash);
    const changed = text.replace('"validator":"mandate-v1"', '"validator":"mandate-v2"');
    expect(changed.length).toBe(text.length);
    landed(e.requestHash).uri = `data:application/json;base64,${toBase64(stringToBytes(changed))}`;

    const report = await verify(e.requestHash);

    expect(report).toMatchObject({ verdict: "mismatch", problems: ["EVIDENCE_HASH_MISMATCH"], recomputed: null, pinnedBlock: null });
  });

  it("evidence re-signed with another pinned block: RESPONSE_HASH_MISMATCH, naming block among the differing keys", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    resign(e.requestHash, (doc) => {
      doc.block.number = "1003";
    });

    const report = await verify(e.requestHash);

    expect(report).toMatchObject({ verdict: "mismatch", match: false, pinnedBlock: 1_003n, problems: ["RESPONSE_HASH_MISMATCH"] });
    expect(report.recomputed?.score).toBe(100);
    expect(report.recomputed?.responseHash).not.toBe(report.posted.responseHash);
    expect(report.differingKeys).toEqual(["block", "permissions", "spend"]);
  });

  it("evidence naming another MandateRegistry than the SDK's deployment: RESPONSE_HASH_MISMATCH in params", async () => {
    const e = addRequest(requestJson());
    await runValidator({ ...ADDRESSES, mandateRegistry: OTHER_MANDATE_REGISTRY });

    const report = await verify(e.requestHash);

    expect(report).toMatchObject({ verdict: "mismatch", problems: ["RESPONSE_HASH_MISMATCH"], differingKeys: ["params"] });
    expect(report.recomputed?.score).toBe(100);
  });

  it("evidence that hashes but isn't a mandate-v1 document: RESPONSE_HASH_MISMATCH, with nothing to re-run", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    resign(e.requestHash, (doc) => {
      delete doc.block;
    });

    const report = await verify(e.requestHash);

    expect(report).toMatchObject({ verdict: "mismatch", problems: ["RESPONSE_HASH_MISMATCH"], recomputed: null, pinnedBlock: null });
  });

  it("a pin before the request's block: PIN_OUT_OF_RANGE, with no re-run", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    resign(e.requestHash, (doc) => {
      doc.block.number = "999";
    });

    const report = await verify(e.requestHash);

    expect(report).toMatchObject({ verdict: "mismatch", problems: ["PIN_OUT_OF_RANGE"], pinnedBlock: 999n, recomputed: null });
  });

  it("the fake chain, like the real one, answers getMandate before the MandateRegistry's deployment with zero data", async () => {
    await expect(new FakeReader(chain).mandate(AGENT, chain.mandateDeployBlock - 1n)).rejects.toBeInstanceOf(AbiDecodingZeroDataError);
  });

  it("a pin before the MandateRegistry existed: PIN_OUT_OF_RANGE, with nothing read at that block", async () => {
    chain.mandateDeployBlock = 1_002n; // the request (block 1,000) predates the MandateRegistry
    const e = addRequest(requestJson());
    await runValidator(); // pins at 1,004
    resign(e.requestHash, (doc) => {
      doc.block.number = (chain.mandateDeployBlock - 1n).toString();
    });
    const reader = new FakeReader(chain);

    const report = await verify(e.requestHash, reader);

    expect(report).toMatchObject({ verdict: "mismatch", problems: ["PIN_OUT_OF_RANGE"], pinnedBlock: 1_001n, recomputed: null });
    expect(reader.mandateReads).toEqual([]);
    expect(reader.statusReads).toEqual([1_015n]);
  });

  it("a pin after the response's block: PIN_OUT_OF_RANGE", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    expect(landed(e.requestHash).block).toBe(1_010n);
    chain.finalized = 1_020n;
    resign(e.requestHash, (doc) => {
      doc.block.number = "1011";
    });

    await expect(verify(e.requestHash)).resolves.toMatchObject({ verdict: "mismatch", problems: ["PIN_OUT_OF_RANGE"], pinnedBlock: 1_011n });
  });
});

describe("verifyRequest: the request's block is a fact of state, so a wrong one is a mismatch", () => {
  it.each([
    { name: "one block after the real one", requestBlock: "1001", pinned: "1004" },
    { name: "one block before the real one", requestBlock: "999", pinned: "1004" },
    { name: "moved back with a pin before the request", requestBlock: "990", pinned: "995" },
  ])("evidence naming a request block $name: REQUEST_BLOCK_WRONG", async ({ requestBlock, pinned }) => {
    const e = addRequest(requestJson());
    await runValidator();
    resign(e.requestHash, (doc) => {
      doc.request.block = requestBlock;
      doc.block.number = pinned;
    });
    const reader = new FakeReader(chain);

    const report = await verify(e.requestHash, reader);

    expect(report).toMatchObject({ verdict: "mismatch", match: false, problems: ["REQUEST_BLOCK_WRONG"], recomputed: null });
    expect(reader.statusReads.every((at) => at >= 0n)).toBe(true);
  });

  it("the fake chain, like the real one, answers a status read before the registry's deployment with zero data, not a revert", async () => {
    const e = addRequest(requestJson());
    await expect(new FakeReader(chain).status(e.requestHash, chain.deployBlock - 1n)).rejects.toBeInstanceOf(AbiDecodingZeroDataError);
  });

  it.each([
    { name: "0", requestBlock: () => "0" },
    { name: "the block before the registry's deployment", requestBlock: () => (chain.deployBlock - 1n).toString() },
  ])("evidence naming a request block before the registry existed ($name): REQUEST_BLOCK_WRONG, read from nowhere", async ({ requestBlock }) => {
    const e = addRequest(requestJson());
    await runValidator();
    resign(e.requestHash, (doc) => {
      doc.request.block = requestBlock(); // an honest pin (1,004) stays in range
    });
    const reader = new FakeReader(chain);

    const report = await verify(e.requestHash, reader);

    expect(report).toMatchObject({ verdict: "mismatch", problems: ["REQUEST_BLOCK_WRONG"], pinnedBlock: 1_004n, recomputed: null });
    expect(reader.requestUriCalls).toEqual([]);
    expect(reader.statusReads).toEqual([1_015n]); // only the head: nothing before the deployment is read
  });

  it("a request made in the registry's deployment block, its log missing: REQUEST_NOT_FOUND, with no read before deployment", async () => {
    chain.deployBlock = 1_000n;
    const e = addRequest(requestJson()); // block 1,000
    await runValidator();
    const reader = new FakeReader(chain);
    reader.hiddenRequests.add(e.requestHash);

    await expect(verify(e.requestHash, reader)).resolves.toMatchObject({ verdict: "unverifiable", problems: ["REQUEST_NOT_FOUND"] });
    expect(reader.statusReads).toEqual([1_015n, 1_000n]);
  });

  it.each(UNKNOWN_REQUEST_SHAPES)("reads UnknownRequest as 'not made yet' in any shape ($shape)", async ({ wrap }) => {
    const e = addRequest(requestJson());
    await runValidator();
    resign(e.requestHash, (doc) => {
      doc.request.block = "999";
    });
    const reader = new FakeReader(chain);
    reader.unknownRequestAs = wrap;

    await expect(verify(e.requestHash, reader)).resolves.toMatchObject({ verdict: "mismatch", problems: ["REQUEST_BLOCK_WRONG"] });
  });

  it("a request URI that doesn't hash to the requestHash: REQUEST_INVALID (a validator must not answer it)", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    e.requestURI = encodeJsonDataUri(requestJson()).uri; // another salt, so another hash

    await expect(verify(e.requestHash)).resolves.toMatchObject({ verdict: "mismatch", problems: ["REQUEST_INVALID"] });
  });

  it("a request URI that isn't request JSON: REQUEST_INVALID", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    e.requestURI = "https://request.example/1";

    await expect(verify(e.requestHash)).resolves.toMatchObject({ verdict: "mismatch", problems: ["REQUEST_INVALID"] });
  });

  it("a request JSON naming another chain than the one verify reads: REQUEST_INVALID (the base never answers it: WRONG_CHAIN)", async () => {
    const e = addRequest(requestJson({ chainId: 1 }));
    answerByHand(e.requestHash);

    await expect(verify(e.requestHash)).resolves.toMatchObject({ verdict: "mismatch", problems: ["REQUEST_INVALID"], recomputed: null });
  });

  it("a deadline more than 3,600 s after P's time: REQUEST_INVALID (the base never answers it: DEADLINE_TOO_FAR at a head no later than P)", async () => {
    const e = addRequest(requestJson({ deadline: tsOf(1_004n) + 3_601n }));
    answerByHand(e.requestHash, 1_004n);

    await expect(verify(e.requestHash)).resolves.toMatchObject({ verdict: "mismatch", problems: ["REQUEST_INVALID"], recomputed: null });
  });

  it("a deadline exactly 3,600 s after P's time is honest: match", async () => {
    const e = addRequest(requestJson({ deadline: tsOf(1_004n) + 3_600n }));
    await runValidator();

    await expect(verify(e.requestHash)).resolves.toMatchObject({ verdict: "match", pinnedBlock: 1_004n });
  });
});

describe("verifyRequest: what can't be found or re-run is never a mismatch", () => {
  it("another tag: NOT_MANDATE_V1, unverifiable (only mandate-v1 verdicts re-run; another tag proves nothing)", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    const response = landed(e.requestHash);
    response.status = { ...response.status, tag: "attest8004-e2e-stub" };
    const reader = new FakeReader(chain);

    const report = await verify(e.requestHash, reader);

    expect(report).toMatchObject({
      verdict: "unverifiable",
      match: false,
      problems: ["NOT_MANDATE_V1"],
      posted: { score: 100, tag: "attest8004-e2e-stub" },
      recomputed: null,
    });
    expect(reader.responseLogCalls).toEqual([]);
  });

  it("a request with no response yet: RESPONSE_NOT_FOUND", async () => {
    const e = addRequest(requestJson());

    const report = await verify(e.requestHash);

    expect(report).toMatchObject({
      verdict: "unverifiable",
      problems: ["RESPONSE_NOT_FOUND"],
      validator: VALIDATOR,
      posted: { score: 0, responseHash: zeroHash, tag: "" },
      recomputed: null,
    });
  });

  it("a response whose log isn't found at its lastUpdate: RESPONSE_NOT_FOUND", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    const reader = new FakeReader(chain);
    reader.hiddenResponses.add(e.requestHash);

    await expect(verify(e.requestHash, reader)).resolves.toMatchObject({ verdict: "unverifiable", problems: ["RESPONSE_NOT_FOUND"] });
  });

  it("state confirms the evidence's request block but its log isn't returned: REQUEST_NOT_FOUND", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    const reader = new FakeReader(chain);
    reader.hiddenRequests.add(e.requestHash);

    await expect(verify(e.requestHash, reader)).resolves.toMatchObject({
      verdict: "unverifiable",
      problems: ["REQUEST_NOT_FOUND"],
      pinnedBlock: 1_004n,
      recomputed: null,
    });
    expect(reader.statusReads).toEqual([1_015n, 1_000n, 999n]); // the head, then the request block and the one before
  });

  it("a request JSON naming another validator than the registry records: REQUEST_INVALID (a validator must not answer it)", async () => {
    // Addressed onchain to validator A, but the JSON (and so the hash) names another validator.
    const e = addRequest(requestJson({ validator: OTHER_VALIDATOR }));
    answerByHand(e.requestHash);

    await expect(verify(e.requestHash)).resolves.toMatchObject({ verdict: "mismatch", problems: ["REQUEST_INVALID"] });
  });

  it.each(UNKNOWN_REQUEST_SHAPES)("a requestHash the registry doesn't know ($shape): REQUEST_NOT_FOUND", async ({ wrap }) => {
    const reader = new FakeReader(chain);
    reader.unknownRequestAs = wrap;

    const report = await verify(keccak256(toHex("no such request")), reader);

    expect(report).toMatchObject({
      verdict: "unverifiable",
      problems: ["REQUEST_NOT_FOUND"],
      validator: zeroAddress,
      pinnedBlock: null,
      recomputed: null,
    });
  });

  it("a requestHash the registry doesn't know, through the real viem reader: REQUEST_NOT_FOUND", async () => {
    const rpc = new FakeRpc();
    rpc.blockNumber = 1_004n;
    const unknown = keccak256(toHex("no such request"));
    rpc.onCall(ADDRESSES.validationRegistry, validationRegistryAbi, "getValidationStatus", () =>
      revert(validationRegistryAbi, "UnknownRequest", [unknown]),
    );
    const { publicClient } = rpc.clients(privateKeyToAccount(generatePrivateKey()), { retryCount: 0 });

    const report = await verifyRequest({
      reader: viemMandateReader({ publicClient, addresses: ADDRESSES }),
      requestHash: unknown,
      addresses: ADDRESSES,
      validationRegistryDeployBlock: 900n,
      mandateRegistryDeployBlock: 950n,
    });

    expect(report).toMatchObject({ verdict: "unverifiable", problems: ["REQUEST_NOT_FOUND"] });
  });

  it.each([
    { name: "a transport failure", failure: () => new HttpRequestError({ url: "https://rpc.example/key", status: 429 }) },
    {
      name: "a revert other than UnknownRequest",
      failure: () => Object.assign(new Error("execution reverted"), { code: 3, data: "0x08c379a0" }),
    },
  ])("$name while proving the request block rejects (exit 2), never a mismatch", async ({ failure }) => {
    const e = addRequest(requestJson());
    await runValidator();
    const reader = new FakeReader(chain);
    reader.hiddenRequests.add(e.requestHash);
    reader.statusFailure = (at) => (at === 999n ? failure() : undefined);

    await expect(verify(e.requestHash, reader)).rejects.toBeDefined();
  });

  it("evidence that won't decode as inline JSON (not a data: URI, never fetched): EVIDENCE_NOT_DECODED, unverifiable", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    landed(e.requestHash).uri = "https://evidence.example/verdict.json";

    await expect(verify(e.requestHash)).resolves.toMatchObject({ verdict: "unverifiable", problems: ["EVIDENCE_NOT_DECODED"], recomputed: null });
  });

  it("evidence over 128 KiB, even with a matching hash: EVIDENCE_NOT_DECODED, unverifiable (an honest validator could post it)", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    resign(e.requestHash, (doc) => {
      doc.note = "x".repeat(MAX_EVIDENCE_URI_BYTES);
    });
    expect(landed(e.requestHash).uri.length).toBeGreaterThan(MAX_EVIDENCE_URI_BYTES);

    await expect(verify(e.requestHash)).resolves.toMatchObject({ verdict: "unverifiable", problems: ["EVIDENCE_NOT_DECODED"] });
  });

  it("a spend approval whose log can't be found during the re-run rejects (retry later), never a report", async () => {
    const first = addRequest(requestJson({ value: 1_000n }));
    const second = addRequest(requestJson({ value: 1_000n }));
    await runValidator();
    const reader = new FakeReader(chain);
    reader.hiddenResponses.add(first.requestHash);

    await expect(verify(second.requestHash, reader)).rejects.toBeInstanceOf(SpendLogNotFoundError);
  });

  it("an RPC failure rejects, never a report", async () => {
    const e = addRequest(requestJson());
    await runValidator();
    const reader = new FakeReader(chain);
    reader.statusFailure = () => Object.assign(new Error("HTTP request failed"), { status: 429 });

    await expect(verify(e.requestHash, reader)).rejects.toThrow(/HTTP request failed/);
  });
});
