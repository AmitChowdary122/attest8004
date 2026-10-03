import type { Address } from "viem";

/** One chain's recorded Attest8004 addresses and demo-agent data. */
export interface Deployment {
  identityRegistry: Address;
  validationRegistry: Address;
  /**
   * The block the ValidationRegistry was deployed in. Before it the address has no code, so a call
   * there returns no data instead of reverting; `verify` uses it to reject a request block from
   * before the registry existed without reading the chain there.
   */
  validationRegistryDeployBlock: bigint;
  agentRequestForwarder: Address;
  mandateRegistry: Address;
  /**
   * The block the MandateRegistry was deployed in. `mandate-v1` reads the mandate at its pinned block,
   * so it never pins before this, and `verify` rejects evidence pinned before it without reading there.
   */
  mandateRegistryDeployBlock: bigint;
  demoAgents: readonly bigint[];
  demoAgentVault: Address;
  demoAgentVaultP2: Address;
}

/**
 * Attest8004 addresses per chain. Mirrors docs/deployments.md; keep the two in sync.
 * The ValidationRegistry address depends on the Identity Registry in its init code, so testnet and
 * mainnet addresses differ.
 */
export const DEPLOYMENTS = {
  10143: {
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    validationRegistry: "0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f",
    /** Deploy tx 0x724f31e0…cf64d03 (docs/deployments.md). */
    validationRegistryDeployBlock: 67_604_893n,
    /** Forwards validationRequest for an agent's registered hot key (SPEC §4.4). */
    agentRequestForwarder: "0x1451F3C36545b191d3642f759D59f21DcFD657B2",
    /** Per-agent spending mandate (SPEC §4.2): owner-set until P6 adds the WebAuthn hook. */
    mandateRegistry: "0x2523197373ef813E19b5b14Ef2984130868cD17c",
    /** Deploy tx 0x1222b700…3ca0b84 (docs/deployments.md). */
    mandateRegistryDeployBlock: 67_842_487n,
    /** The two demo agents, owned by the deployer; their hot keys request through the forwarder. */
    demoAgents: [1984n, 1985n] as readonly bigint[],
    /** Bound to demo agent 1984; requires validator A (mandate-v1) at 100 until the P5 redeploy. */
    demoAgentVault: "0x23BfBD12545CCd1501ddA1B65a54518FD6212a96",
    /** The P2 vault, bound to test agent 1982. Superseded in P3; gated-execute still uses it. */
    demoAgentVaultP2: "0x7A5EC388CCbfD3B255CFa94fc2062c0807F2C4CD",
  },
} as const satisfies Record<number, Deployment>;

/** `DEPLOYMENTS[chainId]`, or throws (`verify` and the validators share this check: SPEC §4.5). */
export function deploymentsFor(chainId: number): Deployment {
  const deployment = (DEPLOYMENTS as Record<number, Deployment>)[chainId];
  if (!deployment) throw new Error(`no Attest8004 deployment recorded for chain ${chainId}`);
  return deployment;
}
