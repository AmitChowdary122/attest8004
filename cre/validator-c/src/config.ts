import { getAddress, sha256, stringToBytes, stringToHex, type Hex } from "viem";
import { z } from "zod";

/** The workflow-name in workflow.yaml. CRE writes it into every report's metadata as {@link workflowNameBytes10}. */
export const WORKFLOW_NAME = "attest8004-validator-c";

/**
 * CRE's encoding of a workflow name in report metadata: the ASCII of the first 10 hex characters of sha256(name), as
 * bytes10 (the CRE docs' ReceiverTemplate; observed in the P11 spike). CreValidator's `workflowName()` holds this.
 */
export function workflowNameBytes10(name: string): Hex {
  return stringToHex(sha256(stringToBytes(name)).slice(2, 12));
}

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte hex address")
  .transform((s) => getAddress(s));
const count = z.number().int().nonnegative();

/**
 * The workflow's config (config.monad-testnet.json), checked when the workflow starts. `evaluateUrl` is loopback http
 * (simulation, P11) or https (a hosted service for a real DON, the production path); `pollAttempts` stays under CRE's
 * 15 HTTP calls per execution.
 */
export const workflowConfigSchema = z.strictObject({
  chainSelectorName: z.literal("monad-testnet"),
  chainId: z.literal(10143),
  validationRegistry: address,
  creValidator: address,
  forwarder: address,
  evaluateUrl: z
    .string()
    .refine((u) => /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/evaluate$/.test(u) || /^https:\/\/[^/\s]+\/evaluate$/.test(u), {
      message: "must be http://127.0.0.1:<port>/evaluate or an https URL ending in /evaluate",
    }),
  gates: z.array(z.strictObject({ gate: address, agentId: z.string().regex(/^(0|[1-9][0-9]*)$/) })).min(1),
  pinLagBlocks: count,
  maxEvidenceBytes: z.number().int().positive().max(20_000),
  pollAttempts: z.number().int().min(1).max(12),
  httpTimeout: z.string().regex(/^[1-9]s$/, "whole seconds below 10 (CRE's HTTP cap is 10 s)"),
  gas: z.strictObject({
    outerBase: count,
    outerPerByte: count,
    routing: count,
    headroomPercent: z.number().int().min(0).max(100),
    max: z.number().int().positive().max(10_000_000),
  }),
});

export type WorkflowConfig = z.output<typeof workflowConfigSchema>;
