#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "$script_dir/.." && pwd)"
project_yml="$app_dir/project.yml"

current="$(
  awk -F'"' '/CURRENT_PROJECT_VERSION:/ { print $2; exit }' "$project_yml"
)"
if [[ -z "$current" || ! "$current" =~ ^[0-9]+$ ]]; then
  echo "Could not read numeric CURRENT_PROJECT_VERSION from $project_yml" >&2
  exit 1
fi

next="${1:-$((current + 1))}"
if [[ ! "$next" =~ ^[0-9]+$ || "$next" -le "$current" ]]; then
  echo "Build number must be numeric and greater than current build $current" >&2
  exit 1
fi

perl -0pi -e "s/CURRENT_PROJECT_VERSION: \"$current\"/CURRENT_PROJECT_VERSION: \"$next\"/g" "$project_yml"

if command -v xcodegen >/dev/null 2>&1; then
  (cd "$app_dir" && xcodegen generate)
else
  echo "xcodegen not found; run 'brew install xcodegen' then regenerate before archiving." >&2
fi

echo "Bumped TaskWraith iOS build $current -> $next"
