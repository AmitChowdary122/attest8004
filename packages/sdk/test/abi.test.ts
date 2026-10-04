import { readFileSync } from "node:fs";
import { getAbiItem, parseAbi, toEventSelector, toEventSignature, toFunctionSelector, toFunctionSignature, type AbiParameter } from "viem";
import { describe, expect, it } from "vitest";
import { mandateRegistryAbi } from "../src/index.ts";

// passkey-vectors.json is shared with contracts/test/MandateRegistry.t.sol; its selectors and topics come
// from cast (passkey-vectors.sh), independent of both the contract and this ABI.
const vectors = JSON.parse(readFileSync(new URL("./passkey-vectors.json", import.meta.url), "utf8")) as {
  selectors: Record<string, { signature: string; selector: string }>;
  topics: Record<string, { signature: string; topic0: string }>;
};

/** `name(type,…)`, the canonical signature a function or error selector hashes. */
function signatureOf(item: { name: string; inputs: readonly AbiParameter[] }): string {
  return toFunctionSignature({ type: "function", name: item.name, inputs: item.inputs, outputs: [], stateMutability: "nonpayable" });
}

/**
 * P4's own entries (P4's abi.ts, contracts/src/MandateRegistry.sol before P6). v2 keeps these exactly, so
 * one ABI reads and decodes both registries in the history.
 */
const p4Abi = parseAbi([
  "struct Mandate { address[] allowedTargets; bytes4[] allowedSelectors; uint256 maxValuePerTx; uint256 maxValuePerDay; uint64 validUntil; }",
  "function getMandate(uint256 agentId) view returns (Mandate mandate, bytes32 mandateHash, address owner, uint64 setAtBlock)",
  "function mandateHashOf(Mandate mandate) pure returns (bytes32)",
  "function identityRegistry() view returns (address)",
  "event MandateSet(uint256 indexed agentId, bytes32 indexed mandateHash, address indexed owner, address[] allowedTargets, bytes4[] allowedSelectors, uint256 maxValuePerTx, uint256 maxValuePerDay, uint64 validUntil, uint64 setAtBlock)",
  "event MandateRevoked(uint256 indexed agentId, bytes32 indexed mandateHash, address indexed owner)",
]);

describe("mandateRegistryAbi (MandateRegistry v2)", () => {
  it("mandateRegistryAbi selectors and topics match passkey-vectors.json", () => {
    for (const [name, { signature, selector }] of Object.entries(vectors.selectors)) {
      const items = mandateRegistryAbi.filter((item) => (item.type === "function" || item.type === "error") && item.name === name);
      expect(items, name).toHaveLength(1); // one entry per name: no overload left over from P4
      const item = items[0] as { name: string; inputs: readonly AbiParameter[] };
      expect(signatureOf(item), name).toBe(signature);
      expect(toFunctionSelector(signatureOf(item)), name).toBe(selector);
    }
    for (const [name, { signature, topic0 }] of Object.entries(vectors.topics)) {
      const items = mandateRegistryAbi.filter((item) => item.type === "event" && item.name === name);
      expect(items, name).toHaveLength(1);
      const event = items[0] as Parameters<typeof toEventSignature>[0];
      expect(toEventSignature(event), name).toBe(signature);
      expect(toEventSelector(event), name).toBe(topic0);
    }
    // Every event and every error the registry itself declares is in the vectors (ERC721NonexistentToken
    // is the Identity Registry's, propagated through ownerOf).
    const events = mandateRegistryAbi.filter((item) => item.type === "event").map((item) => item.name);
    expect(events.sort()).toEqual(Object.keys(vectors.topics).sort());
    const errors = mandateRegistryAbi.filter((item) => item.type === "error" && item.name !== "ERC721NonexistentToken");
    for (const error of errors) expect(Object.keys(vectors.selectors), error.name).toContain(error.name);
    // P4-only entries are gone: the 2-argument setMandate (checked above) and REVOKE.
    const names: string[] = mandateRegistryAbi.map((item) => item.name);
    expect(names).not.toContain("REVOKE");
  });

  it("keeps P4's getMandate, mandateHashOf, identityRegistry, MandateSet and MandateRevoked exactly", () => {
    for (const name of ["getMandate", "mandateHashOf", "identityRegistry", "MandateSet", "MandateRevoked"] as const) {
      expect(getAbiItem({ abi: mandateRegistryAbi, name }), name).toEqual(getAbiItem({ abi: p4Abi, name }));
    }
  });
});
