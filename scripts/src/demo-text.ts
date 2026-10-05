/**
 * Every line `pnpm demo` prints that carries data (P9, Decision 12): plain text only, never JSON. Verdicts are shown in
 * the same words the inbox decrypts (the validators' own operator reports), each transaction as an explorer link, the
 * setMandate's P256VERIFY call from its trace, and the validators' log lines narrated. Anything that came from a model,
 * a validator or the chain goes through `plainText` first: escape sequences, control and bidi characters are removed
 * and URLs in error text are replaced, so nothing on the recording can be spoofed or leak an endpoint.
 */
import { describeMandate, type Mandate, type OperatorReport } from "@attest8004/sdk";
import type { Address, Hex } from "viem";
import type { SceneId } from "./demo-args.ts";

/** The explorer the web app and the docs link to (web/src/explorer.ts; a test pins them together). */
export const EXPLORER = "https://monad-testnet.socialscan.io";

const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// C0 and C1 controls (newlines and tabs included: they become spaces first), DEL, and the bidi marks and overrides.
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** `s` as one line of plain text: no escape sequences, controls or bidi marks, whitespace collapsed, at most `max` characters. */
export function plainText(s: string, max = 600): string {
  const text = s.replace(CSI, "").replace(/[\t\n\r]/g, " ").replace(CONTROLS, "").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** URLs in `s` replaced with `<url>`: an RPC or LLM endpoint can carry a key. */
export function redactUrls(s: string): string {
  return s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>");
}

/** `s` word-wrapped to `width` columns, each line starting with `indent`. A word longer than a line gets its own. */
export function wrap(s: string, width: number, indent: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of s.split(/\s+/).filter(Boolean)) {
    if (line !== "" && indent.length + line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  if (line !== "") lines.push(indent + line);
  return lines;
}

/** Colours for a TTY without NO_COLOR; plain text otherwise. */
export function palette(enabled: boolean): { ok(s: string): string; bad(s: string): string; dim(s: string): string; bold(s: string): string } {
  const code = (open: number, close: number) => (s: string) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return { ok: code(32, 39), bad: code(31, 39), dim: code(2, 22), bold: code(1, 22) };
}

/** A scene's title block. */
export function sceneHeader(id: SceneId, title: string, width = 72): string[] {
  const rule = "━".repeat(width);
  return ["", rule, `  Scene ${id} · ${title}`, rule];
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** One transaction: its label and its explorer link. Throws on anything that isn't a transaction hash. */
export function txLine(label: string, hash: Hex): string {
  if (!TX_HASH.test(hash)) throw new Error(`not a transaction hash: ${plainText(String(hash), 80)}`);
  return `  ${label.padEnd(30)}  ${EXPLORER}/tx/${hash.toLowerCase()}`;
}

/** An address's explorer link. Throws on anything that isn't an address. */
export function addressLink(address: Address): string {
  if (!ADDRESS.test(address)) throw new Error(`not an address: ${plainText(String(address), 80)}`);
  return `${EXPLORER}/address/${address.toLowerCase()}`;
}

const WIDTH = 100;

/**
 * A verdict in the operator report's own words (what the phone decrypts in scene 5): the tag, the score against the
 * gate's minimum, then each reason or finding with its severity, and the report's notes. Every text is `plainText`.
 */
export function verdictLines(o: { report: OperatorReport; minScore: number }): string[] {
  const { report, minScore } = o;
  const verdict = report.score >= minScore ? `passed (needs ${minScore})` : `refused (needs ${minScore})`;
  const lines = [`  ${plainText(report.tag, 32)}  ${report.score}/100  ${verdict}`];
  if (report.items.length === 0) lines.push("    no findings");
  for (const item of report.items) {
    const head = `${item.severity ? `[${item.severity}] ` : ""}${plainText(item.code, 64)}:`;
    lines.push(...wrap(`- ${head} ${plainText(item.text)}`, WIDTH, "    "));
  }
  for (const note of report.notes) lines.push(...wrap(`note: ${plainText(note)}`, WIDTH, "    "));
  return lines;
}

/** A mandate in plain words (the SDK's `describeMandate`, as `/approve` and submit-approval show it), wrapped. */
export function mandateLines(m: Mandate, labels: Record<string, string>): string[] {
  return describeMandate(m, labels).flatMap((sentence) => wrap(plainText(sentence), WIDTH, "    "));
}

/** One `callTracer` frame, as `debug_traceTransaction` returns it (only the fields read here). */
export interface TraceFrame {
  type: string;
  to?: string;
  gasUsed?: string;
  output?: string;
  calls?: TraceFrame[];
}

export interface P256Call {
  gasUsed: bigint;
  /** The precompile returned 32 bytes ending `…01` (it returns empty bytes for an invalid signature). */
  valid: boolean;
  output: Hex;
}

const P256VERIFY = "0x0000000000000000000000000000000000000100";

/** Every STATICCALL to the P256VERIFY precompile (`0x0100`) in `frame`, depth first. */
export function findP256Calls(frame: TraceFrame): P256Call[] {
  const found: P256Call[] = [];
  const visit = (f: TraceFrame) => {
    if (f.type === "STATICCALL" && f.to?.toLowerCase() === P256VERIFY) {
      const output = (f.output ?? "0x") as Hex;
      found.push({ gasUsed: BigInt(f.gasUsed ?? "0x0"), valid: output.length === 66 && BigInt(output) === 1n, output });
    }
    for (const call of f.calls ?? []) visit(call);
  };
  visit(frame);
  return found;
}

const field = (entry: Record<string, unknown>, key: string) => (typeof entry[key] === "string" ? (entry[key] as string) : undefined);

/**
 * The validator an operator-report log line (posted or skipped) belongs to, or `null` for any other line. The validator
 * posts its report right after its response, before the runner prints that verdict; the runner holds these lines and
 * prints them after the verdict.
 */
export function reportLogOf(entry: Record<string, unknown>): string | null {
  const msg = field(entry, "msg");
  if (msg !== "operator report posted" && msg !== "operator report skipped") return null;
  return field(entry, "validator") ?? null;
}

/**
 * A validator's log entry as one narration line, or `null` for the routine ones (responses are printed from their
 * outcomes instead). Waits are said once per request (`seen` remembers them); warnings and errors start with `!`.
 */
export function narrateLog(entry: Record<string, unknown>, seen: Set<string>): string | null {
  const validator = plainText(field(entry, "validator") ?? "validator", 32);
  const msg = field(entry, "msg") ?? "";
  const once = (line: string) => {
    const key = `${validator}:${msg}:${field(entry, "requestHash") ?? ""}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return line;
  };
  switch (msg) {
    case "waiting for mandate-v1's verdict":
      return once(`${validator} waits for mandate-v1's verdict on the same action`);
    case "waiting for the finalized head":
      return once(`${validator} waits for its pinned block (5 below the finalized head)`);
    case "operator report posted": {
      const tx = field(entry, "txHash");
      return tx && TX_HASH.test(tx) ? txLine(`${validator}: encrypted report`, tx as Hex).trimStart() : `${validator}: encrypted report posted`;
    }
    case "operator report skipped":
      return `${validator}: no encrypted report (${plainText(field(entry, "reason") ?? "skipped", 80)})`;
  }
  const level = field(entry, "level");
  if (level !== "warn" && level !== "error") return null;
  const why = field(entry, "reason") ?? field(entry, "error");
  return `! ${validator}: ${plainText(msg, 120)}${why ? ` (${plainText(redactUrls(why), 200)})` : ""}`;
}

/** `wei` as MON rounded to 4 decimals for the screen (a non-zero amount below that shows as `<0.0001 MON`). */
export function monShort(wei: bigint): string {
  if (wei === 0n) return "0 MON";
  const tenThousandths = (wei + 50_000_000_000_000n) / 100_000_000_000_000n;
  if (tenThousandths === 0n) return "<0.0001 MON";
  const whole = tenThousandths / 10_000n;
  const fraction = (tenThousandths % 10_000n).toString().padStart(4, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} MON`;
}

/** `ms` as m:ss. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A key that can't pay for a take, with its full address to paste into the faucet (Decision 24). */
export function shortKeyLine(o: { name: string; address: Address; balance: bigint; need: bigint; takes: number }): string {
  return (
    `${o.name} ${o.address} holds ${monShort(o.balance)}, needs ${monShort(o.need)} for ${o.takes} take${o.takes === 1 ? "" : "s"}: ` +
    "paste the address into https://faucet.monad.xyz, or run `pnpm demo --fund`"
  );
}
