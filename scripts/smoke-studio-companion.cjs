#!/usr/bin/env node

/**
 * Deterministic smoke for the assembled TaskWraith Studio.app staging bundle.
 *
 * This checks identity and layout, proves the expected Mach-O slices, rejects
 * the old false-signature pattern, and runs the executable from inside the
 * bundle through the complete companion-driven hello -> getDocument handshake.
 */

const { spawn, spawnSync } = require('node:child_process')
const { accessSync, constants, existsSync } = require('node:fs')
const { join } = require('node:path')

const REPO_ROOT = join(__dirname, '..')
const APP_PATH =
  process.env.TASKWRAITH_STUDIO_APP_OUTPUT ||
  join(REPO_ROOT, 'swift', 'TaskWraithBridge', '.build', 'studio', 'TaskWraith Studio.app')
const INFO_PLIST = join(APP_PATH, 'Contents', 'Info.plist')
const EXPECTED_IDENTIFIER = 'com.chrisizatt.taskwraith.studio'
const MAIN_IDENTIFIER = 'com.chrisizatt.taskwraith'
const EXPECTED_EXECUTABLE = 'TaskWraithStudioCompanion'
const EXPECTED_ICON = 'TaskWraithStudio.icns'
const EXECUTABLE_PATH = join(APP_PATH, 'Contents', 'MacOS', EXPECTED_EXECUTABLE)
const EXPECTED_ARCH = process.env.TASKWRAITH_STUDIO_EXPECT_ARCH || 'host'
const TIMEOUT_MS = 10_000

if (process.platform !== 'darwin') {
  console.log(
    `[smoke-studio-companion] Skipping — companion is macOS-only (platform=${process.platform})`
  )
  process.exit(0)
}

if (!existsSync(INFO_PLIST)) fail(`Info.plist not found at ${INFO_PLIST}`)
run('/usr/bin/plutil', ['-lint', INFO_PLIST], 'plutil -lint')

const identifier = plistValue('CFBundleIdentifier')
const executable = plistValue('CFBundleExecutable')
const icon = plistValue('CFBundleIconFile')
const packageType = plistValue('CFBundlePackageType')
if (identifier !== EXPECTED_IDENTIFIER || identifier === MAIN_IDENTIFIER) {
  fail(`unexpected or non-unique CFBundleIdentifier: ${identifier}`)
}
if (executable !== EXPECTED_EXECUTABLE) {
  fail(`unexpected CFBundleExecutable: ${executable}`)
}
if (icon !== EXPECTED_ICON || !existsSync(join(APP_PATH, 'Contents', 'Resources', icon))) {
  fail(`declared icon is missing: ${icon}`)
}
if (packageType !== 'APPL') fail(`unexpected CFBundlePackageType: ${packageType}`)
if (existsSync(join(APP_PATH, 'Contents', '_CodeSignature'))) {
  fail('unsigned staging bundle unexpectedly contains _CodeSignature')
}
try {
  accessSync(EXECUTABLE_PATH, constants.X_OK)
} catch {
  fail(`bundle executable is not executable: ${EXECUTABLE_PATH}`)
}

if (EXPECTED_ARCH === 'universal') {
  verifyArch('arm64')
  verifyArch('x86_64')
} else if (EXPECTED_ARCH !== 'host') {
  fail(`TASKWRAITH_STUDIO_EXPECT_ARCH must be "host" or "universal", got "${EXPECTED_ARCH}"`)
}

const child = spawn(EXECUTABLE_PATH, ['--hydrate-once'], {
  stdio: ['pipe', 'pipe', 'pipe']
})
let buffered = ''
let stderr = ''
let sequence = []
let settled = false

const timer = setTimeout(() => {
  child.kill('SIGKILL')
  finish(new Error(`handshake timed out after ${TIMEOUT_MS}ms`))
}, TIMEOUT_MS)

child.stderr.on('data', (chunk) => {
  stderr = (stderr + String(chunk)).slice(-8192)
})
child.stdout.on('data', (chunk) => {
  buffered += String(chunk)
  let newline = buffered.indexOf('\n')
  while (newline !== -1) {
    const raw = buffered.slice(0, newline).replace(/\r$/, '')
    buffered = buffered.slice(newline + 1)
    newline = buffered.indexOf('\n')
    if (raw.length === 0) continue
    let message
    try {
      message = JSON.parse(raw)
    } catch (error) {
      finish(new Error(`invalid NDJSON from bundled executable: ${String(error)}`))
      return
    }
    if (message.method === 'studio/hello') {
      if (message.params?.protocolVersion !== 1 || !Number.isSafeInteger(message.id)) {
        finish(new Error('bundled executable emitted an invalid studio/hello request'))
        return
      }
      sequence.push('studio/hello')
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { protocolVersion: 1, server: 'studio-bundle-smoke', revision: 0 }
        }) + '\n'
      )
    } else if (message.method === 'studio/getDocument') {
      if (!Number.isSafeInteger(message.id)) {
        finish(new Error('bundled executable emitted an invalid studio/getDocument request'))
        return
      }
      sequence.push('studio/getDocument')
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { revision: 0, document: { items: [] } }
        }) + '\n'
      )
    } else {
      finish(new Error(`unexpected message from bundled executable: ${raw}`))
      return
    }
  }
})
child.on('error', (error) => finish(error))
child.on('exit', (code, signal) => {
  if (settled) return
  if (code !== 0 || signal !== null) {
    finish(
      new Error(
        `bundled executable exited code=${String(code)} signal=${String(signal)} stderr=${stderr}`
      )
    )
    return
  }
  if (sequence.join(',') !== 'studio/hello,studio/getDocument') {
    finish(new Error(`incomplete handshake sequence: ${sequence.join(',')}`))
    return
  }
  finish()
})

function finish(error) {
  if (settled) return
  settled = true
  clearTimeout(timer)
  if (error) fail(error.message)
  console.log(
    `[smoke-studio-companion] OK — ${identifier}, ${EXPECTED_ARCH}, bundled hello -> getDocument`
  )
}

function plistValue(key) {
  const result = run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', INFO_PLIST], key, {
    encoding: 'utf8',
    stdio: 'pipe'
  })
  return result.stdout.trim()
}

function verifyArch(arch) {
  run('/usr/bin/lipo', [EXECUTABLE_PATH, '-verify_arch', arch], `lipo -verify_arch ${arch}`, {
    stdio: 'pipe'
  })
}

function run(command, args, label, options = { stdio: 'inherit' }) {
  const result = spawnSync(command, args, options)
  if (result.error) fail(`${label} failed to launch: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    fail(`${label} exited with code ${result.status}${detail ? `: ${detail}` : ''}`)
  }
  return result
}

function fail(message) {
  console.error(`[smoke-studio-companion] FAIL — ${message}`)
  process.exit(1)
}
