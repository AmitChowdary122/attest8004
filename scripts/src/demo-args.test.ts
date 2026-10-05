import { describe, expect, it } from "vitest";
import { SCENES, SCENE_TITLES, parseDemoArgs, pausePolicy } from "./demo-args.ts";

describe("parseDemoArgs", () => {
  it("runs every scene in order by default", () => {
    expect(parseDemoArgs([])).toEqual({ mode: "run", scenes: SCENES, fast: false, approvalsDir: null });
    expect(SCENES).toEqual(["1", "2", "3", "3b", "4", "5"]);
    for (const id of SCENES) expect(SCENE_TITLES[id].length).toBeGreaterThan(0);
  });

  it("runs one scene with --scene, and skips the pauses with --fast (a leading -- from pnpm is ignored)", () => {
    expect(parseDemoArgs(["--", "--scene", "3b", "--fast"])).toEqual({ mode: "run", scenes: ["3b"], fast: true, approvalsDir: null });
  });

  it("takes the approvals folder from --approvals", () => {
    expect(parseDemoArgs(["--approvals", "/tmp/a"]).approvalsDir).toBe("/tmp/a");
  });

  it("has a preflight-only mode and a fund mode", () => {
    expect(parseDemoArgs(["--preflight"]).mode).toBe("preflight");
    expect(parseDemoArgs(["--fund"]).mode).toBe("fund");
  });

  it.each([
    [["--scene", "6"]],
    [["--scene"]],
    [["--scene=2"]],
    [["--bogus"]],
    [["--preflight", "--scene", "2"]],
    [["--fund", "--preflight"]],
    [["--preflight", "--fast"]],
    [["--approvals"]],
    [["--scene", "2", "--scene", "3"]],
  ])("refuses %j rather than guessing", (argv) => {
    expect(() => parseDemoArgs(argv)).toThrow(/usage: pnpm demo/);
  });
});

describe("pausePolicy", () => {
  it("pauses between scenes and reads typed input only on a TTY; --fast drops only the pauses", () => {
    expect(pausePolicy({ stdinIsTty: true, fast: false })).toEqual({ betweenScenes: true, typedInput: true });
    expect(pausePolicy({ stdinIsTty: true, fast: true })).toEqual({ betweenScenes: false, typedInput: true });
    expect(pausePolicy({ stdinIsTty: false, fast: false })).toEqual({ betweenScenes: false, typedInput: false });
    expect(pausePolicy({ stdinIsTty: false, fast: true })).toEqual({ betweenScenes: false, typedInput: false });
  });
});
