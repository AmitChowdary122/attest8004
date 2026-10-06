import { describe, expect, test } from "bun:test";
import { encodeJsonDataUri, requestHashOfJson } from "../../../packages/sdk/src/request.ts";
import { checkLive, checkPinned, checkRequest, type OnchainStatus } from "../src/request.ts";
import { decodeValidationRequest, type TriggerRequest } from "../src/trigger.ts";
import { REAL, realTriggerLog, testConfig } from "./helpers.ts";

const real = (): TriggerRequest => decodeValidationRequest(realTriggerLog());
const C = "0x6D12F00870cB6edA2d8e389696f6B5d050423B95" as const;
const ZERO = `0x${"00".repeat(32)}` as const;
const pending: OnchainStatus = { validator: REAL.validatorA, agentId: 1984n, response: 0, responseHash: ZERO, tag: "" };

/** The real request with one field of its JSON changed, re-encoded (and re-hashed unless `keepHash`). */
function variant(edit: (json: Record<string, any>) => void, o: { keepHash?: boolean } = {}): TriggerRequest {
  const t = real();
  const json = JSON.parse(atob(t.requestURI.split(",")[1] as string));
  edit(json);
  return { ...t, requestURI: encodeJsonDataUri(json).uri, requestHash: o.keepHash ? t.requestHash : requestHashOfJson(json) };
}

describe("checkRequest: the trigger's own request JSON, authenticated by its requestHash", () => {
  test("accepts the real request when configured for its validator", () => {
    const out = checkRequest(real(), testConfig());
    expect("decline" in out).toBe(false);
    if ("decline" in out) return;
    expect(out.deadline).toBe(REAL.deadline);
    expect(out.json.gate).toBe(REAL.vault);
  });

  test("WRONG_VALIDATOR: the event names another validator than C", () => {
    expect(checkRequest(real(), testConfig({ creValidator: C }))).toMatchObject({ decline: "WRONG_VALIDATOR" });
  });

  test("HASH_MISMATCH: a tampered deadline no longer hashes to the event's requestHash", () => {
    const t = variant((j) => (j.action.deadline = "1891216243"), { keepHash: true });
    expect(checkRequest(t, testConfig())).toMatchObject({ decline: "HASH_MISMATCH" });
  });

  test("URI_NOT_DATA: a URI that isn't an inline data: URI is never fetched", () => {
    expect(checkRequest({ ...real(), requestURI: "https://example.com/r.json" }, testConfig())).toMatchObject({ decline: "URI_NOT_DATA" });
  });

  test("AGENT_MISMATCH and WRONG_CHAIN", () => {
    expect(checkRequest({ ...real(), agentId: 1985n }, testConfig())).toMatchObject({ decline: "AGENT_MISMATCH" });
    expect(checkRequest(variant((j) => (j.chainId = 143)), testConfig())).toMatchObject({ decline: "WRONG_CHAIN" });
  });

  test("GATE_NOT_SERVED and GATE_NOT_FOR_AGENT, from the workflow's own allowlist", () => {
    expect(checkRequest(real(), testConfig({ gates: [{ gate: C, agentId: "1984" }] }))).toMatchObject({ decline: "GATE_NOT_SERVED" });
    expect(checkRequest(real(), testConfig({ gates: [{ gate: REAL.vault, agentId: "1985" }] }))).toMatchObject({ decline: "GATE_NOT_FOR_AGENT" });
  });
});

describe("checkPinned: the workflow's own reads at P, the request's block", () => {
  const header = { hash: REAL.blockHash, timestamp: REAL.blockTime };

  test("passes the real block with the pending request naming C, and returns P's time", () => {
    expect(checkPinned({ t: real(), header, status: pending, deadline: REAL.deadline, cfg: testConfig() })).toEqual({ pinTime: REAL.blockTime });
  });

  test("pinned_rejectsHashMismatch: a header hash other than the trigger's block hash throws (reorg or RPC)", () => {
    expect(() => checkPinned({ t: real(), header: { ...header, hash: ZERO }, status: pending, deadline: REAL.deadline, cfg: testConfig() })).toThrow(
      /PIN_HASH_MISMATCH/,
    );
  });

  test("REQUEST_NOT_AT_PIN: a status at P naming another validator or agent", () => {
    // A status read at P throws on a revert (the request isn't there), so checkPinned only ever sees a status (P12).
    for (const status of [{ ...pending, validator: C }, { ...pending, agentId: 1985n }]) {
      expect(checkPinned({ t: real(), header, status, deadline: REAL.deadline, cfg: testConfig() })).toMatchObject({ decline: "REQUEST_NOT_AT_PIN" });
    }
  });

  test("pinned_declinesDeadlineTooFar: more than 3,600 s after P's time; exactly 3,600 is fine", () => {
    const at = (deadline: bigint) => checkPinned({ t: real(), header, status: pending, deadline, cfg: testConfig() });
    expect(at(REAL.blockTime + 3_600n)).toEqual({ pinTime: REAL.blockTime });
    expect(at(REAL.blockTime + 3_601n)).toMatchObject({ decline: "DEADLINE_TOO_FAR" });
  });
});

describe("checkLive: finality, the deadline and 'not answered yet', at the finalized head", () => {
  const live = (o: { number: bigint; timestamp?: bigint; status?: OnchainStatus; deadline?: bigint }) =>
    checkLive({
      P: REAL.block,
      finalized: { number: o.number, timestamp: o.timestamp ?? REAL.blockTime },
      finalizedStatus: o.status ?? pending,
      deadline: o.deadline ?? REAL.deadline,
      cfg: testConfig(),
    });

  test("live_retryUntilFinal: below P + 5 is a retry; P + 5 passes", () => {
    expect(live({ number: REAL.block + 4n })).toMatchObject({ retry: expect.stringMatching(/^NOT_FINAL/) });
    expect(live({ number: REAL.block + 5n })).toBe(true);
  });

  test("live_declinesAnswered: a response hash or a tag means answered", () => {
    expect(live({ number: REAL.block + 9n, status: { ...pending, tag: "mandate-v1" } })).toMatchObject({ decline: "ALREADY_ANSWERED" });
    expect(live({ number: REAL.block + 9n, status: { ...pending, responseHash: `0x${"01".repeat(32)}` } })).toMatchObject({
      decline: "ALREADY_ANSWERED",
    });
  });

  test("live_declinesDeadlinePassed: the finalized head's time is past the deadline", () => {
    expect(live({ number: REAL.block + 9n, timestamp: REAL.deadline + 1n })).toMatchObject({ decline: "DEADLINE_PASSED" });
    expect(live({ number: REAL.block + 9n, timestamp: REAL.deadline })).toBe(true);
  });
});
