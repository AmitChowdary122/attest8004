// The `attest8004` entry (bin/attest8004.mjs), run as `pnpm attest8004` runs it: a child Node process. Exit 1 means
// "mismatch", so a Node too old to run the TypeScript source, a load failure or an uncaught error must exit 2.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BIN = "packages/cli/bin/attest8004.mjs";
/** The root `attest8004` script's flags, without `--env-file-if-exists` (the tests read no `.env`). */
const FLAGS = ["--conditions=@attest8004/source"];

/** A `--import` of an inline module that runs `code` before the entry. */
const preload = (code: string): string[] => ["--import", `data:text/javascript,${encodeURIComponent(code)}`];

function run(nodeArgs: string[], args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [...nodeArgs, BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
    timeout: 60_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("bin/attest8004.mjs", () => {
  it("runs the CLI: --help prints the usage, naming both tags, and exits 0", () => {
    const { status, stdout } = run(FLAGS, ["--help"]);
    expect(stdout).toContain("usage: attest8004 verify <requestHash>");
    expect(stdout).toContain("mandate-v1");
    expect(stdout).toContain("risk-v1");
    expect(status).toBe(0);
  });

  it("passes the CLI's own exit code through: bad usage is 2", () => {
    const { status, stderr } = run(FLAGS, ["verify", "0x1234"]);
    expect(stderr).toContain("<requestHash> must be 0x followed by 64 hex digits");
    expect(status).toBe(2);
  });

  it("refuses a Node older than 22.18 (no type stripping by default) with exit 2, before loading anything", () => {
    const old = preload(`Object.defineProperty(process.versions, "node", { value: "22.17.1" });`);
    const { status, stdout, stderr } = run([...FLAGS, ...old], ["--help"]);
    expect(stderr).toContain("could not verify: attest8004 needs Node 22.18 or later (this is Node 22.17.1)");
    expect(stdout).toBe("");
    expect(status).toBe(2);
  });

  it("exits 2, not Node's 1, when the TypeScript source fails to load", () => {
    const { status, stderr } = run([...FLAGS, "--no-experimental-strip-types"], ["--help"]);
    expect(stderr).toContain("could not verify: the attest8004 CLI failed to load");
    expect(status).toBe(2);
  });

  it("exits 2, not Node's 1, on an uncaught exception, and prints no error detail (it could carry the RPC URL)", () => {
    const boom = preload(`setTimeout(() => { throw new Error("boom https://rpc.example/secret"); }, 0);`);
    const { status, stderr } = run([...FLAGS, ...boom], ["--help"]);
    expect(stderr).toContain("could not verify: unexpected error");
    expect(stderr).not.toContain("secret");
    expect(status).toBe(2);
  });

  it("exits 2 on an unhandled rejection", () => {
    const boom = preload(`setTimeout(() => { Promise.reject(new Error("boom")); }, 0);`);
    const { status, stderr } = run([...FLAGS, ...boom], ["--help"]);
    expect(stderr).toContain("could not verify: unexpected error");
    expect(status).toBe(2);
  });

  it("is what the root `attest8004` script runs, and the root package asks for Node 22.18 or later", () => {
    const root = JSON.parse(readFileSync(`${REPO_ROOT}package.json`, "utf8")) as { engines: { node: string }; scripts: Record<string, string> };
    expect(root.scripts.attest8004).toBe(`node ${FLAGS.join(" ")} --env-file-if-exists=.env ${BIN}`);
    expect(root.engines.node).toBe(">=22.18 <23");
  });
});
