#!/usr/bin/env bash
# Deploys ValidationRegistry to Monad testnet through the CREATE2 factory.
#
#   ./script/deploy-testnet.sh               # dry run: no transaction is sent
#   BROADCAST=1 ./script/deploy-testnet.sh   # send the transaction
#
# Reads DEPLOYER_PRIVATE_KEY and MONAD_TESTNET_RPC_URL from the repo's .env as environment
# variables. Never prints them: no `set -x`, and no forge -v flags (traces can echo values).
# --skip-simulation keeps the literal gas limit set in the script (DEPLOY_GAS); forge's
# on-chain simulation would replace it with its own estimate.
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
. ../.env
set +a
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is not set in .env}"
: "${MONAD_TESTNET_RPC_URL:?MONAD_TESTNET_RPC_URL is not set in .env}"

args=(
  script script/DeployValidationRegistry.s.sol
  --rpc-url "$MONAD_TESTNET_RPC_URL"
  --skip-simulation
  --slow
  --private-key "$DEPLOYER_PRIVATE_KEY"
)
if [[ "${BROADCAST:-0}" == "1" ]]; then
  args+=(--broadcast)
fi

exec forge "${args[@]}"
