// P12 AUD-07: contracts/script/deploy-testnet.sh must not put the deployer key (or the RPC URL) on forge's or cast's
// command line, nor export every .env secret to them. Runs the real script against stub `forge` and `cast` binaries
// and a throwaway env file; nothing reaches a network. The values below are low-entropy placeholders, not keys.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "../../contracts/script/deploy-testnet.sh");
const PLACEHOLDER_KEY = `0x${"ab".repeat(32)}`;
const OTHER_SECRET = `0x${"cd".repeat(32)}`;
const RPC = "https://rpc.example/keyed-path";

function run(): { status: number | null; stderr: string; forgeArgv: string; forgeEnv: string; castArgv: string } {
  // A copy of the script in a throwaway tree: its default ../.env is then this tree's, never the repo's real one.
  const dir = mkdtempSync(join(tmpdir(), "deploy-testnet-"));
  mkdirSync(join(dir, "contracts", "script"), { recursive: true });
  const script = join(dir, "contracts", "script", "deploy-testnet.sh");
  copyFileSync(SCRIPT, script);
  writeFileSync(join(dir, "contracts", "script", "DeployValidationRegistry.s.sol"), "");
  const envFile = join(dir, ".env");
  writeFileSync(envFile, [`DEPLOYER_PRIVATE_KEY=${PLACEHOLDER_KEY}`, `MONAD_TESTNET_RPC_URL="${RPC}"`, "DEPLOYER_ADDRESS=0x00000000000000000000000000000000000000d1", `VALIDATOR_A_PRIVATE_KEY=${OTHER_SECRET}`, ""].join("\n"));
  const plan = JSON.stringify({ returns: { to: { value: "0x4e59b44847b379578588920cA78FbF26c0B4956C" }, data: { value: "0x00" }, gasLimit: { value: "1" }, predicted: { value: "0x00000000000000000000000000000000000000e1" } } });
  writeFileSync(
    join(dir, "forge"),
    `#!/usr/bin/env bash\nfor a in "$@"; do if [[ "$a" == deployPlan* ]]; then echo '${plan}'; exit 0; fi; done\nprintf '%s\\n' "$@" > "${dir}/forge-argv"\nenv > "${dir}/forge-env"\n`,
  );
  writeFileSync(join(dir, "cast"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${dir}/cast-argv"\ncase "$1" in chain-id) echo 10143 ;; code) echo 0x1234 ;; *) echo 0 ;; esac\n`);
  chmodSync(join(dir, "forge"), 0o755);
  chmodSync(join(dir, "cast"), 0o755);
  const result = spawnSync("bash", [script, "ValidationRegistry"], {
    env: { PATH: `${dir}:${process.env.PATH ?? ""}`, HOME: dir },
    encoding: "utf8",
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      return "";
    }
  };
  const out = { status: result.status, stderr: result.stderr, forgeArgv: read("forge-argv"), forgeEnv: read("forge-env"), castArgv: read("cast-argv") };
  rmSync(dir, { recursive: true, force: true });
  return out;
}

describe("contracts/script/deploy-testnet.sh (P12 AUD-07)", () => {
  it("passes the deployer key to forge only through its environment, and no other .env secret at all", () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.forgeArgv).toContain("script/DeployValidationRegistry.s.sol");
    expect(r.forgeArgv).not.toContain(PLACEHOLDER_KEY);
    expect(r.forgeArgv).not.toContain("--private-key");
    expect(r.forgeEnv).toContain(`DEPLOYER_PRIVATE_KEY=${PLACEHOLDER_KEY}`);
    expect(r.forgeEnv).not.toContain(OTHER_SECRET);
    expect(r.forgeEnv).not.toContain("VALIDATOR_A_PRIVATE_KEY");
  });

  it("never puts the RPC URL on forge's or cast's command line", () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.castArgv).not.toContain(RPC);
    expect(r.forgeArgv).not.toContain(RPC);
    expect(r.castArgv).toContain("monad_testnet");
  });
});
