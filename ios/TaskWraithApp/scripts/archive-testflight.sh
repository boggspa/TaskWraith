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
/usr/libexec/PlistBuddy -c 'Print :aps-environment' "$entitlements_path"
/usr/libexec/PlistBuddy -c 'Print :com.apple.security.application-groups' "$entitlements_path" >/dev/null 2>&1 || true

xcodebuild \
  -exportArchive \
  -archivePath "$archive_path" \
  -exportOptionsPlist "$export_options" \
  -exportPath "$export_path" \
  -allowProvisioningUpdates

echo "Archive: $archive_path"
echo "Export:  $export_path"
