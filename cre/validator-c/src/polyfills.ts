// CRE's QuickJS runtime (cre-sdk 1.23.0, Javy) declares atob/btoa in its types but doesn't provide them: calling
// either throws "not a function" (P11 spike). The repo SDK's data: URI codec (packages/sdk/src/request.ts) calls
// both, so the workflow installs these before any SDK code runs (main.ts imports this module first). Pure JS,
// deterministic; never replaces a runtime's own functions.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** btoa: a binary string (every char ≤ U+00FF) to base64 with padding. Throws above U+00FF, as the native one does. */
function encode(binary: string): string {
  let out = "";
  for (let i = 0; i < binary.length; i += 3) {
    const a = binary.charCodeAt(i);
    const b = i + 1 < binary.length ? binary.charCodeAt(i + 1) : 0;
    const c = i + 2 < binary.length ? binary.charCodeAt(i + 2) : 0;
    if (a > 0xff || b > 0xff || c > 0xff) throw new Error("btoa: the string has characters outside Latin1");
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63);
    out += i + 1 < binary.length ? ALPHABET.charAt((n >> 6) & 63) : "=";
    out += i + 2 < binary.length ? ALPHABET.charAt(n & 63) : "=";
  }
  return out;
}

/**
 * atob: base64 (padding optional, no whitespace) to a binary string. Throws on a character outside the alphabet, a
 * '=' anywhere but the end, more than two '=', or a length that no byte string encodes to (length % 4 === 1).
 */
function decode(text: string): string {
  const padding = /=*$/.exec(text)?.[0].length ?? 0;
  if (padding > 2) throw new Error("atob: too much padding");
  const body = text.slice(0, text.length - padding);
  if (body.length % 4 === 1) throw new Error("atob: impossible length");
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const ch of body) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error("atob: not base64");
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}

/** Installs atob and/or btoa on `target` where they are missing; returns the names it installed. */
export function installBase64Polyfill(target: { atob?: unknown; btoa?: unknown }): Array<"atob" | "btoa"> {
  const installed: Array<"atob" | "btoa"> = [];
  if (typeof target.atob !== "function") {
    target.atob = decode;
    installed.push("atob");
  }
  if (typeof target.btoa !== "function") {
    target.btoa = encode;
    installed.push("btoa");
  }
  return installed;
}

installBase64Polyfill(globalThis as { atob?: unknown; btoa?: unknown });
