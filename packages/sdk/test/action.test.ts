import { readFileSync } from "node:fs";
import {
  AbiEncodingBytesSizeMismatchError,
  IntegerOutOfRangeError,
  InvalidAddressError,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { computeActionHash, computeRequestHash, type Action } from "../src/index.ts";

// vectors.json is shared with contracts/test/ActionHash.t.sol; its hashes come from cast (vectors.sh).
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const decimal = z.string().regex(/^\d+$/);
const vectorFile = z.object({
  schema: z.literal("attest8004.hash-vectors.v1"),
  vectors: z.array(
    z.object({
      name: z.string(),
      chainId: decimal,
      gate: hex,
      validator: hex,
      action: z.object({ agentId: decimal, target: hex, value: decimal, data: hex, deadline: decimal, salt: hex }),
      actionHash: hex,
      requestHash: hex,
    }),
  ),
});

const { vectors } = vectorFile.parse(
  JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8")),
);

type Vector = (typeof vectors)[number];

function toAction(v: Vector): Action {
  return {
    agentId: BigInt(v.action.agentId),
    target: v.action.target as Address,
    value: BigInt(v.action.value),
    data: v.action.data as Hex,
    deadline: BigInt(v.action.deadline),
    salt: v.action.salt as Hex,
  };
}

function byName(name: string): Vector {
  const v = vectors.find((x) => x.name === name);
  if (!v) throw new Error(`missing vector ${name}`);
  return v;
}

const base = byName("erc20-transfer-testnet");
const baseArgs = {
  chainId: Number(base.chainId),
  gate: base.gate as Address,
  validator: base.validator as Address,
  action: toAction(base),
};

describe("computeActionHash / computeRequestHash", () => {
  it("matches every shared vector", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(8);
    for (const v of vectors) {
      const args = { chainId: BigInt(v.chainId), gate: v.gate as Address, action: toAction(v) };
      expect(computeActionHash(args), `${v.name} actionHash`).toBe(v.actionHash);
      expect(computeRequestHash({ ...args, validator: v.validator as Address }), `${v.name} requestHash`).toBe(
        v.requestHash,
      );
    }
  });

  it("actionHash ignores the validator, requestHash binds it", () => {
    const other = byName("same-action-validator-b");
    expect(other.actionHash).toBe(base.actionHash);
    expect(other.requestHash).not.toBe(base.requestHash);
    expect(computeActionHash({ ...baseArgs, action: toAction(other) })).toBe(base.actionHash);
    expect(computeRequestHash({ ...baseArgs, validator: other.validator as Address })).toBe(other.requestHash);
  });

  it("treats addresses case-insensitively", () => {
    const lower = {
      ...baseArgs,
      gate: baseArgs.gate.toLowerCase() as Address,
      validator: baseArgs.validator.toLowerCase() as Address,
      action: { ...baseArgs.action, target: baseArgs.action.target.toLowerCase() as Address },
    };
    expect(computeActionHash(lower)).toBe(base.actionHash);
    expect(computeRequestHash(lower)).toBe(base.requestHash);
    expect(computeRequestHash({ ...lower, gate: getAddress(lower.gate) })).toBe(base.requestHash);
  });

  it("accepts chainId as a number or a bigint", () => {
    expect(computeRequestHash({ ...baseArgs, chainId: 10143 })).toBe(base.requestHash);
    expect(computeRequestHash({ ...baseArgs, chainId: 10143n })).toBe(base.requestHash);
  });

  describe("rejects an action the contract would see differently", () => {
    const withAction = (patch: Partial<Action>) => ({ ...baseArgs, action: { ...baseArgs.action, ...patch } });

    // Each assertion names the error, so a missing function (which also throws) can't pass it.
    it("odd-length data", () => {
      expect(() => computeRequestHash(withAction({ data: "0x123" }))).toThrow(/action\.data/);
      expect(() => computeActionHash(withAction({ data: "0x123" }))).toThrow(/action\.data/);
    });

    it("non-hex data", () => {
      expect(() => computeRequestHash(withAction({ data: "0xzz" as Hex }))).toThrow(/action\.data/);
      expect(() => computeRequestHash(withAction({ data: "abcd" as Hex }))).toThrow(/action\.data/);
    });

    it("a salt that is not 32 bytes", () => {
      expect(() => computeRequestHash(withAction({ salt: `0x${"11".repeat(31)}` }))).toThrow(
        AbiEncodingBytesSizeMismatchError,
      );
      expect(() => computeRequestHash(withAction({ salt: `0x${"11".repeat(33)}` }))).toThrow(
        AbiEncodingBytesSizeMismatchError,
      );
    });

    it("a deadline above uint64", () => {
      expect(() => computeRequestHash(withAction({ deadline: 2n ** 64n }))).toThrow(IntegerOutOfRangeError);
    });

    it("a negative value or agentId", () => {
      expect(() => computeRequestHash(withAction({ value: -1n }))).toThrow(IntegerOutOfRangeError);
      expect(() => computeRequestHash(withAction({ agentId: -1n }))).toThrow(IntegerOutOfRangeError);
    });

    it("an address with a bad checksum", () => {
      // The valid checksum is 0x513d9815b1Fc9391e6dF16e8B6145d183eab815B; flip the case of one letter.
      expect(() =>
        computeRequestHash(withAction({ target: "0x513D9815b1Fc9391e6dF16e8B6145d183eab815B" })),
      ).toThrow(InvalidAddressError);
      expect(() =>
        computeRequestHash({ ...baseArgs, validator: "0xA62DaB21E0C0F57e94B3ed6e675F214199989e92" }),
      ).toThrow(InvalidAddressError);
    });
  });
});
