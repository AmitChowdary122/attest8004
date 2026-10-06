import {
  Admission,
  decodeJsonDataUri,
  encodeCanonicalJsonDataUri,
  encodeJsonDataUri,
  MemoryCursorStore,
  requestHashOfJson,
  toBase64,
  validationRegistryAbi,
  type RequestEvent,
  type RequestJsonV1,
} from "@attest8004/sdk";
import {
  AbiDecodingZeroDataError,
  HttpRequestError,
  keccak256,
  stringToBytes,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeRpc, revert } from "../../../packages/sdk/test/helpers/fake-rpc.ts";
import { MAX_EVIDENCE_URI_BYTES, SpendLogNotFoundError } from "../src/collect.ts";
import { MANDATE_V1 } from "../src/params.ts";
import { mandateContractsFor, viemMandateReader, type MandateContracts, type ResponseLog, type VerifyReader } from "../src/reader.ts";
import type { MandateRecord, PermissionEvent, PinnedBlock, Simulation } from "../src/types.ts";
import { MandateValidator, PIN_LAG_BLOCKS } from "../src/validator.ts";
import { verifyContextFor, verifyRequest, type VerifyReport } from "../src/verify.ts";
import {
  AGENT,
  CHAIN_ID,
  CODELESS_GATE,
  FakeChain,
  FakeReader,
  GATE,
  OTHER_MANDATE_REGISTRY,
  OTHER_VALIDATOR,
  P4_REGISTRY,
  RECORDED,
  UNKNOWN_REQUEST_SHAPES,
  UNLISTED,
  V2_REGISTRY,
  VALIDATOR,
  mandate,
  requestJson,
  tsOf,
  type Landed,
} from "./helpers/fake-chain.ts";


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

/**
 * The recorded contracts with a MandateRegistry history for the fake chain: by default the recorded one alone,
 * "deployed" at `chain.mandateDeployBlock` (as the real one was at 67,842,487).
 */
function contracts(mandateRegistries?: MandateContracts["mandateRegistries"]): MandateContracts {
  return { ...RECORDED, mandateRegistries: mandateRegistries ?? [{ address: P4_REGISTRY, fromBlock: chain.mandateDeployBlock }] };
}

/** Runs a real `MandateValidator` over the fakes for one poll cycle: every pending request is answered. */
async function runValidator(
  validatorContracts: MandateContracts = contracts(),
  gates: Array<{ gate: Address; agentId: bigint }> = [{ gate: GATE, agentId: AGENT }],
): Promise<void> {
  const validator = new MandateValidator({
    chain,
    cursor: new MemoryCursorStore(999n),
    reader: validatorReader,
    contracts: validatorContracts,
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

function verify(requestHash: Hex, reader: FakeReader = new FakeReader(chain), verifyContracts: MandateContracts = contracts()): Promise<VerifyReport> {
  return verifyRequest({
    reader,
    requestHash,
    contracts: verifyContracts,
    validationRegistryDeployBlock: chain.deployBlock,
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
      skippedApprovals: [],
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
    await runValidator(contracts(), [
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

  it("verifyContextFor reads the SDK's recorded deployment: the contracts, both registries' deployment blocks, and C pinning at the request", () => {
    expect(verifyContextFor(CHAIN_ID)).toEqual({
      contracts: mandateContractsFor(CHAIN_ID),
      validationRegistryDeployBlock: 67_604_893n,
      pinAtRequestBlock: ["0x6D12F00870cB6edA2d8e389696f6B5d050423B95"],
    });
    expect(verifyContextFor(CHAIN_ID).contracts.mandateRegistries[0]).toEqual({ address: P4_REGISTRY, fromBlock: 67_842_487n });
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

describe("verifyRequest: the MandateRegistry history (the registry valid at the pin)", () => {
  it("verify: a pre-switch verdict matches with a two-entry history; PIN_OUT_OF_RANGE only before the first registry", async () => {
    chain.mandateDeployBlock = 1_002n; // the request (block 1,000) predates the first registry
    const e = addRequest(requestJson());
    await runValidator(); // answered while the history held P4's registry alone; pins at 1,004
    // v2 is appended later, valid from the block after that pin.
    const twoRegistries = contracts([
      { address: P4_REGISTRY, fromBlock: 1_002n },
      { address: V2_REGISTRY, fromBlock: 1_005n },
    ]);

    const report = await verify(e.requestHash, new FakeReader(chain), twoRegistries);

    expect(report).toMatchObject({ verdict: "match", pinnedBlock: 1_004n, problems: [], differingKeys: [] });

    // The pin is out of range only before the first registry: a pin in either registry's range is re-run there.
    for (const [pin, problems] of [
      [1_001n, ["PIN_OUT_OF_RANGE"]],
      [1_002n, ["RESPONSE_HASH_MISMATCH"]],
      [1_005n, ["RESPONSE_HASH_MISMATCH"]],
    ] as const) {
      resign(e.requestHash, (doc) => {
        doc.block.number = pin.toString();
      });
      const reader = new FakeReader(chain);
      const moved = await verify(e.requestHash, reader, twoRegistries);
      expect(moved, `pin ${pin}`).toMatchObject({ verdict: "mismatch", pinnedBlock: pin, problems });
      expect(reader.mandateReads, `pin ${pin}`).toEqual(pin < 1_002n ? [] : [pin]);
    }
  });

  it("a verdict pinned at the switch block records v2, and re-verifies only with v2 in the history", async () => {
    const e = addRequest(requestJson());
    const twoRegistries = contracts([
      { address: P4_REGISTRY, fromBlock: chain.mandateDeployBlock },
      { address: V2_REGISTRY, fromBlock: 1_004n },
    ]);
    await runValidator(twoRegistries); // pins at 1,004: v2's first block

    expect((JSON.parse(evidenceText(e.requestHash)) as Doc).params.mandateRegistry).toBe(V2_REGISTRY);
    await expect(verify(e.requestHash, new FakeReader(chain), twoRegistries)).resolves.toMatchObject({ verdict: "match", problems: [] });
    await expect(verify(e.requestHash)).resolves.toMatchObject({ verdict: "mismatch", problems: ["RESPONSE_HASH_MISMATCH"], differingKeys: ["params"] });
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
    await runValidator(contracts([{ address: OTHER_MANDATE_REGISTRY, fromBlock: chain.mandateDeployBlock }]));

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
    rpc.onCall(RECORDED.validationRegistry, validationRegistryAbi, "getValidationStatus", () =>
      revert(validationRegistryAbi, "UnknownRequest", [unknown]),
    );
    const { publicClient } = rpc.clients(privateKeyToAccount(generatePrivateKey()), { retryCount: 0 });

    const report = await verifyRequest({
      reader: viemMandateReader({ publicClient, contracts: contracts([{ address: P4_REGISTRY, fromBlock: 950n }]) }),
      requestHash: unknown,
      contracts: contracts([{ address: P4_REGISTRY, fromBlock: 950n }]),
      validationRegistryDeployBlock: 900n,
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
