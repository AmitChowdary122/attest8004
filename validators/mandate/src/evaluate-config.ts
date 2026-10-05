import { parseRequestsPerSecond } from "@attest8004/sdk";
import { parseGateList } from "./gates.ts";
import type { ServedGate } from "./validator.ts";

/** The read-only `/evaluate` service's settings (P11). It holds no key, so it reads none. */
export interface EvaluateConfig {
  /** Never logged: it can carry an API key. */
  rpcUrl: string;
  /** The RPC URL's host, the most of it the service logs. */
  rpcHost: string;
  /** The (gate, agent) pairs it answers for: validator A's allowlist, `MANDATE_V1_GATES`. */
  gates: ServedGate[];
  /** The port on 127.0.0.1. Validator C's workflow config names 8787. */
  port: number;
  /** Its RPC client's requests a second (the public RPC refuses more than 15 per IP). */
  rpcRequestsPerSecond: number;
}

export const EVALUATE_DEFAULTS = { port: 8787, rpcRequestsPerSecond: 7 } as const;

const PORT = /^[1-9][0-9]{0,4}$/;

/**
 * Reads `MONAD_TESTNET_RPC_URL`, `MANDATE_V1_GATES` (same parser and default as validator A), `CRE_EVALUATE_PORT`
 * and `CRE_EVALUATE_RPC_REQUESTS_PER_SECOND`, and nothing else; reports every problem at once, never echoing the RPC
 * URL. Blank values count as unset.
 */
export function parseEvaluateConfig(env: Record<string, string | undefined>): EvaluateConfig {
  const problems: string[] = [];
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };

  const rpcUrl = read("MONAD_TESTNET_RPC_URL");
  let rpcHost = "";
  if (rpcUrl === undefined) {
    problems.push("MONAD_TESTNET_RPC_URL is not set");
  } else {
    const url = URL.parse(rpcUrl);
    if (url === null || (url.protocol !== "https:" && url.protocol !== "http:") || url.host === "") {
      problems.push("MONAD_TESTNET_RPC_URL must be an http(s) URL");
    } else {
      rpcHost = url.host;
    }
  }

  const gates = parseGateList(read("MANDATE_V1_GATES"), problems);

  let port: number = EVALUATE_DEFAULTS.port;
  const portText = read("CRE_EVALUATE_PORT");
  if (portText !== undefined) {
    if (!PORT.test(portText) || Number(portText) > 65_535) {
      problems.push(`CRE_EVALUATE_PORT must be a port number from 1 to 65535, got "${portText}"`);
    } else {
      port = Number(portText);
    }
  }

  let rpcRequestsPerSecond: number = EVALUATE_DEFAULTS.rpcRequestsPerSecond;
  const rps = read("CRE_EVALUATE_RPC_REQUESTS_PER_SECOND");
  if (rps !== undefined) {
    const parsed = parseRequestsPerSecond(rps, "CRE_EVALUATE_RPC_REQUESTS_PER_SECOND");
    if (parsed.ok) rpcRequestsPerSecond = parsed.value;
    else problems.push(parsed.problem);
  }

  if (problems.length > 0) throw new Error(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
  return { rpcUrl: rpcUrl as string, rpcHost, gates, port, rpcRequestsPerSecond };
}
