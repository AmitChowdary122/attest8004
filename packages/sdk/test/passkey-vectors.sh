#!/usr/bin/env bash
# Recomputes the expected values in passkey-vectors.json with Foundry's cast and sha256sum, a
# third implementation that is independent of both the Solidity contract and the TypeScript SDK.
#
#   ./passkey-vectors.sh          rewrite every expected value
#   ./passkey-vectors.sh --check  exit 1 if any stored value differs from cast's
#
# Needs cast, jq, sha256sum, and xxd (or GNU basenc). The formulas are SPEC §4.2 (also stored in
# passkey-vectors.json).
set -euo pipefail

cd "$(dirname "$0")"
file=passkey-vectors.json
check=0
[[ "${1:-}" == "--check" ]] && check=1

# Hex (no 0x) on stdin to raw bytes on stdout.
hex2bin() { if command -v xxd >/dev/null; then xxd -r -p; else tr 'a-f' 'A-F' | basenc --base16 -d; fi; }
# sha256 of the bytes an 0x-hex string encodes, as 0x-hex.
sha256hex() { printf '%s' "${1#0x}" | hex2bin | sha256sum | cut -d' ' -f1 | sed 's/^/0x/'; }

json=$(cat "$file")
mismatches=0

# Compares (--check) or stores (rewrite) one computed value at a jq path.
put() {
  local path=$1 value=$2
  if ((check)); then
    if [[ "$(jq -r "$path" <<<"$json")" != "$value" ]]; then
      echo "mismatch: $path" >&2
      mismatches=$((mismatches + 1))
    fi
  else
    json=$(jq --arg v "$value" "$path = \$v" <<<"$json")
  fi
}
get() { jq -r "$1" <<<"$json"; }

# rpIdHash = sha256(rpId)
put .rpIdHash "0x$(printf '%s' "$(get .rpId)" | sha256sum | cut -d' ' -f1)"

# challenge = sha256(abi.encode(uint256 chainId, address registry, uint256 agentId, bytes32 changeHash, uint256 nonce))
count=$(get '.challenges | length')
for ((i = 0; i < count; i++)); do
  c=".challenges[$i]"
  encoded=$(cast abi-encode "f(uint256,address,uint256,bytes32,uint256)" \
    "$(get "$c.chainId")" "$(get "$c.registry")" "$(get "$c.agentId")" "$(get "$c.changeHash")" "$(get "$c.nonce")")
  put "$c.expected" "$(sha256hex "$encoded")"
done

# rotatePasskey: keccak256(abi.encode(ROTATE_PASSKEY, qx, qy)), ROTATE_PASSKEY = keccak256(tagPreimage)
tag=$(cast keccak "$(get .rotateChangeHash.tagPreimage)")
put .rotateChangeHash.tag "$tag"
put .rotateChangeHash.expected "$(cast keccak "$(cast abi-encode "f(bytes32,bytes32,bytes32)" \
  "$tag" "$(get .rotateChangeHash.qx)" "$(get .rotateChangeHash.qy)")")"

# setInboxKey: keccak256(abi.encode(SET_INBOX_KEY, x25519Pub)), SET_INBOX_KEY = keccak256(tagPreimage)
tag=$(cast keccak "$(get .inboxKeyChangeHash.tagPreimage)")
put .inboxKeyChangeHash.tag "$tag"
put .inboxKeyChangeHash.expected "$(cast keccak "$(cast abi-encode "f(bytes32,bytes32)" \
  "$tag" "$(get .inboxKeyChangeHash.x25519Pub)")")"

# The e2e mandate: mandateHash = keccak256(abi.encode(Mandate)), allowedTargets = [owner, demoPassThrough]
m=.e2eMandate
mandate="([$(get "$m.owner"),$(get "$m.demoPassThrough")],[$(get "$m.allowedSelectors | join(\",\")")],$(get "$m.maxValuePerTx"),$(get "$m.maxValuePerDay"),$(get "$m.validUntil"))"
put "$m.mandateHash" "$(cast keccak "$(cast abi-encode "f((address[],bytes4[],uint256,uint256,uint64))" "$mandate")")"

# Function and error selectors, event topics.
for name in $(get '.selectors | keys[]'); do
  put ".selectors.$name.selector" "$(cast sig "$(get ".selectors.$name.signature")")"
done
for name in $(get '.topics | keys[]'); do
  put ".topics.$name.topic0" "$(cast keccak "$(get ".topics.$name.signature")")"
done

if ((check)); then
  ((mismatches == 0)) || exit 1
  echo "passkey-vectors.json: $count challenges, both change hashes, the e2e mandate, $(get '.selectors | length') selectors and $(get '.topics | length') topics match cast"
else
  jq . <<<"$json" >"$file"
  echo "passkey-vectors.json: wrote expected values"
fi
