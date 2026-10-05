import { DEPLOYMENTS, validationRegistryAbi, type ValidationStatus } from "@attest8004/sdk";
import { mandateContractsFor, SpendLogNotFoundError, verifyContextFor, type VerifyReport } from "@attest8004/validator-mandate";
import { riskContractsFor, type RiskReader, type RiskVerifyReport } from "@attest8004/validator-risk";
import { encodeErrorResult, getAddress, HttpRequestError, InvalidParamsRpcError, keccak256, RpcRequestError, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { chainVerifiers, DEFAULT_RPC_URL, main, USAGE, type CliDeps, type Verifiers } from "../src/cli.ts";
import { printable } from "../src/text.ts";

const HASH = `0x${"ab".repeat(32)}` as Hex;
const RESPONSE_HASH = `0x${"cd".repeat(32)}` as Hex;
const OTHER_RESPONSE_HASH = `0x${"ef".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"12".repeat(32)}` as Hex;
const SPENT_REQUEST = `0x${"34".repeat(32)}` as Hex;
const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const VALIDATOR_B = DEPLOYMENTS[10143].validators.riskV1;
const GATE = getAddress("0x23bfbd12545ccd1501dda1b65a54518fd6212a96");
/** An RPC URL carrying an API key: it must never be printed, nor its host. */
const SECRET_URL = "https://rpc.secret-provider.example/v2/not-a-real-key-42";
const SECRET_HOST = "rpc.secret-provider.example";
const MODEL_OUTPUT_ROW = "model output: recorded, not re-run";

const matchReport: VerifyReport = {
  requestHash: HASH,
  validator: VALIDATOR,
  pinnedBlock: 67_900_000n,
  pinned: { number: 67_900_000n, hash: BLOCK_HASH, timestamp: 1_790_000_000n },
  match: true,
  verdict: "match",
  posted: { score: 0, responseHash: RESPONSE_HASH, tag: "mandate-v1" },
  recomputed: { score: 0, responseHash: RESPONSE_HASH, reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"] },
  problems: [],
  differingKeys: [],
  spendEntries: [
    {
      requestHash: SPENT_REQUEST,
      approvedAt: 1_789_990_000n,
      gate: GATE,
      value: 1_000_000_000_000_000n,
      deadline: 1_789_990_600n,
      consumed: true,
      counted: true,
    },
  ],
  permissionEvents: [
    {
      block: 67_895_000n,
      logIndex: 1,
      txHash: keccak256(toHex("MandateSet tx")),
      emitter: "MandateRegistry",
      event: "MandateSet",
      afterMandate: false,
    },
  ],
};

const mismatchReport: VerifyReport = {
  ...matchReport,
  match: false,
  verdict: "mismatch",
  recomputed: { score: 0, responseHash: OTHER_RESPONSE_HASH, reasons: ["TARGET_NOT_ALLOWED", "VALUE_OVER_TX_CAP"] },
  problems: ["RESPONSE_HASH_MISMATCH"],
  differingKeys: ["block", "permissions"],
};

const unverifiableReport: VerifyReport = {
  ...matchReport,
  pinnedBlock: null,
  pinned: null,
  match: false,
  verdict: "unverifiable",
  posted: { score: 0, responseHash: `0x${"00".repeat(32)}` as Hex, tag: "" },
  recomputed: null,
  problems: ["RESPONSE_NOT_FOUND"],
  spendEntries: [],
  permissionEvents: [],
};

const riskMatchReport: RiskVerifyReport = {
  requestHash: HASH,
  validator: VALIDATOR_B,
  pinnedBlock: 67_900_000n,
  pinned: { number: 67_900_000n, hash: BLOCK_HASH, timestamp: 1_790_000_000n },
  match: true,
  verdict: "match",
  posted: { score: 0, responseHash: RESPONSE_HASH, tag: "risk-v1" },
  recomputed: { score: 0, reasons: ["FUNDS_FORWARDED", "PROMPT_INJECTION_SUSPECTED"] },
  problems: [],
  mismatchedToolCalls: [],
  checkedToolCalls: [
    { index: 0, name: "simulate_action" },
    { index: 1, name: "counterparty_onchain" },
  ],
  uncheckedToolCalls: [{ index: 2, name: "nansen_flows" }],
  notShownToolCalls: [{ index: 3, name: "get_mandate" }],
  model: "openai/gpt-oss-120b",
  findings: [
    { code: "FUNDS_FORWARDED", severity: "high", explanation: "The target forwards all 0.001 MON to the sink.", sources: ["simulate_action"], origin: "model" },
    {
      code: "PROMPT_INJECTION_SUSPECTED",
      severity: "medium",
      explanation: "Untrusted text in calldata_text was classified as a likely prompt injection.",
      sources: ["classifier:calldata_text"],
      origin: "code",
    },
  ],
};

const riskMismatchReport: RiskVerifyReport = {
  ...riskMatchReport,
  match: false,
  verdict: "mismatch",
  problems: ["TOOL_OUTPUT_MISMATCH"],
  mismatchedToolCalls: [0],
};

const riskUnverifiableReport: RiskVerifyReport = {
  ...riskMatchReport,
  pinnedBlock: null,
  pinned: null,
  match: false,
  verdict: "unverifiable",
  recomputed: null,
  problems: ["EVIDENCE_NOT_DECODED"],
  checkedToolCalls: [],
  uncheckedToolCalls: [],
  notShownToolCalls: [],
  model: null,
  findings: [],
};

/** JSON as the CLI prints it: bigints as decimal strings. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));

type HarnessOptions = {
  /** What the mandate-v1 verifier returns. */
  report?: VerifyReport;
  /** What the risk-v1 verifier returns. */
  riskReport?: RiskVerifyReport;
  /** The request's tag at the head (`null`: no such request). Default `mandate-v1`. */
  tag?: string | null;
  connect?: CliDeps["connect"];
  mandate?: Verifiers["mandate"];
  risk?: Verifiers["risk"];
};

/** `main` over scripted verifiers: the chain and the verifiers themselves never run here. */
function harness(over: HarnessOptions = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  const statusCalls: Hex[] = [];
  const verifyCalls: Array<{ requestHash: Hex }> = [];
  const riskCalls: Array<{ requestHash: Hex }> = [];
  const { report = matchReport, riskReport = riskMatchReport, tag = "mandate-v1" } = over;
  const run = (argv: string[], env: Record<string, string | undefined> = {}) =>
    main(argv, env, {
      connect:
        over.connect ??
        (async (rpcUrl) => {
          urls.push(rpcUrl);
          return {
            status: async (requestHash) => {
              statusCalls.push(requestHash);
              return tag === null ? null : { tag };
            },
            mandate: async (requestHash) => {
              verifyCalls.push({ requestHash });
              return over.mandate ? over.mandate(requestHash) : report;
            },
            risk: async (requestHash) => {
              riskCalls.push({ requestHash });
              return over.risk ? over.risk(requestHash) : riskReport;
            },
          };
        }),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });
  return { run, out, err, urls, statusCalls, verifyCalls, riskCalls, all: () => [...out, ...err].join("\n") };
}

describe("attest8004 CLI: usage", () => {
  it.each([
    { argv: [] },
    { argv: ["verify"] },
    { argv: ["verify", "0x123"] },
    { argv: ["verify", "ab".repeat(32)] },
    { argv: ["verify", `${HASH}00`] },
    { argv: ["verify", `0x${"zz".repeat(32)}`] },
    { argv: ["check", HASH] },
    { argv: ["verify", HASH, "--bogus"] },
    { argv: ["verify", HASH, HASH] },
    { argv: ["verify", HASH, "--rpc-url"] },
  ])("$argv: exit 2 with the usage, and no RPC", async ({ argv }) => {
    const h = harness();
    await expect(h.run(argv)).resolves.toBe(2);
    expect(h.err.join("\n")).toContain("usage: attest8004 verify <requestHash> [--rpc-url URL] [--json]");
    expect(h.out).toEqual([]);
    expect(h.urls).toEqual([]);
  });

  it("--help prints the usage on stdout and exits 0", async () => {
    const h = harness();
    await expect(h.run(["--help"])).resolves.toBe(0);
    expect(h.out.join("\n")).toContain("usage: attest8004 verify <requestHash>");
    expect(h.urls).toEqual([]);
  });

  it("the usage names both tags, and says risk-v1's model output is recorded, not re-run", () => {
    expect(USAGE).toContain("mandate-v1");
    expect(USAGE).toContain("risk-v1");
    expect(USAGE).toContain("recorded, not re-run");
  });
});

describe("attest8004 CLI: exit codes and output", () => {
  it.each([
    { report: matchReport, code: 0, first: /^match\b/ },
    { report: mismatchReport, code: 1, first: /^MISMATCH\b/ },
    { report: unverifiableReport, code: 2, first: /^could not verify\b/ },
  ])("$report.verdict: exit $code, and the first line says so", async ({ report, code, first }) => {
    const h = harness({ report });
    await expect(h.run(["verify", HASH])).resolves.toBe(code);
    expect(h.out.join("\n").split("\n")[0]).toMatch(first);
    expect(h.verifyCalls).toEqual([{ requestHash: HASH }]);
  });

  it("prints the validator, the pinned block, both scores and hashes, the reasons, the spend and the permission events", async () => {
    const h = harness();
    await h.run(["verify", HASH]);
    const text = h.out.join("\n");
    expect(text).toContain(VALIDATOR);
    expect(text).toContain("67900000");
    expect(text).toContain(BLOCK_HASH);
    expect(text).toContain(new Date(1_790_000_000_000).toISOString());
    expect(text).toContain(RESPONSE_HASH);
    expect(text).toContain("TARGET_NOT_ALLOWED, VALUE_OVER_TX_CAP");
    expect(text).toContain(SPENT_REQUEST);
    expect(text).toContain("1000000000000000 wei (0.001 MON)");
    expect(text).toMatch(/\bcounted\b/);
    expect(text).toMatch(/permission events\s+1\b/);
    expect(h.err).toEqual([]);
  });

  it("a mismatch names its problems and the differing evidence keys", async () => {
    const h = harness({ report: mismatchReport });
    await h.run(["verify", HASH]);
    const text = h.out.join("\n");
    expect(text).toContain("RESPONSE_HASH_MISMATCH");
    expect(text).toContain("block, permissions");
    expect(text).toContain(OTHER_RESPONSE_HASH);
  });

  it("--json prints the report as one JSON line, bigints as decimal strings, and exits by its verdict", async () => {
    const h = harness({ report: mismatchReport });
    await expect(h.run(["verify", HASH, "--json"])).resolves.toBe(1);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]).not.toContain("\n");
    const parsed = JSON.parse(h.out[0] as string) as Record<string, unknown>;
    expect(parsed).toEqual(asJson(mismatchReport));
    expect(parsed).toMatchObject({ pinnedBlock: "67900000", verdict: "mismatch", match: false });
  });

  it("prints chain-controlled strings escaped, never raw control characters", async () => {
    const report: VerifyReport = {
      ...mismatchReport,
      posted: { ...mismatchReport.posted, tag: "evil\u001b[2J" },
      differingKeys: ["\u001b]0;pwned\u0007"],
    };
    const h = harness({ report });
    await h.run(["verify", HASH]);
    expect(h.all()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(h.all()).toContain("\\u001b[2J");
  });

  it("a thrown error is 'could not verify', exit 2, with viem's short message only", async () => {
    const h = harness({
      mandate: async () => {
        throw new HttpRequestError({ url: SECRET_URL, status: 429, body: { method: "eth_call" } });
      },
    });
    await expect(h.run(["verify", HASH])).resolves.toBe(2);
    expect(h.err.join("\n")).toMatch(/^could not verify/);
    expect(h.err.join("\n")).toContain("HTTP request failed.");
    expect(h.out).toEqual([]);
  });

  it("an approval log not found during the re-run is 'could not verify', exit 2", async () => {
    const h = harness({
      mandate: async () => {
        throw new SpendLogNotFoundError(SPENT_REQUEST, 1_789_990_000n);
      },
    });
    await expect(h.run(["verify", HASH, "--json"])).resolves.toBe(2);
    expect(h.err.join("\n")).toContain(`no ValidationResponse log found for approval ${SPENT_REQUEST}`);
  });

  it("history the RPC no longer serves (-32602) suggests an archive RPC", async () => {
    const h = harness({
      mandate: async () => {
        throw new InvalidParamsRpcError(
          new RpcRequestError({
            body: { method: "eth_call" },
            url: SECRET_URL,
            error: { code: -32602, message: "Block requested not found. Request might be querying historical state that is not available" },
          }),
        );
      },
    });
    await expect(h.run(["verify", HASH])).resolves.toBe(2);
    expect(h.err.join("\n")).toMatch(/archive RPC/);
    expect(h.err.join("\n")).toContain("MONAD_TESTNET_RPC_URL=<url> pnpm attest8004 verify <requestHash>");
  });

  it("the usage's exit-2 line names every unverifiable outcome, including an unknown tag and undecodable evidence", () => {
    const exitCodes = USAGE.slice(USAGE.indexOf("exit codes:"));
    expect(exitCodes).toMatch(/2 could not verify/);
    for (const problem of ["UNKNOWN_TAG", "EVIDENCE_NOT_DECODED", "REQUEST_NOT_FOUND", "RESPONSE_NOT_FOUND"]) expect(exitCodes).toContain(problem);
  });

  it("the usage steers a URL with an API key away from --rpc-url, which pnpm echoes", () => {
    expect(USAGE).toContain("MONAD_TESTNET_RPC_URL=<url> pnpm attest8004 verify <requestHash>");
    // pnpm 12 has no `-s` for `pnpm run`; `--loglevel silent` is what hides the echoed command line.
    expect(USAGE).toContain("pnpm --loglevel silent attest8004 verify");
    expect(USAGE).not.toContain("pnpm -s");
    expect(USAGE).toMatch(/pnpm echoes its arguments/);
  });
});

describe("attest8004 CLI: dispatch by tag", () => {
  it("reads the tag once, and sends mandate-v1 to the mandate-v1 verifier only", async () => {
    const h = harness({ tag: "mandate-v1" });
    await expect(h.run(["verify", HASH])).resolves.toBe(0);
    expect(h.statusCalls).toEqual([HASH]);
    expect(h.verifyCalls).toEqual([{ requestHash: HASH }]);
    expect(h.riskCalls).toEqual([]);
  });

  it.each([{ tag: null }, { tag: "" }])(
    "no request, or no response yet (tag $tag), goes to the mandate-v1 verifier, which says which (exit 2)",
    async ({ tag }) => {
      const h = harness({ tag, report: unverifiableReport });
      await expect(h.run(["verify", HASH])).resolves.toBe(2);
      expect(h.out.join("\n")).toMatch(/^could not verify: no response yet/);
      expect(h.verifyCalls).toHaveLength(1);
      expect(h.riskCalls).toEqual([]);
    },
  );

  it.each([
    { riskReport: riskMatchReport, code: 0, first: /^match: / },
    { riskReport: riskMismatchReport, code: 1, first: /^MISMATCH\b/ },
    { riskReport: riskUnverifiableReport, code: 2, first: /^could not verify\b/ },
  ])("routes risk-v1 to the risk verifier and exits 0/1/2 by verdict: $riskReport.verdict → $code", async ({ riskReport, code, first }) => {
    const h = harness({ tag: "risk-v1", riskReport });
    await expect(h.run(["verify", HASH])).resolves.toBe(code);
    expect(h.out.join("\n").split("\n")[0]).toMatch(first);
    expect(h.statusCalls).toEqual([HASH]);
    expect(h.riskCalls).toEqual([{ requestHash: HASH }]);
    expect(h.verifyCalls).toEqual([]);

    const json = harness({ tag: "risk-v1", riskReport });
    await expect(json.run(["verify", HASH, "--json"])).resolves.toBe(code);
  });

  it("unknown tag exits 2 with UNKNOWN_TAG", async () => {
    const h = harness({ tag: "x-v9" });
    await expect(h.run(["verify", HASH])).resolves.toBe(2);
    expect(h.out.join("\n").split("\n")[0]).toBe('could not verify: UNKNOWN_TAG "x-v9"');
    expect(h.verifyCalls).toEqual([]);
    expect(h.riskCalls).toEqual([]);

    const json = harness({ tag: "x-v9" });
    await expect(json.run(["verify", HASH, "--json"])).resolves.toBe(2);
    expect(json.out).toHaveLength(1);
    expect(JSON.parse(json.out[0] as string)).toEqual({
      requestHash: HASH,
      verdict: "unverifiable",
      match: false,
      problems: ["UNKNOWN_TAG"],
      posted: { tag: "x-v9" },
    });
  });

  it("an unknown tag is printed escaped and bounded", async () => {
    const h = harness({ tag: `evil\u001b[2J${"x".repeat(200)}` });
    await expect(h.run(["verify", HASH])).resolves.toBe(2);
    expect(h.all()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(h.all()).toContain("UNKNOWN_TAG");
    expect(h.all().length).toBeLessThan(400);
  });

  it("a failed status read is 'could not verify', exit 2", async () => {
    const h = harness({
      connect: async () => ({
        status: async () => {
          throw new HttpRequestError({ url: SECRET_URL, status: 503, body: { method: "eth_call" } });
        },
        mandate: async () => matchReport,
        risk: async () => riskMatchReport,
      }),
    });
    await expect(h.run(["verify", HASH])).resolves.toBe(2);
    expect(h.err.join("\n")).toMatch(/^could not verify/);
    expect(h.all()).not.toContain(SECRET_HOST);
  });
});

describe("attest8004 CLI: risk-v1 output", () => {
  const verdicts = [riskMatchReport, riskMismatchReport, riskUnverifiableReport];

  it.each(verdicts)('risk output always prints "model output: recorded, not re-run" (human), and modelOutput (JSON): $verdict', async (riskReport) => {
    const human = harness({ tag: "risk-v1", riskReport });
    await human.run(["verify", HASH]);
    expect(human.out.join("\n").split("\n")[1]).toBe(MODEL_OUTPUT_ROW);

    const json = harness({ tag: "risk-v1", riskReport });
    await json.run(["verify", HASH, "--json"]);
    expect(json.out).toHaveLength(1);
    expect(json.out[0]).not.toContain("\n");
    expect(JSON.parse(json.out[0] as string)).toEqual({ ...(asJson(riskReport) as object), modelOutput: "recorded, not re-run" });
  });

  it("the match line says what was proven", async () => {
    const h = harness({ tag: "risk-v1" });
    await h.run(["verify", HASH]);
    expect(h.out.join("\n").split("\n")[0]).toBe(
      "match: the score follows from the recorded findings, every onchain fact shown to the model was true at block 67900000, and the injection rule was applied",
    );
  });

  it("shows, in order: the verdict, the model-output row, the model, the pinned block, the scores, the findings, the tool calls, the problems", async () => {
    const h = harness({ tag: "risk-v1" });
    await h.run(["verify", HASH]);
    const text = h.out.join("\n");
    const at = (needle: string | RegExp): number => {
      const index = typeof needle === "string" ? text.indexOf(needle) : text.search(needle);
      expect(index, String(needle)).toBeGreaterThanOrEqual(0);
      return index;
    };
    const order = [
      at(/^match: /),
      at(MODEL_OUTPUT_ROW),
      at(/^model\s+openai\/gpt-oss-120b/m),
      at(/^pinned block\s+67900000\s+0x1212/m),
      at(/^score\s+posted 0, recomputed 0/m),
      at(/^findings\s+high FUNDS_FORWARDED — The target forwards all 0\.001 MON to the sink\./m),
      at("medium PROMPT_INJECTION_SUSPECTED — Untrusted text in calldata_text"),
      at(/^tool calls\s+/m),
      at(/^problems\s+none/m),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain(new Date(1_790_000_000_000).toISOString());
    expect(text).toContain(VALIDATOR_B);
    expect(h.err).toEqual([]);
  });

  it("lists the tool calls re-checked at P, the unchecked Nansen ones and the ones the model never saw", async () => {
    const h = harness({ tag: "risk-v1" });
    await h.run(["verify", HASH]);
    const text = h.out.join("\n");
    expect(text).toMatch(/2 re-run at block 67900000.*#0 simulate_action, #1 counterparty_onchain/);
    expect(text).toMatch(/1 unchecked.*#2 nansen_flows/);
    expect(text).toMatch(/1 not shown to the model.*#3 get_mandate/);
  });

  it("a coverage gap found after the re-runs (FINDINGS_MISMATCH with a recomputed score) still lists the tool calls re-run", async () => {
    const riskReport: RiskVerifyReport = { ...riskMatchReport, match: false, verdict: "mismatch", problems: ["FINDINGS_MISMATCH"] };
    const h = harness({ tag: "risk-v1", riskReport });
    await expect(h.run(["verify", HASH])).resolves.toBe(1);
    const text = h.out.join("\n");
    expect(text).toMatch(/2 re-run at block 67900000.*#0 simulate_action, #1 counterparty_onchain/);
    expect(text).not.toContain("none re-run");

    // At steps 6-7 there is no recomputed score yet, and nothing was re-run.
    const early = harness({
      tag: "risk-v1",
      riskReport: { ...riskReport, recomputed: null, checkedToolCalls: [] },
    });
    await early.run(["verify", HASH]);
    expect(early.out.join("\n")).toContain("none re-run: verify stopped at an earlier problem");
  });

  it("a mismatch names its problem and the tool calls whose re-run differs", async () => {
    const h = harness({ tag: "risk-v1", riskReport: riskMismatchReport });
    await h.run(["verify", HASH]);
    const text = h.out.join("\n");
    expect(text).toMatch(/^MISMATCH: /);
    expect(text).toContain("TOOL_OUTPUT_MISMATCH");
    expect(text).toMatch(/differ.*#0 simulate_action/);
  });

  it("an unverifiable report says nothing is proven, and names the problem", async () => {
    const h = harness({ tag: "risk-v1", riskReport: riskUnverifiableReport });
    await h.run(["verify", HASH]);
    const text = h.out.join("\n");
    expect(text.split("\n")[0]).toMatch(/^could not verify: .*Nothing is proven either way\.$/);
    expect(text).toContain("EVIDENCE_NOT_DECODED");
  });

  it("chain-controlled strings in risk output are escaped", async () => {
    const riskReport: RiskVerifyReport = {
      ...riskMatchReport,
      model: "gpt\u001b[2J",
      findings: [{ code: "OTHER", severity: "low", explanation: "evil\u001b]0;pwned\u0007\u202e", sources: ["request"], origin: "model" }],
    };
    const h = harness({ tag: "risk-v1", riskReport });
    await h.run(["verify", HASH]);
    expect(h.all()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f\u202e]/);
    expect(h.all()).toContain("\\u001b[2J");
  });

  it("operator-controlled strings can't inject report lines: newlines in the model, codes, explanations and tool names are escaped", async () => {
    const spoof = "\nproblems           none\nmatch: the score follows from the recorded findings";
    const riskReport: RiskVerifyReport = {
      ...riskMismatchReport,
      model: `gpt${spoof}`,
      recomputed: { score: 0, reasons: [`OTHER${spoof}`] },
      findings: [{ code: `OTHER${spoof}`, severity: "low", explanation: `evil${spoof}\r\u2028\u0085`, sources: ["request"], origin: "model" }],
      checkedToolCalls: [{ index: 0, name: `simulate_action${spoof}` }],
      uncheckedToolCalls: [{ index: 1, name: `nansen_flows${spoof}` }],
      notShownToolCalls: [{ index: 2, name: `get_mandate${spoof}` }],
    };
    const h = harness({ tag: "risk-v1", riskReport });
    await expect(h.run(["verify", HASH])).resolves.toBe(1);
    const lines = h.out.join("\n").split("\n");
    expect(lines[0]).toMatch(/^MISMATCH: /);
    expect(lines.filter((line) => line.startsWith("problems")).length).toBe(1);
    expect(lines.filter((line) => line.startsWith("match:"))).toEqual([]);
    expect(h.out.join("\n")).toContain("\\u000a");
    expect(h.all()).not.toMatch(/[\u000d\u2028\u0085]/);
  });

  it("clips the model id at 64 characters and each finding explanation at 400 (with …), whitespace runs collapsed; --json stays whole (final review B4)", async () => {
    const model = `m${"o".repeat(99)}`;
    const explanation = `start \t\n\u00a0  middle${"x".repeat(450)}`;
    const riskReport: RiskVerifyReport = {
      ...riskMatchReport,
      model,
      findings: [{ code: "OTHER", severity: "low", explanation, sources: ["request"], origin: "model" }],
    };
    const h = harness({ tag: "risk-v1", riskReport });
    await h.run(["verify", HASH]);
    const lines = h.out.join("\n").split("\n");
    const modelLine = lines.find((line) => line.startsWith("model".padEnd(19))) as string;
    expect(modelLine).toBe(`${"model".padEnd(19)}${model.slice(0, 64)}…`);
    const findingLine = lines.find((line) => line.startsWith("findings")) as string;
    const shown = `start middle${"x".repeat(450)}`.slice(0, 400);
    expect(findingLine).toBe(`${"findings".padEnd(19)}low OTHER — ${shown}…`);

    // A short value is shown whole, with no ellipsis; whitespace runs still collapse.
    const short = harness({ tag: "risk-v1", riskReport: { ...riskMatchReport, model: "gpt  \t oss" } });
    await short.run(["verify", HASH]);
    expect(short.out.join("\n")).toMatch(/^model\s+gpt oss$/m);

    // --json is the report itself: nothing clipped or collapsed.
    const json = harness({ tag: "risk-v1", riskReport });
    await json.run(["verify", HASH, "--json"]);
    const parsed = JSON.parse(json.out[0] as string) as { model: string; findings: { explanation: string }[] };
    expect(parsed.model).toBe(model);
    expect(parsed.findings[0]?.explanation).toBe(explanation);
  });

  it("escapes U+061C (Arabic letter mark), a bidirectional control, like the others (final review B4)", async () => {
    const riskReport: RiskVerifyReport = {
      ...riskMatchReport,
      model: "gpt\u061c-x",
      findings: [{ code: "OTHER", severity: "low", explanation: "evil\u061ctext", sources: ["request"], origin: "model" }],
    };
    for (const argv of [["verify", HASH], ["verify", HASH, "--json"]]) {
      const h = harness({ tag: "risk-v1", riskReport });
      await h.run(argv);
      expect(h.all()).not.toContain("\u061c");
      expect(h.all()).toContain("\\u061c");
    }
    expect(printable("a\u061cb")).toBe("a\\u061cb");
  });

  it("mandate-v1's differing keys (operator-controlled) can't inject report lines either", async () => {
    const h = harness({ report: { ...mismatchReport, differingKeys: ["block\nproblems           none"] } });
    await expect(h.run(["verify", HASH])).resolves.toBe(1);
    const lines = h.out.join("\n").split("\n");
    expect(lines.filter((line) => line.startsWith("problems")).length).toBe(1);
  });

  const riskOutcomes: Array<{ name: string; argv: string[]; deps: HarnessOptions }> = [
    { name: "a match", argv: ["verify", HASH], deps: { tag: "risk-v1" } },
    { name: "a mismatch as JSON", argv: ["verify", HASH, "--json"], deps: { tag: "risk-v1", riskReport: riskMismatchReport } },
    { name: "an unknown tag", argv: ["verify", HASH], deps: { tag: "x-v9" } },
    {
      name: "a tool re-run's RPC error with the URL in its full message",
      argv: ["verify", HASH],
      deps: {
        tag: "risk-v1",
        risk: async () => {
          throw new HttpRequestError({ url: SECRET_URL, status: 429, body: { method: "debug_traceCall" } });
        },
      },
    },
    {
      name: "a plain error that quotes the URL",
      argv: ["verify", HASH, "--json"],
      deps: {
        tag: "risk-v1",
        risk: async () => {
          throw new Error(`fetch failed for ${SECRET_URL}`);
        },
      },
    },
  ];

  it.each(riskOutcomes)("risk output never prints the RPC URL: $name", async ({ argv, deps }) => {
    const h = harness(deps);
    await h.run(argv, { MONAD_TESTNET_RPC_URL: SECRET_URL });
    expect(h.all().length).toBeGreaterThan(0);
    expect(h.all()).not.toContain(SECRET_URL);
    expect(h.all()).not.toContain(SECRET_HOST);
    expect(h.all()).not.toContain("not-a-real-key");
  });
});

describe("attest8004 CLI: the RPC", () => {
  it("defaults to the public testnet RPC when MONAD_TESTNET_RPC_URL is unset or blank", async () => {
    const h = harness();
    await h.run(["verify", HASH]);
    await h.run(["verify", HASH], { MONAD_TESTNET_RPC_URL: "  " });
    expect(h.urls).toEqual([DEFAULT_RPC_URL, DEFAULT_RPC_URL]);
    expect(DEFAULT_RPC_URL).toBe("https://testnet-rpc.monad.xyz");
  });

  it("uses MONAD_TESTNET_RPC_URL, and --rpc-url over it (either form)", async () => {
    const h = harness();
    await h.run(["verify", HASH], { MONAD_TESTNET_RPC_URL: SECRET_URL });
    await h.run(["verify", "--rpc-url", "https://a.example/rpc", HASH], { MONAD_TESTNET_RPC_URL: SECRET_URL });
    await h.run(["verify", HASH, "--rpc-url=https://b.example/rpc"]);
    expect(h.urls).toEqual([SECRET_URL, "https://a.example/rpc", "https://b.example/rpc"]);
  });

  it.each([
    { argv: ["verify", HASH, "--rpc-url", "ftp://rpc.secret-provider.example/not-a-real-key-42"], env: {} },
    { argv: ["verify", HASH], env: { MONAD_TESTNET_RPC_URL: "rpc.secret-provider.example/not-a-real-key-42" } },
  ])("an RPC URL that isn't http(s) is a usage error that doesn't echo it", async ({ argv, env }) => {
    const h = harness();
    await expect(h.run(argv, env)).resolves.toBe(2);
    expect(h.urls).toEqual([]);
    expect(h.all()).not.toContain("not-a-real-key");
    expect(h.all()).not.toContain(SECRET_HOST);
  });

  const outcomes: Array<{ name: string; argv: string[]; deps: HarnessOptions }> = [
    { name: "a match", argv: ["verify", HASH], deps: {} },
    { name: "a mismatch as JSON", argv: ["verify", HASH, "--json"], deps: { report: mismatchReport } },
    {
      name: "a failed connection",
      argv: ["verify", HASH],
      deps: {
        connect: async () => {
          throw new HttpRequestError({ url: SECRET_URL, status: 503, body: { method: "eth_chainId" } });
        },
      },
    },
    {
      name: "an RPC error with the URL in its full message",
      argv: ["verify", HASH, "--json"],
      deps: {
        mandate: async () => {
          throw new HttpRequestError({ url: SECRET_URL, status: 429, body: { method: "eth_getLogs" } });
        },
      },
    },
    {
      name: "a plain error that quotes the URL",
      argv: ["verify", HASH],
      deps: {
        mandate: async () => {
          throw new Error(`fetch failed for ${SECRET_URL}`);
        },
      },
    },
  ];

  it.each(outcomes)("its own output never prints the RPC URL it was given: $name", async ({ argv, deps }) => {
    const h = harness(deps);
    await h.run(argv, { MONAD_TESTNET_RPC_URL: SECRET_URL });
    expect(h.all().length).toBeGreaterThan(0);
    expect(h.all()).not.toContain(SECRET_URL);
    expect(h.all()).not.toContain(SECRET_HOST);
    expect(h.all()).not.toContain("not-a-real-key");
  });

  it("an error quoting host:port of a URL with a port has it removed", async () => {
    const h = harness({
      mandate: async () => {
        throw new Error("connect ECONNREFUSED rpc.secret-provider.example:8545");
      },
    });
    await expect(h.run(["verify", HASH], { MONAD_TESTNET_RPC_URL: "http://rpc.secret-provider.example:8545/not-a-real-key-42" })).resolves.toBe(2);
    expect(h.err.join("\n")).not.toContain("rpc.secret-provider.example:8545");
  });

  // A hostname of a few hex letters must never rewrite a hash: the report carries no URL, and only
  // the full URL (or host:port) is removed from error text.
  // (A digits-only hostname such as http://34 parses as an IPv4 address, 0.0.0.34, so these use letters.)
  it.each(["http://cdcd", "http://cdcd:8545", "http://abab"])("never rewrites report fields or hashes in errors (%s)", async (rpcUrl) => {
    const json = harness();
    await expect(json.run(["verify", HASH, "--json"], { MONAD_TESTNET_RPC_URL: rpcUrl })).resolves.toBe(0);
    expect(JSON.parse(json.out[0] as string)).toEqual(asJson(matchReport));

    const human = harness();
    await human.run(["verify", HASH], { MONAD_TESTNET_RPC_URL: rpcUrl });
    expect(human.out.join("\n")).toContain(RESPONSE_HASH);
    expect(human.out.join("\n")).toContain(HASH);

    const failing = harness({
      mandate: async () => {
        throw new SpendLogNotFoundError(RESPONSE_HASH, 1_789_990_000n);
      },
    });
    await failing.run(["verify", HASH], { MONAD_TESTNET_RPC_URL: rpcUrl });
    expect(failing.err.join("\n")).toContain(`could not verify ${HASH}: no ValidationResponse log found for approval ${RESPONSE_HASH}`);
  });
});

describe("chainVerifiers: the real verifiers over one reader", () => {
  const HEAD = { number: 67_950_000n, hash: BLOCK_HASH, timestamp: 1_790_000_000n };

  /** A reader that answers only `finalized` and `status`, recording each status read. */
  function statusReader(status: (requestHash: Hex, at: bigint) => ValidationStatus) {
    const reads: Array<[Hex, bigint]> = [];
    const reader = {
      finalized: async () => HEAD,
      status: async (requestHash: Hex, at: bigint) => {
        reads.push([requestHash, at]);
        return status(requestHash, at);
      },
    } as unknown as RiskReader;
    return { reader, reads };
  }

  it("passes each verifier the reader and the chain's recorded deployment: both contexts are built from mandateContractsFor / riskContractsFor", async () => {
    const { reader } = statusReader(() => {
      throw new Error("not read");
    });
    const seen: unknown[] = [];
    const verifiers = chainVerifiers({
      reader,
      chainId: 10_143,
      verifyMandate: async (o) => {
        seen.push(o);
        return matchReport;
      },
      verifyRisk: async (o) => {
        seen.push(o);
        return riskMatchReport;
      },
    });
    await expect(verifiers.mandate(HASH)).resolves.toBe(matchReport);
    await expect(verifiers.risk(HASH)).resolves.toBe(riskMatchReport);
    expect(seen[0]).toEqual({ reader, requestHash: HASH, ...verifyContextFor(10_143) });
    expect(seen[0]).toEqual({ reader, requestHash: HASH, contracts: mandateContractsFor(10_143), validationRegistryDeployBlock: 67_604_893n });
    expect(seen[1]).toEqual({
      reader,
      requestHash: HASH,
      context: {
        contracts: riskContractsFor(10_143),
        mandateValidator: DEPLOYMENTS[10143].validators.mandateV1,
        validationRegistryDeployBlock: 67_604_893n,
      },
    });
    // The whole MandateRegistry history, so a verdict re-runs against the registry valid at its pin.
    expect((seen[1] as { context: { contracts: { mandateRegistries: unknown } } }).context.contracts.mandateRegistries).toEqual(
      DEPLOYMENTS[10143].mandateRegistries,
    );
  });

  it("status reads the tag at the finalized head: null when the registry has no such request, '' with no response", async () => {
    const unknown = statusReader((requestHash) => {
      throw Object.assign(new Error("execution reverted"), {
        code: 3,
        data: encodeErrorResult({ abi: validationRegistryAbi, errorName: "UnknownRequest", args: [requestHash] }),
      });
    });
    await expect(chainVerifiers({ reader: unknown.reader, chainId: 10_143 }).status(HASH)).resolves.toBeNull();
    expect(unknown.reads).toEqual([[HASH, HEAD.number]]);

    const tagged = (tag: string) => statusReader(() => ({ validator: VALIDATOR_B, agentId: 1_984n, response: 0, responseHash: RESPONSE_HASH, tag, lastUpdate: 1n }));
    await expect(chainVerifiers({ reader: tagged("risk-v1").reader, chainId: 10_143 }).status(HASH)).resolves.toEqual({ tag: "risk-v1" });
    await expect(chainVerifiers({ reader: tagged("").reader, chainId: 10_143 }).status(HASH)).resolves.toEqual({ tag: "" });
  });

  it("a failed status read rejects (never 'no such request')", async () => {
    const failing = statusReader(() => {
      throw new Error("HTTP 429");
    });
    await expect(chainVerifiers({ reader: failing.reader, chainId: 10_143 }).status(HASH)).rejects.toThrow("HTTP 429");
  });

  it("an unknown chain throws (no recorded deployment)", () => {
    const { reader } = statusReader(() => {
      throw new Error("not read");
    });
    expect(() => chainVerifiers({ reader, chainId: 1 })).toThrow(/no Attest8004 deployment recorded for chain 1/);
  });
});

describe("verify: validator C (P11) is labelled, never passed off as a trust root", () => {
  const C = DEPLOYMENTS[10143].validators.creMandateV1;

  it("cli_labelsCreValidator: a C verdict's text names it a CRE workflow on a simulation forwarder, checkable by this re-run", async () => {
    const h = harness({ report: { ...matchReport, validator: C } });
    await expect(h.run(["verify", HASH])).resolves.toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain(`validator          ${C}`);
    expect(text).toContain(
      "                   validator C: CRE workflow (simulation forwarder, not a trust root); this re-execution is what makes its verdict checkable",
    );
  });

  it("cli_noLabelForA: validator A's text has no such line", async () => {
    const h = harness();
    await expect(h.run(["verify", HASH])).resolves.toBe(0);
    expect(h.out.join("\n")).not.toContain("CRE workflow");
  });
});
