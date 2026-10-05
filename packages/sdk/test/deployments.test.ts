import { getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  currentMandateRegistry,
  DEPLOYMENTS,
  MandateRegistryNotDeployedError,
  mandateRegistryAt,
  type Deployment,
  type MandateRegistryEpoch,
} from "../src/index.ts";

const P4: Address = "0x2523197373ef813E19b5b14Ef2984130868cD17c";
const V2: Address = "0xb60aDb7d3cFB303DD501FEf6aE136131E655E231";
const P4_FROM = 67_842_487n;
const V2_FROM = 68_500_000n;

/** A synthetic history: P4's registry, then a v2 from `V2_FROM` (the real one is appended when v2 is deployed). */
const twoRegistries: Pick<Deployment, "mandateRegistries"> = {
  mandateRegistries: [
    { address: P4, fromBlock: P4_FROM },
    { address: V2, fromBlock: V2_FROM },
  ],
};

/**
 * The first MandateRegistry each chain had, from docs/deployments.md (its deploy transaction's block):
 * every later entry is appended, never inserted before it.
 */
const FIRST_REGISTRY: Record<string, MandateRegistryEpoch> = {
  "10143": { address: P4, fromBlock: P4_FROM },
};

describe("mandateRegistryAt", () => {
  it("mandateRegistryAt picks the P4 registry at fromBlock(v2) − 1 and v2 at fromBlock(v2)", () => {
    expect(mandateRegistryAt(twoRegistries, V2_FROM - 1n)).toEqual({ address: P4, fromBlock: P4_FROM });
    expect(mandateRegistryAt(twoRegistries, V2_FROM)).toEqual({ address: V2, fromBlock: V2_FROM });
    expect(mandateRegistryAt(twoRegistries, P4_FROM).address).toBe(P4);
    expect(mandateRegistryAt(twoRegistries, V2_FROM + 1_000_000n).address).toBe(V2);
  });

  it("mandateRegistryAt throws MandateRegistryNotDeployedError before the first registry", () => {
    const failure = (() => {
      try {
        mandateRegistryAt(twoRegistries, P4_FROM - 1n);
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(MandateRegistryNotDeployedError);
    expect(failure).toMatchObject({ name: "MandateRegistryNotDeployedError", block: P4_FROM - 1n, firstBlock: P4_FROM });
    expect(() => mandateRegistryAt(twoRegistries, 0n)).toThrow(MandateRegistryNotDeployedError);
    expect(() => mandateRegistryAt({ mandateRegistries: [] }, P4_FROM)).toThrow(/no MandateRegistry/);
  });

  it("every DEPLOYMENTS history is ascending, non-empty, and starts at the first deploy block", () => {
    const chains = Object.keys(DEPLOYMENTS);
    expect(chains.sort()).toEqual(Object.keys(FIRST_REGISTRY).sort());
    for (const [chainId, deployment] of Object.entries(DEPLOYMENTS as Record<string, Deployment>)) {
      const history = deployment.mandateRegistries;
      expect(history.length, `chain ${chainId}`).toBeGreaterThan(0);
      expect(history[0], `chain ${chainId}`).toEqual(FIRST_REGISTRY[chainId]);
      for (let i = 1; i < history.length; i++) {
        const [previous, entry] = [history[i - 1] as MandateRegistryEpoch, history[i] as MandateRegistryEpoch];
        expect(entry.fromBlock > previous.fromBlock, `chain ${chainId}, entry ${i}`).toBe(true);
        expect(getAddress(entry.address), `chain ${chainId}, entry ${i}`).not.toBe(getAddress(previous.address));
      }
      for (const entry of history) expect(entry.address).toBe(getAddress(entry.address)); // EIP-55, as the evidence records it
    }
  });
});

describe("currentMandateRegistry", () => {
  it("currentMandateRegistry is the last entry", () => {
    expect(currentMandateRegistry(twoRegistries)).toEqual({ address: V2, fromBlock: V2_FROM });
    for (const deployment of Object.values(DEPLOYMENTS as Record<string, Deployment>)) {
      expect(currentMandateRegistry(deployment)).toBe(deployment.mandateRegistries.at(-1));
    }
    expect(() => currentMandateRegistry({ mandateRegistries: [] })).toThrow(/no MandateRegistry/);
  });
});

describe("findingsBoard", () => {
  it("findingsBoard is the deployed board and its deploy block (10143)", () => {
    expect(DEPLOYMENTS[10143].findingsBoard).toEqual({ address: "0xa7d52B3B08FAB0cd0527c6242ca678f9Feee6a1c", fromBlock: 68_296_810n });
  });
});

describe("validator C (P11)", () => {
  const testnet = DEPLOYMENTS[10143];

  it("records CreValidator as a checksummed address distinct from validators A and B", () => {
    const c = testnet.validators.creMandateV1;
    expect(getAddress(c)).toBe(c);
    expect(c).not.toBe(getAddress(testnet.validators.mandateV1));
    expect(c).not.toBe(getAddress(testnet.validators.riskV1));
  });

  it("records the forwarder C trusts: CRE's MockKeystoneForwarder on Monad testnet (Forwarder Directory)", () => {
    expect(testnet.creForwarder).toBe("0xB9F79d863261869B234c481D1f9A7af84AeAd192");
  });
});
