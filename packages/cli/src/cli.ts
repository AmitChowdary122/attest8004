// `attest8004 verify <requestHash> [--rpc-url URL] [--json]` (SPEC §4.5, §4.6): re-checks a posted
// verdict from chain data alone. It reads the response's tag once and sends it to that tag's verifier:
// `mandate-v1` is re-run at the block its evidence pins (score and responseHash must reproduce);
// `risk-v1` is re-checked from its public evidence (the score from the recorded findings, the
// injection rule, every onchain tool call the model saw re-run at the pin, the mandate-v1 verdict it
// required) without ever re-running the model. Any other tag is UNKNOWN_TAG (exit 2).
//
// From the repo root: `pnpm attest8004 verify <requestHash>`, through bin/attest8004.mjs (which turns an
// old Node, a load failure or an uncaught error into exit 2). Read-only: it never sends a transaction.
// Its own output never prints the RPC URL it was given, which can carry an API key: errors show viem's
// short message only. pnpm, though, echoes the command line it runs, so a keyed URL belongs in
// MONAD_TESTNET_RPC_URL (or `pnpm --loglevel silent` with --rpc-url; pnpm 12 has no `-s` for `pnpm run`).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deploymentsFor } from "@attest8004/sdk";
import { MANDATE_V1, statusOrUnknown, verifyContextFor, verifyRequest, type VerifyReport, type VerifyVerdict } from "@attest8004/validator-mandate";
import { RISK_V1, riskAddressesFor, verifyRiskRequest, viemRiskReader, type RiskReader, type RiskVerifyReport } from "@attest8004/validator-risk";
import { BaseError, createPublicClient, http, type Hex } from "viem";
import { jsonText, mandateText, printable, riskJson, riskText, unknownTagJson, unknownTagText } from "./text.ts";

/** Monad's public testnet RPC: the default, so a third party needs no `.env`. */
export const DEFAULT_RPC_URL = "https://testnet-rpc.monad.xyz";

export const USAGE = [
  "usage: attest8004 verify <requestHash> [--rpc-url URL] [--json]",
  "",
  "Re-checks a posted verdict from chain data alone, by the response's tag. Read-only.",
  "  mandate-v1  re-runs the verdict at the block its evidence pins, and compares the score and",
  "              responseHash with the ones posted onchain.",
  "  risk-v1     re-derives the score from the recorded findings, checks that every untrusted text",
  "              the model saw was screened and re-applies the injection rule, re-runs every onchain",
  "              tool call the model saw at the pinned block, and re-checks the mandate-v1 verdict it",
  "              required. It never re-runs the model (or the guard): the model output is",
  "              recorded, not re-run, so a match doesn't prove that the model produced it.",
  "",
  "  <requestHash>   the request's hash: 0x and 64 hex digits",
  "  --rpc-url URL   a Monad testnet RPC (default: $MONAD_TESTNET_RPC_URL, else the public RPC).",
  "                  pnpm echoes its arguments, so give a URL with an API key as",
  "                  MONAD_TESTNET_RPC_URL=<url> pnpm attest8004 verify <requestHash>, or in .env,",
  "                  or run pnpm --loglevel silent attest8004 verify <requestHash> --rpc-url <url>.",
  "                  The public RPC serves about 51 days of history; older verdicts need an",
  "                  archive RPC.",
  "  --json          print the report as one JSON object",
  "",
  "exit codes: 0 match; 1 mismatch (public proof that the validator misbehaved);",
  "            2 could not verify: bad usage, an RPC error, something not found",
  "              (REQUEST_NOT_FOUND, RESPONSE_NOT_FOUND, an input log), a tag other than mandate-v1",
  "              and risk-v1 (UNKNOWN_TAG), evidence that isn't inline JSON verify decodes",
  "              (EVIDENCE_NOT_DECODED), or a Node that can't run the CLI (it needs Node 22.18",
  "              or later)",
].join("\n");

/** The verifiers `main` dispatches to, over one RPC. */
export interface Verifiers {
  /** The request's tag at the finalized head: `null` when the registry has no such request, `""` while it has no response. */
  status(requestHash: Hex): Promise<{ tag: string } | null>;
  /** `mandate-v1`'s `verifyRequest`. It also reports a request with no response, or none at all. */
  mandate(requestHash: Hex): Promise<VerifyReport>;
  /** `risk-v1`'s `verifyRiskRequest`. */
  risk(requestHash: Hex): Promise<RiskVerifyReport>;
}

/** What `main` needs from the outside world, so tests can script it. */
export interface CliDeps {
  /** Connects to the RPC at `rpcUrl`: the verifiers, over the chain's recorded deployment. */
  connect(rpcUrl: string): Promise<Verifiers>;
  /** Writes `text` and a newline. */
  stdout(text: string): void;
  stderr(text: string): void;
}

const EXIT_CODES: Record<VerifyVerdict, number> = { match: 0, mismatch: 1, unverifiable: 2 };
const REQUEST_HASH = /^0x[0-9a-fA-F]{64}$/;
const HISTORY_HINT =
  "If the pinned block is older than the RPC's history (the public RPC serves about 51 days), use an archive RPC: " +
  "MONAD_TESTNET_RPC_URL=<url> pnpm attest8004 verify <requestHash> (pnpm would echo a URL passed with --rpc-url).";

type Outcome = { kind: "mandate"; report: VerifyReport } | { kind: "risk"; report: RiskVerifyReport } | { kind: "unknown"; tag: string };

/**
 * Runs the CLI on `argv` (the arguments after the script) and returns its exit code. Never throws.
 *
 * Reads the request's tag once: `mandate-v1`, or no response yet, or no such request, goes to the
 * `mandate-v1` verifier (which reports the last two as `RESPONSE_NOT_FOUND` and `REQUEST_NOT_FOUND`);
 * `risk-v1` goes to the `risk-v1` verifier; any other tag prints `could not verify: UNKNOWN_TAG
 * "<tag>"`. Exit 0 match, 1 mismatch, 2 could not verify (including any failed read).
 */
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

  let outcome: Outcome;
  try {
    const verifiers = await deps.connect(rpc.url);
    const status = await verifiers.status(command.requestHash);
    if (status === null || status.tag === "" || status.tag === MANDATE_V1.tag) {
      outcome = { kind: "mandate", report: await verifiers.mandate(command.requestHash) };
    } else if (status.tag === RISK_V1.tag) {
      outcome = { kind: "risk", report: await verifiers.risk(command.requestHash) };
    } else {
      outcome = { kind: "unknown", tag: status.tag };
    }
  } catch (error) {
    deps.stderr(printable(`could not verify ${command.requestHash}: ${redact(errorText(error), rpc.url)}`));
    return 2;
  }
  // The reports are built from chain data and our own text, never from the URL, so they are printed as is.
  switch (outcome.kind) {
    case "mandate":
      deps.stdout(printable(command.json ? jsonText(outcome.report) : mandateText(outcome.report)));
      return EXIT_CODES[outcome.report.verdict];
    case "risk":
      deps.stdout(printable(command.json ? riskJson(outcome.report) : riskText(outcome.report)));
      return EXIT_CODES[outcome.report.verdict];
    case "unknown":
      deps.stdout(printable(command.json ? unknownTagJson(command.requestHash.toLowerCase(), outcome.tag) : unknownTagText(outcome.tag)));
      return 2;
  }
}

/**
 * The real verifiers over one `RiskReader` (a `risk-v1` reader is also everything `mandate-v1`'s
 * `verify` reads), checking against the SDK's recorded deployment for `chainId` (`DEPLOYMENTS`):
 * `mandate-v1` with `verifyContextFor(chainId)`; `risk-v1` with the same deploy blocks, the contracts
 * `risk-v1` reads (`riskAddressesFor`) and validator A (`validators.mandateV1`). Throws for a chain with
 * no recorded deployment. The two verify functions can be replaced, for tests.
 */
export function chainVerifiers(o: {
  reader: RiskReader;
  chainId: number;
  verifyMandate?: typeof verifyRequest;
  verifyRisk?: typeof verifyRiskRequest;
}): Verifiers {
  const { reader, chainId } = o;
  const mandateContext = verifyContextFor(chainId);
  const riskContext = { ...mandateContext, addresses: riskAddressesFor(chainId), mandateValidator: deploymentsFor(chainId).validators.mandateV1 };
  const verifyMandate = o.verifyMandate ?? verifyRequest;
  const verifyRisk = o.verifyRisk ?? verifyRiskRequest;
  return {
    async status(requestHash) {
      const head = await reader.finalized();
      const status = await statusOrUnknown(reader, requestHash, head.number);
      return status === null ? null : { tag: status.tag };
    },
    mandate: (requestHash) => verifyMandate({ reader, requestHash, ...mandateContext }),
    risk: (requestHash) => verifyRisk({ reader, requestHash, context: riskContext }),
  };
}

/** The real dependencies: a viem client over HTTP, and the process's stdout and stderr. */
export function nodeCliDeps(): CliDeps {
  return {
    async connect(rpcUrl) {
      const publicClient = createPublicClient({ transport: http(rpcUrl) });
      const chainId = await publicClient.getChainId();
      return chainVerifiers({ reader: viemRiskReader({ publicClient, addresses: riskAddressesFor(chainId) }), chainId });
    },
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  };
}

type Command =
  | { kind: "help" }
  | { kind: "usage"; error: string }
  | { kind: "verify"; requestHash: Hex; rpcUrl: string | undefined; json: boolean };

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
  return { kind: "verify", requestHash: requestHash as Hex, rpcUrl, json };
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
 * Whether Node is running this file directly (`node --conditions=@attest8004/source src/cli.ts …`), so
 * importing it runs nothing: `pnpm attest8004` runs bin/attest8004.mjs, which imports this file and
 * calls `main` itself, and so do the tests. Compares paths rather than reading `import.meta.main`,
 * which older Node 22 releases lack: there it would be undefined, and the CLI would exit 0, which
 * means "match".
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
