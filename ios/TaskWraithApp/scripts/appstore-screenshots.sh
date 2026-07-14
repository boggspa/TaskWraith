#!/usr/bin/env bash
# App Store screenshot run — builds the app once, then drives the OFFLINE
# demo session (-tw-demo / -tw-demo-thread launch arguments, no pairing
# needed) with plain simctl per device class and captures stills with
# `simctl io screenshot`. Deliberately NO XCUITest: accessibility snapshot
# queries time out against this app's deep glass hierarchy.
#
# Usage:
#   scripts/appstore-screenshots.sh
#   TW_SCREENSHOT_DEVICES="iPhone 17 Pro Max" scripts/appstore-screenshots.sh
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

BUNDLE_ID="com.taskwraith.companion"
# Splash-sized still (~117KB) means the app hadn't rendered yet; real screens
# compress to ≳300KB. Poll until content appears — fixed settles kept losing
# to post-boot CPU storms (a fresh sim boot, and especially the first boot
# after an erase, can hold the app on its splash for well over 30s).
MIN_BYTES="${TW_SCREENSHOT_MIN_BYTES:-200000}"
POLL_SECONDS=5
MAX_WAIT_SECONDS="${TW_SCREENSHOT_MAX_WAIT:-120}"
# Extra hold after content first appears, so reveal/transition animations
# finish before the keeper frame.
POST_CONTENT_SECONDS=4
IFS='|' read -r -a devices <<< "${TW_SCREENSHOT_DEVICES:-iPhone 17 Pro Max|iPad Pro 13-inch (M5)}"

# One simulator build serves every device class. Keep ad-hoc signing ON —
# CODE_SIGNING_ALLOWED=NO strips the keychain-access-groups entitlement, the
# identity seed read fails with -34018, and the app boots to the "Device
# identity unavailable" recovery screen instead of the demo.
echo "==> build"
xcodebuild build \
  -project TaskWraith.xcodeproj \
  -scheme TaskWraith \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/screenshot-dd \
  -quiet
APP="build/screenshot-dd/Build/Products/Debug-iphonesimulator/TaskWraith.app"
[[ -d "$APP" ]] || { echo "built app missing at $APP" >&2; exit 1; }

# name|launch-args pairs: NN-name gets `simctl io screenshot` once content
# renders. 02 deep-links demo-3 (not demo-1) deliberately: iPad split view
# auto-opens demo-1 from home, so demo-1 would make 01 and 02 byte-identical
# there — demo-3 keeps every capture a distinct surface on both device classes.
SHOTS=(
  "01-home|-tw-demo"
  "02-thread-detail|-tw-demo -tw-demo-thread demo-3"
  "03-ensemble|-tw-demo -tw-demo-thread demo-2"
)
FAILED=0

# One booted simulator at a time — two live sims contend for CPU and the
# app can still be on its splash when the settle expires.
xcrun simctl shutdown all 2>/dev/null || true

for device in "${devices[@]}"; do
  slug="$(echo "$device" | tr -cd '[:alnum:]-' | tr '[:upper:]' '[:lower:]')"
  out="screenshots/${slug}"
  rm -rf "$out"
  mkdir -p "$out"

  echo "==> ${device}"
  xcrun simctl boot "$device" 2>/dev/null || true
  xcrun simctl bootstatus "$device" -b >/dev/null
  # No accessibility prefs needed: the historical launch-splash wedge on
  # 440/420pt iPhones was a one-ULP GeometryReader layout livelock in
  # ComposerDiffPill (fixed via quantizedMeasurement in TWSharedViews.swift),
  # NOT Reduce Motion — that earlier attribution was wrong.
  # Pre-dismiss the first-launch welcome sheet so it never covers home.
  xcrun simctl spawn "$device" defaults write "$BUNDLE_ID" tw.firstLaunchSheet.dismissed.v1 -bool true
  xcrun simctl install "$device" "$APP"

  for shot in "${SHOTS[@]}"; do
    name="${shot%%|*}"
    args="${shot#*|}"
    xcrun simctl terminate "$device" "$BUNDLE_ID" 2>/dev/null || true
    # shellcheck disable=SC2086 — args are intentionally word-split.
    xcrun simctl launch "$device" "$BUNDLE_ID" $args >/dev/null
    waited=0
    size=0
    while (( waited < MAX_WAIT_SECONDS )); do
      sleep "$POLL_SECONDS"
      waited=$(( waited + POLL_SECONDS ))
      xcrun simctl io "$device" screenshot "${out}/${name}.png" >/dev/null
      size=$(stat -f%z "${out}/${name}.png")
      if (( size >= MIN_BYTES )); then
        sleep "$POST_CONTENT_SECONDS"
        xcrun simctl io "$device" screenshot "${out}/${name}.png" >/dev/null
        size=$(stat -f%z "${out}/${name}.png")
        break
      fi
    done
    if (( size < MIN_BYTES )); then
      echo "    WARNING: ${name}.png still splash-sized (${size}B) after ${waited}s" >&2
      FAILED=1
    fi
    echo "    ${out}/${name}.png (${size}B, ${waited}s)"
  done
  xcrun simctl shutdown "$device" 2>/dev/null || true
done

if (( FAILED )); then
  echo "FAILED: one or more captures never rendered content — do NOT upload." >&2
  exit 1
fi
echo "Done. Upload from ios/TaskWraithApp/screenshots/ to App Store Connect."
