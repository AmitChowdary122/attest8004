/**
 * Prints the address derived from every `*_PRIVATE_KEY` variable Node loaded from `.env`
 * (DEPLOYER, VALIDATOR_A, VALIDATOR_B, the demo agents' hot keys, X402_PAYER, ...): addresses
 * only, never a key. A key that isn't set is skipped with a note instead of being derived.
 *
 * Run: pnpm --filter @attest8004/scripts addresses
 */
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** DEMO_AGENT_1_HOT_PRIVATE_KEY -> "demoAgent1Hot"; VALIDATOR_A_PRIVATE_KEY -> "validatorA". */
function label(envName: string): string {
  const base = envName.slice(0, -"_PRIVATE_KEY".length);
  return base
    .split("_")
    .map((part, i) => (i === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()))
    .join("");
}

const keyNames = Object.keys(process.env).filter((name) => name.endsWith("_PRIVATE_KEY"));
const width = Math.max(...keyNames.map((name) => label(name).length), 0);

for (const name of keyNames) {
  const value = process.env[name];
  const text = label(name).padEnd(width);
  if (!value) {
    console.log(`${text}  (skipped: ${name} is not set)`);
    continue;
  }
  console.log(`${text}  ${privateKeyToAccount(value as Hex).address}`);
}
