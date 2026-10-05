import { deploymentsFor } from "@attest8004/sdk";
import type { Address, PublicClient } from "viem";
import { evaluateAtPin } from "./evaluate.ts";
import { HOLD_MS, startEvaluateServer } from "./evaluate-http.ts";
import { EvaluateJobs } from "./evaluate-jobs.ts";
import { viemMandateReader } from "./reader.ts";
import type { ServedGate } from "./validator.ts";
import { verifyContextFor } from "./verify.ts";

/** JSON-RPC requests the evaluation reader keeps in flight at once, as validator A's. */
const READER_CONCURRENCY = 8;

/**
 * The read-only `/evaluate` service for validator C (P11): a mandate reader over `publicClient` (whose transport
 * should be rate-limited), the memoized long-poll jobs, and the HTTP server on 127.0.0.1:`port`. It answers only for
 * validator C (`DEPLOYMENTS[chainId].validators.creMandateV1`) and the given (gate, agent) pairs. Used by
 * evaluate-main.ts and, in-process, by `pnpm cre:demo`.
 */
export async function startEvaluateService(o: {
  publicClient: PublicClient;
  chainId: number;
  gates: readonly ServedGate[];
  port: number;
  holdMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}): Promise<{ host: string; port: number; validator: Address; close(): Promise<void> }> {
  const context = verifyContextFor(o.chainId);
  const validator = deploymentsFor(o.chainId).validators.creMandateV1;
  const reader = viemMandateReader({ publicClient: o.publicClient, contracts: context.contracts, concurrency: READER_CONCURRENCY });
  const jobs = new EvaluateJobs({
    evaluate: (requestHash, pinnedBlock) => evaluateAtPin({ reader, context, validator, gates: o.gates, requestHash, pinnedBlock }),
    finalized: async () => (await reader.finalized()).number,
    log: o.log,
  });
  const server = await startEvaluateServer({ jobs, port: o.port, validator, holdMs: o.holdMs ?? HOLD_MS, log: o.log });
  return { ...server, validator };
}
