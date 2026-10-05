// Chain reads for /approve and /inbox: the public Monad testnet RPC (no key), the recorded deployment, and the registry
// valid now. Everything read here is public data.
import {
  DEPLOYMENTS,
  currentMandateRegistry,
  identityRegistryAbi,
  mandateFromJson,
  mandateRegistryAbi,
  rateLimitedFetch,
  type Deployment,
  type Mandate,
} from "@attest8004/sdk/browser";
import { createPublicClient, getAddress, http, type Address, type Hex } from "viem";
import { monadTestnet } from "viem/chains";

/** The only host the page connects to (the CSP's connect-src allows exactly this one). */
export const RPC_URL = "https://testnet-rpc.monad.xyz";

/** Typed as a `Deployment`, so fields recorded later (the FindingsBoard) keep their declared type, not today's literal. */
export const deployment: Deployment = DEPLOYMENTS[monadTestnet.id];
export const chainId = monadTestnet.id;
export const registry: Address = getAddress(currentMandateRegistry(deployment).address);

/**
 * The pages' one client. The public RPC refuses more than 15 requests a second per IP (-32011): the inbox's discovery
 * reads in bursts, so every request waits for a slot (8 a second) and a refusal is retried.
 */
export const client = createPublicClient({
  chain: monadTestnet,
  transport: http(RPC_URL, { fetchFn: rateLimitedFetch({ requestsPerSecond: 8, retries: 6, retryDelayMs: 1_000 }) }),
});

export interface AgentState {
  agentId: bigint;
  /** The block these reads were made at. */
  block: bigint;
  owner: Address;
  passkey: { qx: Hex; qy: Hex } | null;
  nonce: bigint;
  /** The agent's X25519 inbox public key; the zero hash when none is set. */
  inboxKey: Hex;
  /** The current mandate, or null when none is set. */
  mandate: { mandate: Mandate; hash: Hex; setAtBlock: bigint } | null;
}

const ZERO32: Hex = `0x${"00".repeat(32)}`;

/** The agent's owner, passkey, nonce and mandate, all read at one block. */
export async function readAgent(agentId: bigint): Promise<AgentState> {
  const block = await client.getBlockNumber();
  const at = { blockNumber: block };
  const [owner, [qx, qy], nonce, [stored, hash, , setAtBlock], inboxKey] = await Promise.all([
    client.readContract({ address: getAddress(deployment.identityRegistry), abi: identityRegistryAbi, functionName: "ownerOf", args: [agentId], ...at }),
    client.readContract({ address: registry, abi: mandateRegistryAbi, functionName: "passkeyOf", args: [agentId], ...at }),
    client.readContract({ address: registry, abi: mandateRegistryAbi, functionName: "nonceOf", args: [agentId], ...at }),
    client.readContract({ address: registry, abi: mandateRegistryAbi, functionName: "getMandate", args: [agentId], ...at }),
    client.readContract({ address: registry, abi: mandateRegistryAbi, functionName: "inboxKeyOf", args: [agentId], ...at }),
  ]);
  return {
    agentId,
    block,
    owner: getAddress(owner),
    passkey: qx === ZERO32 && qy === ZERO32 ? null : { qx, qy },
    nonce,
    inboxKey,
    mandate:
      hash === ZERO32
        ? null
        : {
            mandate: mandateFromJson({
              allowedTargets: [...stored.allowedTargets],
              allowedSelectors: [...stored.allowedSelectors],
              maxValuePerTx: stored.maxValuePerTx.toString(),
              maxValuePerDay: stored.maxValuePerDay.toString(),
              validUntil: stored.validUntil.toString(),
            }),
            hash,
            setAtBlock,
          },
  };
}

/** The registry's own `challengeFor(agentId, changeHash, nonce)`, to cross-check the page's challenge before signing. */
export async function contractChallenge(agentId: bigint, changeHash: Hex, nonce: bigint): Promise<Hex> {
  return client.readContract({ address: registry, abi: mandateRegistryAbi, functionName: "challengeFor", args: [agentId, changeHash, nonce] });
}

/** The agent's inbox key on the current registry (zero: none). */
export async function readInboxKey(agentId: bigint): Promise<Hex> {
  return client.readContract({ address: registry, abi: mandateRegistryAbi, functionName: "inboxKeyOf", args: [agentId] });
}

/** The registry's own `mandateHashOf` and `challengeFor`, to cross-check the page's computation before signing. */
export async function contractHashes(agentId: bigint, mandate: Mandate, nonce: bigint): Promise<{ mandateHash: Hex; challenge: Hex }> {
  const mandateHash = await client.readContract({ address: registry, abi: mandateRegistryAbi, functionName: "mandateHashOf", args: [mandate] });
  const challenge = await client.readContract({ address: registry, abi: mandateRegistryAbi, functionName: "challengeFor", args: [agentId, mandateHash, nonce] });
  return { mandateHash, challenge };
}
