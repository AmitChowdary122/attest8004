import { keccak256, stringToBytes, type Hex } from "viem";
import { toBase64 } from "./request.ts";

/**
 * Deterministic JSON for evidence and other hashed documents (the "Reproducibility" global
 * constraint: canonical JSON, sorted keys, integers above 2^53 as decimal strings): object keys
 * sorted by UTF-16 code unit, no whitespace, a `bigint` written as a decimal string, and a number
 * accepted only if it is a safe integer (so it round-trips through every JSON parser unchanged;
 * values above 2^53 must be passed as a `bigint`).
 *
 * Throws on anything JSON can't represent unambiguously: `undefined`, a function, a symbol, a
 * non-finite or fractional number, and anything that is not a plain object or array (a `Date`, a
 * `Map`, a `Set`, a class instance) — these would either lose information or vary by engine.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(
        `canonicalJson: number must be a safe integer, got ${value} (pass a bigint for values above 2**53)`,
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    const entries = keys.map((key) => {
      const entryValue = value[key];
      if (entryValue === undefined) throw new TypeError(`canonicalJson: key "${key}" is undefined`);
      return `${JSON.stringify(key)}:${canonicalJson(entryValue)}`;
    });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`canonicalJson: cannot encode ${describe(value)}`);
}

/** `{}` or `Object.create(null)`, not an array, a `Date`, a `Map` or a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(value: unknown): string {
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "function") return "a function";
  if (typeof value === "symbol") return "a symbol";
  if (typeof value === "object") return `a non-plain object (${Object.prototype.toString.call(value)})`;
  return typeof value;
}

/**
 * A JSON document as a base64 `data:` URI, plus keccak256 of its exact UTF-8 bytes — the same form
 * as {@link import("./request.ts").encodeJsonDataUri}, but over `canonicalJson`'s bytes instead of
 * `JSON.stringify`'s, so two callers who build the same document in different key orders commit to
 * the same `hash`.
 */
export function encodeCanonicalJsonDataUri(doc: unknown): { uri: string; hash: Hex } {
  const bytes = stringToBytes(canonicalJson(doc));
  return { uri: `data:application/json;base64,${toBase64(bytes)}`, hash: keccak256(bytes) };
}
