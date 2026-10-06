// CI's hidden-Unicode check (P12): every tracked text file must be free of literal bidi controls and zero-width
// characters (hidden-unicode.ts). Exits 1, listing each one, when any is found.
//
//   node scripts/src/check-hidden-unicode.ts        (from the repo root; pnpm check:unicode)
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { scanRepository } from "./hidden-unicode.ts";

const root = resolve(import.meta.dirname, "../..");
const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const problems = scanRepository(root, files);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`${problems.length} hidden Unicode character(s): write them as \\u escapes (Trojan Source; GitHub's hidden-Unicode warning)`);
  process.exitCode = 1;
} else {
  console.log(`no hidden Unicode in ${files.length} tracked files`);
}
