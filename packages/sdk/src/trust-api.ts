// The Envio trust API (SPEC §4.8, ARCHITECTURE §5.7): read indexed requests, verdicts, validator stats, agents and
// operator reports over GraphQL, then re-check what matters from the chain. Browser-safe: fetch, zod and viem only.
//
// The indexer is a convenience, never a trust root. Its answers are untrusted data: every response is validated
// (hex as hex, codes as codes, numbers as integers; a validator's free-text tag is made printable and short), every
// result carries its onchain anchors (requestHash, transaction, log index, block), and confirmIndexedVerdict /
// confirmIndexedReport re-check a result from chain reads. One GraphQL request per call: Envio Cloud's free plan
// serves 100 queries a minute.
import { decodeEventLog, getAddress, zeroHash, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { z } from "zod";
import { findingsPostedEvent, validationRegistryAbi } from "./abi.ts";
import { deploymentsFor, mandateRegistryAt, type Deployment } from "./deployments.ts";
import type { FindingsPost } from "./inbox-read.ts";

export type TrustApiErrorKind = "NOT_CONFIGURED" | "NETWORK" | "HTTP" | "RATE_LIMITED" | "TIMEOUT" | "GRAPHQL" | "SHAPE";

/** Why a trust API call failed. Its message is plain text, safe to show as text. */
export class TrustApiError extends Error {
  readonly kind: TrustApiErrorKind;

  constructor(kind: TrustApiErrorKind, message: string) {
    super(message);
    this.name = "TrustApiError";
    this.kind = kind;
  }
}

export interface TrustApiOptions {
  /** The GraphQL endpoint; defaults to `DEPLOYMENTS[chainId].trustApi.graphqlUrl`. */
  url?: string;
  /** Defaults to Monad testnet (10143). */
  chainId?: number;
  fetchImpl?: typeof fetch;
  /** Abort after this long; defaults to {@link TRUST_API_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export const TRUST_API_TIMEOUT_MS = 10_000;
/** The most request hashes one {@link findIndexedReports} call may ask about. */
export const MAX_REPORT_REQUEST_HASHES = 50;
/** The most posts one {@link findIndexedReports} call returns. */
export const MAX_INDEXED_REPORTS = 200;
/** How many of a validator's free-text tag characters are shown. */
export const MAX_TAG_DISPLAY = 64;

// ---------- the documents ----------

const VERDICT_FIELDS = `id agentId validator requestBlock requestTime requestTx requestStatus gate target value deadline actionHash
  responses score tag responseHash reasons evidenceStatus responseBlock responseTime responseTx firstResponseBlock executedTx executedBlock`;
const META = (chainId: number) => `_meta(where: {chainId: {_eq: ${chainId}}}) { chainId progressBlock isReady }`;

/** The GraphQL documents the SDK sends (exported so the indexer's tests check every field exists in its schema). */
export const TRUST_API_QUERIES = {
  agentTrust: `query AgentTrust($id: String!) {
  Agent_by_pk(id: $id) { id owner firstSeenBlock hotKey hotKeyOwner }
  AgentTrustSummary_by_pk(id: $id) { requests answered executed trustedReports untrustedReports permissionChanges lastPermissionChangeBlock lastActivityBlock }
  AgentTagSummary(where: {agentId: {_eq: $id}}, order_by: {tag: asc}, limit: 20) { tag verdicts scoreSum avgScore zeroScores fullScores lastScore lastRequestHash lastResponseBlock }
  Mandate(where: {agentId: {_eq: $id}}, limit: 10) { registry mandateHash owner allowedTargets allowedSelectors maxValuePerTx maxValuePerDay validUntil setAtBlock active changedBlock changedTx }
  Passkey(where: {agentId: {_eq: $id}}, limit: 10) { registry qx qy owner block tx }
  InboxKey(where: {agentId: {_eq: $id}}, limit: 10) { registry x25519Pub owner changes block tx }
  ValidationRequest(where: {agentId: {_eq: $id}}, order_by: {requestBlock: desc}, limit: 20) { ${VERDICT_FIELDS} }
  PermissionEvent(where: {agentId: {_eq: $id}}, order_by: {block: desc}, limit: 20) { kind source inEpoch from to approved mandateHash block time tx logIndex }
  ${META(10143)}
}`,
  overview: `query TrustOverview {
  mandateV1: ValidationRequest(where: {tag: {_eq: "mandate-v1"}}, order_by: {responseBlock: desc}, limit: 20) { ${VERDICT_FIELDS} }
  riskV1: ValidationRequest(where: {tag: {_eq: "risk-v1"}}, order_by: {responseBlock: desc}, limit: 20) { ${VERDICT_FIELDS} }
  pending: ValidationRequest(where: {responses: {_eq: 0}}, order_by: {requestBlock: desc}, limit: 10) { ${VERDICT_FIELDS} }
  Validator(order_by: {requests: desc}, limit: 50) { id requests answered responseEvents scoreSum avgScore score0 score1to39 score40to79 score80to99 score100 latencyBlocksSum latencyCount avgLatencyBlocks tags firstSeenBlock lastActivityBlock }
  AgentTrustSummary(order_by: {lastActivityBlock: desc}, limit: 200) { id }
  ${META(10143)}
}`,
  findReports: `query FindReports($where: FindingsPost_bool_exp!, $limit: Int!) {
  FindingsPost(where: $where, order_by: {block: asc}, limit: $limit) { requestHash agentId validator envelope block tx logIndex trusted trustProblem }
  ${META(10143)}
}`,
} as const;

// ---------- validation ----------

/** Any text a validator chose (its tag): printable ASCII only (anything else becomes "?"), at most `max` characters. */
export function displayText(text: string, max: number = MAX_TAG_DISPLAY): string {
  const printable = text.replace(/[^\x20-\x7e]/g, "?");
  return printable.length > max ? `${printable.slice(0, max)}…` : printable;
}

const decimal = z
  .string()
  .regex(/^(0|[1-9]\d{0,77})$/)
  .refine((s) => BigInt(s) < 2n ** 256n);
/** A uint256 the indexer stores as a decimal string. */
const uint = decimal.transform((s) => BigInt(s));
/** A BigInt column: Hasura serialises it as a decimal string, or as a JSON number when it fits. */
const bigintLike = z
  .union([decimal, z.number().int().min(-1).refine(Number.isSafeInteger)])
  .transform((v) => BigInt(v));
const count = z.number().int().min(0).max(2 ** 31 - 1);
const floatLike = z
  .union([z.number(), z.string().regex(/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/)])
  .transform(Number)
  .refine(Number.isFinite);
const hex32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((s) => s.toLowerCase() as Hex);
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => getAddress(s));
const hexBytes = z
  .string()
  .max(2 + 2 * 8192)
  .regex(/^0x([0-9a-fA-F]{2})*$/)
  .transform((s) => s.toLowerCase() as Hex);
const selector = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/)
  .transform((s) => s.toLowerCase() as Hex);
const reason = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const tag = z
  .string()
  .max(100_000)
  .transform((s) => displayText(s));
const score = z.number().int().min(0).max(100);
const decodeStatus = z.enum(["VERIFIED", "HASH_MISMATCH", "NOT_INLINE", "UNREADABLE"]);
const permissionKind = z.enum(["TRANSFER", "APPROVAL", "APPROVAL_FOR_ALL", "AGENT_KEY_SET", "MANDATE_SET", "MANDATE_REVOKED", "PASSKEY_SET", "PASSKEY_ROTATED"]);
const trustProblem = z.enum(["NO_REQUEST", "WRONG_VALIDATOR", "WRONG_AGENT"]);

export type DecodeStatus = z.infer<typeof decodeStatus>;
export type PermissionKind = z.infer<typeof permissionKind>;
export type IndexedTrustProblem = z.infer<typeof trustProblem>;

const verdictRow = z
  .object({
    id: hex32,
    agentId: uint,
    validator: address,
    requestBlock: bigintLike,
    requestTime: bigintLike,
    requestTx: hex32,
    requestStatus: decodeStatus,
    gate: address.nullable(),
    target: address.nullable(),
    value: uint.nullable(),
    deadline: bigintLike.nullable(),
    actionHash: hex32.nullable(),
    responses: count,
    score: score.nullable(),
    tag: tag.nullable(),
    responseHash: hex32.nullable(),
    reasons: z.array(reason).max(16).nullable(),
    evidenceStatus: decodeStatus.nullable(),
    responseBlock: bigintLike.nullable(),
    responseTime: bigintLike.nullable(),
    responseTx: hex32.nullable(),
    firstResponseBlock: bigintLike.nullable(),
    executedTx: hex32.nullable(),
    executedBlock: bigintLike.nullable(),
  })
  .transform(({ id, ...rest }) => ({ requestHash: id, ...rest }));

/** One request as the indexer has it, with its latest verdict (null fields while it is unanswered). */
export type IndexedVerdict = z.infer<typeof verdictRow>;

const validatorRow = z
  .object({
    id: address,
    requests: count,
    answered: count,
    responseEvents: count,
    scoreSum: bigintLike,
    avgScore: floatLike.nullable(),
    score0: count,
    score1to39: count,
    score40to79: count,
    score80to99: count,
    score100: count,
    latencyBlocksSum: bigintLike,
    latencyCount: count,
    avgLatencyBlocks: floatLike.nullable(),
    tags: z.array(tag).max(64),
    firstSeenBlock: bigintLike,
    lastActivityBlock: bigintLike,
  })
  .transform(({ id, score0, score1to39, score40to79, score80to99, score100, ...rest }) => ({
    validator: id,
    buckets: { score0, score1to39, score40to79, score80to99, score100 },
    ...rest,
  }));

/** A validator's indexed stats: buckets and the average over each answered request's latest score; latency in blocks. */
export type ValidatorStats = z.infer<typeof validatorRow>;

const mandateRow = z.object({
  registry: address,
  mandateHash: hex32,
  owner: address,
  allowedTargets: z.array(address).max(16),
  allowedSelectors: z.array(selector).max(16),
  maxValuePerTx: uint,
  maxValuePerDay: uint,
  validUntil: bigintLike,
  setAtBlock: bigintLike,
  active: z.boolean(),
  changedBlock: bigintLike,
  changedTx: hex32,
});
export type IndexedMandate = z.infer<typeof mandateRow>;

const passkeyRow = z.object({ registry: address, qx: hex32, qy: hex32, owner: address, block: bigintLike, tx: hex32 });
const inboxKeyRow = z.object({ registry: address, x25519Pub: hex32, owner: address, changes: count, block: bigintLike, tx: hex32 });

const permissionRow = z.object({
  kind: permissionKind,
  source: address,
  inEpoch: z.boolean(),
  from: address.nullable(),
  to: address.nullable(),
  approved: z.boolean().nullable(),
  mandateHash: hex32.nullable(),
  block: bigintLike,
  time: bigintLike,
  tx: hex32,
  logIndex: count,
});
export type IndexedPermissionEvent = z.infer<typeof permissionRow>;

const tagRow = z.object({
  tag,
  verdicts: count,
  scoreSum: bigintLike,
  avgScore: floatLike.nullable(),
  zeroScores: count,
  fullScores: count,
  lastScore: score.nullable(),
  lastRequestHash: hex32.nullable(),
  lastResponseBlock: bigintLike.nullable(),
});
export type AgentTagStats = z.infer<typeof tagRow>;

const summaryRow = z.object({
  requests: count,
  answered: count,
  executed: count,
  trustedReports: count,
  untrustedReports: count,
  permissionChanges: count,
  lastPermissionChangeBlock: bigintLike.nullable(),
  lastActivityBlock: bigintLike,
});

const metaRows = z.array(z.object({ chainId: z.number().int(), progressBlock: bigintLike, isReady: z.boolean() })).max(16);

const postRow = z
  .object({
    requestHash: hex32,
    agentId: uint,
    validator: address,
    envelope: hexBytes,
    block: bigintLike,
    tx: hex32,
    logIndex: count,
    trusted: z.boolean(),
    trustProblem: trustProblem.nullable(),
  })
  .transform(({ block, tx, ...rest }) => ({ ...rest, blockNumber: block, txHash: tx as Hash }));

/** An indexed FindingsPosted post, with the indexer's trust flag; re-check it with {@link confirmIndexedReport}. */
export type IndexedReport = FindingsPost & { trusted: boolean; trustProblem: IndexedTrustProblem | null };

// ---------- transport ----------

function urlFor(o: TrustApiOptions): string {
  if (o.url !== undefined) return o.url;
  const chainId = o.chainId ?? 10143;
  const url = deploymentsFor(chainId).trustApi?.graphqlUrl;
  if (url === undefined) throw new TrustApiError("NOT_CONFIGURED", `no trust API is recorded for chain ${chainId}`);
  return url;
}

/** One GraphQL POST, validated with `schema`. Throws {@link TrustApiError} on every failure. */
async function query<T>(o: TrustApiOptions, document: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const url = urlFor(o);
  const fetchImpl = o.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? TRUST_API_TIMEOUT_MS);
  let body: unknown;
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: document, variables }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) throw new TrustApiError("TIMEOUT", "the indexer didn't answer in time");
      throw new TrustApiError("NETWORK", "the indexer couldn't be reached");
    }
    if (response.status === 429) throw new TrustApiError("RATE_LIMITED", "the indexer is rate-limited (100 queries a minute on Envio's free plan)");
    if (!response.ok) throw new TrustApiError("HTTP", `the indexer answered HTTP ${response.status}`);
    try {
      body = await response.json();
    } catch {
      if (controller.signal.aborted) throw new TrustApiError("TIMEOUT", "the indexer didn't answer in time");
      throw new TrustApiError("SHAPE", "the indexer's answer isn't JSON");
    }
  } finally {
    clearTimeout(timer);
  }
  if (typeof body === "object" && body !== null && Array.isArray((body as { errors?: unknown }).errors)) {
    const first = (body as { errors: unknown[] }).errors[0] as { message?: unknown } | undefined;
    throw new TrustApiError("GRAPHQL", `the indexer refused the query: ${displayText(typeof first?.message === "string" ? first.message : "unknown error", 200)}`);
  }
  const parsed = schema.safeParse((body as { data?: unknown } | null)?.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new TrustApiError("SHAPE", `the indexer's answer doesn't have the expected shape (${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid"})`);
  }
  return parsed.data;
}

function indexedTo(meta: z.infer<typeof metaRows>, chainId: number): bigint {
  const row = meta.find((m) => m.chainId === chainId);
  if (!row) throw new TrustApiError("SHAPE", `the indexer reports no progress for chain ${chainId}`);
  return row.progressBlock;
}

// ---------- reads ----------

export interface AgentTrust {
  agentId: bigint;
  /** The agent's owner in the Identity Registry, as last indexed; null if never seen. */
  owner: Address | null;
  firstSeenBlock: bigint;
  hotKey: Address | null;
  /** The passkey, inbox key and mandate on the MandateRegistry valid at `indexedTo`. */
  passkey: z.infer<typeof passkeyRow> | null;
  inboxKey: z.infer<typeof inboxKeyRow> | null;
  mandate: IndexedMandate | null;
  summary: z.infer<typeof summaryRow>;
  tags: AgentTagStats[];
  /** The 20 newest requests, newest first, each with its latest verdict. */
  recentVerdicts: IndexedVerdict[];
  /** The 20 newest permission events, newest first. */
  recentPermissionEvents: IndexedPermissionEvent[];
  /** The block the indexer has processed up to. */
  indexedTo: bigint;
}

const agentTrustData = z.object({
  Agent_by_pk: z.object({ id: uint, owner: address.nullable(), firstSeenBlock: bigintLike, hotKey: address.nullable(), hotKeyOwner: address.nullable() }).nullable(),
  AgentTrustSummary_by_pk: summaryRow.nullable(),
  AgentTagSummary: z.array(tagRow).max(20),
  Mandate: z.array(mandateRow).max(10),
  Passkey: z.array(passkeyRow).max(10),
  InboxKey: z.array(inboxKeyRow).max(10),
  ValidationRequest: z.array(verdictRow).max(20),
  PermissionEvent: z.array(permissionRow).max(20),
  _meta: metaRows,
});

/**
 * An agent's indexed trust record, or null when the indexer has never seen the agent. Every verdict and event in it
 * names its transaction; re-check a verdict with {@link confirmIndexedVerdict} or `pnpm attest8004 verify`.
 */
export async function getAgentTrust(agentId: bigint, o: TrustApiOptions = {}): Promise<AgentTrust | null> {
  const chainId = o.chainId ?? 10143;
  const data = await query(o, TRUST_API_QUERIES.agentTrust, { id: agentId.toString() }, agentTrustData);
  const head = indexedTo(data._meta, chainId);
  const agent = data.Agent_by_pk;
  if (agent === null) return null;
  if (data.AgentTrustSummary_by_pk === null) throw new TrustApiError("SHAPE", `the indexer has agent ${agentId} but no summary for it`);
  const registry = registryAt(deploymentsFor(chainId), head);
  const onRegistry = <T extends { registry: Address }>(rows: T[]) => rows.find((r) => r.registry === registry) ?? null;
  return {
    agentId: agent.id,
    owner: agent.owner,
    firstSeenBlock: agent.firstSeenBlock,
    hotKey: agent.hotKey,
    passkey: onRegistry(data.Passkey),
    inboxKey: onRegistry(data.InboxKey),
    mandate: onRegistry(data.Mandate),
    summary: data.AgentTrustSummary_by_pk,
    tags: data.AgentTagSummary,
    recentVerdicts: data.ValidationRequest,
    recentPermissionEvents: data.PermissionEvent,
    indexedTo: head,
  };
}

function registryAt(deployment: Deployment, block: bigint): Address | null {
  try {
    return getAddress(mandateRegistryAt(deployment, block).address);
  } catch {
    return null;
  }
}

export interface TrustOverview {
  /** The newest `mandate-v1` and `risk-v1` verdicts (20 of each), newest response first. */
  verdicts: IndexedVerdict[];
  /** The 10 newest unanswered requests. */
  pending: IndexedVerdict[];
  validators: ValidatorStats[];
  /** The ids of agents that appeared in our contracts, most recently active first (at most 200). */
  agents: bigint[];
  agentsTruncated: boolean;
  indexedTo: bigint;
}

const overviewData = z.object({
  mandateV1: z.array(verdictRow).max(20),
  riskV1: z.array(verdictRow).max(20),
  pending: z.array(verdictRow).max(10),
  Validator: z.array(validatorRow).max(50),
  AgentTrustSummary: z.array(z.object({ id: uint })).max(200),
  _meta: metaRows,
});

/** The dashboard's overview: recent verdicts for both tags, pending requests, validator stats and the agents seen. */
export async function getTrustOverview(o: TrustApiOptions = {}): Promise<TrustOverview> {
  const data = await query(o, TRUST_API_QUERIES.overview, {}, overviewData);
  const newest = (v: IndexedVerdict) => v.responseBlock ?? v.requestBlock;
  return {
    verdicts: [...data.mandateV1, ...data.riskV1].sort((a, b) => (newest(a) === newest(b) ? 0 : newest(a) > newest(b) ? -1 : 1)),
    pending: data.pending,
    validators: data.Validator,
    agents: data.AgentTrustSummary.map((a) => a.id),
    agentsTruncated: data.AgentTrustSummary.length === 200,
    indexedTo: indexedTo(data._meta, o.chainId ?? 10143),
  };
}

const reportsData = z.object({ FindingsPost: z.array(postRow).max(MAX_INDEXED_REPORTS), _meta: metaRows });

/**
 * Findings discovery: indexed FindingsPosted posts for an agent and/or a set of requests, trusted or not, each with the
 * indexer's flag and its anchors. A post's `trusted` is the indexer's view; re-check one with
 * {@link confirmIndexedReport} before relying on it (`/inbox` re-checks every post it shows).
 */
export async function findIndexedReports(
  o: TrustApiOptions & { agentId?: bigint; requestHashes?: readonly Hex[]; limit?: number },
): Promise<{ reports: IndexedReport[]; indexedTo: bigint }> {
  const hashes = o.requestHashes?.map((h) => h.toLowerCase());
  if (hashes && hashes.length > MAX_REPORT_REQUEST_HASHES) throw new RangeError(`at most ${MAX_REPORT_REQUEST_HASHES} request hashes per call, got ${hashes.length}`);
  if (hashes?.some((h) => !/^0x[0-9a-f]{64}$/.test(h))) throw new RangeError("every request hash must be 32 bytes of hex");
  const where: Record<string, unknown> = {};
  if (o.agentId !== undefined) where.agentId = { _eq: o.agentId.toString() };
  if (hashes !== undefined) where.requestHash = { _in: hashes };
  const limit = Math.min(o.limit ?? MAX_INDEXED_REPORTS, MAX_INDEXED_REPORTS);
  const data = await query(o, TRUST_API_QUERIES.findReports, { where, limit }, reportsData);
  return { reports: data.FindingsPost, indexedTo: indexedTo(data._meta, o.chainId ?? 10143) };
}

// ---------- re-checks from the chain ----------

export type VerdictProblem = "NOT_FOUND" | "VALIDATOR" | "AGENT" | "SCORE" | "RESPONSE_HASH" | "TAG";

/**
 * Re-checks an indexed verdict against `getValidationStatus` now: the validator, the agent, and the latest score,
 * `responseHash` and tag (an unanswered request must still be unanswered). To re-run the verdict itself, use
 * `pnpm attest8004 verify <requestHash>`.
 */
export async function confirmIndexedVerdict(o: {
  publicClient: PublicClient;
  deployment: Pick<Deployment, "validationRegistry">;
  verdict: Pick<IndexedVerdict, "requestHash" | "agentId" | "validator" | "responses" | "score" | "responseHash" | "tag">;
}): Promise<{ ok: true } | { ok: false; problems: VerdictProblem[] }> {
  const { verdict } = o;
  const [validator, agentId, response, responseHash, tag] = await o.publicClient.readContract({
    address: getAddress(o.deployment.validationRegistry),
    abi: validationRegistryAbi,
    functionName: "getValidationStatus",
    args: [verdict.requestHash],
  });
  if (BigInt(validator) === 0n) return { ok: false, problems: ["NOT_FOUND"] };
  const answered = verdict.responses > 0;
  const problems: VerdictProblem[] = [];
  if (getAddress(validator) !== getAddress(verdict.validator)) problems.push("VALIDATOR");
  if (agentId !== verdict.agentId) problems.push("AGENT");
  if (response !== (answered ? verdict.score : 0)) problems.push("SCORE");
  if (responseHash.toLowerCase() !== (answered ? verdict.responseHash : zeroHash)?.toLowerCase()) problems.push("RESPONSE_HASH");
  if (displayText(tag) !== (answered ? verdict.tag : "")) problems.push("TAG");
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** A receipt log, as viem returns it. */
export interface ReceiptLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  logIndex: number;
}

/** Whether `logs` (a transaction receipt's) carry exactly this FindingsPosted post, from `board`, at its log index. */
export function postMatchesReceipt(post: FindingsPost, logs: readonly ReceiptLog[], board: Address): boolean {
  const log = logs.find((l) => l.logIndex === post.logIndex);
  if (!log || getAddress(log.address) !== getAddress(board) || log.topics.length === 0) return false;
  try {
    const { args } = decodeEventLog({ abi: [findingsPostedEvent], topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
    return (
      args.requestHash.toLowerCase() === post.requestHash.toLowerCase() &&
      args.agentId === post.agentId &&
      getAddress(args.validator) === getAddress(post.validator) &&
      args.envelope.toLowerCase() === post.envelope.toLowerCase()
    );
  } catch {
    return false;
  }
}

export type ReportProblem = "UNTRUSTED" | "NOT_ON_CHAIN";

/**
 * Re-checks an indexed post from the chain: SPEC §4.7's trust rule against `getValidationStatus` (it names this
 * validator and agent), then that its transaction's receipt carries exactly this post. The envelope's encryption
 * doesn't say who posted it; only the chain does.
 */
export async function confirmIndexedReport(o: {
  publicClient: PublicClient;
  deployment: Pick<Deployment, "validationRegistry" | "findingsBoard">;
  report: FindingsPost;
}): Promise<{ ok: true } | { ok: false; problems: ReportProblem[] }> {
  const { report } = o;
  if (o.deployment.findingsBoard === null) return { ok: false, problems: ["NOT_ON_CHAIN"] };
  const [validator, agentId] = await o.publicClient.readContract({
    address: getAddress(o.deployment.validationRegistry),
    abi: validationRegistryAbi,
    functionName: "getValidationStatus",
    args: [report.requestHash],
  });
  if (BigInt(validator) === 0n || getAddress(validator) !== getAddress(report.validator) || agentId !== report.agentId) return { ok: false, problems: ["UNTRUSTED"] };
  let logs: readonly ReceiptLog[];
  try {
    logs = (await o.publicClient.getTransactionReceipt({ hash: report.txHash })).logs;
  } catch (error) {
    if (error instanceof Error && error.name === "TransactionReceiptNotFoundError") return { ok: false, problems: ["NOT_ON_CHAIN"] };
    throw error;
  }
  return postMatchesReceipt(report, logs, o.deployment.findingsBoard.address) ? { ok: true } : { ok: false, problems: ["NOT_ON_CHAIN"] };
}
