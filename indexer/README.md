# indexer

The Envio HyperIndex (V3) indexer behind Attest8004's trust API (SPEC §4.8, ARCHITECTURE §5.7 and §6). It indexes
every Attest8004 contract on Monad testnet (10143), each from its deploy block, and the canonical ERC-8004 Identity
Registry's ownership events for the agents that use them. **A convenience, never a trust root:** no verdict and no
`verify` reads it, and every record carries the transaction it came from.

| File | What |
|---|---|
| `config.yaml` | The chain, each contract's address and start block, and each event by its signature (held to the SDK's `DEPLOYMENTS`, `docs/deployments.md` and ABIs by `test/config.test.ts`) |
| `schema.graphql` | The entities: requests with their latest verdicts, responses, validators, agents, mandates, passkeys, inbox keys, permission events, operator-report posts, executed actions, and per-agent summaries |
| `src/handlers/` | One file per contract (`indexer.onEvent`), plus `shared.ts` (agents, summaries, validator stats) |
| `src/lib/` | Pure decoders: the request JSON and the evidence, read the validators' way and checked against their hashes (`test/lib.test.ts` holds them to the SDK's hash vectors); MandateRegistry epochs; score buckets |
| `scripts/envio.mjs` | Runs `envio` with `ENVIO_API_TOKEN` read from the repo's `.env` (that line only, never printed) |
| `test/` | Handler tests with Envio's test framework (`createTestIndexer`, simulated events; no Docker, no token), and a test that every field the SDK queries exists in the schema |

**Run it locally** (Docker, and a free HyperSync token in `.env` as `ENVIO_API_TOKEN`):

```bash
pnpm --filter @attest8004/indexer dev     # syncs Monad testnet; GraphQL at http://localhost:8080/v1/graphql
pnpm --filter @attest8004/indexer test    # codegen, then the handler tests
pnpm --filter @attest8004/scripts indexer-check -- --url http://localhost:8080/v1/graphql
```

**Hosted:** Envio Cloud's free plan builds this folder alone (pnpm 10.32, Node 24, no lockfile), so `package.json`
pins exact versions, declares no package manager, and nothing in `src/` imports from outside `indexer/`. It deploys
from the `envio` branch; each deployment gets a new GraphQL URL, recorded in `DEPLOYMENTS[10143].trustApi`,
`web/vercel.json`'s CSP and `docs/deployments.md` (which also says how to redeploy).

**Licence:** our code here is MIT. The `envio` package is under Envio's own licences (not OSI; see its
`licenses/README.md`), credited in the root README.
