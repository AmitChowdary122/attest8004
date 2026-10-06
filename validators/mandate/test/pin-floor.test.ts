// P12 AUD-02: a verdict pinned before this validator's own earlier approval of the agent landed leaves that approval
// out of the daily spend. `verify` reports it (PIN_SKIPS_APPROVAL), and validator A's pin waits for it, read from
// the chain, so a restarted process can't lose the floor.
import { Admission, buildEvidence, encodeCanonicalJsonDataUri, encodeJsonDataUri, MemoryCursorStore, requestHashOfJson } from "@attest8004/sdk";
import type { RequestEvent, RequestJsonV1 } from "@attest8004/sdk";
import { keccak256, toHex, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { mandateAddressesAt, type MandateContracts } from "../src/reader.ts";
import { mandateRequestOf, runMandateV1 } from "../src/run.ts";
import { MandateValidator } from "../src/validator.ts";
import { approvalsAfterPin, verifyRequest } from "../src/verify.ts";
import { AGENT, FakeChain, FakeReader, GATE, OTHER_VALIDATOR, P4_REGISTRY, RECORDED, VALIDATOR, requestJson, tsOf } from "./helpers/fake-chain.ts";

let chain: FakeChain;
let contracts: MandateContracts;

beforeEach(() => {
  chain = new FakeChain();
  contracts = { ...RECORDED, mandateRegistries: [{ address: P4_REGISTRY, fromBlock: chain.mandateDeployBlock }] };
});

function addRequest(json: RequestJsonV1, block: bigint): RequestEvent {
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

function validator(o: { pinTimeoutMs?: number } = {}): MandateValidator {
  return new MandateValidator({
    chain,
    cursor: new MemoryCursorStore(999n),
    reader: new FakeReader(chain),
    contracts,
    gates: [{ gate: GATE, agentId: AGENT }],
    admission: new Admission({ maxRequestsPerAgent: 20, agentWindowSeconds: 3_600n, dailyGasBudget: 10_000_000n, maxGasPerResponse: 400_000n }),
    retryDelayMs: 0,
    pollIntervalMs: 0,
    pinPollMs: 1,
    ...(o.pinTimeoutMs === undefined ? {} : { pinTimeoutMs: o.pinTimeoutMs }),
    log: () => {},
  });
}

/** Posts `json`'s verdict by hand, as `poster`, with evidence pinned at `pin`, in the block after the finalized head. */
async function postPinnedAt(event: RequestEvent, json: RequestJsonV1, pin: bigint, poster: Address = VALIDATOR): Promise<bigint> {
  const reader = new FakeReader(chain);
  const result = await runMandateV1({
    reader,
    addresses: mandateAddressesAt(contracts, pin),
    validator: poster,
    request: mandateRequestOf(json, event.requestHash, event.blockNumber),
    pinned: await reader.block(pin),
    cache: new Map(),
  });
  const { uri, hash } = encodeCanonicalJsonDataUri(buildEvidence({ tag: "mandate-v1", requestHash: event.requestHash, result }));
  const block = chain.finalized + 1n;
  chain.landed.set(event.requestHash.toLowerCase() as Hex, {
    block,
    logIndex: 0,
    uri,
    status: { validator: poster, agentId: AGENT, response: result.score, responseHash: hash, tag: "mandate-v1", lastUpdate: tsOf(block) },
  });
  chain.finalized = block + 5n;
  return block;
}

/** R1 (1,000) approved by a real validator, then R2 (2,000: 1,000 + 2,000 is over the 2,500 daily cap), requested before R1's approval landed. */
async function overCapPair() {
  const r1 = addRequest(requestJson({ value: 1_000n }), 1_000n);
  await validator().pollOnce();
  const r1Block = chain.landed.get(r1.requestHash.toLowerCase() as Hex)?.block;
  if (r1Block === undefined) throw new Error("R1 wasn't answered");
  const r2json = requestJson({ value: 2_000n });
  const r2 = addRequest(r2json, 1_001n);
  return { r1, r1Block, r2, r2json };
}

describe("approvalsAfterPin", () => {
  it("lists this validator's mandate-v1 approvals of the agent answered after the pin, leaving out the request itself", async () => {
    const { r1, r1Block, r2 } = await overCapPair();
    const reader = new FakeReader(chain);
    const after = (pin: bigint, exclude: Hex = r2.requestHash) =>
      approvalsAfterPin({ reader, validator: VALIDATOR, agentId: AGENT, pin, upTo: chain.finalized, exclude });

    await expect(after(r1Block - 1n)).resolves.toEqual([r1.requestHash]);
    await expect(after(r1Block)).resolves.toEqual([]);
    await expect(after(r1Block - 1n, r1.requestHash)).resolves.toEqual([]);
  });

  it("ignores another validator's approvals, refusals and other tags", async () => {
    const { r1, r1Block } = await overCapPair();
    const reader = new FakeReader(chain);
    const landed = chain.landed.get(r1.requestHash.toLowerCase() as Hex);
    if (!landed) throw new Error("no response");
    const pin = r1Block - 1n;
    const check = () => approvalsAfterPin({ reader, validator: VALIDATOR, agentId: AGENT, pin, upTo: chain.finalized, exclude: keccak256(toHex("none")) });

    landed.status = { ...landed.status, validator: OTHER_VALIDATOR };
    await expect(check()).resolves.toEqual([]);
    landed.status = { ...landed.status, validator: VALIDATOR, response: 0 };
    await expect(check()).resolves.toEqual([]);
    landed.status = { ...landed.status, response: 100, tag: "risk-v1" };
    await expect(check()).resolves.toEqual([]);
  });
});

describe("approvalsAfterPin's cache (P12 re-check, N2)", () => {
  it("skips, on later calls, every request it has seen naming another validator or agent: they never change", async () => {
    const { r1Block } = await overCapPair();
    const other = addRequest({ ...requestJson({ value: 7n }), validator: OTHER_VALIDATOR }, 1_002n);
    chain.landed.set(other.requestHash.toLowerCase() as Hex, {
      block: r1Block,
      logIndex: 1,
      uri: "data:,",
      status: { validator: OTHER_VALIDATOR, agentId: AGENT, response: 100, responseHash: keccak256(toHex("x")), tag: "mandate-v1", lastUpdate: tsOf(r1Block) },
    });
    const reader = new FakeReader(chain);
    const reads: Hex[] = [];
    const counting = { agentValidations: reader.agentValidations.bind(reader), status: (h: Hex, at: bigint) => (reads.push(h), reader.status(h, at)) };
    const notOurs = new Set<string>();
    const check = () => approvalsAfterPin({ reader: counting, validator: VALIDATOR, agentId: AGENT, pin: r1Block, upTo: chain.finalized, exclude: keccak256(toHex("none")), notOurs });

    await check();
    expect(reads.filter((h) => h === other.requestHash)).toHaveLength(1);
    await check();
    expect(reads.filter((h) => h === other.requestHash)).toHaveLength(1);
  });
});

describe("verify: a pin that skips the validator's own approval (P12 AUD-02)", () => {
  it("an early-pinned approval that leaves out an earlier approval of the agent: PIN_SKIPS_APPROVAL, a mismatch", async () => {
    const { r1, r1Block, r2, r2json } = await overCapPair();
    const early = 1_004n;
    expect(early < r1Block).toBe(true);
    await postPinnedAt(r2, r2json, early);
    expect(chain.landed.get(r2.requestHash.toLowerCase() as Hex)?.status.response).toBe(100); // the cap overrun

    const report = await verifyRequest({ reader: new FakeReader(chain), requestHash: r2.requestHash, contracts, validationRegistryDeployBlock: chain.deployBlock });

    expect(report.verdict).toBe("mismatch");
    expect(report.problems).toEqual(["PIN_SKIPS_APPROVAL"]);
    expect(report.skippedApprovals).toEqual([r1.requestHash]);
  });

  it("an honest pin after the earlier approval: match, nothing skipped", async () => {
    const { r1Block, r2, r2json } = await overCapPair();
    await postPinnedAt(r2, r2json, r1Block);

    const report = await verifyRequest({ reader: new FakeReader(chain), requestHash: r2.requestHash, contracts, validationRegistryDeployBlock: chain.deployBlock });

    expect(report).toMatchObject({ verdict: "match", problems: [], skippedApprovals: [] });
  });

  it("a validator whose documented pin is the request's block (validator C) is exempt", async () => {
    const { r2, r2json } = await overCapPair();
    await postPinnedAt(r2, r2json, 1_004n);

    const report = await verifyRequest({
      reader: new FakeReader(chain),
      requestHash: r2.requestHash,
      contracts,
      validationRegistryDeployBlock: chain.deployBlock,
      pinAtRequestBlock: [VALIDATOR],
    });

    expect(report).toMatchObject({ verdict: "match", problems: [], skippedApprovals: [] });
  });
});

describe("validator A's pin floor comes from the chain (P12 AUD-02, the restart case)", () => {
  it("a fresh process waits until its own last approval of the agent is visible at P", async () => {
    const { r1Block, r2 } = await overCapPair();
    // The process restarts, and the finalized head is only 2 blocks past R1's approval: head − 5 is before it.
    chain.finalized = r1Block + 2n;

    const restarted = validator({ pinTimeoutMs: 30 });
    const first = await restarted.pollOnce();
    expect(chain.landed.has(r2.requestHash.toLowerCase() as Hex)).toBe(false);
    expect(first.caughtUp).toBe(false);

    chain.finalized = r1Block + 5n;
    await restarted.pollOnce();
    const answer = chain.landed.get(r2.requestHash.toLowerCase() as Hex);
    expect(answer?.status.response).toBe(0);
  });
});
