#!/usr/bin/env bash
# Runs a command up to <attempts> times, <delay-seconds> apart, until it succeeds (P12). CI uses it for the fork
# tests, whose only flake is the public Monad RPC's rate limit; a real failure fails every attempt, so the step still
# ends with the command's last exit code and the job goes red.
#
#   .github/scripts/retry.sh <attempts> <delay-seconds> -- <command…>
set -u
attempts=${1:?usage: retry.sh <attempts> <delay-seconds> -- <command…>}
delay=${2:?usage: retry.sh <attempts> <delay-seconds> -- <command…>}
shift 2
[[ "${1:-}" == "--" ]] && shift
status=1
for ((i = 1; i <= attempts; i++)); do
  "$@" && exit 0
  status=$?
  if ((i < attempts)); then
    echo "retry.sh: attempt $i of $attempts failed (exit $status); retrying in ${delay}s" >&2
    sleep "$delay"
  fi
done
echo "retry.sh: all $attempts attempts failed (last exit $status)" >&2
exit "$status"
