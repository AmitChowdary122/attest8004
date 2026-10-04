/**
 * A Nansen API client (P5 plan "Nansen", Decisions 16, 18-20): two of `risk-v1`'s seven tools read
 * entity labels, funding origin and counterparty flows for one address, all POSTed to
 * `https://api.nansen.ai` with the key in an `apikey` header (docs.nansen.ai, read 4 Oct 2026). Every
 * endpoint this validator calls is listed in `docs/nansen.md` and the README (a Nansen bounty
 * requirement) — this file is the only place their paths and bodies are built, so that list stays
 * accurate by construction.
 *
 * `nansenClient({})` (today: `NANSEN_API_KEY` unset) makes `available` `false` and every call return
 * `{available: false, reason: "NANSEN_API_KEY is not set"}` without ever calling `fetch`. With a key,
 * a Nansen error (a non-200 response, or the network failing outright) still never throws: it becomes
 * `{available: false, reason: "NANSEN_ERROR <status> <code>"}` (or `"NANSEN_ERROR network"`), after
 * one retry on 429 or 5xx that honours `Retry-After` (capped at 10 s, falling back to a 2 s delay when
 * the header is missing or unusable) — Nansen is advisory and, unlike the onchain tools, can't be
 * re-checked by `verify`, so a bad call must never fail the check. The key never appears in any output,
 * error or log: only the fixed `NANSEN_ERROR <status> <code>` text and the response's own
 * `status`/`code` are recorded, exactly as `llm.ts` does for the LLM provider.
 *
 * Response normalisation keeps canonicalJson safe throughout (never an unsafe-integer or non-finite
 * number reaches `output`): Nansen's USD volumes become decimal strings (`String(n)` of a finite
 * number, else `null`), and every Nansen string this validator surfaces to the model (an entity
 * `label`, a `first_funder_name`, a counterparty label) is capped at 64 characters — with
 * {@link import("./trace.ts").dropTrailingLoneSurrogate} applied after the cut, exactly as `capOutput`
 * does for its own string cuts — before it ever reaches `output`. `tools.ts` reads those same capped
 * strings back out of `output` for Prompt Guard screening (`untrusted`), so the two can never disagree.
 */
import { getAddress, type Address } from "viem";
import { RISK_V1 } from "./params.ts";
import { dropTrailingLoneSurrogate } from "./trace.ts";
import type { JsonValue } from "./types.ts";

const BASE_URL = "https://api.nansen.ai";
const LABELS_PATH = "/api/v1/profiler/address/labels";
const FIRST_FUNDER_PATH = "/api/v1/profiler/address/first-funder";
const COUNTERPARTIES_PATH = "/api/v1/profiler/address/counterparties";

/** The fixed reason both tools give today, with no `NANSEN_API_KEY` set (Decision 20). */
export const NANSEN_NO_KEY_REASON = "NANSEN_API_KEY is not set";

/**
 * `profile`/`flows` never throw (Decision 20): every result is a plain {@link JsonValue}, either
 * `{available: true, ...}` with the normalised data, or `{available: false, reason}`.
 */
export interface NansenClient {
  readonly available: boolean;
  readonly reason: string | null;
  profile(address: Address): Promise<JsonValue>;
  flows(address: Address, from: bigint, to: bigint): Promise<JsonValue>;
}

// ---- small, defensive JSON readers: Nansen's response body is never trusted to match its docs ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `body.data`, filtered to object entries; `[]` for anything else (including a missing/malformed body). */
function dataArray(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return [];
  return body.data.filter(isRecord);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

const LABEL_MAX_CHARS = 64;

/** Caps one Nansen-sourced string at {@link LABEL_MAX_CHARS} before it reaches `output` (and so `untrusted`). */
function capLabel(value: string): string {
  return value.length <= LABEL_MAX_CHARS ? value : dropTrailingLoneSurrogate(value.slice(0, LABEL_MAX_CHARS));
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** `value` checksummed if it's exactly 20 bytes of hex, the raw string Nansen sent otherwise, or `null`. */
function addressLike(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return ADDRESS_PATTERN.test(value) ? getAddress(value.toLowerCase() as Address) : value;
}

/** A USD figure as a decimal string (`String(n)` of a finite number), or `null` (Decision 19). */
function usdString(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

/** A count as a safe-integer `number` (so it can never make a later `canonicalJson` call throw), or `null`. */
function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** `{label, category, kind}[]`, capped at `RISK_V1.nansenMaxLabels`; `label` is capped and goes to `untrusted`. */
function normalizeLabels(body: unknown): JsonValue[] {
  return dataArray(body)
    .slice(0, RISK_V1.nansenMaxLabels)
    .map((entry) => ({
      label: capLabel(asString(entry.label) ?? ""),
      category: asString(entry.category) ?? "",
      kind: asStringArray(entry.kind),
    }));
}

/** `{address, name, chain, time} | null` from the first-funder endpoint's `data[0]` (`null` when `data` is empty). */
function normalizeFirstFunder(body: unknown): JsonValue {
  const first = dataArray(body)[0];
  if (first === undefined) return null;
  const name = asString(first.first_funder_name);
  const timestamp = first.block_timestamp;
  const time = asString(timestamp) ?? (safeCount(timestamp) !== null ? String(timestamp) : null);
  return {
    address: addressLike(first.first_funder_address),
    name: name === null ? null : capLabel(name),
    chain: asString(first.chain),
    time,
  };
}

/** The counterparties endpoint's `data[]`, capped at `RISK_V1.nansenMaxCounterparties`; each label is capped. */
function normalizeCounterparties(body: unknown): JsonValue[] {
  return dataArray(body)
    .slice(0, RISK_V1.nansenMaxCounterparties)
    .map((entry) => ({
      address: addressLike(entry.counterparty_address) ?? asString(entry.counterparty_address) ?? "",
      labels: asStringArray(entry.counterparty_address_label).map(capLabel),
      interactionCount: safeCount(entry.interaction_count),
      totalVolumeUsd: usdString(entry.total_volume_usd),
      volumeInUsd: usdString(entry.volume_in_usd),
      volumeOutUsd: usdString(entry.volume_out_usd),
    }));
}

// ---- transport: one retry on 429/5xx honouring Retry-After (capped at 10s); never throws ----

type FetchResult = { ok: true; body: unknown } | { ok: false; reason: string };

const RETRY_AFTER_CAP_MS = 10_000;
const RETRY_FALLBACK_MS = 2_000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);

/** `retry-after` honoured up to {@link RETRY_AFTER_CAP_MS}; missing or unusable falls back to a fixed 2 s. */
function retryDelayMs(headers: Headers): number {
  const raw = headers.get("retry-after");
  if (raw !== null) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  }
  return RETRY_FALLBACK_MS;
}

/** `body.code` (context: Nansen's error body is `{error, message, code, status, ...}`), read defensively. */
function readErrorCode(body: unknown): string | null {
  if (!isRecord(body)) return null;
  return typeof body.code === "string" ? body.code : null;
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * POSTs one Nansen endpoint, with one retry on 429/5xx (Decision 20). Never throws: a network failure
 * (`fetch` itself rejecting) is reported the same way, as `NANSEN_ERROR network`, with no retry.
 */
async function postNansen(
  o: { apiKey: string; fetchFn: typeof fetch; sleepFn: (ms: number) => Promise<void> },
  path: string,
  body: unknown,
): Promise<FetchResult> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await o.fetchFn(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: o.apiKey },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, reason: "NANSEN_ERROR network" };
    }

    if (response.status === 200) {
      return { ok: true, body: await readJsonSafely(response) };
    }

    if (RETRYABLE_STATUSES.has(response.status) && attempt === 0) {
      await o.sleepFn(retryDelayMs(response.headers));
      continue;
    }

    const errorBody = await readJsonSafely(response);
    const code = readErrorCode(errorBody);
    return { ok: false, reason: code === null ? `NANSEN_ERROR ${response.status}` : `NANSEN_ERROR ${response.status} ${code}` };
  }
}

/** `seconds` (a block timestamp) as a UTC ISO 8601 date-time, for the `date` window in `flows()`'s body. */
function iso(seconds: bigint): string {
  return new Date(Number(seconds) * 1_000).toISOString();
}

/**
 * `o.apiKey` missing or empty: `available` is `false`, `reason` is {@link NANSEN_NO_KEY_REASON}, and
 * `profile`/`flows` return `{available: false, reason}` without ever calling `fetchFn` (Decision 20).
 * `fetchFn`/`sleepFn` are injectable so tests make zero network calls and wait on no real clock.
 */
export function nansenClient(o: { apiKey?: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }): NansenClient {
  const fetchFn = o.fetch ?? fetch;
  const sleepFn = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  if (o.apiKey === undefined || o.apiKey === "") {
    return {
      available: false,
      reason: NANSEN_NO_KEY_REASON,
      async profile(): Promise<JsonValue> {
        return { available: false, reason: NANSEN_NO_KEY_REASON };
      },
      async flows(): Promise<JsonValue> {
        return { available: false, reason: NANSEN_NO_KEY_REASON };
      },
    };
  }

  const transport = { apiKey: o.apiKey, fetchFn, sleepFn };

  return {
    available: true,
    reason: null,

    async profile(address: Address): Promise<JsonValue> {
      // Labels costs 100 credits; first-funder only 1. On a labels failure, skip first-funder rather
      // than spending another call on a profile that's already unavailable.
      const labels = await postNansen(transport, LABELS_PATH, { address, chain: "all", pagination: { page: 1, per_page: 100 } });
      if (!labels.ok) return { available: false, reason: labels.reason };

      const firstFunder = await postNansen(transport, FIRST_FUNDER_PATH, { address, chain: "all" });
      if (!firstFunder.ok) return { available: false, reason: firstFunder.reason };

      return { available: true, labels: normalizeLabels(labels.body), firstFunder: normalizeFirstFunder(firstFunder.body) };
    },

    async flows(address: Address, from: bigint, to: bigint): Promise<JsonValue> {
      const result = await postNansen(transport, COUNTERPARTIES_PATH, {
        address,
        chain: "all",
        date: { from: iso(from), to: iso(to) },
        source_input: "Combined",
        group_by: "wallet",
        pagination: { page: 1, per_page: 10 },
        order_by: [{ field: "total_volume_usd", direction: "DESC" }],
      });
      if (!result.ok) return { available: false, reason: result.reason };

      return { available: true, counterparties: normalizeCounterparties(result.body) };
    },
  };
}
