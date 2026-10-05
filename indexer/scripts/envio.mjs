// Runs the envio CLI (e.g. `envio dev`) with the HyperSync token from the repo's .env, which local syncing needs
// (Envio Cloud doesn't). Only ENVIO_API_TOKEN is read from that file, and it is never printed: the other secrets there
// (validator and deployer keys) never reach the indexer's process.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_FILE = fileURLToPath(new URL("../../.env", import.meta.url));
const NAME = "ENVIO_API_TOKEN";

function tokenFromEnvFile() {
  if (!existsSync(ENV_FILE)) return undefined;
  const line = readFileSync(ENV_FILE, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${NAME}=`));
  const value = line?.slice(NAME.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  return value ? value : undefined;
}

const token = process.env[NAME] || tokenFromEnvFile();
if (!token) console.warn(`${NAME} is not set (in the environment or the repo's .env): HyperSync will refuse to sync.`);

const bin = fileURLToPath(new URL("../node_modules/.bin/envio", import.meta.url));
const child = spawn(bin, process.argv.slice(2), { stdio: "inherit", env: { ...process.env, ...(token ? { [NAME]: token } : {}) } });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
