// The hosted indexer's daily keep-alive (.github/workflows/indexer-keepalive.yml, plan addition 1): one small GraphQL
// query to DEPLOYMENTS[10143].trustApi.graphqlUrl, and the chain's head from the public RPC. It exits 1, loudly, when
// no indexer is recorded, the endpoint doesn't answer, it reports no Monad testnet progress, or it is more than a day
// behind. Envio's free plan deletes a deployment after 7 days without a query; each run is a query (the 30-day
// lifetime still applies: docs/deployments.md).
//
// Dependency-free, so the workflow runs it with plain `node` and no install: fetch, and the SDK's deployments file by
// path (it imports viem's types only, which Node's type stripping erases). No secrets.
import { pathToFileURL } from "node:url";
import { deploymentsFor } from "../../packages/sdk/src/deployments.ts";

/** A day of Monad testnet blocks at 0.305 s each. */
export const MAX_LAG_BLOCKS = 283_000n;
const CHAIN_ID = 10143;
const PUBLIC_RPC = "https://testnet-rpc.monad.xyz";
const TIMEOUT_MS = 20_000;

export type KeepAliveProblem = "NO_INDEXER_RECORDED" | "UNREACHABLE" | "NO_CHAIN" | "NO_HEAD" | "BEHIND";
type MetaRow = { chainId: number; progressBlock: number | string };
export type KeepAliveVerdict = { ok: true; progressBlock: bigint; lag: bigint } | { ok: false; problem: KeepAliveProblem; detail: string };

/** The verdict from what was read: `meta` is null when the indexer didn't answer, `head` when the RPC didn't. */
export function keepAliveVerdict(o: { url: string | null; meta: MetaRow[] | null; head: bigint | null }): KeepAliveVerdict {
  if (o.url === null) return { ok: false, problem: "NO_INDEXER_RECORDED", detail: "DEPLOYMENTS[10143].trustApi is null" };
  if (o.meta === null) return { ok: false, problem: "UNREACHABLE", detail: `${o.url} didn't answer the query` };
  const row = o.meta.find((m) => m.chainId === CHAIN_ID);
  if (!row) return { ok: false, problem: "NO_CHAIN", detail: `${o.url} reports no progress for chain ${CHAIN_ID}` };
  const progressBlock = BigInt(row.progressBlock);
  if (o.head === null) return { ok: false, problem: "NO_HEAD", detail: `the public RPC didn't give the head; the indexer is at block ${progressBlock}` };
  const lag = o.head > progressBlock ? o.head - progressBlock : 0n;
  if (lag > MAX_LAG_BLOCKS) return { ok: false, problem: "BEHIND", detail: `indexed to block ${progressBlock}, ${lag} blocks behind the head ${o.head} (more than a day)` };
  return { ok: true, progressBlock, lag };
}

async function post(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function main(): Promise<void> {
  const url = deploymentsFor(CHAIN_ID).trustApi?.graphqlUrl ?? null;
  let meta: MetaRow[] | null = null;
  let head: bigint | null = null;
  if (url !== null) {
    try {
      const answer = (await post(url, { query: "{ _meta { chainId progressBlock } }" })) as { data?: { _meta?: unknown } };
      if (Array.isArray(answer.data?._meta)) meta = answer.data._meta as MetaRow[];
    } catch (error) {
      console.error(`indexer query failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const answer = (await post(PUBLIC_RPC, { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] })) as { result?: unknown };
      if (typeof answer.result === "string" && /^0x[0-9a-f]+$/i.test(answer.result)) head = BigInt(answer.result);
    } catch (error) {
      console.error(`RPC head failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const verdict = keepAliveVerdict({ url, meta, head });
  if (verdict.ok) {
    console.log(`indexer OK: ${url} indexed to block ${verdict.progressBlock}, ${verdict.lag} blocks behind the head`);
    return;
  }
  console.log(`indexer PROBLEM ${verdict.problem}: ${verdict.detail}`);
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
