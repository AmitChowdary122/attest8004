// Posting an operator report (SPEC §4.7): after a verdict lands, a validator seals its report to the agent's inbox
// key and posts it to the FindingsBoard, with an explicit gas limit. Nothing here can change a verdict: every
// failure is an outcome, never a throw.
import { BaseError, getAddress, zeroHash, type Address, type Hash, type Hex, type PublicClient, type WalletClient } from "viem";
import { findingsBoardAbi, mandateRegistryAbi } from "./abi.ts";
import { currentMandateRegistry, type Deployment } from "./deployments.ts";
import { writeWithGasGuard } from "./gas.ts";
import { LowOrderKeyError, sealEnvelope } from "./inbox-crypto.ts";
import { ReportTooLargeError, encodeReport, fitReport, type OperatorReport } from "./report.ts";

/**
 * The most gas one report post may be sent with. The limit sent is Monad's estimate × 1.2, never above this; a post
 * whose estimate is above it is refused, so nothing is sent. Provisional (P7, Decision 16): 21,000 plus EIP-7623's
 * floor of 10 gas per calldata token for a full 8,192-byte envelope (about 350,000), × 1.2. Replaced by Monad's
 * live eth_estimateGas for a full envelope once the board is deployed.
 */
export const OPERATOR_REPORT_GAS_CAP = 420_000n;
/** How long `sendOperatorReport` waits for the whole post (read, seal, send, receipt) before it reports `failed`. */
export const REPORT_POST_TIMEOUT_MS = 60_000;

/** What a validator needs to post reports: its address and the addresses the envelope's AAD binds. */
export interface InboxPort {
  chainId: number;
  /** The posting account: `msg.sender` of `post`, and the validator the AAD binds. */
  validator: Address;
  findingsBoard: Address;
  validationRegistry: Address;
  /** The agent's X25519 inbox key on the current MandateRegistry; the zero hash when none is set. */
  inboxKeyOf(agentId: bigint): Promise<Hex>;
  /**
   * Sends `FindingsBoard.post` and resolves once it succeeded onchain. Once `signal` is aborted (the caller gave up
   * waiting), it must not broadcast: a late send would contend for the key's next nonce.
   */
  post(p: { requestHash: Hex; agentId: bigint; envelope: Hex }, signal?: AbortSignal): Promise<{ txHash: Hash; blockNumber: bigint; gasLimit: bigint }>;
}

/**
 * An `InboxPort` over viem, or `null` when the deployment has no FindingsBoard (then validators post nothing).
 * `inboxKeyOf` reads the current MandateRegistry at `latest`; `post` goes through `writeWithGasGuard` with
 * `{ headroomPercent: 20, max: OPERATOR_REPORT_GAS_CAP }`. The wallet client must carry its account and chain.
 */
export function viemInboxPort(o: { publicClient: PublicClient; walletClient: WalletClient; deployment: Deployment }): InboxPort | null {
  const { publicClient, walletClient, deployment } = o;
  if (deployment.findingsBoard === null) return null;
  const account = walletClient.account;
  const chainId = walletClient.chain?.id;
  if (!account) throw new Error("viemInboxPort needs a walletClient with an account");
  if (chainId === undefined) throw new Error("viemInboxPort needs a walletClient with a chain");
  const findingsBoard = getAddress(deployment.findingsBoard.address);
  const mandateRegistry = getAddress(currentMandateRegistry(deployment).address);
  return {
    chainId,
    validator: getAddress(account.address),
    findingsBoard,
    validationRegistry: getAddress(deployment.validationRegistry),
    inboxKeyOf: (agentId) =>
      publicClient.readContract({ address: mandateRegistry, abi: mandateRegistryAbi, functionName: "inboxKeyOf", args: [agentId] }),
    async post({ requestHash, agentId, envelope }, signal) {
      const { hash, receipt, gasLimit } = await writeWithGasGuard({
        publicClient,
        walletClient,
        address: findingsBoard,
        abi: findingsBoardAbi,
        functionName: "post",
        args: [requestHash, agentId, envelope],
        gasLimit: { headroomPercent: 20, max: OPERATOR_REPORT_GAS_CAP },
        label: "FindingsBoard.post",
        signal,
      });
      return { txHash: hash, blockNumber: receipt.blockNumber, gasLimit };
    },
  };
}

export type SendReportOutcome =
  | { kind: "posted"; txHash: Hash; blockNumber: bigint; gasLimit: bigint; envelopeBytes: number }
  /** Nothing was sent. */
  | { kind: "skipped"; reason: "NO_INBOX_KEY" | "LOW_ORDER_KEY" | "REPORT_TOO_LARGE" }
  /** It may or may not have been sent (a send that timed out can still land), so a gas reservation stays. */
  | { kind: "failed"; error: string };

/**
 * Seals `report` to its agent's inbox key and posts it, as `port.validator`. The request and the agent come from the
 * report. Never throws: an agent with no inbox key, a low-order key or a report too large to fit is `skipped`
 * (nothing sent); any other failure, or no answer within `timeoutMs` (default {@link REPORT_POST_TIMEOUT_MS}), is
 * `failed`, with viem's short message only (the full one can carry the RPC URL). A timeout also aborts the post, so
 * one still preparing never broadcasts afterwards (one already sent can't be recalled; the gas guard then treats a
 * transaction of this key that it replaced as a failed send, never as landed).
 */
export async function sendOperatorReport(port: InboxPort, o: { report: OperatorReport; timeoutMs?: number }): Promise<SendReportOutcome> {
  const timeoutMs = o.timeoutMs ?? REPORT_POST_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<SendReportOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "failed", error: `timed out after ${timeoutMs} ms` });
    }, timeoutMs);
  });
  try {
    return await Promise.race([postReport(port, o.report, controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function postReport(port: InboxPort, report: OperatorReport, signal: AbortSignal): Promise<SendReportOutcome> {
  try {
    const agentId = BigInt(report.agentId);
    const requestHash = report.requestHash;
    const recipient = await port.inboxKeyOf(agentId);
    if (BigInt(recipient) === BigInt(zeroHash)) return { kind: "skipped", reason: "NO_INBOX_KEY" };
    let plaintext: Uint8Array;
    try {
      plaintext = encodeReport(fitReport(report));
    } catch (error) {
      if (error instanceof ReportTooLargeError) return { kind: "skipped", reason: "REPORT_TOO_LARGE" };
      throw error;
    }
    let envelope: Hex;
    try {
      envelope = sealEnvelope({
        plaintext,
        context: {
          chainId: port.chainId,
          findingsBoard: port.findingsBoard,
          validationRegistry: port.validationRegistry,
          requestHash,
          agentId,
          validator: port.validator,
          recipient,
        },
      });
    } catch (error) {
      if (error instanceof LowOrderKeyError) return { kind: "skipped", reason: "LOW_ORDER_KEY" };
      throw error;
    } finally {
      plaintext.fill(0);
    }
    if (signal.aborted) return { kind: "failed", error: "timed out before sending" };
    const sent = await port.post({ requestHash, agentId, envelope }, signal);
    return { kind: "posted", ...sent, envelopeBytes: (envelope.length - 2) / 2 };
  } catch (error) {
    return { kind: "failed", error: shortMessage(error) };
  }
}

/** viem's short message, never its full one (which can carry the RPC URL and its key). */
function shortMessage(error: unknown): string {
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message : String(error);
}
