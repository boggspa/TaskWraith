#!/usr/bin/env node

/**
 * build-bridge-daemon
 *
 * Pre-build step that compiles the Swift TaskWraithBridgeDaemon as a
 * release binary so electron-builder can bundle it as an extraResource
 * in the packaged .app. macOS-only; no-op (with a friendly log) on
 * other platforms because the daemon uses Apple Network framework +
 * Bonjour + CryptoKit and only makes sense in a macOS Electron build.
 *
 * Invoked via the `prebuild:bridge-daemon` npm script before the
 * electron-builder step in mac build targets.
 */

const { spawnSync } = require('child_process')
const { existsSync, mkdirSync } = require('fs')
const { join } = require('path')

const REPO_ROOT = join(__dirname, '..')
const PACKAGE_PATH = join(REPO_ROOT, 'swift', 'TaskWraithBridge')
const RELEASE_BINARY_PATH = join(PACKAGE_PATH, '.build', 'release', 'TaskWraithBridgeDaemon')
const DEPLOYMENT_TARGET = process.env.MACOSX_DEPLOYMENT_TARGET || '14.0'
const REQUESTED_ARCH = process.env.TASKWRAITH_BRIDGE_ARCH || 'host'

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
  console.log(`[build-bridge-daemon] OK — release binary at ${RELEASE_BINARY_PATH}`)
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
  const lipoResult = spawnSync('/usr/bin/lipo', ['-create', ...builtSlices, '-output', RELEASE_BINARY_PATH], {
    stdio: 'inherit'
  })
  if (lipoResult.status !== 0) {
    console.error(`[build-bridge-daemon] lipo exited with code ${lipoResult.status}`)
    process.exit(lipoResult.status ?? 1)
  }
  verifyMachOArch(RELEASE_BINARY_PATH, 'arm64')
  verifyMachOArch(RELEASE_BINARY_PATH, 'x86_64')
  console.log(`[build-bridge-daemon] OK — universal release binary at ${RELEASE_BINARY_PATH}`)
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
  const swiftArgs =
    args[0] === 'build' ? ['build', '--disable-sandbox', ...args.slice(1)] : args
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
