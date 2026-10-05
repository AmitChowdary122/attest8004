import { currentMandateRegistry, mandateRegistryAbi, validationRegistryAbi } from "@attest8004/sdk";
import { getAddress, type Address, type PublicClient } from "viem";
import type { MandateContracts } from "./reader.ts";

/**
 * Refuses to start unless the RPC is on the expected chain and the contracts agree on one Identity
 * Registry, the one the reader uses for owners and permission events. The MandateRegistry checked is
 * the current one (the history's last): the one new mandates are set on. Shared by validator A's
 * service (main.ts) and the read-only /evaluate service (evaluate-main.ts); each logs the result.
 */
export async function startupChecks(
  publicClient: PublicClient,
  chainId: number,
  contracts: MandateContracts,
): Promise<{ identityRegistry: Address; mandateRegistry: Address }> {
  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== chainId) throw new Error(`the RPC is on chain ${rpcChainId}, expected ${chainId}`);
  const mandateRegistry = currentMandateRegistry(contracts).address;
  const [fromMandateRegistry, fromValidationRegistry] = await Promise.all([
    publicClient.readContract({ address: mandateRegistry, abi: mandateRegistryAbi, functionName: "identityRegistry" }),
    publicClient.readContract({ address: contracts.validationRegistry, abi: validationRegistryAbi, functionName: "getIdentityRegistry" }),
  ]);
  const expected = getAddress(contracts.identityRegistry);
  if (getAddress(fromMandateRegistry) !== getAddress(fromValidationRegistry)) {
    throw new Error(
      `MandateRegistry.identityRegistry() is ${fromMandateRegistry}, but ValidationRegistry.getIdentityRegistry() is ${fromValidationRegistry}`,
    );
  }
  if (getAddress(fromValidationRegistry) !== expected) {
    throw new Error(`the registries use Identity Registry ${fromValidationRegistry}, but the deployment records ${expected}`);
  }
  return { identityRegistry: expected, mandateRegistry };
}
