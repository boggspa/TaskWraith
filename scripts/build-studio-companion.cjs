#!/usr/bin/env node

/**
 * Build the separate TaskWraith Studio companion app bundle.
 *
 * The staging bundle is intentionally unsigned. electron-builder's macOS
 * signing pass owns the final nested-code seal; pre-signing here would either
 * be invalidated by packaging or hide a failed sign behind stale metadata.
 *
 * TASKWRAITH_STUDIO_ARCH=universal builds arm64 and x86_64 slices and merges
 * them before bundle assembly. The pre-lipo'd executable is byte-identical in
 * electron-builder's two temporary apps, avoiding @electron/universal's
 * single-architecture nested-app merge failure.
 */

const { spawnSync } = require('node:child_process')
const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require('node:fs')
const { join } = require('node:path')

const REPO_ROOT = join(__dirname, '..')
const PACKAGE_PATH = join(REPO_ROOT, 'swift', 'TaskWraithBridge')
const APP_NAME = 'TaskWraith Studio.app'
const OUTPUT_APP =
  process.env.TASKWRAITH_STUDIO_APP_OUTPUT || join(PACKAGE_PATH, '.build', 'studio', APP_NAME)
const EXECUTABLE_NAME = 'TaskWraithStudioCompanion'
const EXECUTABLE_PATH = join(OUTPUT_APP, 'Contents', 'MacOS', EXECUTABLE_NAME)
const ICON_NAME = 'TaskWraithStudio.icns'
const ICON_SOURCE = join(REPO_ROOT, 'build', 'icon.icns')
const IDENTIFIER = 'com.chrisizatt.taskwraith.studio'
const DEPLOYMENT_TARGET = process.env.MACOSX_DEPLOYMENT_TARGET || '14.0'
const REQUESTED_ARCH = process.env.TASKWRAITH_STUDIO_ARCH || 'host'
const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
const version = packageJson.version

if (process.platform !== 'darwin') {
  console.log(
    `[build-studio-companion] Skipping — companion is macOS-only (platform=${process.platform})`
  )
  process.exit(0)
}

if (!existsSync(join(PACKAGE_PATH, 'Package.swift'))) {
  fail(`No SwiftPM manifest at ${PACKAGE_PATH}/Package.swift`, 2)
}
if (!existsSync(ICON_SOURCE)) {
  fail(`Required app icon not found at ${ICON_SOURCE}`, 3)
}
if (typeof version !== 'string' || !/^\d+(?:\.\d+){1,2}$/.test(version)) {
  fail(`package.json version is not a valid bundle version: ${String(version)}`, 4)
}

let executableSource
if (REQUESTED_ARCH === 'universal') {
  executableSource = buildUniversal()
} else if (REQUESTED_ARCH === 'host') {
  executableSource = buildHost()
} else {
  fail(`TASKWRAITH_STUDIO_ARCH must be "host" or "universal", got "${REQUESTED_ARCH}"`, 5)
}

assembleBundle(executableSource)
console.log(
  `[build-studio-companion] OK — ${REQUESTED_ARCH} unsigned staging bundle at ${OUTPUT_APP}`
)

function buildHost() {
  console.log(
    `[build-studio-companion] swift build -c release --product ${EXECUTABLE_NAME} (host arch) …`
  )
  runSwift(['build', '-c', 'release', '--package-path', PACKAGE_PATH, '--product', EXECUTABLE_NAME])
  const binaryPath = join(showBinPath(), EXECUTABLE_NAME)
  assertBinary(binaryPath)
  return binaryPath
}

function buildUniversal() {
  const slices = [
    { arch: 'arm64', triple: 'arm64-apple-macosx14.0' },
    { arch: 'x86_64', triple: 'x86_64-apple-macosx14.0' }
  ]
  const builtSlices = slices.map(({ arch, triple }) => {
    const scratchPath = join(PACKAGE_PATH, '.build', 'studio-slices', arch)
    console.log(
      `[build-studio-companion] swift build -c release --product ${EXECUTABLE_NAME} --triple ${triple} …`
    )
    runSwift([
      'build',
      '-c',
      'release',
      '--package-path',
      PACKAGE_PATH,
      '--scratch-path',
      scratchPath,
      '--triple',
      triple,
      '--product',
      EXECUTABLE_NAME
    ])
    const binaryPath = join(showBinPath(scratchPath, triple), EXECUTABLE_NAME)
    assertBinary(binaryPath)
    verifyMachOArch(binaryPath, arch)
    return binaryPath
  })

  const mergedDirectory = join(PACKAGE_PATH, '.build', 'studio', 'universal')
  const mergedBinary = join(mergedDirectory, EXECUTABLE_NAME)
  mkdirSync(mergedDirectory, { recursive: true })
  run('/usr/bin/lipo', ['-create', ...builtSlices, '-output', mergedBinary], 'lipo')
  verifyMachOArch(mergedBinary, 'arm64')
  verifyMachOArch(mergedBinary, 'x86_64')
  return mergedBinary
}

function assembleBundle(executableSource) {
  rmSync(OUTPUT_APP, { recursive: true, force: true })
  mkdirSync(join(OUTPUT_APP, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(OUTPUT_APP, 'Contents', 'Resources'), { recursive: true })
  copyFileSync(executableSource, EXECUTABLE_PATH)
  chmodSync(EXECUTABLE_PATH, 0o755)
  copyFileSync(ICON_SOURCE, join(OUTPUT_APP, 'Contents', 'Resources', ICON_NAME))
  writeFileSync(join(OUTPUT_APP, 'Contents', 'Info.plist'), infoPlist(), 'utf8')
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>TaskWraith Studio</string>
  <key>CFBundleExecutable</key>
  <string>${EXECUTABLE_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>${ICON_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${IDENTIFIER}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>TaskWraith Studio</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.video</string>
  <key>LSMinimumSystemVersion</key>
  <string>${DEPLOYMENT_TARGET}</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
</dict>
</plist>
`
}

function showBinPath(scratchPath, triple) {
  const args = [
    'build',
    '-c',
    'release',
    '--package-path',
    PACKAGE_PATH,
    '--product',
    EXECUTABLE_NAME
  ]
  if (scratchPath && triple) {
    args.push('--scratch-path', scratchPath, '--triple', triple)
  }
  args.push('--show-bin-path')
  const result = runSwift(args, { encoding: 'utf8', stdio: 'pipe' })
  if (!result.stdout.trim()) {
    fail('swift build --show-bin-path returned no path', 6)
  }
  return result.stdout.trim()
}

function runSwift(args, options = { stdio: 'inherit' }) {
  return run('swift', ['build', '--disable-sandbox', ...args.slice(1)], 'swift build', options)
}

function run(command, args, label, options = { stdio: 'inherit' }) {
  const result = spawnSync(command, args, {
    ...options,
    env: {
      ...process.env,
      MACOSX_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET
    }
  })
  if (result.error) {
    fail(`${label} failed to launch: ${result.error.message}`, 7)
  }
  if (result.status !== 0) {
    fail(`${label} exited with code ${result.status}`, result.status || 8)
  }
  return result
}

function assertBinary(binaryPath) {
  if (!existsSync(binaryPath)) {
    fail(`Expected companion binary not found at ${binaryPath}`, 9)
  }
}

function verifyMachOArch(binaryPath, arch) {
  run('/usr/bin/lipo', [binaryPath, '-verify_arch', arch], `lipo -verify_arch ${arch}`, {
    stdio: 'pipe'
  })
}

function fail(message, code) {
  console.error(`[build-studio-companion] ${message}`)
  process.exit(code)
}
