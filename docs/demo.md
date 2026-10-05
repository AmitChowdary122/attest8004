# The demo: `pnpm demo` and the 3-minute script

`pnpm demo` plays [SPEC §5](../SPEC.md#5-demo-scenario-must-run-end-to-end-live-on-testnet) live on Monad testnet,
scene by scene, for a screen recording. It runs both reference validators in its own process (as the e2e does),
pauses for Enter between scenes, prints plain sentences and an explorer link for every transaction, and marks every
wait so the edit can cut it honestly. This page is the recording guide: setup, the narration script with timestamps,
the real durations from the live run, where to cut, and how to reset between takes.

## Before you record

1. **The terminal:** a real terminal (a TTY: the runner pauses between scenes and colours its output only there), at
   least 120 columns, a large font. Run `pnpm --loglevel silent demo` so pnpm doesn't echo its own command line.
2. **Stop the validator services** (`mandate-v1` and `risk-v1`): the runner signs with both validator keys itself, and
   the preflight refuses while a service runs.
3. **Laptop Chrome**, signed in to the Google account that holds agent 1984's passkey (Google Password Manager).
   Downloads must land in `~/Downloads` without asking (Settings → Downloads → "Ask where to save each file" off), or
   pass `--approvals <dir>`. Open `https://attest8004.vercel.app/approve` in one tab and `/dashboard` in another.
4. **The phone:** Android Chrome with the same Google account (the passkey syncs), `https://attest8004.vercel.app/inbox`
   open.
5. **The preflight:** `pnpm --loglevel silent demo --preflight`. It must show no blockers, and `Takes left today` at
   least 1. A short key is printed with its full address: paste it into https://faucet.monad.xyz, or run
   `pnpm demo --fund` (the deployer tops every key up to 4 takes). It also prints the Groq tokens used in the last
   24 h, read from validator B's own recorded verdicts (Groq has no daily-token header), and how many takes fit.

## The flags

| Command | What it does |
|---|---|
| `pnpm demo` | Every scene in order: 1, 2, 3, 3b, 4, 5 |
| `pnpm demo --scene 3b` | One scene (`1`, `2`, `3`, `3b`, `4` or `5`) |
| `pnpm demo --fast` | No Enter between scenes; scene 3 prints the `verify` command instead of running it |
| `pnpm demo --approvals <dir>` | Where the browser saves approvals (default `~/Downloads`) |
| `pnpm demo --preflight` | Checks only; sends nothing |
| `pnpm demo --fund` | Tops the hot key, the rogue key and both validators up to 4 takes from the deployer, then checks |

## The 3-minute script

The runner's own screen time per scene after cuts (from the live run below) is about 2:00; each passkey approval and
each browser scene add what you spend in the browser. Scene 3b is the one to shorten first.

| Time | Scene | On screen | Say |
|---|---|---|---|
| 0:00–0:15 | Intro | The terminal, the preflight's last lines | "Attest8004 is the ERC-8004 Validation layer for Monad. An agent's every action is checked by two validators before a vault will run it. Everything you'll see is live on Monad testnet." |
| 0:15–0:50 | **1 · The mandate** | Laptop Chrome, `/approve` → **3 · Approve a mandate change** → agent 1984: **Read agent from chain** → **Preset: e2e mandate** → **Prepare approval** → **Sign with passkey** (screen lock) → **Download approval**. Then the terminal: the mandate read back from chain, and `P256VERIFY (0x0100): 6,900 gas, returned …01` | "The owner approves what the agent may do with a passkey: 0.002 MON per transaction, 0.005 a day, two recipients. Monad verifies the passkey signature on chain, through the P256 precompile at 0x0100: here it is in the transaction's trace." |
| 0:50–1:15 | **2 · A benign action** | The two requests, `┄ waiting` (cut), mandate-v1 100, `┄ waiting` (cut), risk-v1 100 with the tools it called, the execute link, the vault balance | "The agent asks to send 0.0005 MON to its owner. mandate-v1 is deterministic: anyone can re-run it from chain data. risk-v1 is an agent with tools. Both pass, and the vault executes." |
| 1:15–2:00 | **3 · The Grok/Bankr replay** | `setAgentKey (the rogue key)`, the rogue requests, mandate-v1 **0** with `TARGET_NOT_ALLOWED` and `PERMISSION_CHANGED_AFTER_MANDATE`, risk-v1 **0** with its high findings, `✗ execute reverts: ScoreTooLow(…)`, `✓ verify …` | "Now the Grok/Bankr pattern: the agent's permissions change outside its mandate. A new key appears on the agent, never approved by the passkey, and asks to send funds to an address nobody has seen. mandate-v1 scores it 0: the target isn't allowed, and the permissions changed after the mandate. risk-v1 explains why. The vault refuses. And anyone can re-run that verdict and get the same hash." |
| 2:00–2:20 | **3b · Recovery** (optional) | `setAgentKey (the hot key back)`, the second approval (see the cut note below), `✓ dry run, nothing posted: mandate-v1 … 100` | "Recovery is the same two factors: revoke the key, approve again with the passkey. Because the new mandate comes after the changes, the agent is trusted again at once." |
| 2:20–2:40 | **4 · The dashboard** | `/dashboard`: **Recent verdicts** (this take's four), then **Agent trust** → 1984 → **Look up**: **Recent permission events** shows `AGENT_KEY_SET` to the rogue key, then back, between two `MANDATE_SET`s | "Every verdict is on chain and indexed by Envio, with the line to re-check it yourself." |
| 2:40–3:00 | **5 · The phone** | Android Chrome, `/inbox` → agent 1984 → **Find reports** → **Decrypt with passkey** (screen lock): each report says "Matches the verdict onchain" | "The validators also sent private reports, encrypted to a key only the agent's passkey can derive, so the owner reads them on any device." |

**Narration rules (honesty):**
- Say "Nansen" only if the preflight said a `NANSEN_API_KEY` is set. Without one, risk-v1's two Nansen tools answer
  "unavailable", and the runner prints `Nansen: not configured`.
- risk-v1's explanations are the model's; its score is computed in code, and `verify` re-checks a risk-v1 verdict
  without re-running the model ("model output: recorded, not re-run").
- The refusal in scene 3 is simulated (`eth_call`): nothing is sent. The 3b check is a dry run, labelled as one.
- The registry is spec-conformant, not the canonical ERC-8004 Validation Registry (none is deployed anywhere).

## Real durations, and where to cut

The live run of 5 Oct 2026 ([deployments.md](./deployments.md#p9-demo-run-testnet-2026-10-05)), as the runner printed
it at the end of the take:

```
scene  total  browser  pin   risk-v1  indexer  after cuts
1      1:23   1:02     0:00  0:00     0:00     1:23
2      1:57   0:00     0:27  1:09     0:00     0:21
3      2:21   0:00     0:28  1:22     0:00     0:31
3b     4:15   3:40     0:01  0:00     0:00     4:15
4      0:01   0:00     0:00  0:00     0:01     0:00
5      0:13   0:00     0:00  0:00     0:00     0:13
total  10:10  4:42     0:56  2:31     0:01     6:42
```

- **"browser"** is time in the browser, never cut by the runner's count. In this run it measured me pinging the
  approver in chat (1:02) and, in 3b, a passkey prompt that failed once and was retried (3:40). A rehearsed approval
  takes about 20–30 s: time yours on the recording.
- **Without the browser time**, the runner's own screen time after cuts was 0:21 (scene 1), 0:21 (2), 0:31 (3),
  0:35 (3b) and 0:13 (5), about 2:00 in all.
- **The `--scene 2` run after the reset** took 2:02, 0:24 after cuts (pin 0:28, risk-v1 1:10).

**Where to cut.** Every wait is marked on screen, with the same two lines each time:

```
┄ waiting: <what> (cut from here)
┄ waited m:ss (cut to here)
```

| Scene | Wait | Typical length |
|---|---|---|
| 2, 3 | `mandate-v1 pins 5 blocks below finalized, then answers` | about 0:28 |
| 2, 3 | `risk-v1's check: its tools at the pinned block, then the model` | 1:09–1:22 (the free tier paces it) |
| 3b | `the pinned block (5 below finalized) passing the new mandate` | about 0:01 |
| 4 | `the indexer reaching block …` | 0:01–1:30 |
| 1, 3b | `your passkey approval on /approve` | show it (scene 1); see below for 3b |

**At every cut, show "waiting time cut" on screen for about a second.** The checks are not instant, and the video
mustn't suggest they are. For scene 3b's approval, which repeats scene 1's on camera, cut it the same way with the
note "same passkey approval as scene 1".

## Between takes: the reset

A full run resets itself. Scene 3b revokes the rogue key (`setAgentKey(1984, hot key)`) and approves the mandate
again, so the next take starts clean. No 31-minute wait is needed: mandate-v1's permission rule (SPEC §4.5, rule 11)
compares the window's events with the **newest** `MandateSet`, so a mandate approved after the key changes is clean
at once. The owner approved it with the changes in view.

After an interrupted take, run `pnpm demo --scene 3b`. It restores the hot key if needed, asks for the re-approval only
if a change follows the mandate, and proves the reset with a mandate-v1 dry run. The preflight names it whenever the
rogue key is still registered or the mandate is older than a key change. Scenes 2 and 3 refuse to start in that state,
so no Groq tokens or gas go on a guaranteed 0.

The runner ignores approval files saved before a scene started waiting. An approval left over from an interrupted take
(same nonce, never submitted) is never submitted behind your back. It says how many it ignored.

## What each take costs

| Key | Pays for (at the caps; Monad charges the gas limit) | Gas per take |
|---|---|---|
| Hot key | 2 forwarded requests | 630,000 |
| Rogue key | 2 forwarded requests | 630,000 |
| Deployer | 2 `setMandate`, 2 `setAgentKey`, 1 `execute` | 1,347,000 |
| Validator A | 2 responses + 2 encrypted reports | 1,660,000 |
| Validator B | 2 responses + 2 encrypted reports | 2,860,000 |

- **Groq:** two risk-v1 checks, about 19K tokens a take (live: 10,592 and 8,297) of the free tier's 200K a day.
- **The daily cap:** each take adds 0.0005 MON to agent 1984's counted spend (25 h window). A take counts while the
  rogue transfer still fits, so it gets exactly the two replay reasons. With nothing else counted, 8 takes fit.
- **`Takes left today`** in the preflight is the smallest of the Groq room, the daily cap and every key's balance, and
  it names which one binds.
- **The e2e after a demo take:** the e2e still waits 6,000 blocks (about 31 minutes) after any new mandate before it
  starts. The demo doesn't.

## When something goes wrong

| What you see | What to do |
|---|---|
| Chrome: "The operation either timed out or was not allowed" | The passkey prompt was dismissed, timed out or lost focus. Keep the window in front, click **Sign with passkey** again (or **Prepare approval**, then sign), and pick the Google Password Manager passkey. The runner waits 15 minutes. |
| Scene 2 stops: "risk-v1 scored the benign action … below the vault's 80" | Read its findings on screen. This hasn't happened yet: in every run so far, the model never opened the reset's permission events. If a finding cites those older events (`afterMandate: false`), the runner can't fix it. Either record takes at least 31 minutes apart (the events then leave the window), or clarify risk-v1's rubric under a new `promptVersion` (`risk-v1/5`) and re-record its fixtures. The evidence format doesn't change. |
| `scene 2 can't run now: … reset with pnpm demo --scene 3b` | An interrupted take left the rogue key or a stale mandate. Run `pnpm demo --scene 3b`. |
| `… can't pay for a take` | Paste the printed address into the faucet, or run `pnpm demo --fund`. |
| `stop the validator services first` | Stop `pnpm --filter @attest8004/validator-mandate start` and `…validator-risk start`. |
| Scene 4: "the indexer is N block(s) behind" | The dashboard says so too, and fills in shortly. Every verdict is on chain regardless. |
| Ctrl-C mid-take | The runner prints the reset command. Run `pnpm demo --scene 3b` before the next take. |
