// Finds literal bidi controls and zero-width characters in text (P12): the characters behind Trojan Source attacks
// and GitHub's "hidden or bidirectional Unicode" warning. Test data that needs one writes it as a \u escape.
//
// Dependency-free, so CI runs the checker (check-hidden-unicode.ts) with plain `node` and no install.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The flagged code points, as inclusive ranges: ALM (U+061C); ZWSP, ZWNJ, ZWJ, LRM, RLM (U+200B-U+200F);
 * LRE, RLE, PDF, LRO, RLO (U+202A-U+202E); WJ and the invisible operators (U+2060-U+2064); LRI, RLI, FSI, PDI
 * (U+2066-U+2069); and the BOM / ZWNBSP (U+FEFF), anywhere. U+202F (a visible narrow no-break space, which recorded
 * model output contains) is not flagged.
 */
export const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

export interface HiddenCharacter {
  line: number;
  column: number;
  codePoint: number;
}

const isHidden = (cp: number): boolean => HIDDEN_RANGES.some(([first, last]) => cp >= first && cp <= last);

/** Every flagged character in `text`, with its 1-based line and column (in code points). */
export function findHiddenUnicode(text: string): HiddenCharacter[] {
  const found: HiddenCharacter[] = [];
  let line = 1;
  let column = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) as number;
    if (cp === 0x0a) {
      line++;
      column = 0;
      continue;
    }
    column++;
    if (isHidden(cp)) found.push({ line, column, codePoint: cp });
  }
  return found;
}

/** Whether `bytes` look binary: a NUL byte in the first 8,000 (git's own heuristic). */
export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8_000).includes(0);
}

/** One problem per flagged character, or per text file that isn't UTF-8, as `path:line:col U+XXXX`. */
export function scanRepository(root: string, files: readonly string[]): string[] {
  const problems: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const file of files) {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(join(root, file));
    } catch {
      continue; // a deleted file still listed, or a submodule
    }
    if (isBinary(bytes)) continue;
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      problems.push(`${file}: not UTF-8`);
      continue;
    }
    for (const h of findHiddenUnicode(text)) {
      problems.push(`${file}:${h.line}:${h.column} U+${h.codePoint.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }
  return problems;
}
