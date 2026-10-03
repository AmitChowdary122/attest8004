import type { Address } from "viem";

/** One chain's recorded Attest8004 addresses and demo-agent data. */
export interface Deployment {
  identityRegistry: Address;
  /** Canonical ERC-8004 ReputationRegistry (CLAUDE.md); testnet and mainnet addresses differ. */
  reputationRegistry: Address;
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
  /** The two reference validators (SPEC §4.4 `mandate-v1`, live; §4.6 `risk-v1`, still being built). */
  validators: {
    mandateV1: Address;
    riskV1: Address;
  };
  demoAgents: readonly bigint[];
  /**
   * The P5 "risky but mandated" demo target (SPEC §4.6, decision 34): forwards every payment straight
   * to `SINK`, an address nobody controls. Not yet allowlisted in any mandate (Task 15).
   */
  demoPassThrough: Address;
  /**
   * Bound to demo agent 1984; requires both validator A (`mandate-v1`) at 100 and validator B
   * (`risk-v1`) at 80, each under its own tag, since the two-validator redeploy on 2026-10-04.
   */
  demoAgentVault: Address;
  demoAgentVaultP2: Address;
  /**
   * The P3 vault, bound to demo agent 1984, requiring validator A (`mandate-v1`) at 100 only.
   * Superseded on 2026-10-04 by `demoAgentVault` above; it still holds 0.006 MON, which can leave
   * only through an A-only validated execute.
   */
  demoAgentVaultP3: Address;
}

/**
 * Attest8004 addresses per chain. Mirrors docs/deployments.md; keep the two in sync.
 * The ValidationRegistry address depends on the Identity Registry in its init code, so testnet and
 * mainnet addresses differ.
 */
export const DEPLOYMENTS = {
  10143: {
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    validationRegistry: "0xc4A4D0cEB3971cbE7a2536494aC106f2Cd9F9a8f",
    /** Deploy tx 0x724f31e0…cf64d03 (docs/deployments.md). */
    validationRegistryDeployBlock: 67_604_893n,
    /** Forwards validationRequest for an agent's registered hot key (SPEC §4.4). */
    agentRequestForwarder: "0x1451F3C36545b191d3642f759D59f21DcFD657B2",
    /** Per-agent spending mandate (SPEC §4.2): owner-set until P6 adds the WebAuthn hook. */
    mandateRegistry: "0x2523197373ef813E19b5b14Ef2984130868cD17c",
    /** Deploy tx 0x1222b700…3ca0b84 (docs/deployments.md). */
    mandateRegistryDeployBlock: 67_842_487n,
    validators: {
      /** `mandate-v1`, deterministic. */
      mandateV1: "0xa62DaB21E0C0F57e94B3ed6e675F214199989e92",
      /** `risk-v1`, agentic (P5; still being built). */
      riskV1: "0x780df855b48AeC7A3907433b0b5984A2fe5dca5E",
    },
    /** The two demo agents, owned by the deployer; their hot keys request through the forwarder. */
    demoAgents: [1984n, 1985n] as readonly bigint[],
    /** Deploy tx 0x0be882c3…65128bc (docs/deployments.md). */
    demoPassThrough: "0xEEEBBa55620afC42E9c88b5d962476367b8da338",
    /** Deploy tx 0x65125575…61b990e (docs/deployments.md). */
    demoAgentVault: "0x12fAb3E3cA810Cc44bD9f537613a230a2be8D614",
    /** The P2 vault, bound to test agent 1982. Superseded in P3; gated-execute still uses it. */
    demoAgentVaultP2: "0x7A5EC388CCbfD3B255CFa94fc2062c0807F2C4CD",
    demoAgentVaultP3: "0x23BfBD12545CCd1501ddA1B65a54518FD6212a96",
  },
} as const satisfies Record<number, Deployment>;

/** `DEPLOYMENTS[chainId]`, or throws (`verify` and the validators share this check: SPEC §4.5). */
export function deploymentsFor(chainId: number): Deployment {
  const deployment = (DEPLOYMENTS as Record<number, Deployment>)[chainId];
  if (!deployment) throw new Error(`no Attest8004 deployment recorded for chain ${chainId}`);
  return deployment;
}
