import { describe, expect, test } from "bun:test";
import { decodeValidationRequest } from "../src/trigger.ts";
import { REAL, realTriggerLog } from "./helpers.ts";

describe("decodeValidationRequest", () => {
  test("decodes the real ValidationRequest log of tx 0x428a7fd2…", () => {
    const t = decodeValidationRequest(realTriggerLog());
    expect(t.validator).toBe(REAL.validatorA);
    expect(t.agentId).toBe(1984n);
    expect(t.requestHash).toBe(REAL.requestHash);
    expect(t.block).toBe(REAL.block);
    expect(t.blockHash).toBe(REAL.blockHash);
    expect(t.txHash).toBe("0x428a7fd27aa4e21189c7ec90cb680e9274c1f79f0cfd2c37b0f70ccec4d297ed");
    expect(t.requestURI).toStartWith("data:application/json;base64,eyJzY2hlbWEiOiJhdHRlc3Q4MDA0");
    expect(t.requestURI.length).toBe(537);
  });

  test("throws on a log that isn't a ValidationRequest", () => {
    const log = realTriggerLog();
    log.topics[0] = new Uint8Array(32);
    expect(() => decodeValidationRequest(log)).toThrow();
  });

  test("throws when the trigger carries no block number", () => {
    const { blockNumber: _, ...rest } = realTriggerLog();
    expect(() => decodeValidationRequest(rest)).toThrow(/block number/);
  });
});
