#!/usr/bin/env bash
set -eo pipefail

cd "$(dirname "$0")/packages/opencode"

BUILD=false

for arg in "$@"; do
  if [ "$arg" = "--build" ]; then
    BUILD=true
    break
  fi
done

if [ "$BUILD" = true ]; then
  bun run build "$@"
else
  bun run bundle:share "$@"
fi
