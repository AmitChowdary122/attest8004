import { getAddress, keccak256, toHex, zeroHash, type Hash, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  MemoryCursorStore,
  buildAction,
  buildRequestJson,
  encodeJsonDataUri,
  requestHashOfJson,
  type RequestEvent,
  type ValidationStatus,
  type ValidatorChain,
} from "@attest8004/sdk";
import { STUB_TAG, StubValidator } from "./stub-validator.ts";

const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const NOW = 1_790_000_000n;

function requestEvent(salt: Hex, logIndex: number): RequestEvent {
  const json = buildRequestJson({
    chainId: 10143,
    gate: getAddress("0x23bfbd12545ccd1501dda1b65a54518fd6212a96"),
    validator: VALIDATOR,
    action: buildAction({ agentId: 1984n, target: VALIDATOR, deadline: NOW + 600n, salt }),
  });
  return {
    validator: VALIDATOR,
    agentId: 1984n,
    requestURI: encodeJsonDataUri(json).uri,
    requestHash: requestHashOfJson(json),
    blockNumber: 100n,
    logIndex,
    txHash: keccak256(toHex(logIndex)),
  };
}

describe("StubValidator", () => {
  // It signs with validator A's real key, and gates check the validator's address, not the tag:
  // it must never pass anyone else's request that names validator A.
  it("answers only the request hashes it was started for", async () => {
    const ours = requestEvent(`0x${"01".repeat(32)}`, 0);
    const theirs = requestEvent(`0x${"02".repeat(32)}`, 1);
    const responded: Hex[] = [];
    const chain: ValidatorChain = {
      address: VALIDATOR,
      chainId: async () => 10143,
      head: async () => ({ number: 100n, timestamp: NOW }),
      requestLogs: async () => [ours, theirs],
      status: async (requestHash): Promise<ValidationStatus> => ({
        validator: VALIDATOR,
        agentId: 1984n,
        response: 0,
        responseHash: responded.includes(requestHash) ? keccak256("0x01") : zeroHash,
        tag: "",
        lastUpdate: 1n,
      }),
      respond: async ({ requestHash }): Promise<Hash> => {
        responded.push(requestHash);
        return keccak256(requestHash);
      },
    };
    const stub = new StubValidator({
      chain,
      tag: STUB_TAG,
      cursor: new MemoryCursorStore(99n),
      log: () => {},
      onlyRequestHashes: [ours.requestHash],
    });

    const { outcomes } = await stub.pollOnce();

    expect(outcomes.map((o) => (o.kind === "skipped" ? o.reason : o.kind))).toEqual(["responded", "DECLINED"]);
    expect(responded).toEqual([ours.requestHash]);
  });
});
