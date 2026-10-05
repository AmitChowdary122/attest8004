/**
 * How long each scene of a take really took, and how much of it was waiting (P9, Decision 23), so the 3-minute video
 * can cut the waits honestly: every wait is marked on screen where it starts and ends, and the take ends with a table
 * of each scene's total, its waits by kind, and what's left after cutting. Browser waits (you, approving) are part of
 * the scene and never cut.
 */
import type { SceneId } from "./demo-args.ts";
import { elapsed } from "./demo-text.ts";

/** `browser`: you, at an approval. `pin`: blocks to pass a validator's pin. `risk-v1`: B's check. `indexer`: scene 4. */
export type WaitKind = "browser" | "pin" | "risk-v1" | "indexer";
const KINDS: readonly WaitKind[] = ["browser", "pin", "risk-v1", "indexer"];
/** The waits the edit cuts. */
const CUT: readonly WaitKind[] = ["pin", "risk-v1", "indexer"];

export interface SceneTiming {
  scene: SceneId;
  totalMs: number;
  waits: { kind: WaitKind; what: string; ms: number }[];
}

/** Scene and wait times against an injected clock. Waits don't nest. */
export class Timeline {
  private readonly now: () => number;
  private readonly done: SceneTiming[] = [];
  private current: { scene: SceneId; start: number; waits: SceneTiming["waits"] } | null = null;
  private open = false;

  constructor(now: () => number) {
    this.now = now;
  }

  /** Starts `scene`, ending the one before it. */
  begin(scene: SceneId): void {
    this.end();
    this.current = { scene, start: this.now(), waits: [] };
  }

  /** Starts a wait in the current scene; the returned function ends it and gives its length in ms. */
  wait(kind: WaitKind, what: string): () => number {
    const scene = this.current;
    if (scene === null) throw new Error("Timeline: a wait needs a scene");
    if (this.open) throw new Error("Timeline: a wait is already open");
    this.open = true;
    const start = this.now();
    let ended: number | null = null;
    return () => {
      if (ended !== null) return ended;
      ended = this.now() - start;
      scene.waits.push({ kind, what, ms: ended });
      this.open = false;
      return ended;
    };
  }

  /** Ends the current scene, if any. */
  end(): void {
    if (this.open) throw new Error("Timeline: a wait is still open");
    if (this.current === null) return;
    this.done.push({ scene: this.current.scene, totalMs: this.now() - this.current.start, waits: this.current.waits });
    this.current = null;
  }

  scenes(): SceneTiming[] {
    return this.done.map((s) => ({ ...s, waits: [...s.waits] }));
  }
}

export function waitOpenLine(what: string): string {
  return `┄ waiting: ${what} (cut from here)`;
}

export function waitCloseLine(ms: number): string {
  return `┄ waited ${elapsed(ms)} (cut to here)`;
}

/** The take's timing: one row per scene, then the totals. "after cuts" removes the pin, risk-v1 and indexer waits. */
export function timingTable(scenes: readonly SceneTiming[]): string[] {
  const header = ["scene", "total", ...KINDS, "after cuts"];
  const rowOf = (name: string, totalMs: number, waits: SceneTiming["waits"]) => {
    const byKind = KINDS.map((kind) => waits.filter((w) => w.kind === kind).reduce((sum, w) => sum + w.ms, 0));
    const cut = waits.filter((w) => CUT.includes(w.kind)).reduce((sum, w) => sum + w.ms, 0);
    return [name, elapsed(totalMs), ...byKind.map(elapsed), elapsed(totalMs - cut)];
  };
  const rows = [header, ...scenes.map((s) => rowOf(s.scene, s.totalMs, s.waits))];
  rows.push(rowOf("total", scenes.reduce((sum, s) => sum + s.totalMs, 0), scenes.flatMap((s) => s.waits)));
  const widths = header.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => `  ${r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd()}`);
}

/**
 * Work run one task after another while something else goes on (scene 2 and 3 print each verdict while the other
 * validator still works). A failed task skips the ones after it, and its error waits for `drain()`: it is never an
 * unhandled rejection, which would end the process mid-take.
 */
export function serialQueue(): { push(task: () => Promise<void>): void; drain(): Promise<void> } {
  let tail: Promise<void> = Promise.resolve();
  return {
    push(task) {
      tail = tail.then(task);
      tail.catch(() => {});
    },
    drain: () => tail,
  };
}
