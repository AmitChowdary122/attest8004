// P12 CI hardening, pinned on the workflow files themselves (read as text: no YAML dependency) and on the fork job's
// retry wrapper's behaviour: a real failure must still fail every attempt and turn the job red.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const RETRY = join(ROOT, ".github", "scripts", "retry.sh");
const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml"));
const text = (f: string) => readFileSync(join(WORKFLOWS, f), "utf8");

/** Each job's block of lines, by job id (two-space-indented keys under `jobs:`). */
function jobs(yaml: string): Map<string, string> {
  const body = yaml.slice(yaml.indexOf("\njobs:\n") + "\njobs:\n".length);
  const out = new Map<string, string>();
  let current: string | null = null;
  for (const line of body.split("\n")) {
    const id = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (id) {
      current = id[1] as string;
      out.set(current, "");
    } else if (current !== null) out.set(current, `${out.get(current)}${line}\n`);
  }
  return out;
}

describe("the CI workflows (P12)", () => {
  it("are ci.yml and indexer-keepalive.yml", () => {
    expect(files.sort()).toEqual(["ci.yml", "indexer-keepalive.yml"]);
  });

  for (const f of files) {
    it(`${f}: every job runs on ubuntu-24.04 with a timeout, and grants at most contents: read`, () => {
      const all = jobs(text(f));
      expect(all.size).toBeGreaterThan(0);
      for (const [id, block] of all) {
        expect(block, `${f} ${id}`).toMatch(/^ {4}runs-on: ubuntu-24\.04$/m);
        expect(block, `${f} ${id}`).toMatch(/^ {4}timeout-minutes: \d+$/m);
        expect(block, `${f} ${id}`).not.toMatch(/:\s*write\b/);
      }
    });

    it(`${f}: no permissions at the top, every action pinned by commit, no continue-on-error`, () => {
      const yaml = text(f);
      expect(yaml).toMatch(/^permissions: \{\}$/m);
      for (const uses of yaml.match(/uses: \S+/g) ?? []) expect(uses).toMatch(/^uses: [\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/);
      expect(yaml).not.toMatch(/continue-on-error/);
    });
  }

  it("ci.yml runs the hidden-Unicode check, and the fork tests through the retry wrapper", () => {
    const all = jobs(text("ci.yml"));
    expect([...all.values()].some((block) => block.includes("node scripts/src/check-hidden-unicode.ts"))).toBe(true);
    expect(all.get("contracts-fork")).toContain(".github/scripts/retry.sh 3 60 -- forge test");
  });
});

describe(".github/scripts/retry.sh", () => {
  function run(attemptsBeforeSuccess: number, maxAttempts: number): { status: number | null; attempts: number } {
    const dir = mkdtempSync(join(tmpdir(), "retry-"));
    const count = join(dir, "count");
    const command = `n=$(( $(cat ${count} 2>/dev/null || echo 0) + 1 )); echo $n > ${count}; [ $n -gt ${attemptsBeforeSuccess} ]`;
    const r = spawnSync("bash", [RETRY, String(maxAttempts), "0", "--", "bash", "-c", command], { encoding: "utf8" });
    const attempts = Number(readFileSync(count, "utf8").trim());
    rmSync(dir, { recursive: true, force: true });
    return { status: r.status, attempts };
  }

  it("a command that always fails fails after every attempt (the job goes red)", () => {
    expect(run(99, 3)).toEqual({ status: 1, attempts: 3 });
  });

  it("stops at the first success", () => {
    expect(run(0, 3)).toEqual({ status: 0, attempts: 1 });
    expect(run(2, 3)).toEqual({ status: 0, attempts: 3 });
  });
});
