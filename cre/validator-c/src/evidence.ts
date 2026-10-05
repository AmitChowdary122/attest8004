import { keccak256, stringToBytes, type Hex } from "viem";
import { z } from "zod";
import { canonicalJson, encodeCanonicalJsonDataUri } from "../../../packages/sdk/src/canonical.ts";
import type { RequestJsonV1 } from "../../../packages/sdk/src/request.ts";
import { MANDATE_V1 } from "../../../validators/mandate/src/params.ts";
import { EVIDENCE_SCHEMA_V1 } from "./mirrored.ts";

const doneSchema = z.strictObject({
  status: z.literal("done"),
  score: z.number().int().min(0).max(100),
  reasons: z.array(z.string()),
  evidence: z.string(),
  evidenceHash: z.string().regex(/^0x[0-9a-f]{64}$/),
});
const bodySchema = z.discriminatedUnion("status", [
  doneSchema,
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({ status: z.literal("declined"), code: z.string(), detail: z.string() }),
]);

/** A 200 body from /evaluate (validators/mandate/src/evaluate-http.ts). */
export type EvaluateBody =
  | { status: "done"; score: number; reasons: string[]; evidence: string; evidenceHash: Hex }
  | { status: "pending" }
  | { status: "declined"; code: string; detail: string };

/** One /evaluate reply: a body; a retry for 503 (unavailable or busy); or an error for anything else. */
export function parseEvaluateBody(statusCode: number, body: string): EvaluateBody | { retry: true } | { error: string } {
  if (statusCode === 503) return { retry: true };
  if (statusCode !== 200) return { error: `/evaluate answered HTTP ${statusCode}` };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { error: "/evaluate's body is not JSON" };
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return { error: "/evaluate's body has an unexpected shape" };
  return parsed.data as EvaluateBody;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Checks /evaluate's `done` answer against the facts the workflow read itself, before anything is written:
 *
 * 1. at most `maxBytes` (CRE's consensus limit), canonical JSON exactly (so its bytes are the ones verify rebuilds),
 *    and hashing to the service's `evidenceHash`;
 * 2. a mandate-v1 evidence document for this requestHash whose score and reasons are the answer's;
 * 3. pinned at the block the workflow read: number, hash and time;
 * 4. evaluating the request the trigger carried: its block, chain, gate, agent, target, value, data hash, deadline
 *    and salt.
 *
 * Returns the score and the response the workflow will post: `responseURI` (a base64 data: URI of the exact bytes)
 * and `responseHash` (their keccak256), both computed here. Otherwise the first problem, a fixed code.
 */
export function checkEvidence(
  body: Extract<EvaluateBody, { status: "done" }>,
  expect: { requestHash: Hex; requestBlock: bigint; json: RequestJsonV1; pin: { number: bigint; hash: Hex; timestamp: bigint }; maxBytes: number },
): { score: number; responseURI: string; responseHash: Hex } | { problem: string } {
  const bytes = stringToBytes(body.evidence);
  if (bytes.length > expect.maxBytes) return { problem: "EVIDENCE_TOO_LARGE" };
  let doc: unknown;
  try {
    doc = JSON.parse(body.evidence);
    if (canonicalJson(doc) !== body.evidence) return { problem: "NOT_CANONICAL" };
  } catch {
    return { problem: "NOT_CANONICAL" };
  }
  const hash = keccak256(bytes);
  if (hash !== body.evidenceHash) return { problem: "HASH_CLAIM_MISMATCH" };
  if (!isRecord(doc) || !isRecord(doc.block) || !isRecord(doc.request)) return { problem: "BODY_MISMATCH:shape" };

  const top: Array<[string, unknown, unknown]> = [
    ["schema", doc.schema, EVIDENCE_SCHEMA_V1],
    ["validator", doc.validator, MANDATE_V1.tag],
    ["requestHash", doc.requestHash, expect.requestHash.toLowerCase()],
    ["score", doc.score, body.score],
    ["reasons", JSON.stringify(doc.reasons), JSON.stringify(body.reasons)],
  ];
  for (const [key, got, want] of top) if (got !== want) return { problem: `BODY_MISMATCH:${key}` };

  const block = doc.block;
  const pinFields: Array<[string, unknown, string]> = [
    ["number", block.number, expect.pin.number.toString()],
    ["hash", block.hash, expect.pin.hash.toLowerCase()],
    ["timestamp", block.timestamp, expect.pin.timestamp.toString()],
  ];
  for (const [key, got, want] of pinFields) if (got !== want) return { problem: `PIN_MISMATCH:${key}` };

  const request = doc.request;
  const { json } = expect;
  const requestFields: Array<[string, unknown, unknown]> = [
    ["block", request.block, expect.requestBlock.toString()],
    ["chainId", request.chainId, json.chainId],
    ["gate", request.gate, json.gate],
    ["agentId", request.agentId, json.agentId],
    ["target", request.target, json.action.target],
    ["value", request.value, json.action.value],
    ["dataHash", request.dataHash, keccak256(json.action.data)],
    ["deadline", request.deadline, json.action.deadline],
    ["salt", request.salt, json.action.salt.toLowerCase()],
  ];
  for (const [key, got, want] of requestFields) if (got !== want) return { problem: `REQUEST_MISMATCH:${key}` };

  const { uri, hash: posted } = encodeCanonicalJsonDataUri(doc);
  if (posted !== hash) return { problem: "NOT_CANONICAL" };
  return { score: body.score, responseURI: uri, responseHash: hash };
}
