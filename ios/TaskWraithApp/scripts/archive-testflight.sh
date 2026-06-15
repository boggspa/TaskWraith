#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "$script_dir/.." && pwd)"
team_id="${TASKWRAITH_APPLE_TEAM_ID:-}"

if [[ -z "$team_id" ]]; then
  echo "Set TASKWRAITH_APPLE_TEAM_ID to your Apple Developer Team ID." >&2
  exit 1
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is required. Install with: brew install xcodegen" >&2
  exit 1
fi

cd "$app_dir"
xcodegen generate

version="$(awk -F'"' '/MARKETING_VERSION:/ { print $2; exit }' project.yml)"
build="$(awk -F'"' '/CURRENT_PROJECT_VERSION:/ { print $2; exit }' project.yml)"
if [[ -z "$version" || -z "$build" ]]; then
  echo "Could not read MARKETING_VERSION/CURRENT_PROJECT_VERSION from project.yml" >&2
  exit 1
fi

mkdir -p build/archives build/export
archive_path="$app_dir/build/archives/TaskWraith-${version}-${build}.xcarchive"
export_path="$app_dir/build/export/TaskWraith-${version}-${build}"
export_options="$(mktemp "${TMPDIR:-/tmp}/TaskWraithExportOptions.XXXXXX.plist")"
trap 'rm -f "$export_options"' EXIT

sed "s/__TEAM_ID__/$team_id/g" ExportOptions-AppStore.plist > "$export_options"

xcodebuild \
  -project TaskWraith.xcodeproj \
  -scheme TaskWraith \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive_path" \
  DEVELOPMENT_TEAM="$team_id" \
  -allowProvisioningUpdates \
  clean archive

app_path="$archive_path/Products/Applications/TaskWraith.app"
entitlements_path="$app_dir/build/archives/TaskWraith-${version}-${build}-entitlements.plist"
codesign -d --entitlements :- "$app_path" > "$entitlements_path"
archive_aps_env="$(/usr/libexec/PlistBuddy -c 'Print :aps-environment' "$entitlements_path" 2>/dev/null || true)"
archive_get_task_allow="$(/usr/libexec/PlistBuddy -c 'Print :get-task-allow' "$entitlements_path" 2>/dev/null || true)"
echo "Archive aps-environment: ${archive_aps_env:-<missing>}"
echo "Archive get-task-allow: ${archive_get_task_allow:-<missing>}"
/usr/libexec/PlistBuddy -c 'Print :com.apple.security.application-groups' "$entitlements_path" >/dev/null 2>&1 || true

xcodebuild \
  -exportArchive \
  -archivePath "$archive_path" \
  -exportOptionsPlist "$export_options" \
  -exportPath "$export_path" \
  -allowProvisioningUpdates

ipa_path="$(find "$export_path" -maxdepth 1 -name '*.ipa' -print -quit)"
if [[ -z "$ipa_path" ]]; then
  echo "Export succeeded but no .ipa was found under $export_path" >&2
  exit 1
fi

ipa_tmp="$(mktemp -d "${TMPDIR:-/tmp}/TaskWraithIpa.XXXXXX")"
trap 'rm -f "$export_options"; rm -rf "$ipa_tmp"' EXIT
ditto -xk "$ipa_path" "$ipa_tmp"
exported_app_path="$ipa_tmp/Payload/TaskWraith.app"
exported_entitlements_path="$app_dir/build/export/TaskWraith-${version}-${build}-exported-entitlements.plist"
codesign -d --entitlements :- "$exported_app_path" > "$exported_entitlements_path"
exported_aps_env="$(/usr/libexec/PlistBuddy -c 'Print :aps-environment' "$exported_entitlements_path" 2>/dev/null || true)"
exported_get_task_allow="$(/usr/libexec/PlistBuddy -c 'Print :get-task-allow' "$exported_entitlements_path" 2>/dev/null || true)"
echo "Exported aps-environment: ${exported_aps_env:-<missing>}"
echo "Exported get-task-allow: ${exported_get_task_allow:-<missing>}"

if [[ "$exported_aps_env" != "production" ]]; then
  echo "Expected exported aps-environment=production, got '${exported_aps_env:-<missing>}'." >&2
  exit 1
fi

if [[ "$exported_get_task_allow" == "true" || "$exported_get_task_allow" == "1" ]]; then
  echo "Expected exported get-task-allow to be false or absent, got '$exported_get_task_allow'." >&2
  exit 1
fi

echo "Archive: $archive_path"
echo "Export:  $export_path"
