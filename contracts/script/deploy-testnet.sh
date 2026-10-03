#!/usr/bin/env bash
# Deploys an Attest8004 contract to Monad testnet through the CREATE2 factory.
#
#   ./script/deploy-testnet.sh <Contract>               # dry run: no transaction is sent
#   BROADCAST=1 ./script/deploy-testnet.sh <Contract>   # send the transaction
#
# <Contract> is ValidationRegistry, AgentRequestForwarder, MandateRegistry or DemoAgentVault; the
# script is script/Deploy<Contract>.s.sol, which must provide run() and deployPlan(uint256 chainId).
#
# Reads DEPLOYER_PRIVATE_KEY and MONAD_TESTNET_RPC_URL from the repo's .env as environment
# variables. Never prints them: no `set -x`, and no forge -v flags (traces can echo values).
# --skip-simulation keeps the literal gas limit set in the script (DEPLOY_GAS); forge's
# on-chain simulation would replace it with its own estimate. So before forge runs, this
# wrapper asks the node for eth_estimateGas of the exact deploy call (deployPlan) and stops
# if the estimate is above the limit: Monad charges the full limit even when a tx runs out of gas.
set -euo pipefail

name="${1:?usage: deploy-testnet.sh <ValidationRegistry|AgentRequestForwarder|MandateRegistry|DemoAgentVault>}"
cd "$(dirname "$0")/.."
script="script/Deploy${name}.s.sol"
[[ -f "$script" ]] || { echo "no deploy script $script" >&2; exit 1; }

set -a
# shellcheck disable=SC1091
. ../.env
set +a
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is not set in .env}"
: "${MONAD_TESTNET_RPC_URL:?MONAD_TESTNET_RPC_URL is not set in .env}"
: "${DEPLOYER_ADDRESS:?DEPLOYER_ADDRESS is not set in .env}"

chain_id=$(cast chain-id --rpc-url "$MONAD_TESTNET_RPC_URL")
plan=$(forge script "$script" --sig "deployPlan(uint256)" "$chain_id" --json \
  | grep '^{' | tail -n 1)
to=$(jq -r '.returns.to.value' <<<"$plan")
data=$(jq -r '.returns.data.value' <<<"$plan")
gas_limit=$(jq -r '.returns.gasLimit.value' <<<"$plan")
predicted=$(jq -r '.returns.predicted.value' <<<"$plan")

if [[ "$(cast code "$predicted" --rpc-url "$MONAD_TESTNET_RPC_URL")" != "0x" ]]; then
  echo "gas guard: $name already deployed at $predicted; the script will not send a deploy"
else
  estimate=$(cast estimate "$to" "$data" --from "$DEPLOYER_ADDRESS" --rpc-url "$MONAD_TESTNET_RPC_URL")
  if ((estimate > gas_limit)); then
    echo "gas guard: eth_estimateGas $estimate is above DEPLOY_GAS $gas_limit; raise DEPLOY_GAS in the script" >&2
    exit 1
  fi
  echo "gas guard: eth_estimateGas $estimate <= DEPLOY_GAS $gas_limit"
fi

args=(
  script "$script"
  --rpc-url "$MONAD_TESTNET_RPC_URL"
  --skip-simulation
  --slow
  --private-key "$DEPLOYER_PRIVATE_KEY"
)
if [[ "${BROADCAST:-0}" == "1" ]]; then
  args+=(--broadcast)
fi

exec forge "${args[@]}"
