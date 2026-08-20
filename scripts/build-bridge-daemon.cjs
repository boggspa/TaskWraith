#!/usr/bin/env node

/**
 * build-bridge-daemon
 *
 * Pre-build step that compiles the Swift TaskWraithBridgeDaemon as a
 * release binary and assembles a nested helper app so electron-builder can
 * bundle it under Contents/Helpers. TCC privacy services resolve usage
 * descriptions from a real bundle, not a bare Mach-O helper. macOS-only;
 * no-op (with a friendly log) on
 * other platforms because the daemon uses Apple Network framework +
 * Bonjour + CryptoKit and only makes sense in a macOS Electron build.
 *
 * Invoked via the `prebuild:bridge-daemon` npm script before the
 * electron-builder step in mac build targets.
 */

const { spawnSync } = require('child_process')
const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} = require('fs')
const { join } = require('path')

const REPO_ROOT = join(__dirname, '..')
const PACKAGE_PATH = join(REPO_ROOT, 'swift', 'TaskWraithBridge')
const RELEASE_BINARY_PATH = join(PACKAGE_PATH, '.build', 'release', 'TaskWraithBridgeDaemon')
const HELPER_APP_PATH = join(PACKAGE_PATH, '.build', 'bridge', 'TaskWraith Bridge.app')
const HELPER_EXECUTABLE_PATH = join(HELPER_APP_PATH, 'Contents', 'MacOS', 'TaskWraithBridgeDaemon')
const APP_IDENTIFIER = 'com.chrisizatt.taskwraith'
const DEPLOYMENT_TARGET = process.env.MACOSX_DEPLOYMENT_TARGET || '14.0'
const REQUESTED_ARCH = process.env.TASKWRAITH_BRIDGE_ARCH || 'host'
const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
const version = packageJson.version

if (process.platform !== 'darwin') {
  console.log(
    `[build-bridge-daemon] Skipping — daemon is macOS-only (platform=${process.platform})`
  )
  process.exit(0)
}

if (!existsSync(join(PACKAGE_PATH, 'Package.swift'))) {
  console.error(`[build-bridge-daemon] No SwiftPM manifest at ${PACKAGE_PATH}/Package.swift`)
  process.exit(2)
}
if (typeof version !== 'string' || !/^\d+(?:\.\d+){1,2}$/.test(version)) {
  console.error(`[build-bridge-daemon] package.json version is invalid: ${String(version)}`)
  process.exit(6)
}

if (REQUESTED_ARCH === 'universal') {
  buildUniversal()
} else {
  buildHost()
}

function buildHost() {
  console.log(
    `[build-bridge-daemon] swift build -c release (host arch, MACOSX_DEPLOYMENT_TARGET=${DEPLOYMENT_TARGET}) …`
  )
  const result = runSwift(['build', '-c', 'release', '--package-path', PACKAGE_PATH], {
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    console.error(`[build-bridge-daemon] swift build exited with code ${result.status}`)
    process.exit(result.status ?? 1)
  }
  assertBinary(RELEASE_BINARY_PATH)
  assembleHelperBundle(RELEASE_BINARY_PATH)
  console.log(`[build-bridge-daemon] OK — helper app at ${HELPER_APP_PATH}`)
}

function buildUniversal() {
  const slices = [
    { arch: 'arm64', triple: 'arm64-apple-macosx14.0' },
    { arch: 'x86_64', triple: 'x86_64-apple-macosx14.0' }
  ]
  const builtSlices = []
  for (const slice of slices) {
    const scratchPath = join(PACKAGE_PATH, '.build', 'universal', slice.arch)
    console.log(
      `[build-bridge-daemon] swift build -c release --triple ${slice.triple} (MACOSX_DEPLOYMENT_TARGET=${DEPLOYMENT_TARGET}) …`
    )
    const result = runSwift(
      [
        'build',
        '-c',
        'release',
        '--package-path',
        PACKAGE_PATH,
        '--scratch-path',
        scratchPath,
        '--triple',
        slice.triple
      ],
      { stdio: 'inherit' }
    )
    if (result.status !== 0) {
      console.error(
        `[build-bridge-daemon] swift build for ${slice.arch} exited with code ${result.status}`
      )
      process.exit(result.status ?? 1)
    }
    const binPath = showBinPath(scratchPath, slice.triple)
    const binaryPath = join(binPath, 'TaskWraithBridgeDaemon')
    assertBinary(binaryPath)
    verifyMachOArch(binaryPath, slice.arch)
    builtSlices.push(binaryPath)
  }

  mkdirSync(join(PACKAGE_PATH, '.build', 'release'), { recursive: true })
  const lipoResult = spawnSync(
    '/usr/bin/lipo',
    ['-create', ...builtSlices, '-output', RELEASE_BINARY_PATH],
    {
      stdio: 'inherit'
    }
  )
  if (lipoResult.status !== 0) {
    console.error(`[build-bridge-daemon] lipo exited with code ${lipoResult.status}`)
    process.exit(lipoResult.status ?? 1)
  }
  verifyMachOArch(RELEASE_BINARY_PATH, 'arm64')
  verifyMachOArch(RELEASE_BINARY_PATH, 'x86_64')
  assembleHelperBundle(RELEASE_BINARY_PATH)
  console.log(`[build-bridge-daemon] OK — universal helper app at ${HELPER_APP_PATH}`)
}

function assembleHelperBundle(executableSource) {
  rmSync(HELPER_APP_PATH, { recursive: true, force: true })
  mkdirSync(join(HELPER_APP_PATH, 'Contents', 'MacOS'), { recursive: true })
  copyFileSync(executableSource, HELPER_EXECUTABLE_PATH)
  chmodSync(HELPER_EXECUTABLE_PATH, 0o755)
  writeFileSync(join(HELPER_APP_PATH, 'Contents', 'Info.plist'), helperInfoPlist(), 'utf8')

  const validation = spawnSync(
    '/usr/bin/plutil',
    ['-lint', join(HELPER_APP_PATH, 'Contents', 'Info.plist')],
    { encoding: 'utf8' }
  )
  if (validation.status !== 0) {
    const detail = [validation.stdout, validation.stderr].filter(Boolean).join('\n').trim()
    console.error(
      `[build-bridge-daemon] helper Info.plist is invalid${detail ? `:\n${detail}` : ''}`
    )
    process.exit(validation.status || 7)
  }
}

function helperInfoPlist() {
  // The identifier deliberately matches the signed parent app. Speech
  // Recognition is a TaskWraith capability selected by the user; the nested
  // transport must not invent a second consent identity or permission grant.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>TaskWraith</string>
  <key>CFBundleExecutable</key>
  <string>TaskWraithBridgeDaemon</string>
  <key>CFBundleIdentifier</key>
  <string>${APP_IDENTIFIER}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>TaskWraith</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>${DEPLOYMENT_TARGET}</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>TaskWraith transcribes audio files you select entirely on-device so agents can read back what was said.</string>
</dict>
</plist>
`
}

function showBinPath(scratchPath, triple) {
  const result = runSwift(
    [
      'build',
      '-c',
      'release',
      '--package-path',
      PACKAGE_PATH,
      '--scratch-path',
      scratchPath,
      '--triple',
      triple,
      '--show-bin-path'
    ],
    { encoding: 'utf8' }
  )
  if (result.status !== 0 || !result.stdout.trim()) {
    console.error(`[build-bridge-daemon] failed to resolve Swift binary path for ${triple}`)
    process.exit(result.status || 4)
  }
  return result.stdout.trim()
}

function runSwift(args, options = {}) {
  const swiftArgs = args[0] === 'build' ? ['build', '--disable-sandbox', ...args.slice(1)] : args
  return spawnSync('swift', swiftArgs, {
    ...options,
    env: {
      ...process.env,
      MACOSX_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET
    }
  })
}

function assertBinary(binaryPath) {
  if (!existsSync(binaryPath)) {
    console.error(`[build-bridge-daemon] Expected binary not found at ${binaryPath}`)
    process.exit(3)
  }
}

function verifyMachOArch(binaryPath, arch) {
  const result = spawnSync('/usr/bin/lipo', [binaryPath, '-verify_arch', arch], {
    stdio: 'pipe',
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    console.error(
      `[build-bridge-daemon] ${binaryPath} does not contain ${arch}${detail ? `:\n${detail}` : ''}`
    )
    process.exit(result.status || 5)
  }
}
