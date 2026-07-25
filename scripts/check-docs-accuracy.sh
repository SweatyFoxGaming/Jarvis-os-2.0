#!/usr/bin/env bash
# Catches the specific failure mode a review of this codebase found live:
# README.md's "Project structure" section described directories
# (src/execution/, src/observation/, src/integrations/, src/data/,
# src/static/) that had been renamed/reorganized out of existence, while the
# README's own test-count claim drifted ~10x out of date. Neither was
# caught by anything — this is that catch, run in CI on every push. Fails
# loudly and specifically (which directory, expected where) rather than
# leaving doc drift to be found by whoever reads the README next and trusts
# it.
set -euo pipefail
cd "$(dirname "$0")/.."

# One entry per top-level src/ subdirectory the README's "Project structure"
# section documents — keep this list in sync with that section when either
# changes, the same way the section itself should stay in sync with reality.
EXPECTED_SRC_DIRS=(kernel cognition executive adaptation capabilities interaction runtime self world)

missing=()
for dir in "${EXPECTED_SRC_DIRS[@]}"; do
  if [ ! -d "src/$dir" ]; then
    missing+=("src/$dir")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "README.md's 'Project structure' section documents director(y/ies) that no longer exist:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  echo "Update README.md's 'Project structure' section (and this script's EXPECTED_SRC_DIRS) to match." >&2
  exit 1
fi

echo "Docs accuracy check passed: all ${#EXPECTED_SRC_DIRS[@]} directories documented in README.md's 'Project structure' section exist."
