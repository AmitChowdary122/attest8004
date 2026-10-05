// The scripted chain and reader the verify tests run on, shared with the /evaluate tests (P11): moved here unchanged
// from verify.test.ts, except that FakeChain can answer as a validator other than A.
import {
  buildAction,
  buildRequestJson,
  DEPLOYMENTS,
  validationRegistryAbi,
  type RequestEvent,
  type RequestJsonV1,
  type ValidationStatus,
  type ValidatorChain,
} from "@attest8004/sdk";
import {
  AbiDecodingZeroDataError,
  encodeErrorResult,
  getAddress,
  keccak256,
  RpcRequestError,
  toHex,
  UnknownRpcError,
  zeroHash,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { MANDATE_V1 } from "../../src/params.ts";
import { mandateContractsFor, type MandateContracts, type ResponseLog, type VerifyReader } from "../../src/reader.ts";
import type { MandateRecord, PermissionEvent, PinnedBlock, Simulation } from "../../src/types.ts";
import { PIN_LAG_BLOCKS } from "../../src/validator.ts";

export const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
export const OTHER_VALIDATOR = getAddress("0x00000000000000000000000000000000000000b0");
export const GATE = getAddress("0x23bfbd12545ccd1501dda1b65a54518fd6212a96");
export const OWNER = getAddress("0x3efeb3cf2fb54a7d99abe90aab786ce5a831a8cf");
export const UNLISTED = getAddress("0x00000000000000000000000000000000000000b2");
export const OTHER_MANDATE_REGISTRY = getAddress("0x00000000000000000000000000000000000000c3");
/** A second MandateRegistry for the history tests (P6's v2, appended after P4's). */
export const V2_REGISTRY = getAddress("0xb60adb7d3cfb303dd501fef6ae136131e655e231");
/** An address with no code: a call to it succeeds with no data. */
export const CODELESS_GATE = getAddress("0x0000000000000000000000000000000000000e0a");
export const AGENT = 1_984n;
export const CHAIN_ID = 10_143;
export const BASE_TS = 1_790_000_000n;
/** One second per block, so every block has its own timestamp. */
export const tsOf = (block: bigint): bigint => BASE_TS + block - 1_000n;
/** The SDK's recorded testnet deployment: what `verify` recomputes with. */
export const RECORDED: MandateContracts = mandateContractsFor(CHAIN_ID);
/** The recorded testnet MandateRegistry (P4's). */
export const P4_REGISTRY = DEPLOYMENTS[10143].mandateRegistries[0].address;

export function unknownRequest(requestHash: Hex): Error {
  // How a raw eth_call revert reaches the reader: JSON-RPC code 3 with the revert data.
  return Object.assign(new Error("execution reverted"), {
    code: 3,
    data: encodeErrorResult({ abi: validationRegistryAbi, errorName: "UnknownRequest", args: [requestHash] }),
  });
}

/**
 * The shapes the registry's `UnknownRequest` revert reaches the reader in: the raw provider error,
 * viem's HTTP `RpcRequestError` (code 3 at the top), and viem's `UnknownRpcError` wrapping a custom
 * transport's error (code -1, the revert as its cause).
 */
export const UNKNOWN_REQUEST_SHAPES: Array<{ shape: string; wrap: (raw: Error) => unknown }> = [
  { shape: "a flat { code: 3, data }", wrap: (raw) => raw },
  {
    shape: "viem's HTTP RpcRequestError",
    wrap: (raw) =>
      new RpcRequestError({
        body: { method: "eth_call" },
        url: "https://rpc.example/key",
        error: { code: 3, message: raw.message, data: (raw as unknown as { data: Hex }).data },
      }),
  },
  { shape: "viem's UnknownRpcError around a custom transport's error", wrap: (raw) => new UnknownRpcError(raw) },
];

export type Landed = { block: bigint; logIndex: number; uri: string; status: ValidationStatus };

/**
 * A scripted chain: the request events, and the responses that landed (each in the block after the
 * finalized head; the chain then moves on and finalizes `PIN_LAG_BLOCKS` past it, so the next pin can
 * see it). Hashes are keyed lower-case.
 */
export class FakeChain implements ValidatorChain {
  /** The validator this chain answers as (`respond`); validator A unless a test names another (validator C, P11). */
  readonly address: Address;
  /** The base's cycle head: requests are polled up to it, deadlines checked against its time. */
  readonly headBlock = { number: 1_004n, timestamp: tsOf(1_004n) };
  /** The finalized head every reader reports: the validator's first pin is block 1,004. */
  finalized = 1_004n + PIN_LAG_BLOCKS;
  /**
   * The block the ValidationRegistry was deployed in. Before it the contract has no code, so a status
   * read returns no data (`"0x"`), which doesn't decode, rather than reverting `UnknownRequest`.
   */
  deployBlock = 900n;
  /** The block the MandateRegistry was deployed in; `getMandate` before it returns no data, likewise. */
  mandateDeployBlock = 950n;
  /** Gates with no code, so `consumed()` on them returns no data. Lower-case. */
  readonly codelessGates = new Set<string>();
  readonly events: RequestEvent[] = [];
  readonly landed = new Map<Hex, Landed>();

  constructor(address: Address = VALIDATOR) {
    this.address = address;
  }

  async chainId() {
    return CHAIN_ID;
  }
  async head() {
    return this.headBlock;
  }
  async requestLogs(fromBlock: bigint, toBlock: bigint) {
    return this.events.filter((e) => e.blockNumber >= fromBlock && e.blockNumber <= toBlock);
  }
  async status(requestHash: Hex): Promise<ValidationStatus> {
    return this.statusAt(requestHash, 2n ** 64n);
  }
  /** `getValidationStatus` at block `at`: it reverts `UnknownRequest` before the request was made. */
  statusAt(requestHash: Hex, at: bigint): ValidationStatus {
    if (at < this.deployBlock) throw new AbiDecodingZeroDataError(); // what viem's decode of "0x" throws
    const key = requestHash.toLowerCase() as Hex;
    const event = this.events.find((e) => e.requestHash === key && e.blockNumber <= at);
    if (!event) throw unknownRequest(key);
    const landed = this.landed.get(key);
    if (landed !== undefined && landed.block <= at) return landed.status;
    return { validator: event.validator, agentId: event.agentId, response: 0, responseHash: zeroHash, tag: "", lastUpdate: tsOf(event.blockNumber) };
  }
  async respond(response: { requestHash: Hex; response: number; responseURI: string; responseHash: Hex; tag: string }): Promise<{
    txHash: Hash;
    blockNumber: bigint;
    gasLimit: bigint;
  }> {
    const block = this.finalized + 1n;
    const event = this.events.find((e) => e.requestHash === response.requestHash);
    if (!event) throw new Error(`FakeChain: no request ${response.requestHash}`);
    this.landed.set(response.requestHash, {
      block,
      logIndex: 0,
      uri: response.responseURI,
      status: {
        validator: this.address,
        agentId: event.agentId,
        response: response.response,
        responseHash: response.responseHash,
        tag: response.tag,
        lastUpdate: tsOf(block),
      },
    });
    this.finalized = block + PIN_LAG_BLOCKS;
    return { txHash: keccak256(toHex(`response tx ${block}`)), blockNumber: block, gasLimit: 84_010n };
  }
}

/** A reader over the fake chain, reading state at the block it is given. It holds no cache of its own. */
export class FakeReader implements VerifyReader {
  readonly chain: FakeChain;
  mandateRecord: MandateRecord | null = mandate();
  owner: Address = OWNER;
  simulation: Simulation = { ok: true };
  permissionEvents: Array<Omit<PermissionEvent, "afterMandate">> = [
    { block: 500n, logIndex: 0, txHash: keccak256(toHex("MandateSet tx")), emitter: "MandateRegistry", event: "MandateSet" },
  ];
  /** Responses whose log this reader can't find (RPC or log-index lag). */
  readonly hiddenResponses = new Set<Hex>();
  /** Requests whose `ValidationRequest` log this reader can't find. */
  readonly hiddenRequests = new Set<Hex>();
  /** Every `responseLog` lookup, by requestHash (`responseEvidence` goes through it). */
  readonly responseLogCalls: Hex[] = [];
  /** Every block a status was read at. */
  readonly statusReads: bigint[] = [];
  /** Every block a request log was looked up in. */
  readonly requestUriCalls: bigint[] = [];
  /** Every block the mandate was read at. */
  readonly mandateReads: bigint[] = [];
  /** A failure for the status read at `at` (thrown instead of reading), or undefined to read. */
  statusFailure: ((at: bigint) => unknown) | undefined;
  /** How an `UnknownRequest` revert reaches the caller. */
  unknownRequestAs: (raw: Error) => unknown = (raw) => raw;

  constructor(chain: FakeChain) {
    this.chain = chain;
  }

  async chainId() {
    return CHAIN_ID;
  }
  async finalized(): Promise<PinnedBlock> {
    return this.block(this.chain.finalized);
  }
  async block(number: bigint): Promise<PinnedBlock> {
    return { number, hash: keccak256(toHex(`block ${number}`)), timestamp: tsOf(number) };
  }
  async mandate(_agentId: bigint, at: bigint) {
    this.mandateReads.push(at);
    if (at < this.chain.mandateDeployBlock) throw new AbiDecodingZeroDataError(); // what viem's decode of "0x" throws
    return this.mandateRecord;
  }
  async ownerOf() {
    return this.owner;
  }
  async agentValidations(agentId: bigint, at: bigint) {
    return this.chain.events.filter((e) => e.agentId === agentId && e.blockNumber <= at).map((e) => e.requestHash);
  }
  async status(requestHash: Hex, at: bigint): Promise<ValidationStatus> {
    this.statusReads.push(at);
    const failure = this.statusFailure?.(at);
    if (failure !== undefined) throw failure;
    try {
      return this.chain.statusAt(requestHash, at);
    } catch (error) {
      throw this.unknownRequestAs(error as Error);
    }
  }
  async consumed(gate: Address) {
    // What viemMandateReader returns when the pinned call to the gate yields no bool: unknown.
    return this.chain.codelessGates.has(gate.toLowerCase()) ? null : false;
  }
  async permissionLogs(fromBlock: bigint, toBlock: bigint) {
    return this.permissionEvents.filter((e) => e.block >= fromBlock && e.block <= toBlock).map((e) => ({ ...e }));
  }
  async simulate() {
    return this.simulation;
  }
  async responseEvidence(requestHash: Hex, timestamp: bigint, notAfter: bigint) {
    return (await this.responseLog(requestHash, timestamp, notAfter))?.uri ?? null;
  }
  async responseLog(requestHash: Hex, timestamp: bigint, notAfter: bigint): Promise<ResponseLog | null> {
    const key = requestHash.toLowerCase() as Hex;
    this.responseLogCalls.push(key);
    const landed = this.chain.landed.get(key);
    if (landed === undefined || this.hiddenResponses.has(key) || landed.block > notAfter || tsOf(landed.block) !== timestamp) return null;
    return { uri: landed.uri, block: landed.block, logIndex: landed.logIndex };
  }
  async requestUri(requestHash: Hex, block: bigint) {
    this.requestUriCalls.push(block);
    const key = requestHash.toLowerCase() as Hex;
    if (this.hiddenRequests.has(key)) return null;
    return this.chain.events.find((e) => e.requestHash === key && e.blockNumber === block)?.requestURI ?? null;
  }
}

export function mandate(over: Partial<MandateRecord> = {}): MandateRecord {
  return {
    allowedTargets: [OWNER],
    allowedSelectors: [MANDATE_V1.plainTransferSelector],
    maxValuePerTx: 2_000n,
    maxValuePerDay: 2_500n,
    validUntil: tsOf(1_004n) + 86_400n,
    mandateHash: keccak256(toHex("mandate")),
    owner: OWNER,
    setAtBlock: 500n,
    ...over,
  };
}

let saltCounter = 0;

export function requestJson(
  over: { chainId?: number; gate?: Address; target?: Address; value?: bigint; validator?: Address; deadline?: bigint } = {},
): RequestJsonV1 {
  return buildRequestJson({
    chainId: over.chainId ?? CHAIN_ID,
    gate: over.gate ?? GATE,
    validator: over.validator ?? VALIDATOR,
    action: buildAction({
      agentId: AGENT,
      target: over.target ?? OWNER,
      value: over.value ?? 1_000n,
      deadline: over.deadline ?? tsOf(1_004n) + 600n,
      salt: keccak256(toHex(`salt ${saltCounter++}`)),
    }),
  });
}
