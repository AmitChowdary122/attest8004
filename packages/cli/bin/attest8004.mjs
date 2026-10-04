// The `attest8004` CLI's entry point: `pnpm attest8004 verify <requestHash>` from the repo root runs
//   node --conditions=@attest8004/source --env-file-if-exists=.env packages/cli/bin/attest8004.mjs …
// It is plain JavaScript so that it can always say why it can't run. The CLI itself (src/cli.ts) is
// TypeScript, run through Node's type stripping, on by default from Node 22.18. Its exit codes are
// 0 match, 1 mismatch, 2 could not verify. Node exits 1 on its own when a module fails to load or an
// error goes uncaught, which would read as "mismatch", so this entry turns each of those into 2. It
// prints a fixed message, never the error, whose text could carry the RPC URL and its API key.

const MIN_NODE = { major: 22, minor: 18 };

function fail(message) {
  process.stderr.write(`could not verify: ${message}\n`);
  process.exit(2);
}

process.on("uncaughtException", () => fail("unexpected error"));
process.on("unhandledRejection", () => fail("unexpected error"));

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < MIN_NODE.major || (major === MIN_NODE.major && minor < MIN_NODE.minor)) {
  fail(`attest8004 needs Node ${MIN_NODE.major}.${MIN_NODE.minor} or later (this is Node ${process.versions.node})`);
}

let cli;
try {
  cli = await import("../src/cli.ts");
} catch {
  fail("the attest8004 CLI failed to load (it runs its TypeScript source: use Node 22.18 or later, from the repo root)");
}
process.exitCode = await cli.main(process.argv.slice(2), process.env, cli.nodeCliDeps());
