# cre: validator C, a Chainlink CRE workflow

Validator C runs Attest8004's deterministic `mandate-v1` check with [Chainlink CRE](https://docs.chain.link/cre) as
its orchestration layer. The workflow is in [`validator-c/`](./validator-c/), and the full account is in
[`../docs/cre.md`](../docs/cre.md). **C is a CRE workflow (simulation forwarder, not a trust root).**

| Path | What |
|---|---|
| `project.yaml` | The CLI target `monad-testnet-sim`: Monad testnet's public RPC. No keys here |
| `mise.toml` | Bun 1.3.14, which the CLI's TypeScript compiler needs (`mise exec -- …`) |
| `validator-c/workflow.yaml` | `workflow-name: "attest8004-validator-c"` (its sha256 prefix is `CreValidator.workflowName()`) |
| `validator-c/config.monad-testnet.json` | CreValidator, the forwarder, the registry, `/evaluate`'s URL, the served (gate, agent) pairs, the pin lag, the evidence cap, the poll budget and the gas model; `scripts/src/cre-config.test.ts` pins it to the repo |
| `validator-c/main.ts`, `src/` | The workflow: `workflow.ts` wires CRE's capabilities; the checks in `trigger.ts`, `request.ts`, `evidence.ts`, `report.ts` and `gas.ts` are pure; `polyfills.ts` adds the `atob`/`btoa` CRE's QuickJS lacks |
| `validator-c/test/` | `bun test`: the pure checks on a real request log and validator A's real evidence, and the handler against the CRE SDK's capability mocks |

This is a Bun project outside the pnpm workspace; CI's `cre` job runs its tests, its typecheck and its WASM build.

Run it from the repo root: `pnpm cre:demo` (the preflight alone: `pnpm cre:demo -- --preflight`). Or by hand from this
directory:

```bash
CRE_ETH_PRIVATE_KEY=… mise exec -- cre workflow simulate validator-c --target monad-testnet-sim --non-interactive --broadcast --trigger-index 0 --evm-tx-hash <request tx> --evm-event-index <i>
```

This needs `cre login` and the read-only `/evaluate` running: `pnpm --filter @attest8004/validator-mandate evaluate`.
