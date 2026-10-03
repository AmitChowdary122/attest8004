/**
 * Prompt Guard screening (P5 plan Decisions 12-13): `chatPromptGuard` sends untrusted text through
 * any `ChatClient` to `meta-llama/llama-prompt-guard-2-86m`, and `screen()` is the per-field helper
 * `run.ts` calls before the model ever sees request data or a tool's result.
 *
 * Groq documents neither the output format nor a threshold for this model. Task 7's Step 1 made two
 * live calls (recorded in `test/fixtures/llm/guard.json`) and found a plain decimal string — the
 * malicious-probability score, e.g. `"0.00038913910975679755"` for a benign text and
 * `"0.9995530247688293"` for an injection attempt. `classify()` is pinned to that format: content
 * that isn't a bare decimal string is an unparseable guard answer, which Decision 6 treats as
 * transient, never a verdict.
 */
import type { ChatClient } from "./llm.ts";
import { ProviderError } from "./llm.ts";
import { RISK_V1 } from "./params.ts";
import type { GuardResult } from "./types.ts";

export interface PromptGuard {
  readonly model: string;
  /** The raw score string (Task 7 Step 1's pinned format): a bare decimal, e.g. `"0.9995530247688293"`. */
  classify(text: string): Promise<string>;
}

/** The pinned format: an optionally-signed decimal number, nothing else (no exponents, no labels). */
const DECIMAL_SCORE = /^-?\d+(?:\.\d+)?$/;

/** Wraps a {@link ChatClient} as a {@link PromptGuard} for `model` (ARCHITECTURE "Tools": its own client/pacer). */
export function chatPromptGuard(client: ChatClient, model: string): PromptGuard {
  return {
    model,
    async classify(text: string): Promise<string> {
      const response = await client.complete({
        model,
        messages: [{ role: "user", content: text }],
        max_completion_tokens: 16,
      });
      const content = (response.content ?? "").trim();
      if (content === "" || !DECIMAL_SCORE.test(content) || !Number.isFinite(Number(content))) {
        throw new ProviderError("unparseable guard answer", { kind: "transient", status: null, code: null, failedGeneration: null });
      }
      return content;
    },
  };
}

/** `text` split into chunks of at most `chunkChars`, each one overlapping the previous by `overlap` chars. */
function chunkText(text: string, chunkChars: number, overlap: number): string[] {
  if (text.length <= chunkChars) return [text];
  const stride = chunkChars - overlap;
  const chunks: string[] = [];
  let start = 0;
  for (;;) {
    const end = Math.min(start + chunkChars, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start += stride;
  }
  return chunks;
}

/**
 * Screens every field through `guard`, chunking long text (`RISK_V1.guardChunkChars` with
 * `RISK_V1.guardChunkOverlap` overlap) and keeping the numerically-highest-scoring chunk: its exact
 * text and the raw score string {@link PromptGuard.classify} returned for it become that field's
 * {@link GuardResult}. `flagged` is whether that score is `>= threshold`. No fields means no calls.
 */
export async function screen(
  guard: PromptGuard,
  fields: { source: string; text: string }[],
  threshold: number,
): Promise<GuardResult[]> {
  const results: GuardResult[] = [];
  for (const field of fields) {
    const chunks = chunkText(field.text, RISK_V1.guardChunkChars, RISK_V1.guardChunkOverlap);
    let bestNum = -Infinity;
    let bestScore = "";
    let bestText = chunks[0] ?? field.text;
    for (const chunk of chunks) {
      const score = await guard.classify(chunk);
      const num = Number(score);
      if (num > bestNum) {
        bestNum = num;
        bestScore = score;
        bestText = chunk;
      }
    }
    results.push({ source: field.source, text: bestText, score: bestScore, flagged: bestNum >= threshold });
  }
  return results;
}
