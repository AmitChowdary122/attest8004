# cre (stretch)

Chainlink CRE workflow (SPEC §4.11): a log trigger on `ValidationRequest`, an HTTP call to the
`mandate-v1` logic, and an EVM write of `validationResponse`, run with
`cre workflow simulate --broadcast` on Monad testnet.

**Built only if the 8 Oct gate passes** (the whole demo flow works on testnet). Otherwise it is cut.
