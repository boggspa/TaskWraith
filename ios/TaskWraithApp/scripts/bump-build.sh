#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "$script_dir/.." && pwd)"
project_yml="${TASKWRAITH_IOS_PROJECT_YML:-$app_dir/project.yml}"

read_project_builds() {
  sed -nE "s/^[[:space:]]*CURRENT_PROJECT_VERSION:[[:space:]]*['\"]?([^'\"[:space:]]+)['\"]?[[:space:]]*$/\1/p" \
    "$project_yml"
}

current_values=()
while IFS= read -r value; do
  current_values+=("$value")
done < <(read_project_builds)

if [[ "${#current_values[@]}" -eq 0 ]]; then
  echo "Could not read numeric CURRENT_PROJECT_VERSION from $project_yml" >&2
  exit 1
fi
current="${current_values[0]}"
for value in "${current_values[@]}"; do
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    echo "Could not read numeric CURRENT_PROJECT_VERSION from $project_yml" >&2
    exit 1
  fi
  if [[ "$value" != "$current" ]]; then
    echo "CURRENT_PROJECT_VERSION values disagree in $project_yml; refusing a partial bump." >&2
    exit 1
  fi
done

next="${1:-$((current + 1))}"
if [[ ! "$next" =~ ^[0-9]+$ || "$next" -le "$current" ]]; then
  echo "Build number must be numeric and greater than current build $current" >&2
  exit 1
fi

TASKWRAITH_NEXT_BUILD="$next" perl -0pi -e \
  's/^([ \t]*CURRENT_PROJECT_VERSION:[ \t]*)(["\x27]?)([0-9]+)\2([ \t]*)$/$1 . $2 . $ENV{TASKWRAITH_NEXT_BUILD} . $2 . $4/mge' \
  "$project_yml"

updated_values=()
while IFS= read -r value; do
  updated_values+=("$value")
done < <(read_project_builds)
if [[ "${#updated_values[@]}" -ne "${#current_values[@]}" ]]; then
  echo "Build bump changed the number of CURRENT_PROJECT_VERSION values in $project_yml" >&2
  exit 1
fi
for value in "${updated_values[@]}"; do
  if [[ "$value" != "$next" ]]; then
    echo "Build bump did not update every CURRENT_PROJECT_VERSION in $project_yml" >&2
    exit 1
  fi
done

if command -v xcodegen >/dev/null 2>&1; then
  (cd "$app_dir" && xcodegen generate)
else
  echo "xcodegen not found; run 'brew install xcodegen' then regenerate before archiving." >&2
fi

echo "Bumped TaskWraith iOS build $current -> $next"
