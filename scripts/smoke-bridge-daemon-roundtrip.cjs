#!/usr/bin/env node

/**
 * smoke-bridge-daemon-roundtrip
 *
 * Self-contained daemon smoke. Spawns TaskWraithBridgeDaemon, waits for the
 * daemon-hello line, then verifies the inbound stdio JSON-RPC request/response
 * path with bridge.ping and bridge.status.
 */

const { spawn } = require('child_process')
const { existsSync } = require('fs')
const { createInterface } = require('readline')
const { join } = require('path')
const { randomUUID } = require('crypto')

const REPO_ROOT = join(__dirname, '..')
const BRIDGE_BUILD_ROOT = join(REPO_ROOT, 'swift', 'TaskWraithBridge', '.build')
const BIN_PATH =
  process.env.TASKWRAITH_BRIDGE_DAEMON_PATH ||
  [
    join(BRIDGE_BUILD_ROOT, 'release', 'TaskWraithBridgeDaemon'),
    join(BRIDGE_BUILD_ROOT, 'debug', 'TaskWraithBridgeDaemon')
  ].find((candidate) => existsSync(candidate))
const TIMEOUT_MS = Number(process.env.BRIDGE_SMOKE_TIMEOUT_MS || 8000)

if (!BIN_PATH || !existsSync(BIN_PATH)) {
  console.error('[smoke-bridge-daemon-roundtrip] daemon binary not found.')
  console.error('Run: npm run prebuild:bridge-daemon and try again.')
  process.exit(2)
}

const pingId = randomUUID()
const statusId = randomUUID()

let helloSeen = false
let pingSeen = false
let statusSeen = false
let stderrTail = ''

const proc = spawn(BIN_PATH, [], {
  shell: false,
  stdio: 'pipe',
  env: process.env
})

const timer = setTimeout(() => {
  fail(
    `Timed out after ${TIMEOUT_MS}ms. helloSeen=${helloSeen} pingSeen=${pingSeen} statusSeen=${statusSeen}`
  )
}, TIMEOUT_MS)
timer.unref?.()

function teardown() {
  clearTimeout(timer)
  try {
    proc.stdin.end()
  } catch {
    // Best effort: the daemon may have already closed stdin.
  }
  setTimeout(() => {
    if (!proc.killed) {
      try {
        proc.kill('SIGTERM')
      } catch {
        // Best effort: process teardown should not mask smoke-test outcome.
      }
    }
  }, 250).unref?.()
}

function pass() {
  teardown()
  console.log('[smoke-bridge-daemon-roundtrip] OK — hello + ping + status observed')
  process.exit(0)
}

function fail(reason) {
  teardown()
  console.error(`[smoke-bridge-daemon-roundtrip] FAIL — ${reason}`)
  if (stderrTail) {
    console.error('--- daemon stderr (tail) ---')
    console.error(stderrTail.trimEnd())
  }
  process.exit(1)
}

function maybeFinish() {
  if (helloSeen && pingSeen && statusSeen) {
    pass()
  }
}

function writeStdinLine(envelope) {
  try {
    proc.stdin.write(`${JSON.stringify(envelope)}\n`)
  } catch (err) {
    fail(`stdin write failed: ${err && err.message ? err.message : String(err)}`)
  }
}

function sendRequests() {
  writeStdinLine({ jsonrpc: '2.0', id: pingId, method: 'bridge.ping', params: {} })
  writeStdinLine({ jsonrpc: '2.0', id: statusId, method: 'bridge.status', params: {} })
}

const stdoutReader = createInterface({ input: proc.stdout })
stdoutReader.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    fail(`Non-JSON output line: ${trimmed.slice(0, 200)}`)
    return
  }
  if (!parsed || typeof parsed !== 'object') return

  if (parsed.kind === 'daemon-hello') {
    if (parsed.daemon !== 'TaskWraithBridgeDaemon') {
      fail(`hello had unexpected daemon field: ${JSON.stringify(parsed)}`)
      return
    }
    if (parsed.remoteTransportEnabled !== false) {
      fail(`hello did not report remoteTransportEnabled=false: ${JSON.stringify(parsed)}`)
      return
    }
    helloSeen = true
    sendRequests()
    return
  }

  if (String(parsed.id) === pingId) {
    if (parsed.error || parsed.result?.pong !== true) {
      fail(`bridge.ping returned unexpected response: ${JSON.stringify(parsed)}`)
      return
    }
    pingSeen = true
    maybeFinish()
    return
  }

  if (String(parsed.id) === statusId) {
    if (
      parsed.error ||
      parsed.result?.daemon !== 'TaskWraithBridgeDaemon' ||
      parsed.result?.remoteTransportEnabled !== false ||
      parsed.result?.screenWatchEnabled !== true
    ) {
      fail(`bridge.status returned unexpected response: ${JSON.stringify(parsed)}`)
      return
    }
    statusSeen = true
    maybeFinish()
  }
})

proc.stderr.on('data', (chunk) => {
  stderrTail += chunk.toString('utf8')
  if (stderrTail.length > 4096) stderrTail = stderrTail.slice(-4096)
})

proc.on('exit', (code, signal) => {
  if (!(helloSeen && pingSeen && statusSeen)) {
    fail(`daemon exited early (code=${code} signal=${signal})`)
  }
})

proc.on('error', (err) => {
  fail(`spawn error: ${err && err.message ? err.message : String(err)}`)
})
