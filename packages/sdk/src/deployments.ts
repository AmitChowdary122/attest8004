import type { Address } from "viem";

/**
 * One MandateRegistry in a chain's history (ARCHITECTURE §6): valid from `fromBlock`, its deployment
 * block, until the block before the next entry's `fromBlock`, or for good when it is the last entry.
 */
export interface MandateRegistryEpoch {
  address: Address;
  fromBlock: bigint;
}

/** The FindingsBoard (P7) and its deployment block: `/inbox` searches for reports from there on. */
export interface FindingsBoardDeployment {
  address: Address;
  fromBlock: bigint;
}

/**
 * The hosted Envio indexer's public GraphQL endpoint (P8, SPEC §4.8). A convenience, never a trust root: verdicts and
 * `verify` never read it. On Envio Cloud's free plan the URL changes with every deployment, so a redeploy updates it
 * here, in web/vercel.json's CSP and in docs/deployments.md.
 */
export interface TrustApiDeployment {
  graphqlUrl: string;
}

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
  /**
   * Every MandateRegistry the chain has had, ascending by `fromBlock`; a redeploy appends an entry and
   * never edits an earlier one. A read at block `b` goes to the registry valid at `b`
   * ({@link mandateRegistryAt}): `mandate-v1` and `risk-v1` read the mandate there and record that
   * registry in their evidence, so a verdict pinned on an older registry still re-verifies after a
   * redeploy. The first entry's `fromBlock` is the earliest block they ever pin (before it there is no
   * mandate to read, and `verify` rejects such a pin without reading there). New transactions go to
   * the last entry ({@link currentMandateRegistry}).
   */
  mandateRegistries: readonly MandateRegistryEpoch[];
  /**
   * Where validators post encrypted operator reports (SPEC §4.7), or `null` before it is deployed: then the
   * validators post nothing and `/inbox` has nothing to read.
   */
  findingsBoard: FindingsBoardDeployment | null;
  /**
   * The trust API (the hosted Envio indexer), or `null` before it is deployed: then `getAgentTrust` needs an explicit
   * URL, `/dashboard` shows its offline view and `/inbox` searches the chain.
   */
  trustApi: TrustApiDeployment | null;
  /**
   * The two reference validators (SPEC §4.5 `mandate-v1`; §4.6 `risk-v1`, built, funded and tested), and validator C
   * (P11): `CreValidator`, the contract a Chainlink CRE workflow delivers `mandate-v1` verdicts to (docs/cre.md).
   */
  validators: {
    mandateV1: Address;
    riskV1: Address;
    /**
     * Validator C: a contract, not a key. Its verdicts arrive only through `creForwarder`, CRE's mock forwarder,
     * through which anyone can deliver a report, so it is **never a trust root and no gate may require it**
     * ({@link CRE_VALIDATOR_LABEL}). Its verdicts are checkable because `verify` re-executes them.
     */
    creMandateV1: Address;
  };
  /**
   * The Keystone forwarder validator C accepts reports from: on testnet, CRE's MockKeystoneForwarder (the Forwarder
   * Directory), which verifies no DON signature and has a public `route()`.
   */
  creForwarder: Address;
  demoAgents: readonly bigint[];
  /**
   * The P5 "risky but mandated" demo target (SPEC §4.6): forwards every payment straight to `SINK`, an
   * address nobody controls. In demo agent 1984's mandate (allowed target) since block 68,005,485.
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
    /**
     * The per-agent spending mandate's registries (SPEC §4.2), in order (docs/deployments.md):
     * - P4's, owner-set: deploy tx 0x1222b700…3ca0b84, read for verdicts pinned before v2's deploy block;
     * - P6's v2, owner + passkey (rpId attest8004.vercel.app): deploy tx 0xfa483be3…751c0d.
     */
    mandateRegistries: [
      { address: "0x2523197373ef813E19b5b14Ef2984130868cD17c", fromBlock: 67_842_487n },
      { address: "0x2Ee5f78149762DE630c6bFF8CD81166010D0454B", fromBlock: 68_196_462n },
    ],
    /** P7's encrypted operator reports: deploy tx 0x1d43bad3…6136b (docs/deployments.md). */
    findingsBoard: { address: "0xa7d52B3B08FAB0cd0527c6242ca678f9Feee6a1c", fromBlock: 68_296_810n },
    /**
     * The hosted Envio indexer (P8): Envio Cloud's free plan, deployment of commit c62592f on the `envio` branch,
     * 5 Oct 2026. Its URL changes with each deployment; docs/deployments.md says how to redeploy.
     */
    trustApi: { graphqlUrl: "https://indexer.dev.hyperindex.xyz/3d57e4d/v1/graphql" },
    validators: {
      /** `mandate-v1`, deterministic. */
      mandateV1: "0xa62DaB21E0C0F57e94B3ed6e675F214199989e92",
      /** `risk-v1`, agentic (P5; built, funded and tested). */
      riskV1: "0x780df855b48AeC7A3907433b0b5984A2fe5dca5E",
      /** `CreValidator` (P11): deploy tx 0x6be1fd19…7fd02a (docs/deployments.md). */
      creMandateV1: "0x6D12F00870cB6edA2d8e389696f6B5d050423B95",
    },
    creForwarder: "0xB9F79d863261869B234c481D1f9A7af84AeAd192",
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

/**
 * How every surface (docs, `verify`, `/dashboard`, `pnpm cre:demo`) labels validator C, verbatim: its verdicts come
 * through a simulation forwarder anyone can deliver through, so they are never a trust root.
 */
export const CRE_VALIDATOR_LABEL = "CRE workflow (simulation forwarder, not a trust root)";

/** `DEPLOYMENTS[chainId]`, or throws (`verify` and the validators share this check: SPEC §4.5). */
export function deploymentsFor(chainId: number): Deployment {
  const deployment = (DEPLOYMENTS as Record<number, Deployment>)[chainId];
  if (!deployment) throw new Error(`no Attest8004 deployment recorded for chain ${chainId}`);
  return deployment;
}

/** A block before a chain's first MandateRegistry: there is no mandate to read there, nor a registry to record. */
export class MandateRegistryNotDeployedError extends Error {
  /** The block asked about. */
  readonly block: bigint;
  /** The first block any MandateRegistry is valid at: the history's first `fromBlock`. */
  readonly firstBlock: bigint;

  constructor(block: bigint, firstBlock: bigint) {
    super(`no MandateRegistry is recorded at block ${block}: the first one is valid from block ${firstBlock}`);
    this.name = "MandateRegistryNotDeployedError";
    this.block = block;
    this.firstBlock = firstBlock;
  }
}

/**
 * The MandateRegistry valid at `block`: the last entry of the (ascending) history whose `fromBlock` is
 * at or before it, so the switch block itself already belongs to the new registry. Throws
 * {@link MandateRegistryNotDeployedError} before the first entry, and an `Error` for an empty history.
 * Takes a `Deployment`, or anything else carrying a history (the validators' contracts).
 */
export function mandateRegistryAt(deployment: Pick<Deployment, "mandateRegistries">, block: bigint): MandateRegistryEpoch {
  const history = deployment.mandateRegistries;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i] as MandateRegistryEpoch;
    if (entry.fromBlock <= block) return entry;
  }
  const first = history[0];
  if (first === undefined) throw new Error("no MandateRegistry recorded: the history is empty");
  throw new MandateRegistryNotDeployedError(block, first.fromBlock);
}

/** The MandateRegistry new transactions go to: the history's last entry. Throws for an empty history. */
export function currentMandateRegistry(deployment: Pick<Deployment, "mandateRegistries">): MandateRegistryEpoch {
  const current = deployment.mandateRegistries.at(-1);
  if (current === undefined) throw new Error("no MandateRegistry recorded: the history is empty");
  return current;
}
