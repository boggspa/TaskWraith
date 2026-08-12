#!/bin/bash
set -euo pipefail

# Inputs
SWIFT_BUILD_DIR="$1"
OUTPUT_APP="$2"
IDENTIFIER="com.taskwraith.studio"
VERSION="1.0.0"
SHORT_VERSION="1.0"

# Create bundle structure
mkdir -p "$OUTPUT_APP/Contents/MacOS"
mkdir -p "$OUTPUT_APP/Contents/Resources"
mkdir -p "$OUTPUT_APP/Contents/_CodeSignature"

# Mach-O → MacOS/
cp "$SWIFT_BUILD_DIR/TaskWraithStudioCompanion" "$OUTPUT_APP/Contents/MacOS/"

# Info.plist
cat > "$OUTPUT_APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>TaskWraithStudioCompanion</string>
    <key>CFBundleIdentifier</key>
    <string>$IDENTIFIER</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>TaskWraith Studio</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$SHORT_VERSION</string>
    <key>CFBundleVersion</key>
    <string>$VERSION</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
EOF

# Icon (placeholder; replace with actual .icns)
cp "$(dirname "$0")/Resources/AppIcon.icns" "$OUTPUT_APP/Contents/Resources/" || true

# Sign (placeholder; replace with actual cert)
codesign --force --deep --sign - "$OUTPUT_APP" || true