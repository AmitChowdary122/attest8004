import { HttpRequestError, InvalidParamsRpcError, keccak256, RpcRequestError, getAddress, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { DEFAULT_RPC_URL, main, USAGE, type CliDeps } from "../src/cli.ts";
import { SpendLogNotFoundError } from "../src/collect.ts";
import { mandateAddressesFor, type VerifyReader } from "../src/reader.ts";
import { verifyContextFor, type VerifyReport } from "../src/verify.ts";

const HASH = `0x${"ab".repeat(32)}` as Hex;
const RESPONSE_HASH = `0x${"cd".repeat(32)}` as Hex;
const OTHER_RESPONSE_HASH = `0x${"ef".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"12".repeat(32)}` as Hex;
const SPENT_REQUEST = `0x${"34".repeat(32)}` as Hex;
const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const GATE = getAddress("0x23bfbd12545ccd1501dda1b65a54518fd6212a96");
const ADDRESSES = mandateAddressesFor(10_143);
/** An RPC URL carrying an API key: it must never be printed, nor its host. */
const SECRET_URL = "https://rpc.secret-provider.example/v2/not-a-real-key-42";
const SECRET_HOST = "rpc.secret-provider.example";

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

/** A reader `verify` never touches in these tests: `verify` itself is scripted. */
const unusedReader = {} as VerifyReader;

function harness(over: Partial<CliDeps> & { report?: VerifyReport } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  const verifyCalls: Array<{ requestHash: Hex }> = [];
  const { report = matchReport, ...deps } = over;
  const run = (argv: string[], env: Record<string, string | undefined> = {}) =>
    main(argv, env, {
      connect: async (rpcUrl) => {
        urls.push(rpcUrl);
        return { reader: unusedReader, ...verifyContextFor(10_143) };
      },
      verify: async (o) => {
        verifyCalls.push({ requestHash: o.requestHash });
        expect(o.reader).toBe(unusedReader);
        expect(o.addresses).toEqual(ADDRESSES);
        expect(o.validationRegistryDeployBlock).toBe(67_604_893n);
        expect(o.mandateRegistryDeployBlock).toBe(67_842_487n);
        return report;
      },
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      ...deps,
    });
  return { run, out, err, urls, verifyCalls, all: () => [...out, ...err].join("\n") };
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
    expect(parsed).toEqual(JSON.parse(JSON.stringify(mismatchReport, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))));
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
      verify: async () => {
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
      verify: async () => {
        throw new SpendLogNotFoundError(SPENT_REQUEST, 1_789_990_000n);
      },
    });
    await expect(h.run(["verify", HASH, "--json"])).resolves.toBe(2);
    expect(h.err.join("\n")).toContain(`no ValidationResponse log found for approval ${SPENT_REQUEST}`);
  });

  it("history the RPC no longer serves (-32602) suggests an archive RPC", async () => {
    const h = harness({
      verify: async () => {
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

  it("the usage steers a URL with an API key away from --rpc-url, which pnpm echoes", () => {
    expect(USAGE).toContain("MONAD_TESTNET_RPC_URL=<url> pnpm attest8004 verify <requestHash>");
    // pnpm 12 has no `-s` for `pnpm run`; `--loglevel silent` is what hides the echoed command line.
    expect(USAGE).toContain("pnpm --loglevel silent attest8004 verify");
    expect(USAGE).not.toContain("pnpm -s");
    expect(USAGE).toMatch(/pnpm echoes its arguments/);
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

  const outcomes: Array<{ name: string; argv: string[]; deps: Partial<CliDeps> & { report?: VerifyReport } }> = [
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
        verify: async () => {
          throw new HttpRequestError({ url: SECRET_URL, status: 429, body: { method: "eth_getLogs" } });
        },
      },
    },
    {
      name: "a plain error that quotes the URL",
      argv: ["verify", HASH],
      deps: {
        verify: async () => {
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
      verify: async () => {
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
    expect(JSON.parse(json.out[0] as string)).toEqual(
      JSON.parse(JSON.stringify(matchReport, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))),
    );

    const human = harness();
    await human.run(["verify", HASH], { MONAD_TESTNET_RPC_URL: rpcUrl });
    expect(human.out.join("\n")).toContain(RESPONSE_HASH);
    expect(human.out.join("\n")).toContain(HASH);

    const failing = harness({
      verify: async () => {
        throw new SpendLogNotFoundError(RESPONSE_HASH, 1_789_990_000n);
      },
    });
    await failing.run(["verify", HASH], { MONAD_TESTNET_RPC_URL: rpcUrl });
    expect(failing.err.join("\n")).toContain(`could not verify ${HASH}: no ValidationResponse log found for approval ${RESPONSE_HASH}`);
  });
});
