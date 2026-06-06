#!/usr/bin/env bash
# Clear nous logs and session diffs only (preserves auth, config, DB, cache, state)

set -euo pipefail

XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"

log_dir="$XDG_DATA_HOME/nous/log"
session_diff_dir="$XDG_DATA_HOME/nous/storage/session_diff"
analysis_dir="$XDG_DATA_HOME/nous/analysis"

targets=()
[ -d "$log_dir" ] && targets+=("$log_dir")
[ -d "$session_diff_dir" ] && targets+=("$session_diff_dir")
[ -d "$analysis_dir" ] && targets+=("$analysis_dir")

if [ ${#targets[@]} -eq 0 ]; then
  echo "Nothing to clear."
  exit 0
fi

echo "The following will be cleared:"
for t in "${targets[@]}"; do
  echo "  - $t"
done

echo
read -r -p "Are you sure? [y/N] " confirm
if [[ "$confirm" != [yY] && "$confirm" != [yY][eE][sS] ]]; then
  echo "Aborted."
  exit 1
fi

echo
for t in "${targets[@]}"; do
  rm -rf "$t"/*
  echo "Cleared: $t"
done

echo
echo "Logs, session diffs and API analysis logs cleared. All other nous data preserved."
