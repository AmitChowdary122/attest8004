import { describe, expect, it } from "vitest";
import { Timeline, serialQueue, timingTable, waitCloseLine, waitOpenLine } from "./demo-timing.ts";

/** A clock the test moves by hand. */
function clock() {
  let t = 0;
  return { now: () => t, at: (ms: number) => void (t = ms) };
}

describe("Timeline", () => {
  it("records each scene's total and its waits", () => {
    const c = clock();
    const timeline = new Timeline(c.now);
    timeline.begin("2");
    c.at(10_000);
    const endRisk = timeline.wait("risk-v1", "risk-v1's check");
    c.at(95_000);
    expect(endRisk()).toBe(85_000);
    c.at(100_000);
    const endPin = timeline.wait("pin", "the pin");
    c.at(102_000);
    endPin();
    c.at(110_000);
    timeline.end();
    expect(timeline.scenes()).toEqual([
      {
        scene: "2",
        totalMs: 110_000,
        waits: [
          { kind: "risk-v1", what: "risk-v1's check", ms: 85_000 },
          { kind: "pin", what: "the pin", ms: 2_000 },
        ],
      },
    ]);
  });

  it("ends the open scene when the next begins", () => {
    const c = clock();
    const timeline = new Timeline(c.now);
    timeline.begin("1");
    c.at(5_000);
    timeline.begin("2");
    c.at(7_000);
    timeline.end();
    expect(timeline.scenes().map((s) => [s.scene, s.totalMs])).toEqual([
      ["1", 5_000],
      ["2", 2_000],
    ]);
  });

  it("refuses to begin or end a scene while a wait is open, and to open a second wait", () => {
    const timeline = new Timeline(clock().now);
    timeline.begin("3");
    timeline.wait("pin", "x");
    expect(() => timeline.begin("3b")).toThrow();
    expect(() => timeline.end()).toThrow();
    expect(() => timeline.wait("risk-v1", "y")).toThrow();
  });

  it("does nothing on end() without a scene", () => {
    const timeline = new Timeline(clock().now);
    timeline.end();
    expect(timeline.scenes()).toEqual([]);
  });
});

describe("wait lines", () => {
  it("mark where to cut", () => {
    expect(waitOpenLine("risk-v1's check")).toBe("┄ waiting: risk-v1's check (cut from here)");
    expect(waitCloseLine(85_000)).toBe("┄ waited 1:25 (cut to here)");
  });
});

describe("timingTable", () => {
  const scenes = [
    { scene: "1" as const, totalMs: 130_000, waits: [{ kind: "browser" as const, what: "approval", ms: 110_000 }, { kind: "pin" as const, what: "p", ms: 3_000 }] },
    {
      scene: "2" as const,
      totalMs: 110_000,
      waits: [
        { kind: "risk-v1" as const, what: "r", ms: 85_000 },
        { kind: "pin" as const, what: "p", ms: 2_000 },
      ],
    },
  ];
  const rows = timingTable(scenes);
  const row = (scene: string) => rows.find((r) => r.trimStart().startsWith(scene)) ?? "";
  const cells = (line: string) => line.trim().split(/\s{2,}/);

  it("has a header, one row per scene and a totals row", () => {
    expect(cells(rows[0] ?? "")).toEqual(["scene", "total", "browser", "pin", "risk-v1", "indexer", "after cuts"]);
    expect(rows).toHaveLength(4);
    expect(row("total")).not.toBe("");
  });

  it("subtracts the pin, risk-v1 and indexer waits, never the browser's", () => {
    expect(cells(row("2"))).toEqual(["2", "1:50", "0:00", "0:02", "1:25", "0:00", "0:23"]);
    expect(cells(row("1"))).toEqual(["1", "2:10", "1:50", "0:03", "0:00", "0:00", "2:07"]);
    expect(cells(row("total"))).toEqual(["total", "4:00", "1:50", "0:05", "1:25", "0:00", "2:30"]);
  });
});

describe("serialQueue", () => {
  it("runs tasks one after another, in order", async () => {
    const seen: number[] = [];
    const queue = serialQueue();
    queue.push(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(1);
    });
    queue.push(async () => {
      seen.push(2);
    });
    await queue.drain();
    expect(seen).toEqual([1, 2]);
  });

  it("holds a failed task's error for drain(), never as an unhandled rejection, and skips the tasks after it", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const queue = serialQueue();
      let ranAfter = false;
      queue.push(async () => {
        throw new Error("print failed");
      });
      queue.push(async () => {
        ranAfter = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      await expect(queue.drain()).rejects.toThrow("print failed");
      expect(ranAfter).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
