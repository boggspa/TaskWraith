#!/usr/bin/env bash
# App Store screenshot run — executes TaskWraithScreenshotUITests (offline
# demo mode, no pairing needed) on the App Store Connect device classes and
# exports the captured attachments per device into screenshots/<device>/.
#
# Usage:
#   scripts/appstore-screenshots.sh
#   TW_SCREENSHOT_DEVICES="iPhone 16 Pro Max" scripts/appstore-screenshots.sh
#
# Prereqs: `xcodegen` has generated TaskWraith.xcodeproj (see README), and the
# named simulators exist for an installed runtime (`xcrun simctl list devices`).
# ASC 2026 classes covered by the defaults: 6.9" iPhone + 13" iPad.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -d TaskWraith.xcodeproj ]]; then
  echo "TaskWraith.xcodeproj missing — run: xcodegen" >&2
  exit 1
fi

IFS='|' read -r -a devices <<< "${TW_SCREENSHOT_DEVICES:-iPhone 16 Pro Max|iPad Pro 13-inch (M4)}"

for device in "${devices[@]}"; do
  slug="$(echo "$device" | tr -cd '[:alnum:]-' | tr '[:upper:]' '[:lower:]')"
  bundle="build/screenshots-${slug}.xcresult"
  out="screenshots/${slug}"
  rm -rf "$bundle" "$out"
  mkdir -p "$out"

  echo "==> ${device}"
  xcodebuild test \
    -project TaskWraith.xcodeproj \
    -scheme TaskWraith \
    -destination "platform=iOS Simulator,name=${device}" \
    -only-testing:TaskWraithUITests/TaskWraithScreenshotUITests \
    -resultBundlePath "$bundle" \
    CODE_SIGNING_ALLOWED=NO

  # Xcode 16+: exports every .keepAlways attachment (PNG) with a manifest.
  xcrun xcresulttool export attachments --path "$bundle" --output-path "$out"
  echo "==> ${out}/ ($(ls "$out" | grep -c png || true) png)"
done

echo "Done. Upload from ios/TaskWraithApp/screenshots/ to App Store Connect."
