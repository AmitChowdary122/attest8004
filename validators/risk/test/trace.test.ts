import { readFileSync } from "node:fs";
import { encodeErrorResult, getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { flattenTrace, type CallFrame, type TraceResult } from "../src/trace.ts";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/chain/trace-passthrough.json", import.meta.url), "utf8")) as {
  result: CallFrame;
};

function frame(partial: Partial<CallFrame> & { type: string; from: Hex }): CallFrame {
  return partial as CallFrame;
}

describe("flattenTrace: the recorded vault -> pass-through -> sink trace", () => {
  it("flattens to two calls (depth 0, depth 1), both moving 0.001 MON, with ok: true", () => {
    const result: TraceResult = { ok: true, frame: FIXTURE.result };
    const flattened = flattenTrace(result, 16);

    expect(flattened.ok).toBe(true);
    expect(flattened.error).toBeNull();
    expect(flattened.revertReason).toBeNull();
    expect(flattened.truncatedCalls).toBe(0);

    expect(flattened.calls).toEqual([
      {
        depth: 0,
        type: "CALL",
        from: getAddress("0x23BfBD12545CCd1501ddA1B65a54518FD6212a96"),
        to: getAddress("0xEEEBBa55620afC42E9c88b5d962476367b8da338"),
        value: "1000000000000000",
        selector: null,
        error: null,
      },
      {
        depth: 1,
        type: "CALL",
        from: getAddress("0xEEEBBa55620afC42E9c88b5d962476367b8da338"),
        to: getAddress("0xc8702cA01e934f0568ea43B354C17ec7749d313f"),
        value: "1000000000000000",
        selector: null,
        error: null,
      },
    ]);

    expect(flattened.valueFlows).toEqual([
      { from: getAddress("0x23BfBD12545CCd1501ddA1B65a54518FD6212a96"), to: getAddress("0xEEEBBa55620afC42E9c88b5d962476367b8da338"), value: "1000000000000000" },
      { from: getAddress("0xEEEBBa55620afC42E9c88b5d962476367b8da338"), to: getAddress("0xc8702cA01e934f0568ea43B354C17ec7749d313f"), value: "1000000000000000" },
    ]);
  });
});

describe("flattenTrace: a reverting frame", () => {
  it('a top frame with Error("nope") output gives REVERTED and revertReason "nope"', () => {
    const output = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
      errorName: "Error",
      args: ["nope"],
    });
    const result: TraceResult = {
      ok: true,
      frame: frame({ type: "CALL", from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", error: "execution reverted", output }),
    };
    const flattened = flattenTrace(result, 16);
    expect(flattened.ok).toBe(false);
    expect(flattened.error).toBe("REVERTED");
    expect(flattened.revertReason).toBe("nope");
  });

  it("a revert whose output isn't Error(string) gives a null revertReason", () => {
    const result: TraceResult = {
      ok: true,
      frame: frame({
        type: "CALL",
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
        error: "execution reverted",
        output: "0xdeadbeef",
      }),
    };
    const flattened = flattenTrace(result, 16);
    expect(flattened.error).toBe("REVERTED");
    expect(flattened.revertReason).toBeNull();
  });

  it('an "out of gas" error is OUT_OF_GAS, with no revert reason', () => {
    const result: TraceResult = {
      ok: true,
      frame: frame({ type: "CALL", from: "0x1111111111111111111111111111111111111111", error: "out of gas" }),
    };
    const flattened = flattenTrace(result, 16);
    expect(flattened.error).toBe("OUT_OF_GAS");
    expect(flattened.revertReason).toBeNull();
  });
});

describe("flattenTrace: a linear chain of 20 nested calls", () => {
  function chainOf(depth: number): CallFrame {
    const leaf = frame({ type: "CALL", from: "0x0000000000000000000000000000000000000000" });
    let node = leaf;
    for (let i = 0; i < depth - 1; i++) {
      node = frame({ type: "CALL", from: "0x0000000000000000000000000000000000000000", calls: [node] });
    }
    return node;
  }

  it("20 nested calls give 16 calls and truncatedCalls: 4", () => {
    const result: TraceResult = { ok: true, frame: chainOf(20) };
    const flattened = flattenTrace(result, 16);
    expect(flattened.calls).toHaveLength(16);
    expect(flattened.truncatedCalls).toBe(4);
    const calls = flattened.calls as Array<{ depth: number }>;
    expect(calls.map((c) => c.depth)).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });
});

describe("flattenTrace: INSUFFICIENT_FUNDS is passed through", () => {
  it("resolves to ok: false, error: INSUFFICIENT_FUNDS, with no calls", () => {
    const result: TraceResult = { ok: false, error: "INSUFFICIENT_FUNDS" };
    const flattened = flattenTrace(result, 16);
    expect(flattened).toEqual({ ok: false, error: "INSUFFICIENT_FUNDS", revertReason: null, calls: [], valueFlows: [], truncatedCalls: 0 });
  });
});

describe("flattenTrace: determinism", () => {
  it("flattening the same TraceResult twice gives byte-identical JSON", () => {
    const result: TraceResult = { ok: true, frame: FIXTURE.result };
    expect(JSON.stringify(flattenTrace(result, 16))).toBe(JSON.stringify(flattenTrace(result, 16)));
  });
});
