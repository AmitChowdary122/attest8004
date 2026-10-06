import { canonicalJson } from "@attest8004/sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Address, Hex } from "viem";
import { z } from "zod";
import type { EvaluateJobs, JobView } from "./evaluate-jobs.ts";
import { MANDATE_V1 } from "./params.ts";

/** `/evaluate` listens on loopback only; there is no setting to change it. */
export const EVALUATE_HOST = "127.0.0.1";
/** The largest request body read (`{"requestHash":"0x…64","pinnedBlock":"…"}` is about 110 bytes). */
export const MAX_BODY_BYTES = 1_024;
/** Past this a body isn't even drained: the connection is dropped. */
const DRAIN_LIMIT_BYTES = 65_536;
/** How long a POST waits for its job before answering `pending`: under CRE's 10 s HTTP cap with room to spare. */
export const HOLD_MS = 6_000;

const UINT64_LIMIT = 2n ** 64n;
const bodySchema = z.strictObject({
  requestHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 32 bytes of 0x-prefixed hex"),
  pinnedBlock: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/, "must be a decimal string without leading zeros")
    .refine((s) => /^(0|[1-9][0-9]*)$/.test(s) && BigInt(s) < UINT64_LIMIT, "must be below 2^64"),
});

/**
 * Starts the read-only `/evaluate` server for validator C's CRE workflow (P11, ARCHITECTURE §5.8) on 127.0.0.1:`port`
 * (0 picks a free one). Every body is canonical JSON, so the same answer is the same bytes on every call:
 *
 * - `GET /health` → 200 `{"ok":true,"tag":"mandate-v1","validator":<C>}`.
 * - `POST /evaluate` with `content-type: application/json` and exactly `{requestHash, pinnedBlock}` (bytes32 hex; a
 *   decimal string below 2^64) → 200 with the job's view (`done`, `declined` or `pending`), 503 for `unavailable` or
 *   `busy`.
 * - 400 `bad-request` for a body that isn't that, 413 above {@link MAX_BODY_BYTES}, 415 for another content type, 405
 *   for another method on either path, 404 elsewhere.
 */
export async function startEvaluateServer(o: {
  jobs: Pick<EvaluateJobs, "view">;
  port: number;
  validator: Address;
  holdMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}): Promise<{ host: string; port: number; close(): Promise<void> }> {
  const holdMs = o.holdMs ?? HOLD_MS;
  const log = o.log ?? (() => {});
  const server = createServer((req, res) => {
    // DNS rebinding (P12, AUD-11): a page whose name resolves to 127.0.0.1 is same-origin to its own host name, not
    // to ours, so only a request naming this exact loopback address and port is served.
    const port = (server.address() as AddressInfo).port;
    if (req.headers.host !== `${EVALUATE_HOST}:${port}` && req.headers.host !== `localhost:${port}`) {
      reply(res, 421, { status: "misdirected" });
      return;
    }
    handle(req, res, o.jobs, o.validator, holdMs, log).catch((error: unknown) => {
      log({ level: "error", msg: "request failed", error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) reply(res, 500, { status: "error" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, EVALUATE_HOST, () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    host: address.address,
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  jobs: Pick<EvaluateJobs, "view">,
  validator: Address,
  holdMs: number,
  log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  const path = (req.url ?? "").split("?")[0];
  if (path === "/health") {
    if (req.method !== "GET") return reply(res, 405, { status: "method-not-allowed" }, { allow: "GET" });
    return reply(res, 200, { ok: true, tag: MANDATE_V1.tag, validator });
  }
  if (path !== "/evaluate") return reply(res, 404, { status: "not-found" });
  if (req.method !== "POST") return reply(res, 405, { status: "method-not-allowed" }, { allow: "POST" });
  const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return reply(res, 415, { status: "unsupported-media-type" });

  const body = await readBody(req);
  if (body === null) return reply(res, 413, { status: "too-large" });
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return reply(res, 400, { problem: "the body is not JSON", status: "bad-request" });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const problem = issue ? `${issue.path.join(".") || "(body)"}: ${issue.message}` : "invalid body";
    return reply(res, 400, { problem, status: "bad-request" });
  }

  const requestHash = parsed.data.requestHash.toLowerCase() as Hex;
  const pinnedBlock = BigInt(parsed.data.pinnedBlock);
  const started = Date.now();
  const view: JobView = await jobs.view(requestHash, pinnedBlock, holdMs);
  log({ level: "info", msg: "evaluate", requestHash, pinnedBlock, status: view.status, ms: Date.now() - started });
  const status = view.status === "unavailable" || view.status === "busy" ? 503 : 200;
  return reply(res, status, view);
}

/** The body as text, or `null` when it is over {@link MAX_BODY_BYTES} (drained up to a limit, then dropped). */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > DRAIN_LIMIT_BYTES) {
        req.destroy();
        return;
      }
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = canonicalJson(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}
