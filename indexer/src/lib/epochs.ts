// The MandateRegistry history (SDK DEPLOYMENTS[10143].mandateRegistries, ARCHITECTURE §6): each registry is valid
// from its deploy block until the next one's, exactly as `mandateRegistryAt` picks the registry for a verdict's pin.
// An event from a registry outside its epoch is stored but changes no state (plan decision 8). test/config.test.ts
// holds this list to the SDK and to config.yaml.

export interface MandateEpoch {
  /** Lowercase address. */
  registry: string;
  fromBlock: bigint;
  /** The first block of the next epoch, or null for the current registry. */
  toBlock: bigint | null;
}

export const MANDATE_EPOCHS: readonly MandateEpoch[] = [
  { registry: "0x2523197373ef813e19b5b14ef2984130868cd17c", fromBlock: 67_842_487n, toBlock: 68_196_462n },
  { registry: "0x2ee5f78149762de630c6bff8cd81166010d0454b", fromBlock: 68_196_462n, toBlock: null },
];

/** Whether `registry` was the valid MandateRegistry at `block`. */
export function inEpoch(registry: string, block: bigint): boolean {
  const epoch = MANDATE_EPOCHS.find((e) => e.registry === registry.toLowerCase());
  return epoch !== undefined && block >= epoch.fromBlock && (epoch.toBlock === null || block < epoch.toBlock);
}
