/**
 * `pnpm demo`'s arguments (P9): which scenes of SPEC §5 to play, whether to pause between them, and the two
 * non-scene modes. Anything else is refused rather than guessed at, as the other scripts do (approval-plan.ts).
 */

export type SceneId = "1" | "2" | "3" | "3b" | "4" | "5";

/** SPEC §5's scenes in order, with 3b (recovery, which is also the reset between takes) after the replay. */
export const SCENES: readonly SceneId[] = ["1", "2", "3", "3b", "4", "5"];

export const SCENE_TITLES: Record<SceneId, string> = {
  "1": "The mandate: a passkey approves what agent 1984 may do",
  "2": "A benign action: both validators pass it, and the vault executes it",
  "3": "The Grok/Bankr replay: a permission change, then a transfer out",
  "3b": "Recovery: revoke the rogue key, approve the mandate again",
  "4": "The dashboard: the record",
  "5": "The phone: the private findings, decrypted with the same passkey",
};

export interface DemoArgs {
  /** `run` plays scenes; `preflight` only checks; `fund` tops up the keys from the deployer, then checks. */
  mode: "run" | "preflight" | "fund";
  scenes: readonly SceneId[];
  /** No Enter between scenes, and scene 3 prints the verify command instead of running it. */
  fast: boolean;
  /** Where the browser saves approvals; `null` means the default (~/Downloads). */
  approvalsDir: string | null;
}

export const DEMO_USAGE =
  "usage: pnpm demo [--scene <1|2|3|3b|4|5>] [--fast] [--approvals <dir>] | pnpm demo --preflight | pnpm demo --fund";

/** The arguments after the script name. A bare `--` (pnpm may pass one through) is ignored. */
export function parseDemoArgs(argv: readonly string[]): DemoArgs {
  const refuse = (why: string): never => {
    throw new Error(`${why}\n${DEMO_USAGE}`);
  };
  let scene: SceneId | null = null;
  let fast = false;
  let approvalsDir: string | null = null;
  let mode: DemoArgs["mode"] = "run";
  const seen = new Set<string>();
  const args = argv.filter((a) => a !== "--");
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] as string;
    if (seen.has(flag)) refuse(`${flag} given twice`);
    seen.add(flag);
    const value = (): string => {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) refuse(`${flag} needs a value`);
      i += 1;
      return next as string;
    };
    switch (flag) {
      case "--scene": {
        const id = value();
        if (!(SCENES as readonly string[]).includes(id)) refuse(`unknown scene "${id}"`);
        scene = id as SceneId;
        break;
      }
      case "--fast":
        fast = true;
        break;
      case "--approvals":
        approvalsDir = value();
        break;
      case "--preflight":
      case "--fund":
        if (mode !== "run") refuse("--preflight and --fund can't be combined");
        mode = flag === "--fund" ? "fund" : "preflight";
        break;
      default:
        refuse(`unknown argument "${flag}"`);
    }
  }
  if (mode !== "run" && (scene !== null || fast)) refuse(`--${mode} runs no scene, so it takes no --scene or --fast`);
  return { mode, scenes: scene === null ? SCENES : [scene], fast, approvalsDir };
}

/**
 * When the runner waits for you. Between scenes it waits for Enter only on a TTY without --fast; typed input (a path,
 * or `skip`) is read only on a TTY. Off a TTY (a background run, a pipe) it never blocks on stdin.
 */
export function pausePolicy(o: { stdinIsTty: boolean; fast: boolean }): { betweenScenes: boolean; typedInput: boolean } {
  return { betweenScenes: o.stdinIsTty && !o.fast, typedInput: o.stdinIsTty };
}
