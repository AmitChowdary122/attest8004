# Nansen endpoints

`risk-v1` uses Nansen for counterparty profiles and fund flows (SPEC §4.6), through two of its seven
read-only tools: `nansen_counterparty_profile(address)` and `nansen_flows(address)`. The Nansen
bounty requires naming every endpoint and data category used, so this list must stay exact. It is
mirrored in the [README](../README.md#nansen-endpoints). Read from docs.nansen.ai on 4 Oct 2026.

Base URL `https://api.nansen.ai`, key in an `apikey` header, every call a POST with a JSON body.

| Endpoint | Data category | Validator tool | Access | Credits |
|---|---|---|---|---|
| `POST /api/v1/profiler/address/labels` | Entity and behavioural labels | `nansen_counterparty_profile` | API key only (**not** payable by x402) | 100 |
| `POST /api/v1/profiler/address/first-funder` | Funding origin (who first funded this address) | `nansen_counterparty_profile` | API key, or x402 at $0.01 | 1 |
| `POST /api/v1/profiler/address/counterparties` | Counterparty volumes in and out, with labels | `nansen_flows` | API key, or x402 at $0.05 | 5 |

`nansen_counterparty_profile` calls the first two endpoints (labels, then first-funder); `nansen_flows`
calls the third, over the 30 days ending at the pinned block `P`'s time (`RISK_V1.nansenWindowSeconds`).

**Why `chain: "all"`.** Monad testnet isn't indexed by Nansen. Every call sends `chain: "all"`, which
searches the same EVM address across every chain Nansen *does* index — including Monad mainnet
(`monad`) — rather than failing outright on a chain it doesn't have. So a counterparty's Monad testnet
activity is invisible to Nansen, but its history on any indexed chain (Ethereum, Monad mainnet, …)
still surfaces.

**Status: integrated; unused until `NANSEN_API_KEY` is set.** Both tools are always offered to the
model. Without a key (today), `nansenClient` reports itself unavailable and both tools answer
`{available: false, reason: "NANSEN_API_KEY is not set"}` without ever calling Nansen — `fetch` is
never invoked, no credits are spent, and the model is told up front that they're unavailable. With a
key, a Nansen error (rate limit, insufficient credits, a network failure, …) becomes ordinary tool
output (`{available: false, reason: "NANSEN_ERROR <status> <code>"}`), never a check failure — Nansen
is advisory and, unlike the five onchain tools, its calls can't be re-run by `verify` (they're
reported `unchecked`). Every verdict's evidence records whether Nansen was available for that run
(`tools.nansen`), so a verdict never silently claims Nansen data it didn't have. No "Qwen" or
Nansen-sourced claim is made about a past verdict unless Nansen was actually available for it.

**Cost per check, with a key.** The model may call each Nansen tool at most once per check (the tool
loop is capped at 8 calls total, shared with the five onchain tools): `nansen_counterparty_profile`
costs up to 101 credits (100 for labels + 1 for first-funder) and `nansen_flows` costs 5, so **at most
106 credits** for a check that uses both. The free plan's 10-credits-a-day allowance after the trial
credits run out means this would exhaust it in under one check — a key is a deliberate upgrade
decision, not a prerequisite for shipping `risk-v1` today.

Every Nansen-sourced string this validator ever surfaces (an entity `label`, a `first_funder_name`, a
counterparty label) is capped at 64 characters and screened by Prompt Guard before the model sees it,
exactly like any other untrusted text (SPEC "Prompt-injection defence").
