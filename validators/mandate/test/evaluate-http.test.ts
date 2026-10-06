import { canonicalJson } from "@attest8004/sdk";
import { readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { getAddress, type Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import type { EvaluateOutcome } from "../src/evaluate.ts";
import { EvaluateJobs } from "../src/evaluate-jobs.ts";
import { EVALUATE_HOST, MAX_BODY_BYTES, startEvaluateServer } from "../src/evaluate-http.ts";

const C = getAddress("0x6d12f00870cb6eda2d8e389696f6b5d050423b95");
const H = `0x${"cd".repeat(32)}` as Hex;
const DONE: EvaluateOutcome = {
  status: "done",
  score: 0,
  reasons: ["TARGET_NOT_ALLOWED"],
  evidence: '{"a":"x\\"y","b":[1,2]}',
  evidenceHash: `0x${"ef".repeat(32)}`,
};

let server: { host: string; port: number; close(): Promise<void> } | undefined;
let evaluations = 0;

afterEach(async () => {
  await server?.close();
  server = undefined;
  evaluations = 0;
});

async function start(evaluate: (h: Hex, p: bigint) => Promise<EvaluateOutcome> = async () => DONE, holdMs = 200) {
  const jobs = new EvaluateJobs({
    evaluate: async (h, p) => {
      evaluations++;
      return evaluate(h, p);
    },
    finalized: async () => 10n ** 12n,
    pollMs: 1,
  });
  server = await startEvaluateServer({ jobs, port: 0, validator: C, holdMs });
  return server.port;
}

/** One raw HTTP exchange: `body` is sent as given (chunked when `chunked`), the reply read whole. */
function send(o: {
  port: number;
  method?: string;
  path?: string;
  body?: string;
  contentType?: string | null;
  chunked?: boolean;
  host?: string;
}): Promise<{ status: number; body: string; contentType: string | undefined }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (o.host !== undefined) headers.host = o.host;
    if (o.contentType !== null) headers["content-type"] = o.contentType ?? "application/json";
    if (o.body !== undefined && !o.chunked) headers["content-length"] = String(Buffer.byteLength(o.body));
    const req = request({ host: "127.0.0.1", port: o.port, method: o.method ?? "POST", path: o.path ?? "/evaluate", headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, contentType: res.headers["content-type"] }));
    });
    req.on("error", reject);
    if (o.body !== undefined) {
      if (o.chunked) for (let i = 0; i < o.body.length; i += 100) req.write(o.body.slice(i, i + 100));
      else req.write(o.body);
    }
    req.end();
  });
}

const ask = (port: number, payload: unknown) => send({ port, body: JSON.stringify(payload) });

describe("/evaluate over HTTP", () => {
  it("http_bindsLoopbackOnly: the server listens on 127.0.0.1", async () => {
    await start();
    expect(EVALUATE_HOST).toBe("127.0.0.1");
    expect(server?.host).toBe("127.0.0.1");
  });

  it("http_health: names the tag and the validator it answers for", async () => {
    const port = await start();
    const res = await send({ port, method: "GET", path: "/health" });
    expect(res.status).toBe(200);
    expect(res.body).toBe(`{"ok":true,"tag":"mandate-v1","validator":"${C}"}`);
  });

  it("http_doneBodyIsCanonical: the outcome as canonical JSON, byte-equal on every call", async () => {
    const port = await start();
    const first = await ask(port, { requestHash: H, pinnedBlock: "68438285" });
    const second = await ask(port, { requestHash: H, pinnedBlock: "68438285" });
    expect(first.status).toBe(200);
    expect(first.contentType).toBe("application/json");
    expect(first.body).toBe(
      `{"evidence":"{\\"a\\":\\"x\\\\\\"y\\",\\"b\\":[1,2]}","evidenceHash":"0x${"ef".repeat(32)}","reasons":["TARGET_NOT_ALLOWED"],"score":0,"status":"done"}`,
    );
    expect(canonicalJson(JSON.parse(first.body))).toBe(first.body);
    expect(second.body).toBe(first.body);
    expect(evaluations).toBe(1);
  });

  it("http_pendingWhileTheJobRuns, then done", async () => {
    const port = await start(() => new Promise((resolve) => setTimeout(() => resolve(DONE), 80)), 10);
    expect((await ask(port, { requestHash: H, pinnedBlock: "1" })).body).toBe('{"status":"pending"}');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(JSON.parse((await ask(port, { requestHash: H, pinnedBlock: "1" })).body).status).toBe("done");
  });

  it("http_unavailableIs503: a failed read is never a verdict", async () => {
    const port = await start(async () => {
      throw new Error("rpc down");
    });
    const res = await ask(port, { requestHash: H, pinnedBlock: "1" });
    expect(res.status).toBe(503);
    expect(res.body).toBe('{"status":"unavailable"}');
  });

  it("http_rejectsOversizedBody: 413 above 1,024 bytes, with or without a content-length", async () => {
    const port = await start();
    const big = JSON.stringify({ requestHash: H, pinnedBlock: "1", pad: "x".repeat(MAX_BODY_BYTES) });
    expect((await send({ port, body: big })).status).toBe(413);
    expect((await send({ port, body: big, chunked: true })).status).toBe(413);
    expect(evaluations).toBe(0);
  });

  it("http_rejectsExtraKeys and other shapes with 400, before any evaluation", async () => {
    const port = await start();
    for (const payload of [
      { requestHash: H, pinnedBlock: "1", extra: 1 },
      { requestHash: H },
      { requestHash: H, pinnedBlock: 1 },
      { requestHash: H, pinnedBlock: "01" },
      { requestHash: "0x1234", pinnedBlock: "1" },
      { requestHash: `0x${"zz".repeat(32)}`, pinnedBlock: "1" },
      { requestHash: H, pinnedBlock: "18446744073709551616" },
      [H, "1"],
    ]) {
      const res = await ask(port, payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      expect(JSON.parse(res.body).status).toBe("bad-request");
    }
    expect((await send({ port, body: "{not json" })).status).toBe(400);
    expect(evaluations).toBe(0);
  });

  it("parses the largest uint64 pin, and refuses it as one that can't finalize in time (503, P12 AUD-11)", async () => {
    const port = await start();
    const r = await ask(port, { requestHash: H, pinnedBlock: "18446744073709551615" });
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toEqual({ status: "unavailable" });
    expect(evaluations).toBe(0);
  });

  it("P12 AUD-11: a Host other than the loopback address and port is 421, before any evaluation (DNS rebinding)", async () => {
    const port = await start();
    const body = JSON.stringify({ requestHash: H, pinnedBlock: "7" });
    expect((await send({ port, body, host: `evil.example:${port}` })).status).toBe(421);
    expect((await send({ port, body, host: "127.0.0.1:1" })).status).toBe(421);
    expect((await send({ port, path: "/health", method: "GET", host: `rebind.example:${port}` })).status).toBe(421);
    expect(evaluations).toBe(0);
    expect((await send({ port, body, host: `localhost:${port}` })).status).toBe(200);
    expect((await send({ port, body, host: `127.0.0.1:${port}` })).status).toBe(200);
  });

  it("http_rejectsWrongContentType: 415", async () => {
    const port = await start();
    expect((await send({ port, body: JSON.stringify({ requestHash: H, pinnedBlock: "1" }), contentType: "text/plain" })).status).toBe(415);
    expect((await send({ port, body: JSON.stringify({ requestHash: H, pinnedBlock: "1" }), contentType: null })).status).toBe(415);
  });

  it("http_405_404: other methods and paths", async () => {
    const port = await start();
    expect((await send({ port, method: "GET" })).status).toBe(405);
    expect((await send({ port, method: "POST", path: "/health", body: "{}" })).status).toBe(405);
    expect((await send({ port, method: "GET", path: "/nope" })).status).toBe(404);
  });
});

describe("the /evaluate sources hold no key and send nothing", () => {
  it("evaluate_sourcesHaveNoSigningCalls", () => {
    const dir = new URL("../src/", import.meta.url);
    const files = readdirSync(dir).filter((f) => f.startsWith("evaluate"));
    expect(files.sort()).toEqual(["evaluate-config.ts", "evaluate-http.ts", "evaluate-jobs.ts", "evaluate-main.ts", "evaluate-service.ts", "evaluate.ts"]);
    for (const f of files) {
      const source = readFileSync(new URL(f, dir), "utf8");
      expect(source, f).not.toMatch(/privateKeyToAccount|createWalletClient|writeContract|sendTransaction|sendRawTransaction|PRIVATE_KEY/);
    }
  });
});
