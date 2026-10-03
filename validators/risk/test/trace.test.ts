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

describe("flattenTrace: valueFlows only counts real movements (fix round 1, finding 1)", () => {
  it("a DELEGATECALL child with inherited value gives no flow for it", () => {
    const result: TraceResult = {
      ok: true,
      frame: frame({
        type: "CALL",
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
        value: "0x1",
        calls: [
          frame({
            type: "DELEGATECALL",
            from: "0x2222222222222222222222222222222222222222",
            to: "0x3333333333333333333333333333333333333333",
            value: "0x1", // callTracer gives a DELEGATECALL the inherited msg.value, but no MON actually moves
          }),
        ],
      }),
    };
    const flattened = flattenTrace(result, 16);
    const flows = flattened.valueFlows as Array<{ from: string; to: string }>;
    expect(flows).toHaveLength(1);
    expect(flows[0]?.to).toBe(getAddress("0x2222222222222222222222222222222222222222"));
  });

  it("a reverted child CALL with value gives no flow", () => {
    const result: TraceResult = {
      ok: true,
      frame: frame({
        type: "CALL",
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
        value: "0x1",
        calls: [
          frame({
            type: "CALL",
            from: "0x2222222222222222222222222222222222222222",
            to: "0x3333333333333333333333333333333333333333",
            value: "0x1",
            error: "execution reverted",
          }),
        ],
      }),
    };
    const flattened = flattenTrace(result, 16);
    expect(flattened.valueFlows).toEqual([
      { from: getAddress("0x1111111111111111111111111111111111111111"), to: getAddress("0x2222222222222222222222222222222222222222"), value: "1" },
    ]);
  });

  it("a successful CALL under a reverted parent gives no flow (the parent's revert still wins)", () => {
    const result: TraceResult = {
      ok: true,
      frame: frame({
        type: "CALL",
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
        value: "0x1",
        error: "execution reverted",
        calls: [
          frame({
            type: "CALL",
            from: "0x2222222222222222222222222222222222222222",
            to: "0x3333333333333333333333333333333333333333",
            value: "0x1", // this inner call itself succeeded, but its parent frame reverted, so it never really moved value
          }),
        ],
      }),
    };
    const flattened = flattenTrace(result, 16);
    expect(flattened.valueFlows).toEqual([]);
  });

  it("STATICCALL and CREATE2 value: STATICCALL never flows (no value possible anyway), CREATE2 does", () => {
    const result: TraceResult = {
      ok: true,
      frame: frame({
        type: "CALL",
        from: "0x1111111111111111111111111111111111111111",
        to: "0x2222222222222222222222222222222222222222",
        calls: [
          frame({ type: "STATICCALL", from: "0x2222222222222222222222222222222222222222", to: "0x3333333333333333333333333333333333333333", value: "0x0" }),
          frame({ type: "CREATE2", from: "0x2222222222222222222222222222222222222222", to: "0x4444444444444444444444444444444444444444", value: "0x5" }),
        ],
      }),
    };
    const flattened = flattenTrace(result, 16);
    const flows = flattened.valueFlows as Array<{ to: string }>;
    expect(flows).toHaveLength(1);
    expect(flows[0]?.to).toBe(getAddress("0x4444444444444444444444444444444444444444"));
  });
});

describe("flattenTrace: valueFlows is computed over ALL frames, not just the first maxCalls (fix round 1, finding 2)", () => {
  it("20 frames where the forward (frame 20) carries value: the flow is present, calls stay capped at 16", () => {
    // A chain of 19 cheap zero-value calls, then a 20th that actually moves value.
    const forward = frame({
      type: "CALL",
      from: "0x0000000000000000000000000000000000000013", // depth-19 node's own "from" (arbitrary distinct address)
      to: "0x0000000000000000000000000000000000000099",
      value: "0x64",
    });
    let node: CallFrame = forward;
    for (let i = 18; i >= 0; i--) {
      node = frame({ type: "CALL", from: "0x0000000000000000000000000000000000000000", calls: [node] });
    }
    const result: TraceResult = { ok: true, frame: node };
    const flattened = flattenTrace(result, 16);
    expect(flattened.calls).toHaveLength(16);
    expect(flattened.truncatedCalls).toBe(4);
    expect(flattened.valueFlows).toEqual([{ from: getAddress("0x0000000000000000000000000000000000000013"), to: getAddress("0x0000000000000000000000000000000000000099"), value: "100" }]);
  });
});

describe("flattenTrace: revertReason is bounded (fix round 1, finding 3)", () => {
  it("a revert reason over 256 chars is cut to 256 and revertReasonTruncated: true", () => {
    const longMessage = "x".repeat(500);
    const output = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
      errorName: "Error",
      args: [longMessage],
    });
    const result: TraceResult = {
      ok: true,
      frame: frame({ type: "CALL", from: "0x1111111111111111111111111111111111111111", error: "execution reverted", output }),
    };
    const flattened = flattenTrace(result, 16);
    expect(flattened.revertReason).toBe("x".repeat(256));
    expect(flattened.revertReasonTruncated).toBe(true);
  });

  it("a revert reason at or under 256 chars is not marked truncated", () => {
    const message = "nope";
    const output = encodeErrorResult({
      abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }],
      errorName: "Error",
      args: [message],
    });
    const result: TraceResult = {
      ok: true,
      frame: frame({ type: "CALL", from: "0x1111111111111111111111111111111111111111", error: "execution reverted", output }),
    };
    const flattened = flattenTrace(result, 16);
    expect(flattened.revertReason).toBe("nope");
    expect(flattened.revertReasonTruncated).toBe(false);
  });
});

describe("flattenTrace: INSUFFICIENT_FUNDS is passed through", () => {
  it("resolves to ok: false, error: INSUFFICIENT_FUNDS, with no calls", () => {
    const result: TraceResult = { ok: false, error: "INSUFFICIENT_FUNDS" };
    const flattened = flattenTrace(result, 16);
    expect(flattened).toEqual({
      ok: false,
      error: "INSUFFICIENT_FUNDS",
      revertReason: null,
      revertReasonTruncated: false,
      calls: [],
      valueFlows: [],
      truncatedCalls: 0,
    });
  });
});

describe("flattenTrace: determinism", () => {
  it("flattening the same TraceResult twice gives byte-identical JSON", () => {
    const result: TraceResult = { ok: true, frame: FIXTURE.result };
    expect(JSON.stringify(flattenTrace(result, 16))).toBe(JSON.stringify(flattenTrace(result, 16)));
  });
});
