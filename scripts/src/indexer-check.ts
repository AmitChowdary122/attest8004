// pnpm --filter @attest8004/scripts indexer-check [-- --url <graphql endpoint>]
//
// The Envio indexer against the chain (plan Task 7): read-only, and the indexer's acceptance check. For every agent
// the indexer knows (plus the demo agents), it compares the requests and their latest verdicts with
// getAgentValidations/getValidationStatus, the trusted reports with the chain search /inbox falls back to, and each of
// our validators' counts and score buckets with getValidatorRequests. Chain state is read at the indexer's progress
// block, so both sides describe the same moment. An indexed trusted report the chain search can't reach (posted more
// than 600 blocks after its verdict) is confirmed from its receipt instead.
//
// The URL: --url, else DEPLOYMENTS[10143].trustApi, else ENVIO_GRAPHQL_URL. Exit 0: everything matches; 1: a
// mismatch (listed); 2: it couldn't check (an RPC or indexer failure).
import { getAddress, type Address, type Hex } from "viem";
import {
  DEPLOYMENTS,
  confirmIndexedReport,
  findInboxEntries,
  findIndexedReports,
  getIndexedVerdicts,
  getTrustOverview,
  validationRegistryAbi,
  viemInboxReader,
  type Deployment,
  type IndexedReport,
  type IndexedVerdict,
  type TrustApiOptions,
  type ValidatorStats,
} from "@attest8004/sdk";
import { assertChain, publicClient } from "./common.ts";
import { compareAgent, compareValidator, type ChainStatus, type ChainValidatorView, type Mismatch } from "./indexer-compare.ts";

const deployment: Deployment = DEPLOYMENTS[10143];
const registry = getAddress(deployment.validationRegistry);

function urlFromArgs(argv: string[]): string | null {
  const i = argv.indexOf("--url");
  if (i >= 0) {
    const url = argv[i + 1];
    if (!url) throw new Error("--url needs a value");
    return url;
  }
  return deployment.trustApi?.graphqlUrl ?? process.env.ENVIO_GRAPHQL_URL ?? null;
}

async function statusesAt(hashes: readonly Hex[], at: bigint): Promise<ChainStatus[]> {
  if (hashes.length === 0) return [];
  const results = await publicClient.multicall({
    contracts: hashes.map((h) => ({ address: registry, abi: validationRegistryAbi, functionName: "getValidationStatus", args: [h] }) as const),
    allowFailure: false,
    blockNumber: at,
  });
  return results.map(([validator, agentId, response, responseHash, tag], i) => ({ requestHash: hashes[i] as Hex, validator: getAddress(validator), agentId, response, responseHash, tag }));
}

async function allVerdicts(api: TrustApiOptions, agentId: bigint): Promise<IndexedVerdict[]> {
  const out: IndexedVerdict[] = [];
  for (let offset = 0; ; offset += 200) {
    const { verdicts } = await getIndexedVerdicts({ ...api, agentId, limit: 200, offset });
    out.push(...verdicts);
    if (verdicts.length < 200) return out;
  }
}

const bucketOf = (score: number): keyof ValidatorStats["buckets"] =>
  score <= 0 ? "score0" : score < 40 ? "score1to39" : score < 80 ? "score40to79" : score < 100 ? "score80to99" : "score100";

async function checkAgent(api: TrustApiOptions, agentId: bigint, at: bigint): Promise<Mismatch[]> {
  const board = deployment.findingsBoard;
  const hashes = await publicClient.readContract({ address: registry, abi: validationRegistryAbi, functionName: "getAgentValidations", args: [agentId], blockNumber: at });
  const statuses = await statusesAt(hashes, at);
  const verdicts = (await allVerdicts(api, agentId)).filter((v) => v.requestBlock <= at);
  const chainReports =
    board === null
      ? []
      : (await findInboxEntries(viemInboxReader({ publicClient, deployment }), { agentId, findingsBoard: board, maxResponses: 1_000 })).flatMap((e) =>
          e.posts.filter((p) => p.blockNumber <= at),
        );
  // Each request's own validator's posts, 50 requests a query; an answer that hit its limit can't be compared.
  const indexedReports: IndexedReport[] = [];
  for (let i = 0; i < statuses.length; i += 50) {
    const requests = statuses.slice(i, i + 50).map((s) => ({ requestHash: s.requestHash, validator: s.validator }));
    const page = await findIndexedReports({ ...api, agentId, requests });
    if (page.truncated) throw new Error(`the indexer's report answer for agent ${agentId} hit its limit`);
    indexedReports.push(...page.reports.filter((r) => r.trusted && r.blockNumber <= at));
  }
  const mismatches = compareAgent(
    { agentId, statuses, trustedReports: chainReports.map((p) => ({ txHash: p.txHash, logIndex: p.logIndex })) },
    { agentId, verdicts, trustedReports: indexedReports.map((p) => ({ txHash: p.txHash, logIndex: p.logIndex })) },
  );
  // A trusted report the chain search can't reach (past its window) is confirmed from the chain directly.
  const reached = new Set(chainReports.map((p) => `${p.txHash.toLowerCase()}#${p.logIndex}`));
  for (const report of indexedReports.filter((r) => !reached.has(`${r.txHash.toLowerCase()}#${r.logIndex}`))) {
    const confirmed = await confirmIndexedReport({ publicClient, deployment, report });
    if (!confirmed.ok) mismatches.push({ what: `agent ${agentId}: report ${report.txHash}#${report.logIndex}`, chain: confirmed.problems.join(", "), indexer: "trusted" });
  }
  console.log(`agent ${agentId}: ${statuses.length} requests on chain, ${verdicts.length} indexed; ${chainReports.length} trusted report(s) on chain, ${indexedReports.length} indexed`);
  return mismatches;
}

async function checkValidator(validator: Address, indexed: ValidatorStats | null, at: bigint): Promise<Mismatch[]> {
  const hashes = await publicClient.readContract({ address: registry, abi: validationRegistryAbi, functionName: "getValidatorRequests", args: [validator], blockNumber: at });
  const statuses = await statusesAt(hashes, at);
  const answered = statuses.filter((s) => s.responseHash !== `0x${"00".repeat(32)}` || s.tag !== "");
  const view: ChainValidatorView = { validator, requests: statuses.length, answered: answered.length, buckets: { score0: 0, score1to39: 0, score40to79: 0, score80to99: 0, score100: 0 } };
  for (const s of answered) view.buckets[bucketOf(s.response)] += 1;
  console.log(`validator ${validator}: ${view.requests} requests, ${view.answered} answered on chain; indexed ${indexed ? `${indexed.requests}, ${indexed.answered}` : "none"}`);
  return compareValidator(view, indexed);
}

async function main(): Promise<number> {
  const url = urlFromArgs(process.argv.slice(2));
  if (url === null) {
    console.log("indexer-check: no GraphQL URL (pass --url, record DEPLOYMENTS[10143].trustApi, or set ENVIO_GRAPHQL_URL)");
    return 2;
  }
  const api: TrustApiOptions = { url };
  await assertChain();
  const overview = await getTrustOverview(api);
  const head = await publicClient.getBlockNumber();
  const at = overview.indexedTo < head ? overview.indexedTo : head;
  console.log(`indexer ${url}: indexed to block ${overview.indexedTo}; chain head ${head} (${head - overview.indexedTo} blocks behind); comparing at block ${at}`);

  const agents = [...new Set([...overview.agents, ...deployment.demoAgents, 1982n])].sort((a, b) => (a < b ? -1 : 1));
  const mismatches: Mismatch[] = [];
  for (const agentId of agents) mismatches.push(...(await checkAgent(api, agentId, at)));
  for (const validator of [deployment.validators.mandateV1, deployment.validators.riskV1].map((v) => getAddress(v))) {
    mismatches.push(...(await checkValidator(validator, overview.validators.find((v) => v.validator === validator) ?? null, at)));
  }

  if (mismatches.length === 0) {
    console.log(`indexer-check OK: ${agents.length} agents and both validators match the chain at block ${at}`);
    return 0;
  }
  console.log(`indexer-check: ${mismatches.length} mismatch(es)`);
  for (const m of mismatches) console.log(`  ${m.what}: chain ${m.chain}, indexer ${m.indexer}`);
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.log(`indexer-check couldn't check: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);
