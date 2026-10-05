import { BaseError, getAddress, keccak256, toHex, zeroHash, type Address, type Hash, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENTS,
  OPERATOR_REPORT_GAS_CAP,
  REPORT_SCHEMA_V1,
  decodeReport,
  deriveInboxPrivateKey,
  openEnvelope,
  sendOperatorReport,
  viemInboxPort,
  x25519PublicKey,
  type InboxPort,
  type OperatorReport,
} from "../src/index.ts";

const VALIDATOR = getAddress("0xa62dab21e0c0f57e94b3ed6e675f214199989e92");
const BOARD = getAddress("0xa7d52b3b08fab0cd0527c6242ca678f9feee6a1c");
const REGISTRY = getAddress("0xc4a4d0ceb3971cbe7a2536494ac106f2cd9f9a8f");
const PRF = new Uint8Array(32).fill(7);

function recipient(): { privateKey: Uint8Array; publicKey: Hex } {
  const privateKey = deriveInboxPrivateKey(PRF.slice());
  return { privateKey, publicKey: x25519PublicKey(privateKey) };
}

function report(over: Partial<OperatorReport> = {}): OperatorReport {
  return {
    schema: REPORT_SCHEMA_V1,
    tag: "risk-v1",
    requestHash: keccak256(toHex("request R")),
    agentId: "1984",
    score: 0,
    responseHash: keccak256(toHex("evidence")),
    summary: "Score 0: 1 high finding.",
    items: [{ code: "FUNDS_FORWARDED", severity: "high", text: "Forwards the value to a sink.", action: "Don't execute it." }],
    notes: [],
    ...over,
  };
}

class FakePort implements InboxPort {
  readonly chainId = 10143;
  readonly validator: Address = VALIDATOR;
  readonly findingsBoard: Address = BOARD;
  readonly validationRegistry: Address = REGISTRY;
  inboxKey: Hex = zeroHash;
  readonly reads: bigint[] = [];
  readonly posts: { requestHash: Hex; agentId: bigint; envelope: Hex }[] = [];
  postImpl: () => Promise<{ txHash: Hash; blockNumber: bigint; gasLimit: bigint }> = async () => ({
    txHash: keccak256(toHex("post")),
    blockNumber: 7n,
    gasLimit: 91_000n,
  });

  async inboxKeyOf(agentId: bigint): Promise<Hex> {
    this.reads.push(agentId);
    return this.inboxKey;
  }
  async post(p: { requestHash: Hex; agentId: bigint; envelope: Hex }, _signal?: AbortSignal) {
    this.posts.push(p);
    return this.postImpl();
  }
}

describe("sendOperatorReport", () => {
  it("NO_INBOX_KEY → skipped, post never called", async () => {
    const port = new FakePort();
    expect(await sendOperatorReport(port, { report: report() })).toEqual({ kind: "skipped", reason: "NO_INBOX_KEY" });
    expect(port.reads).toEqual([1984n]);
    expect(port.posts).toHaveLength(0);
  });

  it("posts an envelope that opens with the recipient's key under the port's context", async () => {
    const port = new FakePort();
    const key = recipient();
    port.inboxKey = key.publicKey;
    const sent = report();

    const outcome = await sendOperatorReport(port, { report: sent });

    expect(outcome).toMatchObject({ kind: "posted", txHash: keccak256(toHex("post")), blockNumber: 7n, gasLimit: 91_000n });
    expect(port.posts).toHaveLength(1);
    const post = port.posts[0] as { requestHash: Hex; agentId: bigint; envelope: Hex };
    expect(post.requestHash).toBe(sent.requestHash);
    expect(post.agentId).toBe(1984n);
    expect(outcome.kind === "posted" && outcome.envelopeBytes).toBe((post.envelope.length - 2) / 2);
    const opened = openEnvelope({
      envelope: post.envelope,
      privateKey: key.privateKey,
      context: {
        chainId: 10143,
        findingsBoard: BOARD,
        validationRegistry: REGISTRY,
        requestHash: sent.requestHash,
        agentId: 1984n,
        validator: VALIDATOR,
        recipient: key.publicKey,
      },
    });
    expect(opened.ok).toBe(true);
    if (opened.ok) expect(decodeReport(opened.plaintext)).toEqual({ ok: true, report: sent });
  });

  it("a low-order inbox key → skipped LOW_ORDER_KEY", async () => {
    const port = new FakePort();
    port.inboxKey = `0x01${"00".repeat(31)}`;
    expect(await sendOperatorReport(port, { report: report() })).toEqual({ kind: "skipped", reason: "LOW_ORDER_KEY" });
    expect(port.posts).toHaveLength(0);
  });

  it("REPORT_TOO_LARGE → skipped", async () => {
    const port = new FakePort();
    port.inboxKey = recipient().publicKey;
    const items = Array.from({ length: 12 }, () => ({ code: "OTHER", severity: null, text: "x", action: "\u0001".repeat(300) }));
    expect(await sendOperatorReport(port, { report: report({ items }) })).toEqual({ kind: "skipped", reason: "REPORT_TOO_LARGE" });
    expect(port.posts).toHaveLength(0);
  });

  it("post throws → failed with the short message", async () => {
    const port = new FakePort();
    port.inboxKey = recipient().publicKey;
    port.postImpl = async () => {
      throw new BaseError("RPC Request failed.", { details: "https://rpc.example/key-123 refused" });
    };
    const outcome = await sendOperatorReport(port, { report: report() });
    expect(outcome).toEqual({ kind: "failed", error: "RPC Request failed." });
  });

  it("a timeout aborts the post's signal, so a post still preparing never broadcasts afterwards (P7 review I1)", async () => {
    const port = new FakePort();
    port.inboxKey = recipient().publicKey;
    let seen: AbortSignal | undefined;
    port.post = async (p, signal) => {
      port.posts.push(p);
      seen = signal;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { txHash: keccak256(toHex("late")), blockNumber: 8n, gasLimit: 90_000n };
    };
    const outcome = await sendOperatorReport(port, { report: report(), timeoutMs: 20 });
    expect(outcome).toEqual({ kind: "failed", error: "timed out after 20 ms" });
    expect(seen?.aborted).toBe(true);
  });

  it("post hangs past timeoutMs → failed", async () => {
    const port = new FakePort();
    port.inboxKey = recipient().publicKey;
    port.postImpl = () => new Promise(() => {});
    const outcome = await sendOperatorReport(port, { report: report(), timeoutMs: 20 });
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.error).toMatch(/timed out after 20 ms/);
  });

  it("inboxKeyOf throws → failed, never thrown", async () => {
    const port = new FakePort();
    port.inboxKeyOf = async () => {
      throw new Error("eth_call: upstream unavailable");
    };
    expect(await sendOperatorReport(port, { report: report() })).toEqual({ kind: "failed", error: "eth_call: upstream unavailable" });
  });
});

describe("viemInboxPort", () => {
  const walletClient = { account: { address: VALIDATOR }, chain: { id: 10143 } } as never;

  it("viemInboxPort returns null without a FindingsBoard", () => {
    expect(viemInboxPort({ publicClient: {} as never, walletClient, deployment: { ...DEPLOYMENTS[10143], findingsBoard: null } })).toBeNull();
  });

  it("names the wallet's account as the validator and the deployment's board and registry", () => {
    const port = viemInboxPort({
      publicClient: {} as never,
      walletClient,
      deployment: { ...DEPLOYMENTS[10143], findingsBoard: { address: BOARD, fromBlock: 1n } },
    });
    expect(port).toMatchObject({ chainId: 10143, validator: VALIDATOR, findingsBoard: BOARD, validationRegistry: REGISTRY });
  });

  /** A viem stand-in for writeWithGasGuard: the node's estimate is `estimate`; it records what was sent. */
  function fakeClients(estimate: bigint) {
    const sent: Record<string, unknown>[] = [];
    const publicClient = {
      simulateContract: async () => ({}),
      estimateContractGas: async () => estimate,
      getChainId: async () => 10143,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      getTransactionCount: async () => 5,
      waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 99n }),
    };
    const wallet = {
      account: { address: VALIDATOR },
      chain: { id: 10143 },
      writeContract: async (call: Record<string, unknown>) => {
        sent.push(call);
        return keccak256(toHex("tx"));
      },
    };
    return { publicClient: publicClient as never, walletClient: wallet as never, sent };
  }

  it("post never broadcasts once its signal is aborted (P7 review I1)", async () => {
    const deployment = { ...DEPLOYMENTS[10143], findingsBoard: { address: BOARD, fromBlock: 1n } };
    const clients = fakeClients(100_000n);
    const port = viemInboxPort({ ...clients, deployment }) as InboxPort;
    const controller = new AbortController();
    controller.abort();
    await expect(port.post({ requestHash: keccak256(toHex("r")), agentId: 1984n, envelope: "0x01" }, controller.signal)).rejects.toThrow(/aborted before sending/);
    expect(clients.sent).toHaveLength(0);
  });

  it("post sends FindingsBoard.post with the estimate × 1.2, refusing above OPERATOR_REPORT_GAS_CAP", async () => {
    const deployment = { ...DEPLOYMENTS[10143], findingsBoard: { address: BOARD, fromBlock: 1n } };
    const ok = fakeClients(100_000n);
    const port = viemInboxPort({ ...ok, deployment }) as InboxPort;
    const request = { requestHash: keccak256(toHex("r")), agentId: 1984n, envelope: "0x01" as Hex };
    expect(await port.post(request)).toEqual({ txHash: keccak256(toHex("tx")), blockNumber: 99n, gasLimit: 120_000n });
    expect(ok.sent[0]).toMatchObject({ address: BOARD, functionName: "post", args: [request.requestHash, 1984n, "0x01"], gas: 120_000n, nonce: 5 });

    const tooBig = fakeClients(OPERATOR_REPORT_GAS_CAP + 1n);
    const refusing = viemInboxPort({ ...tooBig, deployment }) as InboxPort;
    await expect(refusing.post(request)).rejects.toThrow(/above the explicit gas limit/);
    expect(tooBig.sent).toHaveLength(0);
  });
});
