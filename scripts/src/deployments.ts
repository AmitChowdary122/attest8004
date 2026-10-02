import type { Address } from "viem";

/**
 * Attest8004 addresses per chain. Mirrors docs/deployments.md; keep the two in sync.
 * The ValidationRegistry address depends on the Identity Registry in its init code, so testnet and
 * mainnet addresses differ.
 */
export const DEPLOYMENTS = {
  10143: {
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    validationRegistry: "0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f",
  },
} as const satisfies Record<number, { identityRegistry: Address; validationRegistry: Address }>;
