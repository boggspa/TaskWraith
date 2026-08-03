#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app_dir="$(cd "$script_dir/.." && pwd)"
repo_root="$(cd "$app_dir/../.." && pwd)"
team_id="${TASKWRAITH_APPLE_TEAM_ID:-}"
asc_key_id="${ASC_API_KEY_ID:-}"
asc_issuer_id="${ASC_API_ISSUER_ID:-}"
asc_key_path="${ASC_API_KEY_PATH:-}"
unsigned_archive="${TASKWRAITH_IOS_UNSIGNED_ARCHIVE:-0}"
distribution_sign_identity="${TASKWRAITH_IOS_DISTRIBUTION_SIGN_IDENTITY:-Apple Distribution}"

if [[ -z "$team_id" ]]; then
  echo "Set TASKWRAITH_APPLE_TEAM_ID to your Apple Developer Team ID." >&2
  exit 1
fi

xcode_auth_args=()
if [[ -n "$asc_key_id" || -n "$asc_issuer_id" || -n "$asc_key_path" ]]; then
  if [[ -z "$asc_key_id" || -z "$asc_issuer_id" || -z "$asc_key_path" ]]; then
    echo "Set ASC_API_KEY_ID, ASC_API_ISSUER_ID, and ASC_API_KEY_PATH together for Xcode automatic provisioning." >&2
    exit 1
  fi
  if [[ ! -f "$asc_key_path" ]]; then
    echo "ASC_API_KEY_PATH does not exist: $asc_key_path" >&2
    exit 1
  fi
  xcode_auth_args=(
    -authenticationKeyPath "$asc_key_path"
    -authenticationKeyID "$asc_key_id"
    -authenticationKeyIssuerID "$asc_issuer_id"
  )
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is required. Install with: brew install xcodegen" >&2
  exit 1
fi

node "$repo_root/scripts/ios-third-party-notices.cjs"

cd "$app_dir"
xcodegen generate

verify_bundled_notice() {
  bundle_root="$1"
  notice_name="$2"
  expected_path="$3"
  match_count="$(find "$bundle_root" -type f -name "$notice_name" -print | awk 'END { print NR }')"
  if [[ "$match_count" != "1" ]]; then
    echo "Expected exactly one bundled $notice_name under $bundle_root; found $match_count." >&2
    exit 1
  fi
  bundled_path="$(find "$bundle_root" -type f -name "$notice_name" -print -quit)"
  if ! cmp -s "$expected_path" "$bundled_path"; then
    echo "Bundled $notice_name does not match the release-verified source." >&2
    exit 1
  fi
}

# Read a scalar from project.yml regardless of how YAML happens to quote it.
# This used to split on a literal double quote, which meant a formatting pass
# that rewrote "85" as '85' silently broke the archive — and only at archive
# time, long after every gate had gone green. Accept double-quoted,
# single-quoted, and bare scalars so the value survives the next reformat.
read_project_scalar() {
  sed -nE "s/^[[:space:]]*$1:[[:space:]]*['\"]?([^'\"[:space:]]+)['\"]?[[:space:]]*$/\1/p" \
    project.yml | head -n 1
}

version="$(read_project_scalar MARKETING_VERSION)"
build="$(read_project_scalar CURRENT_PROJECT_VERSION)"
if [[ -z "$version" || -z "$build" ]]; then
  echo "Could not read MARKETING_VERSION/CURRENT_PROJECT_VERSION from project.yml" >&2
  exit 1
fi

mkdir -p build/archives build/export
archive_path="$app_dir/build/archives/TaskWraith-${version}-${build}.xcarchive"
export_path="$app_dir/build/export/TaskWraith-${version}-${build}"
export_options="$(mktemp "${TMPDIR:-/tmp}/TaskWraithExportOptions.XXXXXX")"
mv "$export_options" "$export_options.plist"
export_options="$export_options.plist"
app_entitlements_path=""
extension_entitlements_path=""
ipa_tmp=""
trap 'rm -f "$export_options" "$app_entitlements_path" "$extension_entitlements_path"; if [[ -n "${ipa_tmp:-}" ]]; then rm -rf "$ipa_tmp"; fi' EXIT

sed "s/__TEAM_ID__/$team_id/g" ExportOptions-AppStore.plist > "$export_options"

archive_build_settings=(DEVELOPMENT_TEAM="$team_id")
if [[ "$unsigned_archive" == "1" || "$unsigned_archive" == "true" ]]; then
  archive_build_settings+=(CODE_SIGNING_ALLOWED=NO)
fi

xcodebuild \
  -project TaskWraith.xcodeproj \
  -scheme TaskWraith \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive_path" \
  "${archive_build_settings[@]}" \
  -allowProvisioningUpdates \
  "${xcode_auth_args[@]}" \
  clean archive

app_path="$archive_path/Products/Applications/TaskWraith.app"
verify_bundled_notice \
  "$app_path" \
  "TASKWRAITH-LICENSE.txt" \
  "$repo_root/ios/TaskWraithKit/Sources/TaskWraithUI/Resources/TASKWRAITH-LICENSE.txt"
verify_bundled_notice \
  "$app_path" \
  "THIRD-PARTY-NOTICES.txt" \
  "$repo_root/ios/TaskWraithKit/Sources/TaskWraithUI/Resources/THIRD-PARTY-NOTICES.txt"
if [[ "$unsigned_archive" == "1" || "$unsigned_archive" == "true" ]]; then
  app_entitlements_path="$(mktemp "${TMPDIR:-/tmp}/TaskWraithAppEntitlements.XXXXXX").plist"
  extension_entitlements_path="$(mktemp "${TMPDIR:-/tmp}/TaskWraithExtensionEntitlements.XXXXXX").plist"

  /usr/libexec/PlistBuddy \
    -c 'Clear dict' \
    -c 'Add :aps-environment string production' \
    -c 'Add :com.apple.security.application-groups array' \
    -c 'Add :com.apple.security.application-groups:0 string group.com.TaskWraith.companion' \
    -c 'Add :keychain-access-groups array' \
    -c "Add :keychain-access-groups:0 string ${team_id}.com.taskwraith.companion" \
    -c "Add :keychain-access-groups:1 string ${team_id}.com.taskwraith.companion.shared" \
    "$app_entitlements_path" >/dev/null
  /usr/libexec/PlistBuddy \
    -c 'Clear dict' \
    -c 'Add :com.apple.security.application-groups array' \
    -c 'Add :com.apple.security.application-groups:0 string group.com.TaskWraith.companion' \
    -c 'Add :keychain-access-groups array' \
    -c "Add :keychain-access-groups:0 string ${team_id}.com.taskwraith.companion.shared" \
    "$extension_entitlements_path" >/dev/null

  codesign --force --sign "$distribution_sign_identity" \
    --entitlements "$extension_entitlements_path" \
    "$app_path/PlugIns/TaskWraithNotificationService.appex"
  codesign --force --sign "$distribution_sign_identity" \
    --entitlements "$app_entitlements_path" \
    "$app_path"
fi
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
  -allowProvisioningUpdates \
  "${xcode_auth_args[@]}"

ipa_path="$(find "$export_path" -maxdepth 1 -name '*.ipa' -print -quit)"
if [[ -z "$ipa_path" ]]; then
  echo "Export succeeded but no .ipa was found under $export_path" >&2
  exit 1
fi

ipa_tmp="$(mktemp -d "${TMPDIR:-/tmp}/TaskWraithIpa.XXXXXX")"
ditto -xk "$ipa_path" "$ipa_tmp"
exported_app_path="$ipa_tmp/Payload/TaskWraith.app"
verify_bundled_notice \
  "$exported_app_path" \
  "TASKWRAITH-LICENSE.txt" \
  "$repo_root/ios/TaskWraithKit/Sources/TaskWraithUI/Resources/TASKWRAITH-LICENSE.txt"
verify_bundled_notice \
  "$exported_app_path" \
  "THIRD-PARTY-NOTICES.txt" \
  "$repo_root/ios/TaskWraithKit/Sources/TaskWraithUI/Resources/THIRD-PARTY-NOTICES.txt"
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
