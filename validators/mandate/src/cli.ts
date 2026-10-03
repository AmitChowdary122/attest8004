// `attest8004 verify <requestHash> [--rpc-url URL] [--json]` (SPEC §4.5): re-runs a `mandate-v1`
// verdict at the block its evidence pins, from chain data alone, and compares the score and
// responseHash with the ones posted onchain. From the repo root: `pnpm attest8004 verify <requestHash>`.
// Read-only: it never sends a transaction. Its own output never prints the RPC URL it was given,
// which can carry an API key: errors show viem's short message only. pnpm, though, echoes the command
// line it runs, so a keyed URL belongs in MONAD_TESTNET_RPC_URL (or `pnpm -s` with --rpc-url).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BaseError, createPublicClient, formatEther, http } from "viem";
import { mandateAddressesFor, viemMandateReader, type MandateAddresses, type VerifyReader } from "./reader.ts";
import { verifyRequest, type VerifyProblem, type VerifyReport, type VerifyVerdict } from "./verify.ts";

/** Monad's public testnet RPC: the default, so a third party needs no `.env`. */
export const DEFAULT_RPC_URL = "https://testnet-rpc.monad.xyz";

export const USAGE = [
  "usage: attest8004 verify <requestHash> [--rpc-url URL] [--json]",
  "",
  "Re-runs a mandate-v1 verdict at the block its evidence pins, from chain data alone, and compares",
  "the score and responseHash with the ones posted onchain. Read-only.",
  "",
  "  <requestHash>   the request's hash: 0x and 64 hex digits",
  "  --rpc-url URL   a Monad testnet RPC (default: $MONAD_TESTNET_RPC_URL, else the public RPC).",
  "                  pnpm echoes its arguments, so give a URL with an API key as",
  "                  MONAD_TESTNET_RPC_URL=<url> pnpm attest8004 verify <requestHash>, or in .env,",
  "                  or run pnpm -s. The public RPC serves about 51 days of history; older",
  "                  verdicts need an archive RPC.",
  "  --json          print the report as one JSON object",
  "",
  "exit codes: 0 match; 1 mismatch (public proof that the validator misbehaved);",
  "            2 could not verify (bad usage, an RPC error, or something not found)",
].join("\n");

/** What `main` needs from the outside world, so tests can script it. */
export interface CliDeps {
  /** Connects to the RPC at `rpcUrl`: a reader, and the contracts to recompute with (the chain's recorded deployment). */
  connect(rpcUrl: string): Promise<{ reader: VerifyReader; addresses: MandateAddresses }>;
  /** Default {@link verifyRequest}. */
  verify?: typeof verifyRequest;
  /** Writes `text` and a newline. */
  stdout(text: string): void;
  stderr(text: string): void;
}

const EXIT_CODES: Record<VerifyVerdict, number> = { match: 0, mismatch: 1, unverifiable: 2 };
const REQUEST_HASH = /^0x[0-9a-fA-F]{64}$/;
const HISTORY_HINT =
  "If the pinned block is older than the RPC's history (the public RPC serves about 51 days), use an archive RPC: " +
  "MONAD_TESTNET_RPC_URL=<url> pnpm attest8004 verify <requestHash> (pnpm would echo a URL passed with --rpc-url).";

/** Runs the CLI on `argv` (the arguments after the script) and returns its exit code. Never throws. */
export async function main(argv: readonly string[], env: Record<string, string | undefined>, deps: CliDeps): Promise<number> {
  const command = parseCommand(argv);
  if (command.kind === "help") {
    deps.stdout(USAGE);
    return 0;
  }
  if (command.kind === "usage") {
    deps.stderr(`${command.error}\n\n${USAGE}`);
    return 2;
  }
  const rpc = rpcUrlOf(command.rpcUrl, env);
  if ("error" in rpc) {
    deps.stderr(`${rpc.error}\n\n${USAGE}`);
    return 2;
  }

  let report: VerifyReport;
  try {
    const { reader, addresses } = await deps.connect(rpc.url);
    report = await (deps.verify ?? verifyRequest)({ reader, requestHash: command.requestHash, addresses });
  } catch (error) {
    deps.stderr(printable(`could not verify ${command.requestHash}: ${redact(errorText(error), rpc.url)}`));
    return 2;
  }
  // The report is built from chain data and our own text, never from the URL, so it is printed as is.
  deps.stdout(printable(command.json ? jsonText(report) : humanText(report)));
  return EXIT_CODES[report.verdict];
}

/** The real dependencies: a viem client over HTTP, and the process's stdout and stderr. */
export function nodeCliDeps(): CliDeps {
  return {
    async connect(rpcUrl) {
      const publicClient = createPublicClient({ transport: http(rpcUrl) });
      const addresses = mandateAddressesFor(await publicClient.getChainId());
      return { reader: viemMandateReader({ publicClient, addresses }), addresses };
    },
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  };
}

type Command =
  | { kind: "help" }
  | { kind: "usage"; error: string }
  | { kind: "verify"; requestHash: `0x${string}`; rpcUrl: string | undefined; json: boolean };

/** Parses the arguments. Its errors never echo an argument, which could be a URL with a key in it. */
function parseCommand(argv: readonly string[]): Command {
  const usage = (error: string): Command => ({ kind: "usage", error });
  const positionals: string[] = [];
  let rpcUrl: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--json") {
      json = true;
    } else if (arg === "--rpc-url") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("-")) return usage("--rpc-url needs a URL");
      rpcUrl = value;
    } else if (arg.startsWith("--rpc-url=")) {
      rpcUrl = arg.slice("--rpc-url=".length);
    } else if (arg.startsWith("-")) {
      return usage("unknown option");
    } else {
      positionals.push(arg);
    }
  }
  const [name, requestHash, ...rest] = positionals;
  if (name === undefined) return usage("missing command");
  if (name !== "verify") return usage("unknown command: the only command is verify");
  if (requestHash === undefined) return usage("missing <requestHash>");
  if (rest.length > 0) return usage("too many arguments");
  if (!REQUEST_HASH.test(requestHash)) return usage("<requestHash> must be 0x followed by 64 hex digits");
  return { kind: "verify", requestHash: requestHash as `0x${string}`, rpcUrl, json };
}

/** `--rpc-url`, else `MONAD_TESTNET_RPC_URL` (blank counts as unset), else the public RPC. Errors never echo it. */
function rpcUrlOf(flag: string | undefined, env: Record<string, string | undefined>): { url: string } | { error: string } {
  const fromEnv = env.MONAD_TESTNET_RPC_URL?.trim();
  const [source, value] =
    flag !== undefined ? ["--rpc-url", flag.trim()] : fromEnv ? ["MONAD_TESTNET_RPC_URL", fromEnv] : ["the default RPC", DEFAULT_RPC_URL];
  const url = URL.parse(value);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:") || url.host === "") {
    return { error: `${source} must be an http(s) URL` };
  }
  return { url: value };
}

/** viem's short message (its full one can carry the RPC URL), or our own error's message. */
function errorText(error: unknown): string {
  const message = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : String(error);
  return hasRpcCode(error, -32602) ? `${message}\n${HISTORY_HINT}` : message;
}

function hasRpcCode(error: unknown, code: number): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 16 && typeof current === "object" && current !== null; depth++) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Belt and braces for error text only: removes the RPC URL (as given, and as `URL` normalizes it) and,
 * when it names a port, its `host:port`. Never a bare hostname, which could be a few hex letters
 * inside a hash the message quotes; never the report, which carries no URL.
 */
function redact(text: string, rpcUrl: string): string {
  const url = URL.parse(rpcUrl);
  const secrets = [rpcUrl, url?.href, url !== null && url.port !== "" ? url.host : undefined];
  return secrets.reduce<string>((out, secret) => (secret ? out.split(secret).join("<rpc>") : out), text);
}

/**
 * Escapes control characters (except newlines) and bidirectional overrides as `\uXXXX`, so strings
 * from the chain (a response's tag, the posted evidence's keys) can't drive the terminal. Inside JSON
 * strings the escape is still valid JSON for the same character.
 */
function printable(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** The report as one line of JSON, every `bigint` as a decimal string. */
function jsonText(report: VerifyReport): string {
  return JSON.stringify(report, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
}

const PROBLEM_TEXT: Record<VerifyProblem, string> = {
  NOT_MANDATE_V1: "the response isn't tagged mandate-v1, so there is no mandate-v1 run to repeat",
  RESPONSE_NOT_FOUND: "no response yet, or its ValidationResponse log wasn't found (retry later)",
  EVIDENCE_NOT_DECODED:
    "the response URI isn't inline JSON verify decodes (not a data: URI, over 128 KiB, or malformed); verify never fetches",
  EVIDENCE_HASH_MISMATCH: "the evidence at responseURI doesn't hash to the onchain responseHash",
  REQUEST_NOT_FOUND:
    "the registry has no such request, or its ValidationRequest log wasn't returned for the block state confirms (retry later)",
  REQUEST_BLOCK_WRONG: "the evidence names a request block the request wasn't made in (the registry's state shows otherwise)",
  REQUEST_INVALID: "the request's JSON doesn't hash to the requestHash or names another validator or agent; it must not be answered",
  PIN_OUT_OF_RANGE: "the evidence's pinned block isn't between the request's block and the response's block",
  SCORE_MISMATCH: "the onchain score isn't the recomputed score",
  RESPONSE_HASH_MISMATCH: "the onchain responseHash isn't the hash of the recomputed evidence",
};

function verdictLine(report: VerifyReport): string {
  switch (report.verdict) {
    case "match":
      return `match: re-running mandate-v1 at block ${report.pinnedBlock} gives the posted score and responseHash`;
    case "mismatch":
      return "MISMATCH: the posted verdict doesn't reproduce. This is public proof that the validator misbehaved.";
    case "unverifiable": {
      const [first] = report.problems;
      return `could not verify: ${first === undefined ? "unknown" : PROBLEM_TEXT[first]}. Nothing is proven either way.`;
    }
  }
}

function humanText(report: VerifyReport): string {
  const lines = [verdictLine(report), ""];
  const row = (label: string, value: string) => lines.push(`${label.padEnd(19)}${value}`);
  const more = (value: string) => row("", value);
  const { posted, recomputed, pinned } = report;

  row("request", report.requestHash);
  row("validator", report.validator);
  row("tag", JSON.stringify(posted.tag));
  if (pinned !== null) {
    row("pinned block", `${pinned.number}  ${pinned.hash}`);
    more(`${new Date(Number(pinned.timestamp) * 1000).toISOString()} (${pinned.timestamp})`);
  } else {
    row("pinned block", report.pinnedBlock === null ? "-" : `${report.pinnedBlock} (named by the evidence; not re-run)`);
  }
  row("score", `posted ${posted.score}, recomputed ${recomputed?.score ?? "-"}`);
  row("responseHash", `posted     ${posted.responseHash}`);
  more(`recomputed ${recomputed?.responseHash ?? "-"}`);
  if (recomputed !== null) {
    row("reasons", recomputed.reasons.length === 0 ? "none" : recomputed.reasons.join(", "));
    row("spend", `${report.spendEntries.length} mandate-v1 approval(s) in the 25 h window`);
    for (const entry of report.spendEntries) {
      more(`${entry.requestHash}  ${entry.value} wei (${formatEther(entry.value)} MON)  ${entry.counted ? "counted" : "not counted"}`);
    }
    row("permission events", `${report.permissionEvents.length} in the window`);
  }
  if (report.problems.length === 0) {
    row("problems", "none");
  } else {
    report.problems.forEach((problem, i) => row(i === 0 ? "problems" : "", `${problem}: ${PROBLEM_TEXT[problem]}`));
  }
  if (report.differingKeys.length > 0) row("differing keys", report.differingKeys.join(", "));
  return lines.join("\n");
}

/**
 * Whether Node is running this file as its entry point (`pnpm attest8004 …`), so importing it (tests)
 * runs nothing. Compares paths rather than reading `import.meta.main`, which older Node 22 releases
 * lack: there it would be undefined, and the CLI would exit 0, which means "match".
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2), process.env, nodeCliDeps()).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write("could not verify: unexpected error\n");
      process.exitCode = 2;
    },
  );
}
