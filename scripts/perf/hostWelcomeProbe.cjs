'use strict'

/**
 * Host welcome probe — out-of-band boot-epoch / identity acquisition (M1).
 *
 * The Host perf snapshot writer stamps `identity { process:'host', instanceId,
 * generation, pid, bootEpoch? }` into its snapshot file, and the collector
 * (`collectors/hostSpans.cjs`) refuses a whole read whose pinned epoch is
 * missing or different (`host_perf_snapshot_identity_mismatch`). What the
 * collector cannot do is decide WHAT to pin: that has to come from an
 * independent, live, authenticated surface — not from the snapshot file
 * itself, which a previous incarnation may have left behind.
 *
 * This module is that surface for the perf harness. It is plain Node (no
 * Electron, no TypeScript): read the Host discovery file the server wrote at
 * startup, read the 0600 auth token, perform exactly ONE hello → welcome
 * handshake over the 0600 unix socket, disconnect, and return the identity
 * the welcome vouches for:
 *
 *   expectedIdentity = {
 *     instanceId: welcome.hostId,        // stable Host identity
 *     generation: welcome.generation,    // journal generation at bind time
 *     pid: discovery.pid,                // the welcome carries no pid; the
 *                                        // discovery record the same process
 *                                        // wrote is the pid source (the
 *                                        // production HostProjectionClient
 *                                        // already sanctions binding the
 *                                        // discovery process identity to the
 *                                        // authenticated connection)
 *     bootEpoch: welcome.bootEpoch       // present only when the Host mints
 *                                        // one (optional committed contract,
 *                                        // src/shared/hostProtocol.ts)
 *   }
 *
 * The epoch, when present, is the incarnation proof: it is a public opaque
 * token minted per Host composition, compared for equality only. A stale
 * snapshot file from a previous incarnation cannot match a freshly welcomed
 * epoch, so PID reuse, same-millisecond clocks and same-lease writer
 * recreation are all irrelevant by construction.
 *
 * TOKEN CONTAINMENT (hard obligation): the auth token is read into a local
 * only to authenticate the single hello frame. It is NEVER returned, logged,
 * or embedded in any result, reason or error string produced here — reason
 * strings are bounded codes, never frame or file contents. Callers must keep
 * it out of every artifact (the T2 runner pins this with named tests).
 *
 * Failure posture: every failure is a specific `{ ok:false, reason }` marker
 * — never a throw from I/O, never a silent fall-through to a legacy pin. A
 * malformed `bootEpoch` on the welcome FAILS the probe rather than being
 * dropped, because dropping it would fold the run into the legacy
 * both-sides-absent path and quietly lose the incarnation guarantee.
 */

const path = require('node:path')
const net = require('node:net')
const nodeFs = require('node:fs')

/** Discovery file name (mirrors TASKWRAITH_HOST_DISCOVERY_FILE, src/shared/taskWraithHostPaths.node.ts). */
const HOST_DISCOVERY_FILE = 'taskwraith-host-v2.json'
const DEFAULT_WELCOME_TIMEOUT_MS = 5_000
/** Cold external-host start measured up to ~70s (smoke-host-boot-electron ceilings). */
const DEFAULT_DISCOVERY_MAX_WAIT_MS = 75_000
const DEFAULT_DISCOVERY_POLL_INTERVAL_MS = 500
/**
 * Public opaque boot epoch (additive M1 identity field): 64 lowercase hex,
 * minted per Host incarnation, compared for equality only — never a
 * timestamp, never a counter, never the auth token.
 *
 * This is a DELIBERATE COPY of the rule, not a shared import. The codec
 * exports isBootEpoch (src/shared/hostProtocol.ts) as the single source of
 * truth, but this module is .cjs and cannot import TypeScript — the same
 * constraint that keeps collectors/hostSpans.cjs on its own copy.
 *
 * Drift is therefore pinned by TEST, not by the type system: the lockstep in
 * collectors/hostSpans.transport.test.ts drives one shared corpus through
 * ALL FOUR enforcement points — writer, codec, collector and this probe via
 * decodeProbedWelcome — and fails if any one of them splits from the others
 * or if all of them relax together. Change this pattern and that test reds.
 */
const HOST_BOOT_EPOCH_PATTERN = /^[0-9a-f]{64}$/
/** Minimal hello: the probe disconnects at the welcome, so it needs no projection capabilities. */
const PROBE_HELLO_CAPABILITIES = Object.freeze(['bootstrap'])
/** Bound on buffered pre-welcome bytes so a chatty/broken peer cannot grow this process. */
const MAX_WELCOME_BUFFER_BYTES = 1024 * 1024

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value, max) {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
  )
}

function isCanonicalIso(value) {
  if (!isNonEmptyString(value, 100)) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function isAbsolutePathLike(value) {
  // POSIX absolute or a Windows named pipe (taskWraithHostSocketPath win32 shape).
  return path.isAbsolute(value) || value.startsWith('\\\\.\\pipe\\')
}

/** Absolute discovery path inside the Host's userData/profile directory. */
function hostDiscoveryPath(userDataPath) {
  if (!isNonEmptyString(userDataPath, 4096)) {
    throw new Error('userDataPath must be a non-empty string')
  }
  return path.join(userDataPath, HOST_DISCOVERY_FILE)
}

/**
 * Fail-closed decode of the discovery payload. Mirrors the contract of
 * decodeTaskWraithHostDiscovery (src/shared/taskWraithHostPaths.node.ts):
 * protocolVersion 2, absolute socket/token paths, positive safe-integer pid,
 * canonical ISO startedAt. Reasons are bounded field codes — the raw payload
 * is never echoed (it is untrusted input from disk).
 */
function decodeHostDiscovery(value) {
  if (!isPlainObject(value)) return { ok: false, reason: 'host_discovery_invalid: shape' }
  if (value.protocolVersion !== 2) {
    return { ok: false, reason: 'host_discovery_invalid: protocolVersion' }
  }
  if (!isNonEmptyString(value.socketPath, 1000) || !isAbsolutePathLike(value.socketPath)) {
    return { ok: false, reason: 'host_discovery_invalid: socketPath' }
  }
  if (!isNonEmptyString(value.tokenPath, 1000) || !isAbsolutePathLike(value.tokenPath)) {
    return { ok: false, reason: 'host_discovery_invalid: tokenPath' }
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) {
    return { ok: false, reason: 'host_discovery_invalid: pid' }
  }
  if (!isCanonicalIso(value.startedAt)) {
    return { ok: false, reason: 'host_discovery_invalid: startedAt' }
  }
  if (value.hostId !== undefined && !isNonEmptyString(value.hostId, 512)) {
    return { ok: false, reason: 'host_discovery_invalid: hostId' }
  }
  if (value.hostVersion !== undefined && !isNonEmptyString(value.hostVersion, 256)) {
    return { ok: false, reason: 'host_discovery_invalid: hostVersion' }
  }
  return {
    ok: true,
    discovery: {
      protocolVersion: 2,
      socketPath: value.socketPath,
      tokenPath: value.tokenPath,
      pid: value.pid,
      startedAt: value.startedAt,
      ...(value.hostId === undefined ? {} : { hostId: value.hostId }),
      ...(value.hostVersion === undefined ? {} : { hostVersion: value.hostVersion })
    }
  }
}

/** One non-blocking-attempt read + decode of the discovery file. */
function readHostDiscovery(userDataPath, options = {}) {
  const fs = options.fs === undefined ? nodeFs : options.fs
  let discoveryPath
  try {
    discoveryPath = hostDiscoveryPath(userDataPath)
  } catch {
    return { ok: false, reason: 'host_discovery_invalid: userDataPath' }
  }
  if (!isPlainObject(fs) || typeof fs.readFileSync !== 'function') {
    return { ok: false, reason: 'host_discovery_unreadable: fs_contract' }
  }
  let raw
  try {
    raw = fs.readFileSync(discoveryPath, 'utf8')
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'io_error'
    return {
      ok: false,
      reason: code === 'ENOENT' ? 'host_discovery_absent' : `host_discovery_unreadable: ${code}`,
      discoveryPath
    }
  }
  let parsed
  try {
    parsed = JSON.parse(String(raw))
  } catch {
    return { ok: false, reason: 'host_discovery_invalid: parse_error', discoveryPath }
  }
  const decoded = decodeHostDiscovery(parsed)
  if (!decoded.ok) return { ...decoded, discoveryPath }
  return { ok: true, discoveryPath, discovery: decoded.discovery }
}

/**
 * Poll for the discovery file until it decodes or the deadline passes.
 * Absence at the deadline is `host_discovery_absent` — host-unsupported
 * (e.g. the silent in-process fallback in main bootstrap), NEVER host-quiet:
 * the caller records the marker and leaves the cell unqualified. Partial or
 * invalid content is retried (the server may be mid-write) and the LAST
 * reason is returned at the deadline.
 */
async function waitForHostDiscovery(userDataPath, options = {}) {
  const maxWaitMs =
    Number.isFinite(options.maxWaitMs) && options.maxWaitMs >= 0
      ? options.maxWaitMs
      : DEFAULT_DISCOVERY_MAX_WAIT_MS
  const intervalMs =
    Number.isFinite(options.intervalMs) && options.intervalMs > 0
      ? options.intervalMs
      : DEFAULT_DISCOVERY_POLL_INTERVAL_MS
  const sleep =
    typeof options.sleep === 'function'
      ? options.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now()
  const startedAtMs = nowMs()
  const deadline = startedAtMs + maxWaitMs
  let last = null
  for (;;) {
    last = readHostDiscovery(userDataPath, options)
    if (last.ok) return last
    const remaining = deadline - nowMs()
    if (remaining <= 0) {
      return { ...last, waitedMs: Math.max(0, nowMs() - startedAtMs), timedOut: true }
    }
    await sleep(Math.min(intervalMs, remaining))
  }
}

/**
 * Validate the welcome payload this probe depends on. Fail-closed and
 * epoch-strict: a malformed bootEpoch refuses the whole probe (it is never
 * dropped to undefined, which would silently degrade the run to the legacy
 * unpinned path). Other welcome fields (cursor, client, capabilities,
 * freshness) are irrelevant here and intentionally not retained.
 */
function decodeProbedWelcome(welcome) {
  if (!isPlainObject(welcome)) return { ok: false, reason: 'host_welcome_invalid: shape' }
  if (!isNonEmptyString(welcome.hostId, 512)) {
    return { ok: false, reason: 'host_welcome_invalid: hostId' }
  }
  if (!Number.isSafeInteger(welcome.generation) || welcome.generation < 0) {
    return { ok: false, reason: 'host_welcome_invalid: generation' }
  }
  if (
    welcome.bootEpoch !== undefined &&
    !(typeof welcome.bootEpoch === 'string' && HOST_BOOT_EPOCH_PATTERN.test(welcome.bootEpoch))
  ) {
    return { ok: false, reason: 'host_welcome_invalid: bootEpoch' }
  }
  return {
    ok: true,
    welcome: {
      hostId: welcome.hostId,
      generation: welcome.generation,
      ...(isNonEmptyString(welcome.hostVersion, 256) ? { hostVersion: welcome.hostVersion } : {}),
      ...(welcome.bootEpoch === undefined ? {} : { bootEpoch: welcome.bootEpoch })
    }
  }
}

/**
 * ONE hello → welcome → disconnect against the discovered socket.
 *
 * The hello frame mirrors the production smoke precedent
 * (scripts/smoke-packaged-host.cjs `hostRequest`): transportVersion 1, the
 * token from the discovery tokenPath, host.hello protocolVersion 2 /
 * projectionVersion 2, bounded client identity, minimal capabilities. The
 * socket is destroyed as soon as the welcome decodes — this probe is a
 * reader, never a subscriber.
 *
 * `connect` is injectable for tests: (socketPath) => a socket-ish
 * EventEmitter with write/destroy. The token appears ONLY inside the hello
 * frame written to the socket; no result, reason or error carries it.
 */
async function requestHostWelcome(options) {
  const discovery = options.discovery
  if (
    !isPlainObject(discovery) ||
    !isNonEmptyString(discovery.socketPath, 1000) ||
    !isNonEmptyString(discovery.tokenPath, 1000)
  ) {
    return { ok: false, reason: 'host_welcome_invalid_input' }
  }
  const fs = options.fs === undefined ? nodeFs : options.fs
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_WELCOME_TIMEOUT_MS
  const connect =
    typeof options.connect === 'function'
      ? options.connect
      : (socketPath) => net.createConnection(socketPath)

  let token
  try {
    token = String(fs.readFileSync(discovery.tokenPath, 'utf8')).trim()
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'io_error'
    return { ok: false, reason: `host_token_unreadable: ${code}` }
  }
  if (!token) return { ok: false, reason: 'host_token_empty' }

  return new Promise((resolve) => {
    let settled = false
    let buffer = ''
    /** @type {any} */
    let socket = null
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        if (socket && typeof socket.destroy === 'function') socket.destroy()
      } catch {
        /* teardown failure never replaces the probe outcome */
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'host_welcome_timeout' }), timeoutMs)
    try {
      socket = connect(discovery.socketPath)
    } catch {
      finish({ ok: false, reason: 'host_socket_connect_failed' })
      return
    }
    if (
      !socket ||
      typeof socket.on !== 'function' ||
      typeof socket.write !== 'function' ||
      typeof socket.destroy !== 'function'
    ) {
      finish({ ok: false, reason: 'host_socket_unavailable' })
      return
    }
    // Error details are not echoed: a socket error message can embed paths;
    // bounded reason codes keep this result safe for reports.
    socket.on('error', () => finish({ ok: false, reason: 'host_socket_error' }))
    socket.on('close', () => finish({ ok: false, reason: 'host_socket_closed_before_welcome' }))
    socket.on('connect', () => {
      const hello = {
        type: 'hello',
        transportVersion: 1,
        token,
        hello: {
          type: 'host.hello',
          protocolVersion: 2,
          projectionVersion: 2,
          client: {
            clientId: 'taskwraith-perf-welcome-probe',
            clientClass: 'test',
            clientVersion: '1.0.0'
          },
          capabilities: [...PROBE_HELLO_CAPABILITIES]
        }
      }
      try {
        socket.write(`${JSON.stringify(hello)}\n`)
      } catch {
        finish({ ok: false, reason: 'host_hello_write_failed' })
      }
    })
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      if (buffer.length > MAX_WELCOME_BUFFER_BYTES) {
        finish({ ok: false, reason: 'host_frame_oversized' })
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          // Never echo the line: untrusted bytes, bounded reason only.
          finish({ ok: false, reason: 'host_frame_malformed' })
          return
        }
        if (!isPlainObject(frame)) {
          finish({ ok: false, reason: 'host_frame_malformed' })
          return
        }
        if (frame.type === 'welcome') {
          finish(decodeProbedWelcome(frame.welcome))
          return
        }
        if (frame.type === 'error' || frame.type === 'hello_error') {
          finish({ ok: false, reason: 'host_hello_refused' })
          return
        }
        // Any other pre-welcome frame is unexpected but ignorable; keep
        // reading until the welcome, the buffer bound or the timeout.
      }
    })
  })
}

/**
 * expectedIdentity for the collector pin. The welcome carries NO pid
 * (hostProtocol.ts HostBootstrapWelcome), so the pid comes from the
 * discovery record the same Host process wrote; epoch equality remains the
 * incarnation proof, and a stale discovery fails closed downstream (dead
 * socket → probe failure; wrong process → pid/epoch mismatch → the
 * collector's whole-read refusal).
 */
function buildExpectedIdentity(welcome, discovery) {
  if (
    !isPlainObject(welcome) ||
    !isNonEmptyString(welcome.hostId, 512) ||
    !Number.isSafeInteger(welcome.generation) ||
    welcome.generation < 0
  ) {
    throw new Error('welcome with hostId + generation required')
  }
  if (!isPlainObject(discovery) || !Number.isSafeInteger(discovery.pid) || discovery.pid <= 0) {
    throw new Error('discovery with positive pid required')
  }
  return {
    instanceId: welcome.hostId,
    generation: welcome.generation,
    pid: discovery.pid,
    ...(welcome.bootEpoch === undefined ? {} : { bootEpoch: welcome.bootEpoch })
  }
}

/**
 * Composed probe used by the T2 runner: discovery poll → hello/welcome →
 * expectedIdentity. `stage` on failure names the boundary that refused
 * ('discovery' | 'welcome') so the runner's marker can distinguish
 * host-unsupported (no discovery: in-process fallback or dead host) from a
 * live-but-refusing host (welcome failures).
 *
 * The success result carries NO token and NO tokenPath — the discovery
 * subset is bounded to { pid, startedAt, hostId? }.
 */
async function probeHostBootstrapIdentity(options = {}) {
  const userDataPath = options.userDataPath
  if (!isNonEmptyString(userDataPath, 4096)) {
    return { ok: false, stage: 'discovery', reason: 'user_data_path_required' }
  }
  const discoveryResult = await waitForHostDiscovery(userDataPath, options)
  if (!discoveryResult.ok) {
    return { ok: false, stage: 'discovery', reason: discoveryResult.reason }
  }
  const discovery = discoveryResult.discovery
  const welcomeResult = await requestHostWelcome({
    discovery,
    timeoutMs: options.timeoutMs,
    fs: options.fs,
    connect: options.connect
  })
  if (!welcomeResult.ok) {
    return {
      ok: false,
      stage: 'welcome',
      reason: welcomeResult.reason,
      discovery: { pid: discovery.pid, startedAt: discovery.startedAt }
    }
  }
  return {
    ok: true,
    expectedIdentity: buildExpectedIdentity(welcomeResult.welcome, discovery),
    welcome: welcomeResult.welcome,
    discovery: {
      pid: discovery.pid,
      startedAt: discovery.startedAt,
      ...(discovery.hostId === undefined ? {} : { hostId: discovery.hostId })
    }
  }
}

module.exports = {
  HOST_DISCOVERY_FILE,
  HOST_BOOT_EPOCH_PATTERN,
  DEFAULT_WELCOME_TIMEOUT_MS,
  DEFAULT_DISCOVERY_MAX_WAIT_MS,
  DEFAULT_DISCOVERY_POLL_INTERVAL_MS,
  hostDiscoveryPath,
  decodeHostDiscovery,
  readHostDiscovery,
  waitForHostDiscovery,
  decodeProbedWelcome,
  requestHostWelcome,
  buildExpectedIdentity,
  probeHostBootstrapIdentity
}
