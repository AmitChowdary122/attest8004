// Copy and download for the page's public JSON (a registration or a signed approval). Nothing is stored or sent.

export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function downloadJson(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/** An error as one readable line: viem's short message when there is one (its full message adds docs links and versions). */
export function errorText(error: unknown): string {
  const short = (error as { shortMessage?: unknown }).shortMessage;
  if (typeof short === "string" && short) return short;
  return error instanceof Error ? error.message : String(error);
}
