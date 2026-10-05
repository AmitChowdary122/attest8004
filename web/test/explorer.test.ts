import { describe, expect, it } from "vitest";
import { explorerAddress, explorerTx } from "../src/explorer.ts";

// Every link the pages render goes through these builders, which accept only well-formed hex: a string from the
// indexer or the chain can never become a link anywhere else (javascript:, another host, a path).
describe("explorer links", () => {
  it("link a transaction hash or an address on the testnet explorer, lowercased", () => {
    expect(explorerTx("0x" + "AB".repeat(32))).toBe(`https://monad-testnet.socialscan.io/tx/0x${"ab".repeat(32)}`);
    expect(explorerAddress("0x12fAb3E3cA810Cc44bD9f537613a230a2be8D614")).toBe("https://monad-testnet.socialscan.io/address/0x12fab3e3ca810cc44bd9f537613a230a2be8d614");
  });

  it("refuse anything else", () => {
    for (const bad of [null, undefined, "", "0x1234", "0x" + "ab".repeat(31), "javascript:alert(1)", `0x${"ab".repeat(32)}/../x`, ` 0x${"ab".repeat(32)}`, `0x${"zz".repeat(32)}`]) {
      expect(explorerTx(bad), String(bad)).toBeNull();
    }
    for (const bad of [null, "0x" + "a".repeat(39), "0x" + "a".repeat(41), "https://evil.example", `0x${"g".repeat(40)}`]) {
      expect(explorerAddress(bad), String(bad)).toBeNull();
    }
  });
});
