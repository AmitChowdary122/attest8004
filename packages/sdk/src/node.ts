// @attest8004/sdk/node: Node-only helpers, kept out of the root entry so browsers can import the SDK.
import { readFile, rename, writeFile } from "node:fs/promises";
import type { CursorStore } from "./validator.ts";

/**
 * A validator's block cursor in a JSON file, `{"block":"<decimal>"}`. Saves go through a temporary
 * file and a rename, so a crash mid-write leaves the previous cursor, never a partial one.
 */
export class FileCursorStore implements CursorStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<bigint | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const block: unknown = (JSON.parse(text) as { block?: unknown }).block;
    if (typeof block !== "string" || !/^(0|[1-9]\d*)$/.test(block)) {
      throw new Error(`${this.path}: not a cursor file (expected {"block":"<decimal>"})`);
    }
    return BigInt(block);
  }

  async save(block: bigint): Promise<void> {
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ block: block.toString() })}\n`);
    await rename(temporary, this.path);
  }
}
