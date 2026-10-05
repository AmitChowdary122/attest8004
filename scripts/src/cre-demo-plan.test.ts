import type { VerifyReport } from "@attest8004/validator-mandate";
import { encodeEventTopics, getAddress, parseAbi, zeroHash, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  alreadyAnsweredLines,
  childEnv,
  creBudget,
  creExcludedFromVault,
  findCreCli,
  fitOuterGas,
  landedVerdict,
  printableCommand,
  requestLogIndex,
  simulateArgv,
  simulationDecision,
} from "./cre-demo-plan.ts";

describe("fitOuterGas: the forwarder's own gas as outerBase + outerPerByte × raw report bytes", () => {
  it("recovers an exact line, rounding the base up to the next 1,000", () => {
    const samples = [
      { rawReportBytes: 1_000, gas: 66_000n },
      { rawReportBytes: 5_000, gas: 130_000n },
      { rawReportBytes: 10_000, gas: 210_000n },
    ];
    expect(fitOuterGas(samples)).toEqual({ outerBase: 50_000, outerPerByte: 16 });
  });

  it("fitOuterGas_rounds_up_and_covers_every_sample", () => {
    const samples = [
      { rawReportBytes: 1_500, gas: 71_234n },
      { rawReportBytes: 5_600, gas: 140_111n },
      { rawReportBytes: 11_000, gas: 225_999n },
      { rawReportBytes: 22_000, gas: 404_321n },
    ];
    const { outerBase, outerPerByte } = fitOuterGas(samples);
    expect(Number.isInteger(outerPerByte)).toBe(true);
    expect(outerBase % 1_000).toBe(0);
    for (const s of samples) expect(BigInt(outerBase + outerPerByte * s.rawReportBytes)).toBeGreaterThanOrEqual(s.gas);
  });

  it("needs two sizes at least", () => {
    expect(() => fitOuterGas([{ rawReportBytes: 1_000, gas: 1n }])).toThrow();
  });
});

const C = getAddress("0x6d12f00870cb6eda2d8e389696f6b5d050423b95");
const A = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const B = getAddress("0x780df855b48aec7a3907433b0b5984a2fe5dca5e");
const REGISTRY = getAddress("0xc4a4d0ceb3971cbe7a2536494ac106f2cd9f9a8f");
const TX = `0x${"ab".repeat(32)}` as Hex;
const RH = `0x${"cd".repeat(32)}` as Hex;
const KEY = `0x${"11".repeat(32)}`;

describe("the simulate command", () => {
  it("simulateArgv_isExact: the CLI arguments after the cre binary, run from cre/", () => {
    expect(simulateArgv({ txHash: TX, eventIndex: 1, wasm: "/tmp/c.wasm", broadcast: true })).toEqual([
      "workflow",
      "simulate",
      "validator-c",
      "--target",
      "monad-testnet-sim",
      "--non-interactive",
      "--broadcast",
      "--wasm",
      "/tmp/c.wasm",
      "--trigger-index",
      "0",
      "--evm-tx-hash",
      TX,
      "--evm-event-index",
      "1",
    ]);
    expect(simulateArgv({ txHash: TX, eventIndex: 0, broadcast: false })).not.toContain("--broadcast");
  });

  it("printableCommand_hasNoKey: names where the key comes from, never its value", () => {
    const line = printableCommand(simulateArgv({ txHash: TX, eventIndex: 0, broadcast: true }));
    expect(line).toBe(
      `cd cre && CRE_ETH_PRIVATE_KEY=<from .env> mise exec -- cre workflow simulate validator-c --target monad-testnet-sim --non-interactive --broadcast --trigger-index 0 --evm-tx-hash ${TX} --evm-event-index 0`,
    );
    expect(line).not.toContain(KEY);
  });

  it("childEnv_onlyThreeVars: the CLI gets PATH, HOME and the broadcast key, nothing else from .env", () => {
    const env = { PATH: "/bin", HOME: "/home/x", CRE_ETH_PRIVATE_KEY: KEY, DEPLOYER_PRIVATE_KEY: "0xdead", LLM_API_KEY: "k" };
    expect(childEnv(env)).toEqual({ PATH: "/bin", HOME: "/home/x", CRE_ETH_PRIVATE_KEY: KEY });
  });

  it("childEnv_throwsWithoutKey, naming the variable only", () => {
    expect(() => childEnv({ PATH: "/bin", HOME: "/h" })).toThrow("CRE_ETH_PRIVATE_KEY is not set in .env");
    expect(() => childEnv({ PATH: "/bin", HOME: "/h", CRE_ETH_PRIVATE_KEY: "  " })).toThrow("CRE_ETH_PRIVATE_KEY is not set in .env");
  });

  it("findCreCli_order: CRE_CLI, then PATH, then ~/.cre/bin/cre", () => {
    const has = (paths: string[]) => (p: string) => paths.includes(p);
    expect(findCreCli({ CRE_CLI: "/opt/cre", PATH: "/usr/bin", HOME: "/h" }, has(["/opt/cre", "/usr/bin/cre"]))).toBe("/opt/cre");
    expect(findCreCli({ PATH: "/a:/usr/bin", HOME: "/h" }, has(["/usr/bin/cre", "/h/.cre/bin/cre"]))).toBe("/usr/bin/cre");
    expect(findCreCli({ PATH: "/a", HOME: "/h" }, has(["/h/.cre/bin/cre"]))).toBe("/h/.cre/bin/cre");
    expect(() => findCreCli({ PATH: "/a", HOME: "/h" }, has([]))).toThrow(/CRE CLI/);
  });
});

describe("requestLogIndex: --evm-event-index is the log's position in the transaction's receipt", () => {
  it("requestLogIndex_findsRegistryLog among the forwarder tx's logs", () => {
    const abi = parseAbi(["event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)"]);
    const topics = encodeEventTopics({ abi, eventName: "ValidationRequest", args: { validatorAddress: C, agentId: 1984n, requestHash: RH } }) as Hex[];
    const logs = [
      { address: getAddress("0x1451f3c36545b191d3642f759d59f21dcfd657b2"), topics: [`0x${"99".repeat(32)}` as Hex] },
      { address: REGISTRY, topics },
    ];
    expect(requestLogIndex(logs, REGISTRY, RH)).toBe(1);
    expect(() => requestLogIndex(logs, REGISTRY, `0x${"00".repeat(32)}`)).toThrow();
  });
});

describe("landedVerdict: a write counts only when the forwarder says result=true and C's verdict is on chain", () => {
  const status = { validator: C, agentId: 1984n, response: 100, responseHash: RH, tag: "mandate-v1", lastUpdate: 1n };

  it("landed", () => {
    expect(landedVerdict({ reportProcessed: { result: true }, status, expectedHash: RH, creValidator: C })).toEqual({ landed: true, score: 100 });
  });

  it("landedVerdict_requiresReportProcessedTrue: the forwarder swallowed onReport's revert", () => {
    expect(landedVerdict({ reportProcessed: { result: false }, status, expectedHash: RH, creValidator: C })).toMatchObject({ landed: false });
    expect(landedVerdict({ reportProcessed: null, status, expectedHash: RH, creValidator: C })).toMatchObject({ landed: false });
  });

  it("landedVerdict_rejectsOtherValidator and an unanswered request", () => {
    expect(landedVerdict({ reportProcessed: { result: true }, status: { ...status, validator: A }, expectedHash: RH, creValidator: C })).toMatchObject({ landed: false });
    expect(landedVerdict({ reportProcessed: { result: true }, status: { ...status, responseHash: zeroHash, tag: "" }, expectedHash: null, creValidator: C })).toMatchObject({
      landed: false,
    });
  });

  it("landedVerdict_rejectsHashMismatch: another verdict filled C's slot", () => {
    expect(landedVerdict({ reportProcessed: { result: true }, status, expectedHash: `0x${"ee".repeat(32)}`, creValidator: C })).toMatchObject({ landed: false });
  });
});

describe("preflight and refusals", () => {
  it("creBudget_math: takes = balance ÷ (2 reports × gas × max fee)", () => {
    expect(creBudget({ balance: 10n ** 18n, reportGas: 600_000n, maxFeePerGas: 100_000_000_000n })).toEqual({ perReport: 6n * 10n ** 16n, takesLeft: 8n });
  });

  it("creExcludedFromVault: true only when no requirement names C", () => {
    expect(creExcludedFromVault([{ validator: A }, { validator: B }], C)).toBe(true);
    expect(creExcludedFromVault([{ validator: A }, { validator: C.toLowerCase() as Hex }], C)).toBe(false);
  });

  it("alreadyAnswered_refusesToSimulate: an answered request is never simulated (a broadcast would spend for nothing)", () => {
    expect(simulationDecision({ responseHash: zeroHash, tag: "" })).toEqual({ simulate: true });
    expect(simulationDecision({ responseHash: RH, tag: "mandate-v1" })).toEqual({ simulate: false, reason: "C already answered this request" });
  });

  it("alreadyAnsweredLines_showVerifyVerdict: match, MISMATCH (a forged verdict took C's slot) or unverifiable", () => {
    const base = { requestHash: RH, validator: C, pinnedBlock: 68_500_000n, posted: { score: 100, responseHash: RH, tag: "mandate-v1" }, problems: [] } as unknown as VerifyReport;
    expect(alreadyAnsweredLines({ ...base, verdict: "match" })).toEqual([
      "C already answered this request; verify re-executes that verdict:",
      "  match: re-running mandate-v1 at block 68500000 gives the posted score 100 and responseHash (C's own verdict)",
    ]);
    expect(alreadyAnsweredLines({ ...base, verdict: "mismatch", problems: ["SCORE_MISMATCH"] } as VerifyReport)[1]).toBe(
      "  MISMATCH (SCORE_MISMATCH): the posted verdict doesn't reproduce: someone filled C's slot through the mock forwarder's open route()",
    );
    expect(alreadyAnsweredLines({ ...base, verdict: "unverifiable", problems: ["RESPONSE_NOT_FOUND"] } as VerifyReport)[1]).toBe(
      "  could not verify (RESPONSE_NOT_FOUND): nothing is proven either way",
    );
  });
});
