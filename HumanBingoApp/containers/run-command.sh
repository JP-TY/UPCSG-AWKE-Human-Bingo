#!/bin/sh
set -eu
if [ -z "${API_START_COMMAND:-}" ] && [ -z "${WORKER_START_COMMAND:-}" ]; then
  echo 'Set API_START_COMMAND or WORKER_START_COMMAND to the reviewed runtime adapter.' >&2
  exit 78
fi
if [ -n "${API_START_COMMAND:-}" ]; then
  exec sh -c "$API_START_COMMAND"
fi
exec sh -c "$WORKER_START_COMMAND"
