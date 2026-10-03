#!/usr/bin/env bash
# Recomputes the expected hashes in vectors.json with Foundry's cast, a third implementation
# that is independent of both the Solidity library and the TypeScript SDK they test.
#
#   ./vectors.sh          rewrite actionHash and requestHash for every vector
#   ./vectors.sh --check  exit 1 if any stored hash differs from cast's
#
# Needs cast and jq. The formulas are SPEC §4.3 (also stored at the top of vectors.json).
set -euo pipefail

cd "$(dirname "$0")"
file=vectors.json
check=0
[[ "${1:-}" == "--check" ]] && check=1

action_types="f(uint256,address,uint256,address,uint256,bytes32,uint64,bytes32)"
request_types="f(uint256,address,address,uint256,address,uint256,bytes32,uint64,bytes32)"

json=$(cat "$file")
count=$(jq '.vectors | length' <<<"$json")
mismatches=0

for ((i = 0; i < count; i++)); do
  v() { jq -r ".vectors[$i].$1" <<<"$json"; }
  name=$(v name)
  chain_id=$(v chainId)
  gate=$(v gate)
  validator=$(v validator)
  agent_id=$(v action.agentId)
  target=$(v action.target)
  value=$(v action.value)
  data=$(v action.data)
  deadline=$(v action.deadline)
  salt=$(v action.salt)

  data_hash=$(cast keccak "$data")
  action_hash=$(cast keccak "$(cast abi-encode "$action_types" \
    "$chain_id" "$gate" "$agent_id" "$target" "$value" "$data_hash" "$deadline" "$salt")")
  request_hash=$(cast keccak "$(cast abi-encode "$request_types" \
    "$chain_id" "$gate" "$validator" "$agent_id" "$target" "$value" "$data_hash" "$deadline" "$salt")")

  if ((check)); then
    if [[ "$(v actionHash)" != "$action_hash" || "$(v requestHash)" != "$request_hash" ]]; then
      echo "mismatch: $name" >&2
      mismatches=$((mismatches + 1))
    fi
  else
    json=$(jq --argjson i "$i" --arg a "$action_hash" --arg r "$request_hash" \
      '.vectors[$i].actionHash = $a | .vectors[$i].requestHash = $r' <<<"$json")
  fi
done

if ((check)); then
  ((mismatches == 0)) || exit 1
  echo "vectors.json: $count vectors match cast"
else
  jq . <<<"$json" >"$file"
  echo "vectors.json: wrote hashes for $count vectors"
fi
