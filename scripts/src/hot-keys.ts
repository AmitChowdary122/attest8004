/**
 * Makes one hot key per demo agent and writes it into the repo's .env (ARCHITECTURE §8):
 * DEMO_AGENT_<n>_HOT_PRIVATE_KEY and DEMO_AGENT_<n>_HOT_ADDRESS, for agents 1 and 2; and the demo's rogue key
 * (P9): DEMO_ROGUE_PRIVATE_KEY and DEMO_ROGUE_ADDRESS, the "new forwarder key" `pnpm demo` scene 3 registers for agent
 * 1984 outside its mandate, and scene 3b revokes. A real random key, never one derived from a public label: anyone
 * could use such a key while it is registered.
 *
 * Run: pnpm --filter @attest8004/scripts hot-keys
 *
 * A key that is already set is kept, never replaced. Prints only addresses; the keys go straight
 * into .env (mode 0600, written to a temporary file and renamed over it) and nowhere else. The
 * owner registers each address with AgentRequestForwarder.setAgentKey (setup-demo-agents).
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readEnvValue, upsertEnv } from "./env-file.ts";

const ENV_PATH = fileURLToPath(new URL("../../.env", import.meta.url));
/** Each key's .env names and what to call it in the report. */
const KEYS = [
  { keyName: "DEMO_AGENT_1_HOT_PRIVATE_KEY", addressName: "DEMO_AGENT_1_HOT_ADDRESS", label: "agent 1 hot key" },
  { keyName: "DEMO_AGENT_2_HOT_PRIVATE_KEY", addressName: "DEMO_AGENT_2_HOT_ADDRESS", label: "agent 2 hot key" },
  { keyName: "DEMO_ROGUE_PRIVATE_KEY", addressName: "DEMO_ROGUE_ADDRESS", label: "demo rogue key" },
] as const;

let text = readFileSync(ENV_PATH, "utf8");
const report: string[] = [];

for (const { keyName, addressName, label } of KEYS) {
  const existing = readEnvValue(text, keyName) as Hex | undefined;
  const key = existing ?? generatePrivateKey();
  const account = privateKeyToAccount(key);
  if (!existing) text = upsertEnv(text, { [keyName]: key });

  const recorded = readEnvValue(text, addressName);
  if (recorded === undefined) text = upsertEnv(text, { [addressName]: account.address });
  else if (getAddress(recorded) !== account.address) throw new Error(`${addressName} does not match ${keyName}`);

  report.push(`${label}: ${account.address} (${existing ? "kept" : "new"})`);
}

const temporary = `${ENV_PATH}.${process.pid}.tmp`;
writeFileSync(temporary, text, { mode: 0o600 });
renameSync(temporary, ENV_PATH);
for (const line of report) console.log(line);
