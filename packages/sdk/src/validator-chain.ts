import { getAddress, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import { validationRegistryAbi, validationRequestEvent } from "./abi.ts";
import { writeWithGasGuard, type GasLimit } from "./gas.ts";

/** A `ValidationRequest` event addressed to this validator. */
export interface RequestEvent {
  validator: Address;
  agentId: bigint;
  /** Attacker-controlled: whoever owns any agent chooses it. */
  requestURI: string;
  requestHash: Hex;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hash;
}

/** `getValidationStatus(requestHash)`. A pending request reads as response 0, zero hash, empty tag. */
export interface ValidationStatus {
  validator: Address;
  agentId: bigint;
  response: number;
  responseHash: Hex;
  tag: string;
  lastUpdate: bigint;
}

/** What `ValidatorBase` needs from the chain. `viemValidatorChain` is the real one. */
export interface ValidatorChain {
  /** The validator's own address: the account that signs its responses. */
  readonly address: Address;
  chainId(): Promise<number>;
  /** The block the validator treats as the chain head, and that block's timestamp. */
  head(): Promise<{ number: bigint; timestamp: bigint }>;
  /** `ValidationRequest` events naming this validator in [fromBlock, toBlock], in chain order. */
  requestLogs(fromBlock: bigint, toBlock: bigint): Promise<RequestEvent[]>;
  status(requestHash: Hex): Promise<ValidationStatus>;
  /** Sends `validationResponse` and resolves once it succeeded onchain, with where it landed. */
  respond(response: {
    requestHash: Hex;
    response: number;
    responseURI: string;
    responseHash: Hex;
    tag: string;
  }): Promise<{ txHash: Hash; blockNumber: bigint; gasLimit: bigint }>;
}

/**
 * A `ValidatorChain` over viem. The head is the `finalized` block by default, so the validator never
 * answers a request that a reorg could remove. Responses go through `writeWithGasGuard` with the
 * given `gasLimit` (Monad charges for the limit): a literal, or an evidence-sized policy, since a
 * response's evidence varies in size with the validator's own findings.
 */
export function viemValidatorChain(options: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  validationRegistry: Address;
  gasLimit: GasLimit;
  headTag?: "finalized" | "safe" | "latest";
}): ValidatorChain {
  const { publicClient, walletClient, validationRegistry, gasLimit, headTag = "finalized" } = options;
  if (!walletClient.account) throw new Error("viemValidatorChain needs a walletClient with an account");
  const address = getAddress(walletClient.account.address);

  return {
    address,
    chainId: () => publicClient.getChainId(),

    async head() {
      const block = await publicClient.getBlock({ blockTag: headTag });
      return { number: block.number, timestamp: block.timestamp };
    },

    async requestLogs(fromBlock, toBlock) {
      const logs = await publicClient.getLogs({
        address: validationRegistry,
        event: validationRequestEvent,
        args: { validatorAddress: address },
        fromBlock,
        toBlock,
      });
      const events: RequestEvent[] = [];
      for (const log of logs) {
        const { validatorAddress, agentId, requestURI, requestHash } = log.args;
        if (!validatorAddress || agentId === undefined || requestURI === undefined || !requestHash) continue;
        events.push({
          validator: getAddress(validatorAddress),
          agentId,
          requestURI,
          requestHash,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
          txHash: log.transactionHash,
        });
      }
      return events.sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
      );
    },

    async status(requestHash) {
      const [validator, agentId, response, responseHash, tag, lastUpdate] = await publicClient.readContract({
        address: validationRegistry,
        abi: validationRegistryAbi,
        functionName: "getValidationStatus",
        args: [requestHash],
      });
      return { validator: getAddress(validator), agentId, response, responseHash, tag, lastUpdate };
    },

    async respond({ requestHash, response, responseURI, responseHash, tag }) {
      const { hash, receipt, gasLimit: sentGasLimit } = await writeWithGasGuard({
        publicClient,
        walletClient,
        address: validationRegistry,
        abi: validationRegistryAbi,
        functionName: "validationResponse",
        args: [requestHash, response, responseURI, responseHash, tag],
        gasLimit,
        label: "validationResponse",
      });
      return { txHash: hash, blockNumber: receipt.blockNumber, gasLimit: sentGasLimit };
    },
  };
}
