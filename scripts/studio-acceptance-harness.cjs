'use strict'

/**
 * Isolated, owner-gated Studio acceptance runner.
 *
 * Default invocation is plan-only. A real Electron run requires three explicit
 * flags and a caller-supplied media file:
 *
 *   node scripts/studio-acceptance-harness.cjs \
 *     --launch --i-accept-studio-isolated-launch \
 *     --owner-confirms-existing-orphans-cleared \
 *     --media=/absolute/path/to/clip.mov --mime=video/quicktime
 *
 * The harness uses TaskWraith's sanctioned TASKWRAITH_INSTANCE_ID profile lane,
 * a disposable macOS mock keychain, exact CDP/inspector port ownership, and an
 * independent watchdog which owns/reaps the Electron process group. It never
 * targets the live/shared profile and never deletes acceptance artifacts.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')
const { execFile, fork } = require('node:child_process')
const {
  buildElectronSpawnPlan,
  assertExactChildOwnsDebugPorts
} = require('./perf/electronChildSession.cjs')
const {
  resolveUnpackagedDevUserDataPath,
  sanitizeDevInstanceId
} = require('./perf/devUserDataPath.cjs')
const { assertLaunchPortsFree } = require('./perf/portGuard.cjs')
const { attachRendererCdpSession } = require('./perf/cdpWebSocketSession.cjs')

const WATCHDOG_PATH = path.join(__dirname, 'studio-acceptance-watchdog.cjs')
const WINDOW_PROBE_PATH = path.join(__dirname, 'studio-acceptance-window-probe.swift')
const UI_DRIVER_PATH = path.join(__dirname, 'studio-acceptance-ui-driver.swift')
const TRANSCRIPT_MEDIA_DIR = 'transcript-media'
const STUDIO_STATE_DIR = 'studio-companion'
const STUDIO_JOURNAL_FILE = 'studio-project.journal.jsonl'
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_WAIT_MS = 45_000
const ACCEPTANCE_SCHEMA_VERSION = 1
const ACCEPTANCE_RECEIPT_MAX_BYTES = 256 * 1024
const STUDIO_UI_MAX_PLAYHEAD_FORWARD_ADVANCE_TICKS = 1_000_000
const WATCHDOG_RECEIPT_KIND = 'taskwraith-studio-acceptance-watchdog'
const KNOWN_RECEIPT_SCHEMA_VERSIONS = new Set([1, 2])
const KNOWN_RECEIPT_STATUSES = new Set([
  'running',
  'reaping',
  'force_kill_sent',
  'group_survived_leader',
  'reaped',
  'exited',
  'spawn_failed',
  'reap_incomplete'
])
const VERIFIED_TERMINAL_RECEIPT_STATUSES = new Set(['reaped', 'exited'])
// Only a v2 watchdog receipt records whether the exact process group was
// observed to disappear. Every older receipt was written by the code path that
// could report `reaped` over a survivor, so it must be re-scanned on sight.
const TRUSTED_RECEIPT_SCHEMA_VERSION = 2
const INSTALLED_TASKWRAITH_EXECUTABLE = '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith'
const INSTALLED_STUDIO_EXECUTABLE =
  '/Applications/TaskWraith.app/Contents/Resources/studio/TaskWraith Studio.app/Contents/MacOS/TaskWraithStudioCompanion'

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const STUDIO_TRANSPORT_MUTATION_KINDS = new Set([
  'lifecycleAttach',
  'lifecycleOpen',
  'playbackToggleKey',
  'playbackToggleAccessibility',
  'playheadAccessibilitySet',
  'playheadAccessibilityStep',
  'frameStepKey',
  'transcriptCueSeek',
  'scrubBegin',
  'scrubMove',
  'scrubEnd',
  'timecodeSeek',
  'markOrLoop',
  'oscillatorReconciliation',
  'audioReschedule'
])
const STUDIO_TRANSPORT_MUTATION_TRANSITIONS = new Set([
  'oscillatorReconciliation',
  'audioReschedule'
])
const STUDIO_TRANSPORT_MUTATION_KEYS = [
  'kind',
  'route',
  'preSrc',
  'postSrc',
  'host',
  'prevHost',
  'preAnchorT',
  'preAnchorH',
  'prePos',
  'preDur',
  'prePlay',
  'preRate',
  'postAnchorT',
  'postAnchorH',
  'postPos',
  'postDur',
  'postPlay',
  'postRate',
  'crossedDomain',
  'clamped'
]
const CANONICAL_INT64 = /^(?:0|-?[1-9]\d*)$/
const CANONICAL_HOST_SECONDS = /^-?(?:0|[1-9]\d*)\.\d{6}$/
const CANONICAL_RATE = /^-?(?:0|[1-9]\d*)\.\d{3}$/
const INT64_MIN = -(1n << 63n)
const INT64_MAX = (1n << 63n) - 1n

function parseStudioTransportMutationText(text) {
  const fail = (detail) => {
    throw new Error(`Studio tm1 receipt is malformed: ${detail}`)
  }
  if (typeof text !== 'string' || !text.startsWith('tm1 ')) fail('schema prefix is missing')
  const tokens = text.split(' ')
  if (tokens.length !== STUDIO_TRANSPORT_MUTATION_KEYS.length + 1 || tokens[0] !== 'tm1') {
    fail('field count is not exact')
  }
  const raw = {}
  for (const [index, key] of STUDIO_TRANSPORT_MUTATION_KEYS.entries()) {
    const prefix = `${key}=`
    const token = tokens[index + 1]
    if (!token.startsWith(prefix) || token.length === prefix.length) {
      fail(`ordered field ${key} is missing`)
    }
    raw[key] = token.slice(prefix.length)
  }

  if (!STUDIO_TRANSPORT_MUTATION_KINDS.has(raw.kind)) fail('kind is not recognized')
  if (raw.route !== 'source' && raw.route !== 'review') fail('route is not recognized')
  if (!['audio', 'machine'].includes(raw.preSrc) || !['audio', 'machine'].includes(raw.postSrc)) {
    fail('host source is not recognized')
  }

  const parseFinite = (field, pattern) => {
    if (!pattern.test(raw[field])) fail(`${field} is not canonical`)
    const value = Number(raw[field])
    if (!Number.isFinite(value)) fail(`${field} is not finite`)
    return value
  }
  const parseInt64 = (field) => {
    if (!CANONICAL_INT64.test(raw[field])) fail(`${field} is not a canonical Int64`)
    const value = BigInt(raw[field])
    if (value < INT64_MIN || value > INT64_MAX) fail(`${field} is outside Int64`)
    return value
  }
  const parseBit = (field) => {
    if (raw[field] !== '0' && raw[field] !== '1') fail(`${field} is not a bit`)
    return raw[field] === '1'
  }

  const suppliedHostSeconds = parseFinite('host', CANONICAL_HOST_SECONDS)
  const previousHostSeconds =
    raw.prevHost === '-' ? null : parseFinite('prevHost', CANONICAL_HOST_SECONDS)
  const beforeAnchorTicks = parseInt64('preAnchorT')
  const beforeAnchorHostSeconds = parseFinite('preAnchorH', CANONICAL_HOST_SECONDS)
  const beforePositionTicks = parseInt64('prePos')
  const beforeDurationTicks = parseInt64('preDur')
  const beforeIsPlaying = parseBit('prePlay')
  const beforeRate = parseFinite('preRate', CANONICAL_RATE)
  const afterAnchorTicks = parseInt64('postAnchorT')
  const afterAnchorHostSeconds = parseFinite('postAnchorH', CANONICAL_HOST_SECONDS)
  const afterPositionTicks = parseInt64('postPos')
  const afterDurationTicks = parseInt64('postDur')
  const afterIsPlaying = parseBit('postPlay')
  const afterRate = parseFinite('postRate', CANONICAL_RATE)
  const recordedCrossedDomain = parseBit('crossedDomain')
  const recordedClamped = parseBit('clamped')

  const crossedDomain = raw.preSrc !== raw.postSrc
  const clamped =
    afterDurationTicks > 0n &&
    beforeAnchorTicks < afterDurationTicks &&
    afterAnchorTicks >= afterDurationTicks
  if (recordedCrossedDomain !== crossedDomain) fail('crossedDomain does not match source identity')
  if (recordedClamped !== clamped) fail('clamped does not match the anchor transition')

  if (!STUDIO_TRANSPORT_MUTATION_TRANSITIONS.has(raw.kind)) {
    if (crossedDomain || previousHostSeconds !== null) {
      fail('ordinary kind carries source-transition operands')
    }
  } else if (raw.kind === 'oscillatorReconciliation') {
    if (!crossedDomain || previousHostSeconds === null) {
      fail('oscillator reconciliation lacks a bounded source transition')
    }
  } else if (raw.preSrc !== 'audio' || raw.postSrc !== 'audio' || previousHostSeconds === null) {
    fail('audio reschedule lacks its bounded audio reset operands')
  }

  return {
    schema: 'tm1',
    kind: raw.kind,
    route: raw.route,
    beforeSource: raw.preSrc,
    afterSource: raw.postSrc,
    suppliedHostSeconds,
    previousHostSeconds,
    beforeAnchorTicks: beforeAnchorTicks.toString(),
    beforeAnchorHostSeconds,
    beforePositionTicks: beforePositionTicks.toString(),
    beforeDurationTicks: beforeDurationTicks.toString(),
    beforeIsPlaying,
    beforeRate,
    afterAnchorTicks: afterAnchorTicks.toString(),
    afterAnchorHostSeconds,
    afterPositionTicks: afterPositionTicks.toString(),
    afterDurationTicks: afterDurationTicks.toString(),
    afterIsPlaying,
    afterRate,
    crossedDomain,
    clamped
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseArgs(argv) {
  const parsed = {
    launch: false,
    acceptLaunch: false,
    ownerConfirmsOrphansCleared: false,
    pretty: false,
    help: false,
    instanceId: null,
    mediaPath: null,
    mimeType: null,
    remoteDebuggingPort: null,
    mainInspectorPort: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    transcriptTimeoutMs: DEFAULT_WAIT_MS
  }
  for (const argument of argv) {
    if (argument === '--launch') parsed.launch = true
    else if (argument === '--i-accept-studio-isolated-launch') parsed.acceptLaunch = true
    else if (argument === '--owner-confirms-existing-orphans-cleared') {
      parsed.ownerConfirmsOrphansCleared = true
    } else if (argument === '--pretty') parsed.pretty = true
    else if (argument === '--help' || argument === '-h') parsed.help = true
    else if (argument.startsWith('--instance-id=')) parsed.instanceId = argument.slice(14)
    else if (argument.startsWith('--media=')) parsed.mediaPath = argument.slice(8)
    else if (argument.startsWith('--mime=')) parsed.mimeType = argument.slice(7)
    else if (argument.startsWith('--remote-debugging-port=')) {
      parsed.remoteDebuggingPort = Number(argument.slice(24))
    } else if (argument.startsWith('--main-inspector-port=')) {
      parsed.mainInspectorPort = Number(argument.slice(22))
    } else if (argument.startsWith('--transcript-timeout-ms=')) {
      parsed.transcriptTimeoutMs = Number(argument.slice(24))
    } else if (argument.startsWith('--timeout-ms=')) {
      parsed.timeoutMs = Number(argument.slice(13))
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return parsed
}

function defaultInstanceId(pid = process.pid) {
  return `studioA${pid}`.slice(0, 16)
}

function assertStudioInstanceId(raw) {
  const sanitized = sanitizeDevInstanceId(raw)
  if (sanitized !== raw || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,15}$/.test(raw)) {
    throw new Error('instanceId must already be a sanitized 2–16 character TASKWRAITH instance id')
  }
  if (raw === 'verify') throw new Error('instanceId verify is shared/reserved')
  return raw
}

function buildStudioAcceptancePlan(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'))
  const instanceId = assertStudioInstanceId(options.instanceId || defaultInstanceId(options.pid))
  const transcriptTimeoutMs =
    options.transcriptTimeoutMs === undefined
      ? DEFAULT_WAIT_MS
      : Number(options.transcriptTimeoutMs)
  if (
    !Number.isSafeInteger(transcriptTimeoutMs) ||
    transcriptTimeoutMs < 1_000 ||
    transcriptTimeoutMs > 30 * 60 * 1_000
  ) {
    throw new Error('transcriptTimeoutMs must be an integer 1000–1800000')
  }
  const artifactRoot = path.resolve(
    options.artifactRoot ||
      path.join(repoRoot, '.local-only', 'taskwraith-studio', 'acceptance', instanceId)
  )
  const home = path.resolve(options.home || path.join(artifactRoot, 'home'))
  const profile = resolveUnpackagedDevUserDataPath({
    instanceId,
    platform: options.platform || process.platform,
    home,
    env: options.env || process.env
  })
  const spawnPlan = buildElectronSpawnPlan({
    instanceId,
    repoRoot,
    home,
    platform: options.platform || process.platform,
    workload: 'dual_run',
    fxPosture: 'reduce_motion',
    ...(options.remoteDebuggingPort == null
      ? {}
      : { remoteDebuggingPort: options.remoteDebuggingPort }),
    ...(options.mainInspectorPort == null ? {} : { mainInspectorPort: options.mainInspectorPort }),
    ...(options.adapters ? { adapters: options.adapters } : {})
  })
  spawnPlan.env.TASKWRAITH_STUDIO_COMPANION = '1'
  const receiptPath = path.join(artifactRoot, 'watchdog-receipt.json')
  const evidencePath = path.join(artifactRoot, 'studio-acceptance-evidence.json')

  return {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    kind: 'taskwraith-studio-acceptance-plan',
    instanceId,
    repoRoot,
    artifactRoot,
    home,
    transcriptTimeoutMs,
    profile,
    spawnPlan,
    receiptPath,
    evidencePath,
    studioStateDirectory: path.join(profile.userDataPath, STUDIO_STATE_DIR),
    safety: {
      planOnlyByDefault: true,
      usesSanctionedInstanceLane: true,
      isolatedHome: true,
      mockKeychain: spawnPlan.safety.disposableMockKeychain,
      exactPortOwnership: true,
      authoritativeBuildIncludesStudioCompanion: true,
      watchdogOwnsSpawn: true,
      parentDisconnectReapsExactGroup: true,
      neverAutoDeletesArtifacts: true,
      neverTargetsLiveOrSharedProfile: true,
      launchRequiresOwnerOrphanClearance: true,
      refusesLaunchOnPriorLiveGroup: true,
      exactCompanionWindowTargeting: true,
      boundedUiActionAllowlist: true,
      uiDriverNeverSignalsProcesses: true,
      realTranscriptRequired: true,
      evidenceAfterVerifiedGroupExit: true
    }
  }
}

function assertLaunchAuthorized(args, plan) {
  if (!args.launch) {
    return { launch: false, reason: 'plan-only; --launch not supplied' }
  }
  if (!args.acceptLaunch) {
    throw new Error('Real launch requires --i-accept-studio-isolated-launch')
  }
  if (!args.ownerConfirmsOrphansCleared) {
    throw new Error(
      'Real launch requires --owner-confirms-existing-orphans-cleared; do not stack another Electron on a known orphan'
    )
  }
  if (process.platform !== 'darwin') {
    throw new Error('Studio acceptance launch is macOS-only')
  }
  if (
    !Number.isSafeInteger(args.timeoutMs) ||
    args.timeoutMs < 30_000 ||
    args.timeoutMs > 30 * 60 * 1_000
  ) {
    throw new Error('timeoutMs must be an integer 30000–1800000')
  }
  if (plan.transcriptTimeoutMs > args.timeoutMs) {
    throw new Error('transcriptTimeoutMs cannot exceed the watchdog timeoutMs')
  }
  if (!args.mediaPath || !path.isAbsolute(args.mediaPath)) {
    throw new Error('Real launch requires --media=<absolute video path>')
  }
  if (!['video/mp4', 'video/quicktime'].includes(String(args.mimeType || '').toLowerCase())) {
    throw new Error('Real launch requires --mime=video/mp4 or --mime=video/quicktime')
  }
  if (!plan.spawnPlan.argv.includes('--use-mock-keychain')) {
    throw new Error('Refuse launch without disposable macOS mock keychain')
  }
  return { launch: true }
}

function mediaExtension(mimeType) {
  if (mimeType === 'video/mp4') return 'mp4'
  if (mimeType === 'video/quicktime') return 'mov'
  throw new Error(`Unsupported Studio acceptance MIME: ${mimeType}`)
}

async function sha256Base64Url(filePath) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('base64url')
}

async function materializeOwnedMedia(options) {
  const sourcePath = path.resolve(options.mediaPath)
  const before = await fsPromises.lstat(sourcePath)
  if (before.isSymbolicLink() || !before.isFile() || before.size <= 0) {
    throw new Error('Acceptance media must be a non-empty regular file, not a symlink')
  }
  const realSource = await fsPromises.realpath(sourcePath)
  const hash = await sha256Base64Url(realSource)
  const mimeType = options.mimeType.toLowerCase()
  const baseDir = path.join(options.userDataPath, TRANSCRIPT_MEDIA_DIR)
  const shard = path.join(baseDir, hash.slice(0, 2))
  const target = path.join(shard, `${hash}.${mediaExtension(mimeType)}`)
  await fsPromises.mkdir(shard, { recursive: true, mode: 0o700 })

  try {
    const existing = await fsPromises.lstat(target)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('Existing acceptance asset is not a safe regular file')
    }
    const existingHash = await sha256Base64Url(target)
    if (existingHash !== hash) throw new Error('Existing acceptance asset hash mismatch')
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
    const temp = path.join(shard, `.${hash}.${process.pid}.tmp`)
    try {
      await fsPromises.copyFile(realSource, temp, fs.constants.COPYFILE_EXCL)
      await fsPromises.chmod(temp, 0o600)
      const copiedHash = await sha256Base64Url(temp)
      if (copiedHash !== hash) throw new Error('Acceptance media copy hash mismatch')
      await fsPromises.rename(temp, target)
    } catch (error) {
      await fsPromises.rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  return {
    sha256: hash,
    mimeType,
    sourcePath: realSource,
    assetPath: await fsPromises.realpath(target),
    byteLength: before.size
  }
}

const ISOLATED_GROK_GUARD = [
  '#!/bin/sh',
  '# TaskWraith Studio isolated acceptance: provider probe disabled',
  'exit 0',
  ''
].join('\n')

async function materializeIsolatedProviderGuards(options) {
  const home = path.resolve(options.home)
  const grokDirectory = path.join(home, '.grok', 'bin')
  const grokBinaryPath = path.join(grokDirectory, 'grok')
  const sha256 = crypto.createHash('sha256').update(ISOLATED_GROK_GUARD).digest('hex')

  await fsPromises.mkdir(grokDirectory, { recursive: true, mode: 0o700 })
  try {
    const existing = await fsPromises.lstat(grokBinaryPath)
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error('Existing isolated Grok guard is not a safe regular file')
    }
    const content = await fsPromises.readFile(grokBinaryPath, 'utf8')
    if (content !== ISOLATED_GROK_GUARD) {
      throw new Error('Existing isolated Grok guard content does not match the acceptance guard')
    }
    await fsPromises.chmod(grokBinaryPath, 0o700)
    return { grokBinaryPath, sha256 }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }

  const temp = path.join(
    grokDirectory,
    `.grok-acceptance-${process.pid}-${crypto.randomUUID()}.tmp`
  )
  try {
    await fsPromises.writeFile(temp, ISOLATED_GROK_GUARD, {
      encoding: 'utf8',
      mode: 0o700,
      flag: 'wx'
    })
    await fsPromises.chmod(temp, 0o700)
    await fsPromises.link(temp, grokBinaryPath)
  } finally {
    await fsPromises.rm(temp, { force: true }).catch(() => undefined)
  }

  return { grokBinaryPath, sha256 }
}

function launchUnderWatchdog(spec, adapters = {}) {
  const forkProcess =
    adapters.fork ||
    ((modulePath, args, options) => {
      return fork(modulePath, args, options)
    })
  const launchTimeoutMs = adapters.launchTimeoutMs || 10_000
  const controller = forkProcess(WATCHDOG_PATH, [], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, ...(adapters.controllerEnv || {}) }
  })
  if (!controller || !Number.isInteger(controller.pid) || controller.pid <= 0) {
    return Promise.reject(new Error('Studio acceptance watchdog returned no pid'))
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let terminalMessage = null
    const terminalWaiters = []
    const disconnectController = () => {
      if (!controller.connected) return
      try {
        controller.disconnect()
      } catch {
        // The controller may have exited between the connected check and disconnect.
      }
    }
    const rejectBeforeLaunch = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      disconnectController()
      reject(error)
    }
    const timer = setTimeout(() => {
      rejectBeforeLaunch(
        new Error(`Studio acceptance watchdog launch timed out after ${launchTimeoutMs}ms`)
      )
    }, launchTimeoutMs)

    const settleTerminal = (message) => {
      terminalMessage = message
      while (terminalWaiters.length > 0) terminalWaiters.shift()(message)
    }

    controller.on('message', (message) => {
      if (!isRecord(message)) return
      if (message.type === 'terminal') settleTerminal(message)
      if (message.type === 'error' && !settled) {
        rejectBeforeLaunch(new Error(String(message.error || 'watchdog launch failed')))
        return
      }
      if (message.type !== 'launched' || settled) return
      settled = true
      clearTimeout(timer)
      const session = {
        controllerPid: message.controllerPid,
        pid: message.childPid,
        pgid: message.childPgid || undefined,
        receiptPath: message.receiptPath,
        remoteDebuggingPort: spec.remoteDebuggingPort,
        mainInspectorPort: spec.mainInspectorPort,
        instanceId: spec.env.TASKWRAITH_INSTANCE_ID,
        waitForTerminal(timeoutMs = 15_000) {
          if (terminalMessage) return Promise.resolve(terminalMessage)
          return new Promise((accept, deny) => {
            const timeout = setTimeout(
              () => deny(new Error(`watchdog termination timed out after ${timeoutMs}ms`)),
              timeoutMs
            )
            terminalWaiters.push((terminal) => {
              clearTimeout(timeout)
              accept(terminal)
            })
          })
        },
        async stop(reason = 'owner_requested') {
          if (terminalMessage) return terminalMessage
          if (controller.connected) controller.send({ type: 'stop', reason })
          return this.waitForTerminal()
        },
        disconnectOwnerForTest() {
          controller.disconnect()
        }
      }
      resolve(session)
    })

    controller.once('error', (error) => {
      rejectBeforeLaunch(error)
    })
    controller.once('exit', (code, signal) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(
          new Error(`Studio acceptance watchdog exited before launch code=${code} signal=${signal}`)
        )
      }
    })

    try {
      controller.send({ type: 'launch', spec }, (error) => {
        if (error) rejectBeforeLaunch(error)
      })
    } catch (error) {
      rejectBeforeLaunch(error)
    }
  })
}

async function evaluateByValue(session, expression) {
  const response = await session.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (response && response.exceptionDetails) {
    throw new Error(
      `Renderer evaluation failed: ${JSON.stringify(response.exceptionDetails).slice(0, 1000)}`
    )
  }
  return response && response.result ? response.result.value : undefined
}

async function waitFor(options) {
  const timeoutMs = options.timeoutMs || DEFAULT_WAIT_MS
  const intervalMs = options.intervalMs || 100
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() <= deadline) {
    try {
      const value = await options.probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  const suffix = lastError
    ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : ''
  throw new Error(`${options.label} timed out after ${timeoutMs}ms${suffix}`)
}

async function invokeAuthorizedStudioOpen(renderer, asset) {
  await waitFor({
    label: 'renderer preload Studio API',
    probe: async () =>
      (await evaluateByValue(
        renderer,
        `typeof window.api?.openMediaAssetInStudio === "function"`
      )) === true
  })
  const expression = `window.api.openMediaAssetInStudio(${JSON.stringify(
    asset.sha256
  )}, ${JSON.stringify(asset.mimeType)})`
  return waitFor({
    label: 'hydrated Studio open_media result',
    intervalMs: 250,
    probe: async () => {
      const result = await evaluateByValue(renderer, expression)
      if (result && result.ok === true) return result
      const error = result && typeof result.error === 'string' ? result.error : ''
      if (/unavailable|hydration|not completed/i.test(error)) return null
      throw new Error(`Open in Studio failed: ${error || JSON.stringify(result)}`)
    }
  })
}

function parseProcessTable(stdout) {
  const rows = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4]
    })
  }
  return rows
}

function commandContainsBoundedPath(command, boundedPath) {
  let offset = 0
  while (offset <= command.length) {
    const index = command.indexOf(boundedPath, offset)
    if (index < 0) return false
    const before = index === 0 ? '' : command[index - 1]
    const afterIndex = index + boundedPath.length
    const after = afterIndex >= command.length ? '' : command[afterIndex]
    const beforeIsBoundary = index === 0 || /[\s="'(,]/.test(before)
    const afterIsBoundary = after === '' || after === path.sep || /[\s"'),:]/.test(after)
    if (beforeIsBoundary && afterIsBoundary) return true
    offset = index + boundedPath.length
  }
  return false
}

function commandReferencesArtifactHome(command, artifactHome) {
  const home = path.resolve(artifactHome)
  if (home === path.parse(home).root) return false
  return commandContainsBoundedPath(command, home)
}

function findAcceptanceArtifactGroups(rows, artifactHomes, baselinePids = new Set()) {
  const homes = [...new Set(artifactHomes.map((home) => path.resolve(home)))].filter(
    (home) => home !== path.parse(home).root
  )
  const byPgid = new Map()
  for (const row of rows) {
    if (
      baselinePids.has(row.pid) ||
      !Number.isSafeInteger(row.pgid) ||
      row.pgid <= 0 ||
      !homes.some((home) => commandReferencesArtifactHome(row.command, home))
    ) {
      continue
    }
    const evidence = byPgid.get(row.pgid) || []
    evidence.push(row.pid)
    byPgid.set(row.pgid, evidence)
  }

  const groups = []
  for (const [pgid, evidencePids] of byPgid.entries()) {
    const members = rows.filter((row) => row.pgid === pgid)
    // Never claim a group that already contained a process before the
    // acceptance launch. A mixed-ownership group is not safe to signal.
    if (members.some((row) => baselinePids.has(row.pid))) continue
    groups.push({
      pgid,
      evidencePids: [...new Set(evidencePids)].sort((left, right) => left - right),
      members: [...members].sort((left, right) => left.pid - right.pid)
    })
  }
  return groups.sort((left, right) => left.pgid - right.pgid)
}

function descendantsOf(rows, rootPid) {
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
        descendants.add(row.pid)
        changed = true
      }
    }
  }
  return rows.filter((row) => row.pid !== rootPid && descendants.has(row.pid))
}

function defaultExecFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: options.timeoutMs || 10_000,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.env ? { env: options.env } : {})
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${path.basename(file)} failed: ${String(
                (stderr && String(stderr).trim()) || error.message || error
              ).slice(0, 1000)}`
            )
          )
        } else {
          resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
        }
      }
    )
  })
}

/**
 * Read every prior watchdog receipt under the acceptance root.
 *
 * A receipt we cannot read is reported as `malformed` rather than skipped: an
 * unreadable receipt is precisely the case where we do not know whether a
 * process group leaked, so it must fail closed.
 */
async function readPriorWatchdogReceipts(acceptanceRoot) {
  let entries
  try {
    entries = await fsPromises.readdir(acceptanceRoot, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }

  const receipts = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const receiptPath = path.join(acceptanceRoot, entry.name, 'watchdog-receipt.json')
    let raw
    try {
      const stat = await fsPromises.lstat(receiptPath)
      if (!stat.isFile()) {
        receipts.push({ receiptPath, malformed: 'receipt is not a regular file' })
        continue
      }
      if (stat.size > ACCEPTANCE_RECEIPT_MAX_BYTES) {
        receipts.push({
          receiptPath,
          malformed: `receipt exceeds ${ACCEPTANCE_RECEIPT_MAX_BYTES} bytes`
        })
        continue
      }
      raw = await fsPromises.readFile(receiptPath, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') continue
      receipts.push({
        receiptPath,
        malformed: error instanceof Error ? error.message : String(error)
      })
      continue
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      receipts.push({ receiptPath, malformed: 'receipt is not valid JSON' })
      continue
    }
    if (!isRecord(parsed)) {
      receipts.push({ receiptPath, malformed: 'receipt is not a JSON object' })
      continue
    }
    receipts.push({ receiptPath, receipt: parsed })
  }
  return receipts
}

function validatePriorWatchdogReceipt(entry) {
  const receipt = entry.receipt
  if (receipt.kind !== WATCHDOG_RECEIPT_KIND) {
    return { ...entry, malformed: 'receipt kind is not recognized' }
  }
  if (!KNOWN_RECEIPT_SCHEMA_VERSIONS.has(receipt.schemaVersion)) {
    return { ...entry, malformed: 'receipt schema version is not recognized' }
  }
  if (!KNOWN_RECEIPT_STATUSES.has(receipt.status)) {
    return { ...entry, malformed: 'receipt status is not recognized' }
  }

  if (
    receipt.status === 'spawn_failed' &&
    receipt.childPid === null &&
    receipt.childPgid === null
  ) {
    return { ...entry, trusted: true, pgid: null }
  }

  if (!Number.isSafeInteger(receipt.childPid) || receipt.childPid <= 0) {
    return { ...entry, malformed: 'receipt has no valid child process id' }
  }
  if (!Number.isSafeInteger(receipt.childPgid) || receipt.childPgid <= 0) {
    return { ...entry, malformed: 'receipt has no valid child process group id' }
  }
  if (receipt.childPid !== receipt.childPgid) {
    return { ...entry, malformed: 'receipt does not identify the exact owned process group' }
  }

  const trusted =
    receipt.schemaVersion === TRUSTED_RECEIPT_SCHEMA_VERSION &&
    VERIFIED_TERMINAL_RECEIPT_STATUSES.has(receipt.status) &&
    receipt.groupExitVerified === true
  return { ...entry, trusted, pgid: receipt.childPgid }
}

function commandRunsExactExecutable(command, executable) {
  return command === executable || command.startsWith(`${executable} `)
}

function isProtectedInstalledTaskWraithStudioGroup(pgid, members) {
  const installedOwner = members.some(
    (row) =>
      row.pid === pgid && commandRunsExactExecutable(row.command, INSTALLED_TASKWRAITH_EXECUTABLE)
  )
  if (!installedOwner) return false

  return members.some(
    (row) =>
      row.ppid === pgid &&
      row.pgid === pgid &&
      commandRunsExactExecutable(row.command, INSTALLED_STUDIO_EXECUTABLE)
  )
}

/**
 * Refuse to stack a launch on a process group a previous acceptance run may
 * have leaked. This NEVER kills anything: a suspected orphan is reported with
 * its receipt, PGID and current member rows so a human adjudicates it.
 *
 * A historical PGID is not a durable identity — the OS reuses group ids — so a
 * receipt is trusted and skipped only when it is a recognized schema-v2
 * watchdog receipt with a clean terminal status and groupExitVerified:true,
 * because only that shape was written after the watchdog actually observed the
 * exact group disappear. Every legacy or unverified receipt is scanned even
 * when it claims `reaped`, because the known false-green path produced exactly
 * that claim.
 *
 * A reused PGID now led by the exact installed TaskWraith executable and its
 * exact packaged Studio child is protected separately: it cannot be the
 * disposable Electron group launched by this harness and must never be targeted.
 */
async function assertNoPriorStudioOrphans(plan, adapters = {}) {
  if (process.platform === 'win32') {
    return {
      scanned: 0,
      trusted: 0,
      protectedInstalledGroups: [],
      orphans: []
    }
  }

  const acceptanceRoot = path.dirname(path.resolve(plan.artifactRoot))
  const priors = await (adapters.readPriorReceipts || readPriorWatchdogReceipts)(acceptanceRoot)

  const validated = priors.map((entry) =>
    entry.malformed ? entry : validatePriorWatchdogReceipt(entry)
  )
  const malformed = validated.filter((entry) => entry.malformed)
  if (malformed.length > 0) {
    throw new Error(
      `Refusing launch: ${malformed.length} prior Studio acceptance receipt(s) could not be read, so a leaked process group cannot be ruled out. Inspect manually:\n${malformed
        .map((entry) => `  ${entry.receiptPath} — ${entry.malformed}`)
        .join('\n')}`
    )
  }

  const suspects = []
  let trusted = 0
  for (const entry of validated) {
    if (entry.trusted) {
      trusted += 1
      continue
    }
    suspects.push({
      receiptPath: entry.receiptPath,
      pgid: entry.pgid,
      recordedStatus: typeof entry.receipt.status === 'string' ? entry.receipt.status : null
    })
  }
  if (priors.length === 0) {
    return {
      scanned: 0,
      trusted,
      protectedInstalledGroups: [],
      orphans: []
    }
  }

  const runExec = adapters.execFile || defaultExecFile
  const sample = await runExec('/bin/ps', ['-axww', '-o', 'pid=,ppid=,pgid=,command='])
  const rows = parseProcessTable(sample.stdout)
  const priorHomes = validated.map((entry) => path.join(path.dirname(entry.receiptPath), 'home'))
  const artifactGroups = findAcceptanceArtifactGroups(rows, priorHomes)
  if (artifactGroups.length > 0) {
    throw new Error(
      `Refusing launch: ${artifactGroups.length} prior Studio acceptance artifact-bound detached process group(s) are still alive. Nothing was killed — adjudicate manually:\n${artifactGroups
        .map(
          (group) =>
            `  pgid ${group.pgid}, evidence pids ${group.evidencePids.join(', ')}, members: ${group.members
              .map((row) => `${row.pid} ${row.command}`)
              .join(', ')}`
        )
        .join('\n')}`
    )
  }

  const orphans = []
  const protectedInstalledGroups = []
  for (const suspect of suspects) {
    const members = rows.filter((row) => row.pgid === suspect.pgid)
    if (members.length === 0) continue
    if (isProtectedInstalledTaskWraithStudioGroup(suspect.pgid, members)) {
      protectedInstalledGroups.push({
        receiptPath: suspect.receiptPath,
        pgid: suspect.pgid,
        memberPids: members.map((row) => row.pid).sort((left, right) => left - right)
      })
      continue
    }
    orphans.push({ ...suspect, members })
  }
  if (orphans.length > 0) {
    throw new Error(
      `Refusing launch: ${orphans.length} prior Studio acceptance process group(s) are still alive. Nothing was killed — adjudicate manually:\n${orphans
        .map(
          (orphan) =>
            `  pgid ${orphan.pgid} (receipt ${orphan.receiptPath}, recorded status ${String(
              orphan.recordedStatus
            )}) members: ${orphan.members.map((row) => `${row.pid} ${row.command}`).join(', ')}`
        )
        .join('\n')}`
    )
  }
  return {
    scanned: priors.length,
    trusted,
    protectedInstalledGroups,
    orphans: []
  }
}

function assertCleanWatchdogTerminal(terminal) {
  if (
    !isRecord(terminal) ||
    terminal.status !== 'reaped' ||
    terminal.groupExitVerified !== true ||
    terminal.detachedGroupExitVerified !== true ||
    terminal.reason !== 'owner_requested'
  ) {
    throw new Error(
      `Studio acceptance watchdog did not confirm clean owner-requested teardown: ${JSON.stringify(
        terminal
      ).slice(0, 1000)}`
    )
  }
  return terminal
}

async function runStudioAcceptanceBuild(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'))
  const runExec = options.execFile || defaultExecFile
  const steps = [
    { command: 'npm', args: ['run', 'prebuild:bridge-daemon'] },
    { command: 'npm', args: ['run', 'prebuild:studio-companion'] },
    { command: 'npx', args: ['electron-vite', 'build'] }
  ]
  const results = []
  for (const step of steps) {
    results.push(
      await runExec(step.command, step.args, {
        cwd: repoRoot,
        env: process.env,
        timeoutMs: 10 * 60 * 1000
      })
    )
  }
  return { ok: true, steps: steps.map((step) => [step.command, ...step.args].join(' ')), results }
}

async function findStudioCompanion(rootPid, adapters = {}) {
  const runExec = adapters.execFile || defaultExecFile
  return waitFor({
    label: 'TaskWraithStudioCompanion descendant',
    probe: async () => {
      const result = await runExec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command='])
      const descendants = descendantsOf(parseProcessTable(result.stdout), rootPid)
      return (
        descendants.find((row) => /(?:^|\/)TaskWraithStudioCompanion(?:\s|$)/.test(row.command)) ||
        null
      )
    }
  })
}

const STUDIO_JOURNAL_MAX_BYTES = 16 * 1024 * 1024
const STUDIO_UI_DRIVER_MAX_ACTIONS = 32
const STUDIO_UI_KEYS = new Set([
  'space',
  'tab',
  'return',
  'left',
  'shift-left',
  'right',
  'bracket-left',
  'bracket-right',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'i',
  'o',
  'l',
  'p',
  'c',
  'g',
  's',
  'v',
  'w',
  'a',
  'r'
])

function assertSafeUiDriverTarget(options) {
  const companion = options.companion
  const electronPgid = options.electronPgid
  const window = options.window
  if (
    !isRecord(companion) ||
    !Number.isSafeInteger(companion.pid) ||
    companion.pid <= 0 ||
    !Number.isSafeInteger(companion.pgid) ||
    companion.pgid <= 0
  ) {
    throw new Error('Studio UI driver requires an exact positive Companion pid and pgid')
  }
  if (!Number.isSafeInteger(electronPgid) || companion.pgid !== electronPgid) {
    throw new Error(
      `Studio UI driver process group mismatch: companion ${companion.pgid}, watchdog ${electronPgid}`
    )
  }
  const command = String(companion.command || '')
  if (command.includes('/Applications/TaskWraith.app/')) {
    throw new Error('Studio UI driver refuses the installed TaskWraith process group')
  }
  const executableMatch = /(^.*\/TaskWraithStudioCompanion)(?:\s|$)/.exec(command)
  if (!executableMatch || !path.isAbsolute(executableMatch[1])) {
    throw new Error('Studio UI driver target is not the exact Companion executable')
  }
  if (
    !isRecord(window) ||
    window.pid !== companion.pid ||
    !Number.isSafeInteger(window.visibleWindowCount) ||
    window.visibleWindowCount < 1 ||
    !Array.isArray(window.windows) ||
    window.windows.length !== window.visibleWindowCount
  ) {
    throw new Error('Studio UI driver requires an exact visible-window set for the Companion pid')
  }
  const expectedWindowTitle = options.expectedWindowTitle
  const candidates = expectedWindowTitle
    ? window.windows.filter((entry) => isRecord(entry) && entry.title === expectedWindowTitle)
    : window.visibleWindowCount === 1
      ? window.windows
      : []
  if (candidates.length !== 1) {
    throw new Error('Studio UI driver requires one exact visible window identity')
  }
  const exactWindow = candidates[0]
  const bounds = exactWindow && exactWindow.bounds
  if (
    !isRecord(exactWindow) ||
    !Number.isSafeInteger(exactWindow.windowId) ||
    exactWindow.windowId <= 0 ||
    typeof exactWindow.title !== 'string' ||
    !exactWindow.title.trim() ||
    !isRecord(bounds) ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(
      (value) => typeof value === 'number' && Number.isFinite(value)
    ) ||
    bounds.width <= 1 ||
    bounds.height <= 1
  ) {
    throw new Error('Studio UI driver requires an exact positive window id and finite bounds')
  }
  return {
    companion,
    exactWindow,
    bounds,
    expectedExecutablePath: path.resolve(executableMatch[1])
  }
}

function buildStudioUiDriverRequest(options) {
  const { companion, exactWindow, bounds, expectedExecutablePath } =
    assertSafeUiDriverTarget(options)
  const artifactRoot = path.resolve(String(options.artifactRoot || ''))
  const actions = options.actions
  if (
    !Array.isArray(actions) ||
    actions.length < 1 ||
    actions.length > STUDIO_UI_DRIVER_MAX_ACTIONS
  ) {
    throw new Error(`Studio UI driver requires 1–${STUDIO_UI_DRIVER_MAX_ACTIONS} bounded actions`)
  }
  const normalizedActions = actions.map((action) => {
    if (!isRecord(action)) throw new Error('unsupported UI action: action must be an object')
    if (action.type === 'key' && STUDIO_UI_KEYS.has(action.key)) {
      return { type: 'key', key: action.key }
    }
    if (
      action.type === 'click' &&
      typeof action.xFraction === 'number' &&
      Number.isFinite(action.xFraction) &&
      action.xFraction > 0 &&
      action.xFraction < 1 &&
      typeof action.yFraction === 'number' &&
      Number.isFinite(action.yFraction) &&
      action.yFraction > 0 &&
      action.yFraction < 1
    ) {
      return {
        type: 'click',
        xFraction: action.xFraction,
        yFraction: action.yFraction
      }
    }
    if (
      action.type === 'press-playback' &&
      ((action.playbackValueBefore === 'paused' && action.playbackValueAfter === 'playing') ||
        (action.playbackValueBefore === 'playing' && action.playbackValueAfter === 'paused'))
    ) {
      return {
        type: 'press-playback',
        accessibilityLabel: 'Playback',
        accessibilityAction: 'AXPress',
        playbackValueBefore: action.playbackValueBefore,
        playbackValueAfter: action.playbackValueAfter
      }
    }
    if (
      action.type === 'set-playhead-ticks' &&
      Number.isSafeInteger(action.playheadTicks) &&
      action.playheadTicks >= 0 &&
      (action.playheadToleranceTicks === undefined ||
        (Number.isSafeInteger(action.playheadToleranceTicks) &&
          action.playheadToleranceTicks >= 0 &&
          action.playheadToleranceTicks <= 50_000)) &&
      (action.playheadMaximumForwardAdvanceTicks === undefined ||
        (Number.isSafeInteger(action.playheadMaximumForwardAdvanceTicks) &&
          action.playheadMaximumForwardAdvanceTicks >= 0 &&
          action.playheadMaximumForwardAdvanceTicks <=
            STUDIO_UI_MAX_PLAYHEAD_FORWARD_ADVANCE_TICKS))
    ) {
      return {
        type: 'set-playhead-ticks',
        playheadTicks: action.playheadTicks,
        playheadToleranceTicks: action.playheadToleranceTicks ?? 0,
        playheadMaximumForwardAdvanceTicks: action.playheadMaximumForwardAdvanceTicks ?? 0
      }
    }
    if (
      action.type === 'step-playhead-frame' &&
      (action.playheadStepFrames === -1 || action.playheadStepFrames === 1)
    ) {
      return {
        type: 'step-playhead-frame',
        playheadStepFrames: action.playheadStepFrames
      }
    }
    if (action.type === 'read-transport-mutation') {
      return {
        type: 'read-transport-mutation',
        accessibilityLabel: 'Transport mutation detail'
      }
    }
    if (action.type === 'screenshot' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(action.name)) {
      const screenshotPath = path.resolve(artifactRoot, 'screenshots', `${String(action.name)}.png`)
      if (!screenshotPath.startsWith(`${artifactRoot}${path.sep}`)) {
        throw new Error('unsupported UI action: screenshot escaped the artifact root')
      }
      return { type: 'screenshot', name: action.name, path: screenshotPath }
    }
    if (
      action.type === 'audio-probe' &&
      Number.isSafeInteger(action.durationSeconds) &&
      action.durationSeconds >= 1 &&
      action.durationSeconds <= 600
    ) {
      return { type: 'audio-probe', durationSeconds: action.durationSeconds }
    }
    throw new Error(`unsupported UI action: ${JSON.stringify(action).slice(0, 200)}`)
  })
  const inputDelivery = options.inputDelivery || 'background-observation-only'
  const hasInteractiveActions = normalizedActions.some(
    (action) => action.type === 'key' || action.type === 'click'
  )
  if (
    inputDelivery !== 'background-observation-only' &&
    inputDelivery !== 'foreground-global-explicit'
  ) {
    throw new Error('Studio UI driver refused an unknown input-delivery mode')
  }
  if (hasInteractiveActions && inputDelivery !== 'foreground-global-explicit') {
    throw new Error('Studio UI driver background observation refuses keyboard and pointer actions')
  }
  if (
    inputDelivery === 'foreground-global-explicit' &&
    (options.allowForegroundInput !== true || !hasInteractiveActions)
  ) {
    throw new Error(
      'Studio UI driver foreground delivery requires an explicit per-call interactive opt-in'
    )
  }
  return {
    schemaVersion: 1,
    kind: 'taskwraith-studio-ui-driver-request',
    inputDelivery,
    allowForegroundInput: inputDelivery === 'foreground-global-explicit',
    expectedPid: companion.pid,
    expectedPgid: companion.pgid,
    expectedExecutablePath,
    windowId: exactWindow.windowId,
    windowTitle: exactWindow.title,
    windowBounds: bounds,
    artifactRoot,
    actions: normalizedActions
  }
}

async function readStudioJournalOperations(plan) {
  const journalPath = path.join(plan.studioStateDirectory, STUDIO_JOURNAL_FILE)
  let stat
  try {
    stat = await fsPromises.lstat(journalPath)
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Studio journal is not a safe regular file')
  }
  if (stat.size > STUDIO_JOURNAL_MAX_BYTES) {
    throw new Error(`Studio journal exceeds ${STUDIO_JOURNAL_MAX_BYTES} bytes`)
  }
  const raw = await fsPromises.readFile(journalPath, 'utf8')
  const entries = []
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      throw new Error(`Studio journal line ${index + 1} is not valid JSON`)
    }
    if (
      !isRecord(entry) ||
      entry.format !== 'taskwraith-studio-journal' ||
      entry.v !== 1 ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 1 ||
      !isRecord(entry.op) ||
      typeof entry.op.type !== 'string'
    ) {
      throw new Error(`Studio journal line ${index + 1} has an invalid shape`)
    }
    entries.push(entry)
  }
  return entries
}

function studioJournalOperationMatches(entry, expectation, afterRevision) {
  if (entry.revision <= afterRevision || entry.op.type !== expectation.type) return false
  if (
    expectation.assetId !== undefined &&
    entry.op.transcript &&
    entry.op.transcript.assetId !== expectation.assetId
  ) {
    return false
  }
  if (
    expectation.proposalId !== undefined &&
    (entry.op.proposalId || entry.op.proposal?.proposalId) !== expectation.proposalId
  ) {
    return false
  }
  if (expectation.decision !== undefined && entry.op.decision !== expectation.decision) {
    return false
  }
  if (expectation.requireNonEmptyTranscript) {
    const segments = entry.op.transcript && entry.op.transcript.segments
    if (
      !Array.isArray(segments) ||
      !segments.some(
        (segment) => isRecord(segment) && typeof segment.text === 'string' && segment.text.trim()
      )
    ) {
      return false
    }
  }
  return true
}

async function waitForStudioJournalOperation(plan, expectation, options = {}) {
  const afterRevision = Number.isSafeInteger(options.afterRevision) ? options.afterRevision : 0
  return waitFor({
    label: `durable Studio ${expectation.type} journal operation`,
    timeoutMs: options.timeoutMs,
    intervalMs: options.intervalMs || 100,
    probe: async () => {
      const entries = await (options.readJournalOperations || readStudioJournalOperations)(plan)
      return (
        entries.find((entry) => studioJournalOperationMatches(entry, expectation, afterRevision)) ||
        null
      )
    }
  })
}

async function runStudioUiDriver(plan, target, actions, adapters = {}) {
  const request = buildStudioUiDriverRequest({
    ...target,
    artifactRoot: plan.artifactRoot,
    actions,
    inputDelivery: adapters.inputDelivery,
    allowForegroundInput: adapters.allowForegroundInput
  })
  await fsPromises.mkdir(plan.artifactRoot, { recursive: true, mode: 0o700 })
  const requestDirectory = path.join(plan.artifactRoot, 'ui-driver-requests')
  await fsPromises.mkdir(requestDirectory, { recursive: true, mode: 0o700 })
  const requestPath = path.join(requestDirectory, `${crypto.randomUUID()}.json`)
  const temp = `${requestPath}.tmp-${process.pid}`
  await fsPromises.writeFile(temp, `${JSON.stringify(request, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  await fsPromises.rename(temp, requestPath)

  const runExec = adapters.execFile || defaultExecFile
  const longestAudioProbeSeconds = request.actions.reduce(
    (longest, action) =>
      action.type === 'audio-probe' ? Math.max(longest, action.durationSeconds) : longest,
    0
  )
  const result = await runExec('/usr/bin/swift', [UI_DRIVER_PATH, requestPath], {
    timeoutMs: Math.max(60_000, longestAudioProbeSeconds * 1000 + 30_000)
  })
  let receipt
  try {
    receipt = JSON.parse(result.stdout)
  } catch {
    throw new Error('Studio UI driver did not return a JSON receipt')
  }
  if (
    !isRecord(receipt) ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== 'taskwraith-studio-ui-driver-receipt' ||
    receipt.inputDelivery !== request.inputDelivery ||
    receipt.pid !== request.expectedPid ||
    receipt.pgid !== request.expectedPgid ||
    receipt.windowId !== request.windowId ||
    !Array.isArray(receipt.actions) ||
    receipt.actions.length !== request.actions.length
  ) {
    throw new Error(`Studio UI driver returned an invalid receipt: ${result.stdout.slice(0, 1000)}`)
  }
  for (const [index, action] of request.actions.entries()) {
    const observed = receipt.actions[index]
    if (!isRecord(observed) || observed.index !== index || observed.type !== action.type) {
      throw new Error('Studio UI driver action receipt does not match the bounded request')
    }
    if (action.type === 'key' && observed.key !== action.key) {
      throw new Error('Studio UI driver key receipt does not match the bounded request')
    }
    if (
      action.type === 'click' &&
      (observed.xFraction !== action.xFraction || observed.yFraction !== action.yFraction)
    ) {
      throw new Error('Studio UI driver click receipt does not match the bounded request')
    }
    if (
      action.type === 'press-playback' &&
      (observed.accessibilityLabel !== action.accessibilityLabel ||
        observed.accessibilityAction !== action.accessibilityAction ||
        observed.playbackValueBefore !== action.playbackValueBefore ||
        observed.playbackValueAfter !== action.playbackValueAfter)
    ) {
      throw new Error('Studio UI driver Playback receipt does not match the bounded request')
    }
    if (
      action.type === 'set-playhead-ticks' &&
      (observed.playheadTicks !== action.playheadTicks ||
        observed.playheadToleranceTicks !== action.playheadToleranceTicks ||
        observed.playheadMaximumForwardAdvanceTicks !== action.playheadMaximumForwardAdvanceTicks ||
        !Number.isSafeInteger(observed.observedPlayheadTicks) ||
        (observed.observedPlayheadTicks < action.playheadTicks
          ? action.playheadTicks - observed.observedPlayheadTicks > action.playheadToleranceTicks
          : observed.observedPlayheadTicks - action.playheadTicks >
            action.playheadToleranceTicks + action.playheadMaximumForwardAdvanceTicks))
    ) {
      throw new Error('Studio UI driver playhead receipt does not match the bounded request')
    }
    if (
      action.type === 'step-playhead-frame' &&
      (observed.playheadStepFrames !== action.playheadStepFrames ||
        !Number.isSafeInteger(observed.playheadTicksBefore) ||
        !Number.isSafeInteger(observed.observedPlayheadTicks) ||
        Math.sign(observed.observedPlayheadTicks - observed.playheadTicksBefore) !==
          action.playheadStepFrames)
    ) {
      throw new Error('Studio UI driver playhead-step receipt does not match the bounded request')
    }
    if (action.type === 'read-transport-mutation') {
      if (
        observed.accessibilityLabel !== action.accessibilityLabel ||
        observed.accessibilityRole !== 'AXStaticText' ||
        observed.accessibilityMatchCount !== 1 ||
        typeof observed.accessibilityValue !== 'string'
      ) {
        throw new Error(
          'Studio UI driver transport-mutation receipt does not match the bounded request'
        )
      }
      try {
        parseStudioTransportMutationText(observed.accessibilityValue)
      } catch (error) {
        throw new Error(`Studio UI driver transport-mutation receipt is invalid: ${error.message}`)
      }
    }
    if (
      action.type === 'screenshot' &&
      (observed.screenshotPath !== action.path ||
        !Number.isSafeInteger(observed.byteLength) ||
        observed.byteLength < 1)
    ) {
      throw new Error('Studio UI driver screenshot receipt does not match the bounded request')
    }
    if (action.type === 'audio-probe') {
      const probe = observed.audioProbe
      const output = probe && probe.defaultOutputDevice
      if (
        !isRecord(probe) ||
        probe.durationSeconds !== action.durationSeconds ||
        typeof probe.elapsedSeconds !== 'number' ||
        !Number.isFinite(probe.elapsedSeconds) ||
        probe.elapsedSeconds < action.durationSeconds ||
        probe.elapsedSeconds > action.durationSeconds + 10 ||
        !Number.isSafeInteger(probe.sampleBufferCount) ||
        probe.sampleBufferCount < 0 ||
        !Number.isSafeInteger(probe.frameCount) ||
        probe.frameCount < 0 ||
        !Number.isSafeInteger(probe.sampleValueCount) ||
        probe.sampleValueCount < 0 ||
        typeof probe.sampleRate !== 'number' ||
        !Number.isFinite(probe.sampleRate) ||
        probe.sampleRate <= 0 ||
        !Number.isSafeInteger(probe.channelCount) ||
        probe.channelCount < 1 ||
        typeof probe.rms !== 'number' ||
        !Number.isFinite(probe.rms) ||
        probe.rms < 0 ||
        typeof probe.peak !== 'number' ||
        !Number.isFinite(probe.peak) ||
        probe.peak < 0 ||
        typeof probe.nonSilentFraction !== 'number' ||
        !Number.isFinite(probe.nonSilentFraction) ||
        probe.nonSilentFraction < 0 ||
        probe.nonSilentFraction > 1 ||
        !isRecord(output) ||
        !Number.isSafeInteger(output.id) ||
        output.id <= 0 ||
        typeof output.name !== 'string' ||
        !output.name.trim() ||
        typeof output.uid !== 'string' ||
        !output.uid.trim() ||
        typeof output.nominalSampleRate !== 'number' ||
        !Number.isFinite(output.nominalSampleRate) ||
        output.nominalSampleRate <= 0
      ) {
        throw new Error('Studio UI driver audio receipt does not match the bounded request')
      }
    }
  }
  const receiptDirectory = path.join(plan.artifactRoot, 'ui-driver-receipts')
  await fsPromises.mkdir(receiptDirectory, { recursive: true, mode: 0o700 })
  const receiptPath = path.join(receiptDirectory, path.basename(requestPath))
  const receiptTemp = `${receiptPath}.tmp-${process.pid}`
  await fsPromises.writeFile(receiptTemp, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  await fsPromises.rename(receiptTemp, receiptPath)
  return { ...receipt, requestPath, receiptPath }
}

function buildStudioAcceptanceJourney() {
  return [
    { id: 'transcript-ready', wait: { type: 'set_transcript', requireNonEmptyTranscript: true } },
    {
      id: 'propose-accept',
      actions: ['tab', 'bracket-left', 'return'],
      wait: { type: 'propose_edit' }
    },
    {
      id: 'review-current-proposed',
      actions: ['w', 'v'],
      screenshots: ['current', 'proposed']
    },
    { id: 'accept', actions: ['a'], wait: { type: 'resolve_proposal', decision: 'accept' } },
    {
      id: 'propose-reject',
      actions: ['w', 'tab', 'bracket-right', 'return'],
      wait: { type: 'propose_edit' }
    },
    { id: 'reject', actions: ['r'], wait: { type: 'resolve_proposal', decision: 'reject' } },
    {
      id: 'transport-review',
      actions: ['space', 'right', 'left', 'i', 'o', 'l', 'p', 'c', 'g', 's'],
      screenshot: 'final'
    }
  ]
}

function screenshotPaths(receipt) {
  return receipt.actions
    .filter((action) => action && action.type === 'screenshot')
    .map((action) => action.screenshotPath)
}

async function driveStudioUiJourney(plan, target, adapters = {}) {
  const waitJournal = adapters.waitForJournalOperation || waitForStudioJournalOperation
  const runDriver = adapters.runUiDriver || runStudioUiDriver
  const probeWindow = adapters.probeWindow || probeNativeWindow
  const sourceWindowTitle = target.window?.windows?.[0]?.title
  const sourceTarget = { ...target, expectedWindowTitle: sourceWindowTitle }
  const reviewWindowTitle = 'TaskWraith Studio — Review'
  const waitForReviewTarget = () =>
    waitFor({
      label: 'exact visible Studio Review window',
      timeoutMs: 10_000,
      intervalMs: 100,
      probe: async () => {
        const window = await probeWindow(target.companion.pid, adapters.windowAdapters || {})
        const matches = Array.isArray(window.windows)
          ? window.windows.filter((entry) => entry?.title === reviewWindowTitle)
          : []
        return matches.length === 1
          ? { ...target, window, expectedWindowTitle: reviewWindowTitle }
          : null
      }
    })
  const assetId = target.asset && target.asset.sha256
  const transcript = await waitJournal(
    plan,
    {
      type: 'set_transcript',
      ...(assetId ? { assetId } : {}),
      requireNonEmptyTranscript: true
    },
    { afterRevision: 0, timeoutMs: plan.transcriptTimeoutMs }
  )
  let afterRevision = transcript.revision
  const driverReceipts = []
  const screenshots = []

  const drive = async (actions, driverTarget = sourceTarget) => {
    const receipt = await runDriver(
      plan,
      driverTarget,
      actions.map((action) => (typeof action === 'string' ? { type: 'key', key: action } : action)),
      adapters.driverAdapters || {}
    )
    driverReceipts.push(receipt)
    screenshots.push(...screenshotPaths(receipt))
    return receipt
  }

  await drive([
    { type: 'screenshot', name: 'transcript-band' },
    'tab',
    { type: 'screenshot', name: 'transcript-selected' },
    'bracket-left',
    { type: 'screenshot', name: 'trim-pending' },
    'return',
    { type: 'screenshot', name: 'proposal-sent' }
  ])
  const acceptedProposal = await waitJournal(plan, { type: 'propose_edit' }, { afterRevision })
  const acceptedProposalId = acceptedProposal.op?.proposal?.proposalId
  if (typeof acceptedProposalId !== 'string' || !acceptedProposalId) {
    throw new Error('Studio accept journey did not journal a proposal identity')
  }
  afterRevision = acceptedProposal.revision
  await drive([{ type: 'screenshot', name: 'ghost' }], sourceTarget)
  await drive(['w'], sourceTarget)
  const acceptedReviewTarget = await waitForReviewTarget()
  await drive(
    [{ type: 'screenshot', name: 'current' }, 'v', { type: 'screenshot', name: 'proposed' }],
    acceptedReviewTarget
  )
  await drive(['a', { type: 'screenshot', name: 'accept-sent' }], acceptedReviewTarget)
  const acceptedResolution = await waitJournal(
    plan,
    {
      type: 'resolve_proposal',
      proposalId: acceptedProposalId,
      decision: 'accept'
    },
    { afterRevision }
  )
  afterRevision = acceptedResolution.revision

  await drive(['w', 'tab', 'bracket-right', 'return'], sourceTarget)
  const rejectedProposal = await waitJournal(plan, { type: 'propose_edit' }, { afterRevision })
  const rejectedProposalId = rejectedProposal.op?.proposal?.proposalId
  if (typeof rejectedProposalId !== 'string' || !rejectedProposalId) {
    throw new Error('Studio reject journey did not journal a proposal identity')
  }
  afterRevision = rejectedProposal.revision
  await drive(['w'], sourceTarget)
  const rejectedReviewTarget = await waitForReviewTarget()
  await drive([{ type: 'screenshot', name: 'ghost-reject' }], rejectedReviewTarget)
  await drive(['r', { type: 'screenshot', name: 'reject-sent' }], rejectedReviewTarget)
  const rejectedResolution = await waitJournal(
    plan,
    {
      type: 'resolve_proposal',
      proposalId: rejectedProposalId,
      decision: 'reject'
    },
    { afterRevision }
  )
  afterRevision = rejectedResolution.revision
  await drive([
    'space',
    'right',
    'left',
    'i',
    'o',
    'l',
    'p',
    'c',
    'g',
    's',
    { type: 'screenshot', name: 'final' }
  ])

  return {
    schemaVersion: 1,
    kind: 'taskwraith-studio-ui-journey-receipt',
    ok: true,
    transcript: { revision: transcript.revision },
    accepted: {
      proposalId: acceptedProposalId,
      proposalRevision: acceptedProposal.revision,
      resolutionRevision: acceptedResolution.revision
    },
    rejected: {
      proposalId: rejectedProposalId,
      proposalRevision: rejectedProposal.revision,
      resolutionRevision: rejectedResolution.revision
    },
    finalRevision: afterRevision,
    screenshots,
    driverReceipts
  }
}

async function probeNativeWindow(pid, adapters = {}) {
  const runExec = adapters.execFile || defaultExecFile
  const result = await runExec('/usr/bin/swift', [WINDOW_PROBE_PATH, String(pid)], {
    timeoutMs: 20_000
  })
  const parsed = JSON.parse(result.stdout)
  if (
    !isRecord(parsed) ||
    parsed.pid !== pid ||
    !Number.isSafeInteger(parsed.visibleWindowCount) ||
    parsed.visibleWindowCount < 1
  ) {
    throw new Error(`No on-screen native Studio window for exact pid ${pid}`)
  }
  return parsed
}

async function verifyDurableOpen(plan, asset) {
  const journalPath = path.join(plan.studioStateDirectory, STUDIO_JOURNAL_FILE)
  return waitFor({
    label: 'durable Studio open_media journal',
    probe: async () => {
      let raw
      try {
        raw = await fsPromises.readFile(journalPath, 'utf8')
      } catch (error) {
        if (error && error.code === 'ENOENT') return null
        throw error
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        const entry = JSON.parse(line)
        if (
          entry &&
          entry.op &&
          entry.op.type === 'open_media' &&
          entry.op.asset &&
          entry.op.asset.assetId === asset.sha256 &&
          path.resolve(entry.op.asset.path) === path.resolve(asset.assetPath)
        ) {
          return { journalPath, revision: entry.revision, operation: entry.op }
        }
      }
      return null
    }
  })
}

async function writeEvidence(plan, evidence) {
  await fsPromises.mkdir(plan.artifactRoot, { recursive: true, mode: 0o700 })
  const temp = `${plan.evidencePath}.tmp-${process.pid}`
  await fsPromises.writeFile(
    temp,
    `${JSON.stringify(
      {
        schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
        kind: 'taskwraith-studio-in-product-acceptance',
        recordedAt: new Date().toISOString(),
        ...evidence
      },
      null,
      2
    )}\n`,
    { encoding: 'utf8', mode: 0o600 }
  )
  await fsPromises.rename(temp, plan.evidencePath)
}

async function runStudioAcceptance(args, adapters = {}) {
  const plan = buildStudioAcceptancePlan({
    instanceId: args.instanceId || undefined,
    transcriptTimeoutMs: args.transcriptTimeoutMs,
    remoteDebuggingPort: args.remoteDebuggingPort,
    mainInspectorPort: args.mainInspectorPort,
    ...(adapters.planOptions || {})
  })
  const authorization = assertLaunchAuthorized(args, plan)
  if (!authorization.launch) return { launched: false, plan, authorization }

  // Before creating or building anything: refuse to launch on top of a group a
  // prior acceptance run may have leaked. The owner attestation flag stays
  // independent of this measurement — a human promise is not evidence.
  const priorOrphanScan = await (adapters.assertNoPriorOrphans || assertNoPriorStudioOrphans)(
    plan,
    adapters.orphanAdapters || {}
  )

  await fsPromises.mkdir(plan.home, { recursive: true, mode: 0o700 })
  await fsPromises.mkdir(plan.artifactRoot, { recursive: true, mode: 0o700 })
  const providerGuards = await (
    adapters.materializeProviderGuards || materializeIsolatedProviderGuards
  )({ home: plan.home })
  plan.spawnPlan.env.TASKWRAITH_GROK_USAGE_BINARY_OVERRIDE = providerGuards.grokBinaryPath
  const asset = await materializeOwnedMedia({
    mediaPath: args.mediaPath,
    mimeType: args.mimeType,
    userDataPath: plan.profile.userDataPath
  })

  await (adapters.assertLaunchPortsFree || assertLaunchPortsFree)(
    {
      remoteDebuggingPort: plan.spawnPlan.remoteDebuggingPort,
      mainInspectorPort: plan.spawnPlan.mainInspectorPort,
      instanceId: plan.instanceId
    },
    adapters.portAdapters || {}
  )
  await (adapters.runBuild || runStudioAcceptanceBuild)({
    repoRoot: plan.repoRoot,
    ...(adapters.buildAdapters || {})
  })

  const spec = {
    kind: 'electron',
    command: plan.spawnPlan.electronBinary,
    args: plan.spawnPlan.argv,
    cwd: plan.repoRoot,
    env: plan.spawnPlan.env,
    timeoutMs: args.timeoutMs,
    forceAfterMs: 4_000,
    receiptPath: plan.receiptPath,
    remoteDebuggingPort: plan.spawnPlan.remoteDebuggingPort,
    mainInspectorPort: plan.spawnPlan.mainInspectorPort
  }
  const watchdogLaunch = adapters.launchUnderWatchdog || launchUnderWatchdog
  const session = await watchdogLaunch(spec, adapters.watchdogAdapters || {})
  let renderer = null
  let evidence = null
  let acceptanceError = null
  try {
    await (adapters.assertExactChildOwnsDebugPorts || assertExactChildOwnsDebugPorts)(
      session,
      adapters.portOwnershipAdapters || {}
    )
    renderer = await (adapters.attachRenderer || attachRendererCdpSession)({
      port: plan.spawnPlan.remoteDebuggingPort,
      ...(adapters.cdpAdapters ? { adapters: adapters.cdpAdapters } : {})
    })
    const openResult = await (adapters.invokeStudioOpen || invokeAuthorizedStudioOpen)(
      renderer,
      asset
    )
    const durable = await (adapters.verifyDurableOpen || verifyDurableOpen)(plan, asset)
    const companion = await (adapters.findCompanion || findStudioCompanion)(
      session.pid,
      adapters.processAdapters || {}
    )
    const window = await (adapters.probeWindow || probeNativeWindow)(
      companion.pid,
      adapters.windowAdapters || {}
    )
    const journey = await (adapters.driveUiJourney || driveStudioUiJourney)(
      plan,
      {
        companion,
        electronPgid: session.pgid || null,
        window,
        asset
      },
      adapters.journeyAdapters || {}
    )
    evidence = {
      ok: true,
      instanceId: plan.instanceId,
      electron: {
        pid: session.pid,
        pgid: session.pgid || null,
        remoteDebuggingPort: plan.spawnPlan.remoteDebuggingPort,
        mainInspectorPort: plan.spawnPlan.mainInspectorPort
      },
      companion,
      window,
      asset,
      providerGuards,
      openResult,
      durable,
      journey,
      watchdogReceiptPath: plan.receiptPath,
      priorOrphanScan,
      safety: plan.safety
    }
  } catch (error) {
    acceptanceError = error
  }

  let rendererCloseError = null
  try {
    renderer?.close()
  } catch (error) {
    rendererCloseError = error
  }

  let watchdogTerminal = null
  let watchdogError = null
  try {
    watchdogTerminal = assertCleanWatchdogTerminal(await session.stop())
  } catch (error) {
    watchdogError = error
  }

  const failures = [acceptanceError, rendererCloseError, watchdogError].filter(Boolean)
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Studio acceptance and cleanup both failed')
  }

  const completedEvidence = { ...evidence, watchdogTerminal }
  await (adapters.writeEvidence || writeEvidence)(plan, completedEvidence)
  return { launched: true, plan, evidence: completedEvidence }
}

function buildStubSpec(options) {
  const directory = path.resolve(options.directory)
  const gracefulExitMs = options.grandchildGracefulExitMs
  if (
    gracefulExitMs !== undefined &&
    (!Number.isSafeInteger(gracefulExitMs) || gracefulExitMs < 1)
  ) {
    throw new Error('grandchildGracefulExitMs must be a positive integer')
  }
  if (options.stubbornGrandchild && gracefulExitMs !== undefined) {
    throw new Error('stub grandchild cannot be both stubborn and graceful')
  }
  // A stubborn grandchild ignores SIGTERM, so only escalation to SIGKILL of the
  // exact group can end it. That is the control which fails whenever the
  // watchdog finalizes on group-leader exit alone.
  //
  // It announces itself only AFTER installing the handler. The leader cannot do
  // that for it: spawn() returns long before the child's runtime boots, so a
  // reap racing that window would kill an ordinary process and silently prove
  // nothing.
  let grandchildBody = 'setInterval(()=>{},1000)'
  if (options.stubbornGrandchild) {
    grandchildBody =
      "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync('grandchild-ready.json',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);"
  } else if (gracefulExitMs !== undefined) {
    grandchildBody = `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),${gracefulExitMs}));require('node:fs').writeFileSync('grandchild-ready.json',JSON.stringify({pid:process.pid}));setInterval(()=>{},1000);`
  }
  return {
    kind: 'stub',
    command: process.execPath,
    args: [
      '-e',
      [
        "const fs=require('node:fs');",
        "const path=require('node:path');",
        "const {spawn}=require('node:child_process');",
        `const grandchild=spawn(process.execPath,['-e',${JSON.stringify(
          grandchildBody
        )}],{stdio:'ignore'});`,
        "fs.writeFileSync(path.join(process.cwd(),'grandchild.json'),JSON.stringify({pid:grandchild.pid})+'\\n');",
        "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),10));",
        "process.on('SIGINT',()=>process.exit(0));",
        'setInterval(()=>{},1000);'
      ].join('')
    ],
    cwd: directory,
    env: {
      TASKWRAITH_INSTANCE_ID: 'studioStub',
      IOS_REMOTE_TRUE: '0',
      TASKWRAITH_STUDIO_COMPANION: '1'
    },
    timeoutMs: options.timeoutMs || 5_000,
    forceAfterMs: options.forceAfterMs || 500,
    receiptPath: path.join(directory, 'watchdog-receipt.json')
  }
}

async function runAbandonOwnerSelfTest(directory) {
  const spec = buildStubSpec({ directory })
  const session = await launchUnderWatchdog(spec, {
    controllerEnv: { TASKWRAITH_STUDIO_ACCEPTANCE_TEST: '1' }
  })
  await fsPromises.writeFile(
    path.join(directory, 'launched.json'),
    `${JSON.stringify({
      ownerPid: process.pid,
      controllerPid: session.controllerPid,
      childPid: session.pid,
      childPgid: session.pgid || null,
      receiptPath: session.receiptPath
    })}\n`,
    'utf8'
  )
  // Deliberately skip stop(). The test kills this owner with SIGKILL; only
  // IPC closure can tell the detached watchdog to reap the target group.
  setInterval(() => {}, 1_000)
}

function helpText() {
  return `TaskWraith Studio acceptance harness

Default: print a non-launching plan.

Required for a real run:
  --launch
  --i-accept-studio-isolated-launch
  --owner-confirms-existing-orphans-cleared
  --media=/absolute/path/to/clip.mov
  --mime=video/mp4|video/quicktime

Optional:
  --instance-id=<unique 2-16 char id>
  --remote-debugging-port=<port>
  --main-inspector-port=<port>
  --timeout-ms=<30000..1800000>
  --transcript-timeout-ms=<1000..1800000; must not exceed timeout-ms>
  --pretty
`
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length === 2 && argv[0] === '--self-test-abandon-owner') {
    await runAbandonOwnerSelfTest(argv[1])
    return
  }
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(helpText())
    return
  }
  const result = await runStudioAcceptance(args)
  process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `[studio-acceptance] FAIL — ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  })
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  ACCEPTANCE_SCHEMA_VERSION,
  parseArgs,
  parseStudioTransportMutationText,
  buildStudioAcceptancePlan,
  assertLaunchAuthorized,
  materializeOwnedMedia,
  materializeIsolatedProviderGuards,
  launchUnderWatchdog,
  evaluateByValue,
  parseProcessTable,
  findAcceptanceArtifactGroups,
  descendantsOf,
  readPriorWatchdogReceipts,
  assertNoPriorStudioOrphans,
  assertCleanWatchdogTerminal,
  runStudioAcceptanceBuild,
  findStudioCompanion,
  probeNativeWindow,
  buildStudioUiDriverRequest,
  readStudioJournalOperations,
  waitForStudioJournalOperation,
  runStudioUiDriver,
  buildStudioAcceptanceJourney,
  driveStudioUiJourney,
  verifyDurableOpen,
  buildStubSpec,
  runAbandonOwnerSelfTest,
  runStudioAcceptance
}
