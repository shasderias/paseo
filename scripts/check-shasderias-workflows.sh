#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

expected_github=$(printf '%s\n' ci.yml shasderias-release.yml)
active_github=$(
  find .github/workflows -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) \
    -printf '%f\n' | sort
)

if [[ "$active_github" != "$expected_github" ]]; then
  printf 'Expected active GitHub workflows:\n%s\n' "$expected_github" >&2
  printf 'Found active GitHub workflows:\n%s\n' "${active_github:-(none)}" >&2
  exit 1
fi

active_eas=""
if [[ -d packages/app/.eas/workflows ]]; then
  active_eas=$(
    find packages/app/.eas/workflows -maxdepth 1 -type f \( -name '*.yml' -o -name '*.yaml' \) \
      -printf '%f\n' | sort
  )
fi

if [[ -n "$active_eas" ]]; then
  printf 'Unexpected active EAS workflows:\n%s\n' "$active_eas" >&2
  exit 1
fi

printf 'Shasderias workflow allowlist is valid\n'
