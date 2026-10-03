/**
 * Line-level edits to a dotenv file that never overwrite a value and never echo one. Only the
 * named `NAME=` lines change; comments, blank lines and every other line stay byte-identical.
 */

function lineIndex(lines: string[], name: string): number {
  return lines.findIndex((line) => line.startsWith(`${name}=`));
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

/** The value of `name`, or undefined if the name is missing or its value is empty. */
export function readEnvValue(text: string, name: string): string | undefined {
  const lines = text.split("\n");
  const i = lineIndex(lines, name);
  if (i < 0) return undefined;
  const value = unquote((lines[i] ?? "").slice(name.length + 1));
  return value === "" ? undefined : value;
}

/**
 * Sets each name: fills an existing empty `NAME=` line in place, or appends `NAME=value`.
 * Throws if a name already has a value; the error names the variable, never its value.
 */
export function upsertEnv(text: string, entries: Record<string, string>): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [name, value] of Object.entries(entries)) {
    const i = lineIndex(lines, name);
    if (i < 0) {
      lines.push(`${name}=${value}`);
    } else if (readEnvValue(`${lines[i]}`, name) !== undefined) {
      throw new Error(`${name} already has a value in .env; refusing to overwrite it`);
    } else {
      lines[i] = `${name}=${value}`;
    }
  }
  return `${lines.join("\n")}\n`;
}
