/**
 * Fixture-backed `ChatClient`s so tests and `record-fixtures` never disagree on format (P5 plan
 * "Tests make zero network calls"): {@link RecordingChatClient} wraps a live client and captures
 * every call; {@link ReplayChatClient} answers from exactly that recording, in order, and refuses to
 * answer a call whose request doesn't match what was recorded there.
 *
 * Fixture shape: `{ host, steps: [{ requestHash, request, response }] }`. `response` is the
 * provider's raw response body (never headers, never the key) — the same thing
 * {@link import("./llm.ts").parseChatResponse} turns a live 200 response into a {@link ChatResponse},
 * so replay applies the exact same "no choices is transient" rule a live call would.
 */
import { canonicalJson } from "@attest8004/sdk";
import { keccak256, stringToBytes, type Hex } from "viem";
import type { ChatClient, ChatRequest, ChatResponse } from "./llm.ts";
import { parseChatResponse } from "./llm.ts";

export interface LlmFixtureStep {
  requestHash: Hex;
  request: ChatRequest;
  response: unknown;
}

export interface LlmFixture {
  host: string;
  steps: LlmFixtureStep[];
}

/**
 * Recursively replaces every non-integer finite number (e.g. a real request's `temperature: 0.2`)
 * with its decimal string, and drops an explicit `undefined` property — `canonicalJson` rejects
 * both (no floats; no undefined values) — so a request that still sends the real number over the
 * wire can still be hashed deterministically. Used only for the hash: the fixture's own `request`
 * field, and what's actually sent, keep the real numbers.
 */
function normalizeForHash(value: unknown): unknown {
  if (typeof value === "number") return Number.isInteger(value) ? value : value.toString();
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[key] = normalizeForHash(v);
    }
    return out;
  }
  return value;
}

/** `keccak256(canonicalJson(request))` over UTF-8 bytes, with floats normalised (see above). */
export function hashRequest(request: ChatRequest): Hex {
  return keccak256(stringToBytes(canonicalJson(normalizeForHash(request))));
}

/**
 * Thrown by {@link ReplayChatClient} when the next call's request doesn't match the recording, or
 * the recording is exhausted. Fix round 1, finding 6: the message now says which case it is and
 * carries enough to debug it without re-instrumenting — the expected and actual request hashes for
 * a changed request, or how many steps the fixture had when it ran out.
 */
export class FixtureMismatchError extends Error {
  readonly fixture: string;
  readonly step: number;
  readonly expectedHash: Hex | null;
  readonly actualHash: Hex | null;

  constructor(fixture: string, step: number, detail?: { expectedHash: Hex; actualHash: Hex } | { exhaustedAfter: number }) {
    let message: string;
    let expectedHash: Hex | null = null;
    let actualHash: Hex | null = null;
    if (detail !== undefined && "exhaustedAfter" in detail) {
      message = `fixture "${fixture}": exhausted after ${detail.exhaustedAfter} steps (no recorded step ${step})`;
    } else if (detail !== undefined) {
      expectedHash = detail.expectedHash;
      actualHash = detail.actualHash;
      message = `fixture "${fixture}": step ${step} expected request hash ${detail.expectedHash}, got ${detail.actualHash}`;
    } else {
      message = `fixture "${fixture}": no recorded step ${step} matches this request`;
    }
    super(message);
    this.name = "FixtureMismatchError";
    this.fixture = fixture;
    this.step = step;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/** Answers from a recorded {@link LlmFixture}, in order, instead of calling the network. */
export class ReplayChatClient implements ChatClient {
  readonly host: string;
  private readonly label: string;
  private readonly steps: LlmFixtureStep[];
  private index = 0;

  constructor(fixture: LlmFixture, label = "fixture") {
    this.host = fixture.host;
    this.steps = fixture.steps;
    this.label = label;
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const step = this.steps[this.index];
    if (step === undefined) throw new FixtureMismatchError(this.label, this.index, { exhaustedAfter: this.steps.length });
    const actualHash = hashRequest(request);
    if (actualHash !== step.requestHash) {
      throw new FixtureMismatchError(this.label, this.index, { expectedHash: step.requestHash, actualHash });
    }
    this.index++;
    return parseChatResponse(step.response);
  }
}

/** Wraps a live {@link ChatClient}, recording every call so {@link toFixture} can be written to disk. */
export class RecordingChatClient implements ChatClient {
  readonly host: string;
  private readonly live: ChatClient;
  private readonly steps: LlmFixtureStep[] = [];

  constructor(live: ChatClient) {
    this.live = live;
    this.host = live.host;
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.live.complete(request);
    // Fix round 1, finding 7: clone both, so a caller mutating a shared `messages` array (or the
    // live response body) after this call can't silently rewrite the recording.
    this.steps.push({
      requestHash: hashRequest(request),
      request: structuredClone(request),
      response: structuredClone(response.body),
    });
    return response;
  }

  /** Everything recorded so far, in the exact shape `record-fixtures` writes to disk. */
  toFixture(): LlmFixture {
    return { host: this.host, steps: this.steps };
  }
}
