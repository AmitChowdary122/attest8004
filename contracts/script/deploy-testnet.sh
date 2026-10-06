#!/usr/bin/env bash
# Deploys an Attest8004 contract to Monad testnet through the CREATE2 factory.
#
#   ./script/deploy-testnet.sh <Contract>               # dry run: no transaction is sent
#   BROADCAST=1 ./script/deploy-testnet.sh <Contract>   # send the transaction
#
# <Contract> is ValidationRegistry, AgentRequestForwarder, MandateRegistry, DemoAgentVault, CreValidator,
# DemoPassThrough or FindingsBoard; the script is script/Deploy<Contract>.s.sol, which must provide run() and
# deployPlan(uint256 chainId).
#
# Reads DEPLOYER_PRIVATE_KEY, MONAD_TESTNET_RPC_URL and DEPLOYER_ADDRESS from the repo's .env (or ENV_FILE), and
# nothing else: the file is never sourced, so no other secret reaches forge or cast (P12, AUD-07). The key reaches
# forge only through its environment (the Deploy scripts' run() reads it with vm.envUint), never its command line,
# where any local user could read it with `ps`; the RPC URL goes through foundry.toml's `monad_testnet` alias, which
# reads MONAD_TESTNET_RPC_URL from the environment. Never prints them: no `set -x`, and no forge -v flags (traces can
# echo values).
# --skip-simulation keeps the literal gas limit set in the script (DEPLOY_GAS); forge's
# on-chain simulation would replace it with its own estimate. So before forge runs, this
# wrapper asks the node for eth_estimateGas of the exact deploy call (deployPlan) and stops
# if the estimate is above the limit: Monad charges the full limit even when a tx runs out of gas.
set -euo pipefail

name="${1:?usage: deploy-testnet.sh <ValidationRegistry|AgentRequestForwarder|MandateRegistry|DemoAgentVault|DemoPassThrough|FindingsBoard|CreValidator>}"
cd "$(dirname "$0")/.."
script="script/Deploy${name}.s.sol"
[[ -f "$script" ]] || { echo "no deploy script $script" >&2; exit 1; }

env_file="${ENV_FILE:-../.env}"
[[ -f "$env_file" ]] || { echo "no env file at $env_file" >&2; exit 1; }
# One variable's value from the env file (the last assignment; surrounding quotes removed), without sourcing it.
env_value() {
  sed -n "s/^$1=//p" "$env_file" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}
deployer_key=$(env_value DEPLOYER_PRIVATE_KEY)
MONAD_TESTNET_RPC_URL=$(env_value MONAD_TESTNET_RPC_URL)
DEPLOYER_ADDRESS=$(env_value DEPLOYER_ADDRESS)
: "${deployer_key:?DEPLOYER_PRIVATE_KEY is not set in $env_file}"
: "${MONAD_TESTNET_RPC_URL:?MONAD_TESTNET_RPC_URL is not set in $env_file}"
: "${DEPLOYER_ADDRESS:?DEPLOYER_ADDRESS is not set in $env_file}"
export MONAD_TESTNET_RPC_URL
rpc=(--rpc-url monad_testnet)

chain_id=$(cast chain-id "${rpc[@]}")
plan=$(forge script "$script" --sig "deployPlan(uint256)" "$chain_id" --json \
  | grep '^{' | tail -n 1)
to=$(jq -r '.returns.to.value' <<<"$plan")
data=$(jq -r '.returns.data.value' <<<"$plan")
gas_limit=$(jq -r '.returns.gasLimit.value' <<<"$plan")
predicted=$(jq -r '.returns.predicted.value' <<<"$plan")

if [[ "$(cast code "$predicted" "${rpc[@]}")" != "0x" ]]; then
  echo "gas guard: $name already deployed at $predicted; the script will not send a deploy"
else
  estimate=$(cast estimate "$to" "$data" --from "$DEPLOYER_ADDRESS" "${rpc[@]}")
  if ((estimate > gas_limit)); then
    echo "gas guard: eth_estimateGas $estimate is above DEPLOY_GAS $gas_limit; raise DEPLOY_GAS in the script" >&2
    exit 1
  fi
  echo "gas guard: eth_estimateGas $estimate <= DEPLOY_GAS $gas_limit"
fi

args=(
  script "$script"
  "${rpc[@]}"
  --skip-simulation
  --slow
)
if [[ "${BROADCAST:-0}" == "1" ]]; then
  args+=(--broadcast)
fi

DEPLOYER_PRIVATE_KEY="$deployer_key" exec forge "${args[@]}"
