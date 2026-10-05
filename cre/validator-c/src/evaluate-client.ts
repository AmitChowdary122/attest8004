import { bytesToHex, consensusIdenticalAggregation, cre, hexToBase64, type HTTPSendRequester, type Runtime } from "@chainlink/cre-sdk";
import { type Hex } from "viem";
import { canonicalJson } from "../../../packages/sdk/src/canonical.ts";
import type { WorkflowConfig } from "./config.ts";
import { parseEvaluateBody, type EvaluateBody } from "./evidence.ts";
import type { Decline } from "./request.ts";

/** What each node's HTTP call returns into consensus: the status code and the body's text. */
type HttpResult = { status: number; body: string };

/** A node whose call failed (timeout, refused): status 0, read as `pending`. Also the no-quorum default. */
const NO_ANSWER: HttpResult = { status: 0, body: "" };

/**
 * One POST /evaluate from one node. A call that fails returns {@link NO_ANSWER} instead of throwing, so consensus sees a
 * value from every node. The 9 s timeout sits under CRE's 10 s cap; the server holds ≤ 6 s.
 */
function postEvaluate(sender: HTTPSendRequester, url: string, timeout: string, body: string): HttpResult {
  try {
    const response = sender
      .sendRequest({
        url,
        method: "POST",
        timeout,
        multiHeaders: { "content-type": { values: ["application/json"] } },
        body: hexToBase64(bytesToHex(new TextEncoder().encode(body))),
      })
      .result();
    return { status: response.statusCode, body: new TextDecoder("utf-8", { fatal: true }).decode(response.body) };
  } catch {
    return NO_ANSWER;
  }
}

/**
 * Asks /evaluate for mandate-v1's verdict at the pin until it is `done` or `declined`, at most `pollAttempts` times.
 * Each round goes through identical-aggregation consensus: a deterministic validator gives every node the same bytes,
 * so the DON agrees on what /evaluate answered (it doesn't compute the score; verify's re-execution proves that).
 * A round without quorum, a failed call, `pending` and a 503 all mean "ask again"; any other status or shape throws.
 * Throws `EVALUATE_TIMEOUT` when the budget runs out. No `cacheSettings`: a cached `pending` would freeze the poll.
 */
export function pollEvaluate(
  runtime: Runtime<WorkflowConfig>,
  request: { requestHash: Hex; pinnedBlock: bigint },
): Extract<EvaluateBody, { status: "done" }> | Decline {
  const cfg = runtime.config;
  const http = new cre.capabilities.HTTPClient();
  const body = canonicalJson({ pinnedBlock: request.pinnedBlock, requestHash: request.requestHash });
  for (let attempt = 1; attempt <= cfg.pollAttempts; attempt++) {
    const result = http
      .sendRequest(runtime, postEvaluate, consensusIdenticalAggregation<HttpResult>().withDefault(NO_ANSWER))(cfg.evaluateUrl, cfg.httpTimeout, body)
      .result();
    if (result.status === 0) {
      runtime.log(`EVALUATE attempt ${attempt}: no answer`);
      continue;
    }
    const parsed = parseEvaluateBody(result.status, result.body);
    if ("error" in parsed) throw new Error(`EVALUATE_ERROR: ${parsed.error}`);
    if ("retry" in parsed || parsed.status === "pending") {
      runtime.log(`EVALUATE attempt ${attempt}: pending`);
      continue;
    }
    if (parsed.status === "declined") return { decline: parsed.code, detail: parsed.detail };
    runtime.log(`EVALUATE attempt ${attempt}: done, score ${parsed.score}, ${parsed.evidence.length} bytes of evidence`);
    return parsed;
  }
  throw new Error(`EVALUATE_TIMEOUT: /evaluate didn't finish within ${cfg.pollAttempts} polls`);
}
