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
const { PNG } = require('pngjs')
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
const {
  parseAvSyncCurrentExport,
  parseAvSyncPeakExport
} = require('./studio-av-endurance-runner.cjs')
const {
  buildMuxCommand,
  buildSayCommand,
  describeFixturePlan,
  verifyFixtureManifest
} = require('./studio-generate-speech-fixture.cjs')

const SHORT_SPEECH_FIXTURE_DURATION_SECONDS = 30
const STUDIO_JOURNEY_OVERLAY_POINTS = 118
const STUDIO_JOURNEY_PIXEL_DELTA = 16
const STUDIO_JOURNEY_TIMELINE_MIN_CHANGED_PIXELS = 32
const STUDIO_JOURNEY_TIMELINE_MIN_CHANGED_FRACTION = 0.00002
// Fixed fail-closed policy for material-plane evidence. These limits are not
// an empirical claim about a particular ffmpeg build or decoded frame pair:
// executable controls prove that distributed video-plane change passes while
// localized overlay noise does not.
const STUDIO_JOURNEY_MATERIAL_POLICY = Object.freeze({
  kind: 'fixed-spatial-material-change-policy',
  basis: 'fixed-acceptance-policy-not-measured-calibration',
  gridColumns: 4,
  gridRows: 3,
  minimumChangedFraction: 0.014,
  minimumOccupiedCells: 6,
  minimumSpanFraction: 0.5,
  occupiedCellPixelDivisor: 256
})
const STUDIO_JOURNEY_MATERIAL_GRID_COLUMNS = STUDIO_JOURNEY_MATERIAL_POLICY.gridColumns
const STUDIO_JOURNEY_MATERIAL_GRID_ROWS = STUDIO_JOURNEY_MATERIAL_POLICY.gridRows
const STUDIO_JOURNEY_MATERIAL_MIN_OCCUPIED_CELLS =
  STUDIO_JOURNEY_MATERIAL_POLICY.minimumOccupiedCells
const STUDIO_JOURNEY_MATERIAL_MIN_CHANGED_FRACTION =
  STUDIO_JOURNEY_MATERIAL_POLICY.minimumChangedFraction
const STUDIO_JOURNEY_MATERIAL_MIN_SPAN_FRACTION = STUDIO_JOURNEY_MATERIAL_POLICY.minimumSpanFraction
const STUDIO_JOURNEY_CAPTURE_MAX_BYTES = 64 * 1024 * 1024
const STUDIO_WORKSPACE_WINDOW_TITLE = 'TaskWraith Studio'
const STUDIO_WORKSPACE_ROOT_ID = 'studio.workspace.root'
const STUDIO_WORKSPACE_SOURCE_HOST_ID = 'studio.workspace.viewer.source'
const STUDIO_WORKSPACE_TIMELINE_HOST_ID = 'studio.workspace.viewer.timeline'
const STUDIO_WORKSPACE_SOURCE_ROUTE_ID = 'studio.workspace.route.source'
const STUDIO_WORKSPACE_TIMELINE_ROUTE_ID = 'studio.workspace.route.timeline'
const STUDIO_WORKSPACE_CURRENT_VERSION_ID = 'studio.workspace.review-version.current'
const STUDIO_WORKSPACE_PROPOSED_VERSION_ID = 'studio.workspace.review-version.proposed'
const STUDIO_WORKSPACE_ELEMENT_IDS = Object.freeze([
  STUDIO_WORKSPACE_ROOT_ID,
  STUDIO_WORKSPACE_SOURCE_ROUTE_ID,
  STUDIO_WORKSPACE_TIMELINE_ROUTE_ID,
  STUDIO_WORKSPACE_SOURCE_HOST_ID,
  STUDIO_WORKSPACE_TIMELINE_HOST_ID,
  STUDIO_WORKSPACE_CURRENT_VERSION_ID,
  STUDIO_WORKSPACE_PROPOSED_VERSION_ID
])
const STUDIO_WORKSPACE_ROUTE_IDS = new Set([
  STUDIO_WORKSPACE_SOURCE_ROUTE_ID,
  STUDIO_WORKSPACE_TIMELINE_ROUTE_ID
])
const STUDIO_WORKSPACE_VERSION_IDS = new Set([
  STUDIO_WORKSPACE_CURRENT_VERSION_ID,
  STUDIO_WORKSPACE_PROPOSED_VERSION_ID
])
const STUDIO_WORKSPACE_HOST_IDS = new Set([
  STUDIO_WORKSPACE_SOURCE_HOST_ID,
  STUDIO_WORKSPACE_TIMELINE_HOST_ID
])
const WATCHDOG_PATH = path.join(__dirname, 'studio-acceptance-watchdog.cjs')
const DETACHED_COORDINATOR_PATH = path.join(__dirname, 'studio-acceptance-detached-coordinator.cjs')
const DETACHED_COORDINATOR_SCHEMA_VERSION = 1
const DETACHED_COORDINATOR_KIND = 'taskwraith-studio-acceptance-detached-coordinator'
const DETACHED_START_KIND = 'taskwraith-studio-acceptance-detached-start'
const DETACHED_TOKEN_KIND = 'taskwraith-studio-acceptance-detached-token'
const DETACHED_MANIFEST_NAME = 'detached-coordinator.json'
const DETACHED_STDOUT_LOG_NAME = 'detached-coordinator.stdout.log'
const DETACHED_STDERR_LOG_NAME = 'detached-coordinator.stderr.log'
const DETACHED_READY_TIMEOUT_MS = 10_000
const DETACHED_STALE_AFTER_MS = 15_000
const DETACHED_HEARTBEAT_MS = 1_000
const DETACHED_ERROR_MAX_CHARS = 4_096
const DETACHED_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/
const WINDOW_PROBE_PATH = path.join(__dirname, 'studio-acceptance-window-probe.swift')
const UI_DRIVER_PATH = path.join(__dirname, 'studio-acceptance-ui-driver.swift')
const TRANSCRIPT_MEDIA_DIR = 'transcript-media'
const STUDIO_STATE_DIR = 'studio-companion'
const STUDIO_JOURNAL_FILE = 'studio-project.journal.jsonl'
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_WAIT_MS = 45_000
const ACCEPTANCE_SCHEMA_VERSION = 1
const ACCEPTANCE_RECEIPT_MAX_BYTES = 256 * 1024
const STUDIO_FAILURE_ARTIFACT_MAX_BYTES = 1024 * 1024 * 1024
const STUDIO_UI_DRIVER_RAW_RECEIPT_MAX_BYTES = 256 * 1024
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
const STUDIO_ACCEPTANCE_REQUIRED_PRODUCT_ANCESTOR = '4b4c1913acd777277d16ae638c39bae635f1355e'
const STUDIO_ACCEPTANCE_EXPECTED_SUPPORT_HASHES = Object.freeze({
  'scripts/studio-acceptance-ui-driver.swift':
    'a358524787405a1e1e9cf9b4bb7923d82c05012abbf2abe6d2ab9a50d9dc6172',
  'scripts/studio-acceptance-window-probe.swift':
    'fb6b385479e33883e2dab7b74c3308459d7aa6e6ba46f861e6b353b3b2963154',
  'scripts/studio-acceptance-watchdog.cjs':
    'c12daaf4e2068090f5db0fc178e4cf46f044e844041778f3a8d0a68358a6b69f',
  'scripts/studio-acceptance-detached-coordinator.cjs':
    'ef316fe25a3c8f57e5963cede12e7b8f3d9f7005865f36545aceadf900a93bd2',
  'scripts/studio-generate-speech-fixture.cjs':
    '734c336b46aac7ebe3748144216514dfbd49c1206962055c703f79a063936e4f',
  'scripts/studio-av-endurance-runner.cjs':
    '8c1cbbad000ddb66466f98128c90ad912d5f36fe117c812c127e78343fb24a6e',
  'scripts/perf/electronChildSession.cjs':
    '49de84f79099488808cc7575c6169aa380d4fdfbb638df7518e6b5c5993f901c',
  'scripts/perf/devUserDataPath.cjs':
    'f40f3f27676d591a8cd78024201cda51cd8c07c2953cc92c26f0ec19db9fd24b',
  'scripts/perf/portGuard.cjs': '1066e3f1222d48bd4de8974f0fe139218799adad73c0ac570faccecf52b8edad',
  'scripts/perf/cdpWebSocketSession.cjs':
    '8a1842735b17424e71e0edf29908a3be99d8b453814d5c14644a3bc5134b5f01'
})
const STUDIO_ACCEPTANCE_BUILD_INPUT_EXACT_PATHS = Object.freeze([
  'build/icon.icns',
  'electron.vite.config.ts',
  'package-lock.json',
  'package.json',
  'scripts/build-bridge-daemon.cjs',
  'scripts/build-studio-companion.cjs',
  'swift/TaskWraithBridge/Package.swift',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json'
])
const STUDIO_ACCEPTANCE_OPTIONAL_ENV_PATHS = Object.freeze([
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local'
])
const STUDIO_ACCEPTANCE_RUNNER_PATH = 'scripts/studio-acceptance-harness.cjs'
const STUDIO_ACCEPTANCE_SELECTED_NATIVE_PRODUCTS = Object.freeze({
  bridgeDaemon: Object.freeze({
    label: 'selected bridge daemon',
    relativePath: 'swift/TaskWraithBridge/.build/debug/TaskWraithBridgeDaemon',
    command: 'swift',
    args: Object.freeze([
      'build',
      '--disable-sandbox',
      '-c',
      'debug',
      '--package-path',
      'swift/TaskWraithBridge',
      '--product',
      'TaskWraithBridgeDaemon'
    ])
  }),
  companion: Object.freeze({
    label: 'selected companion binary',
    relativePath: 'swift/TaskWraithBridge/.build/debug/TaskWraithStudioCompanion',
    command: 'swift',
    args: Object.freeze([
      'build',
      '--disable-sandbox',
      '-c',
      'debug',
      '--package-path',
      'swift/TaskWraithBridge',
      '--product',
      'TaskWraithStudioCompanion'
    ])
  })
})
const STUDIO_ACCEPTANCE_BUILD_ENVIRONMENT_NAMES = Object.freeze([
  'IOS_REMOTE_TRUE',
  'MACOSX_DEPLOYMENT_TARGET',
  'NODE_ENV',
  'TASKWRAITH_ACTIVITY_ENDPOINT',
  'TASKWRAITH_BRIDGE_ARCH',
  'TASKWRAITH_STUDIO_APP_OUTPUT',
  'TASKWRAITH_STUDIO_ARCH'
])
const STUDIO_ACCEPTANCE_EXPECTED_CUSTODY_PINS = Object.freeze({
  sourceDigest: '5f513fdf972fc580d5b8acc38b945f0aa4410e9695a4d5a9c5a83fe295b6c618',
  sourceCount: 2254,
  buildEnvironmentDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
  buildEnvironmentCount: 0,
  companionPath: STUDIO_ACCEPTANCE_SELECTED_NATIVE_PRODUCTS.companion.relativePath,
  companionSha256: '21f70055169e10b1bf05f9b235459635a41e458a9d0b230a32d7d823086d1104',
  bridgeDaemonPath: STUDIO_ACCEPTANCE_SELECTED_NATIVE_PRODUCTS.bridgeDaemon.relativePath,
  bridgeDaemonSha256: 'ba3cd5ce8630b143eb64f4c8d726b1c22afea02a10133807039ba485617961cb'
})

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
  } else if (raw.postSrc !== 'audio' || previousHostSeconds === null) {
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
    detach: false,
    detachedStatus: false,
    detachedToken: null,
    acceptLaunch: false,
    ownerConfirmsOrphansCleared: false,
    pretty: false,
    help: false,
    instanceId: null,
    generateSpeechFixture: false,
    mediaPath: null,
    mimeType: null,
    remoteDebuggingPort: null,
    mainInspectorPort: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    transcriptTimeoutMs: DEFAULT_WAIT_MS
  }
  for (const argument of argv) {
    if (argument === '--launch') parsed.launch = true
    else if (argument === '--detach') parsed.detach = true
    else if (argument === '--detached-status') parsed.detachedStatus = true
    else if (argument.startsWith('--detached-token=')) {
      parsed.detachedToken = argument.slice(17)
    } else if (argument === '--i-accept-studio-isolated-launch') parsed.acceptLaunch = true
    else if (argument === '--owner-confirms-existing-orphans-cleared') {
      parsed.ownerConfirmsOrphansCleared = true
    } else if (argument === '--pretty') parsed.pretty = true
    else if (argument === '--help' || argument === '-h') parsed.help = true
    else if (argument.startsWith('--instance-id=')) parsed.instanceId = argument.slice(14)
    else if (argument === '--generate-speech-fixture') parsed.generateSpeechFixture = true
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
  const generatedMedia = args.generateSpeechFixture === true
  const suppliedMedia =
    typeof args.mediaPath === 'string' &&
    path.isAbsolute(args.mediaPath) &&
    ['video/mp4', 'video/quicktime'].includes(String(args.mimeType || '').toLowerCase())
  if (generatedMedia === suppliedMedia) {
    throw new Error(
      'Real launch requires exactly one bounded media source: --generate-speech-fixture or absolute --media plus supported --mime'
    )
  }
  if (generatedMedia && (args.mediaPath !== null || args.mimeType !== null)) {
    throw new Error(
      'Real launch requires exactly one bounded media source; generated speech cannot be combined with caller media'
    )
  }
  if (!plan.spawnPlan.argv.includes('--use-mock-keychain')) {
    throw new Error('Refuse launch without disposable macOS mock keychain')
  }
  return { launch: true }
}

function assertDetachedToken(raw) {
  if (typeof raw !== 'string' || !DETACHED_TOKEN_PATTERN.test(raw)) {
    throw new Error('detached coordinator token must be exactly 32 base64url characters')
  }
  return raw
}

function buildDetachedCoordinatorPaths(plan) {
  const artifactRoot = path.resolve(String(plan.artifactRoot || ''))
  if (!path.isAbsolute(artifactRoot) || artifactRoot === path.parse(artifactRoot).root) {
    throw new Error('detached coordinator artifact root must be a bounded absolute directory')
  }
  const paths = {
    artifactRoot,
    manifestPath: path.join(artifactRoot, DETACHED_MANIFEST_NAME),
    evidencePath: path.resolve(String(plan.evidencePath || '')),
    watchdogReceiptPath: path.resolve(String(plan.receiptPath || '')),
    stdoutLogPath: path.join(artifactRoot, DETACHED_STDOUT_LOG_NAME),
    stderrLogPath: path.join(artifactRoot, DETACHED_STDERR_LOG_NAME)
  }
  for (const [label, candidate] of Object.entries(paths)) {
    if (label === 'artifactRoot') continue
    if (path.dirname(candidate) !== artifactRoot) {
      throw new Error(`detached coordinator ${label} escaped the artifact root`)
    }
  }
  return paths
}

function assertDetachedLaunchAuthorized(args, plan) {
  if (!args.detach) throw new Error('Detached launch requires --detach')
  if (args.detachedStatus) {
    throw new Error('Detached launch and detached status are mutually exclusive')
  }
  if (args.detachedToken !== null && args.detachedToken !== undefined) {
    throw new Error(
      'Detached launch tokens are coordinator-generated; --detached-token is status-only'
    )
  }
  if (typeof args.instanceId !== 'string' || args.instanceId.length === 0) {
    throw new Error('Detached launch requires an explicit --instance-id')
  }
  assertStudioInstanceId(args.instanceId)
  const authorization = assertLaunchAuthorized(args, plan)
  if (!authorization.launch) throw new Error('Detached coordinator cannot run in plan-only mode')
  return { launch: true, detached: true }
}

async function sha256Hex(filePath) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function sha256SafeRegularFileIfPresent(filePath, label) {
  const stat = await assertSafeRegularFile(filePath, label, {
    allowMissing: true,
    maxBytes: ACCEPTANCE_RECEIPT_MAX_BYTES
  })
  return stat ? sha256Hex(filePath) : null
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function normalizeStudioAcceptanceCustodyPath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.split('/').includes('..') ||
    relativePath.includes('\\')
  ) {
    throw new Error('Studio acceptance custody path is not a bounded workspace-relative path')
  }
  return relativePath
}

function isStudioAcceptanceTestSource(relativePath) {
  return /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
}

function isStudioAcceptanceBuildInputPath(relativePath) {
  const candidate = normalizeStudioAcceptanceCustodyPath(relativePath)
  return (
    candidate === STUDIO_ACCEPTANCE_RUNNER_PATH ||
    Object.prototype.hasOwnProperty.call(STUDIO_ACCEPTANCE_EXPECTED_SUPPORT_HASHES, candidate) ||
    STUDIO_ACCEPTANCE_BUILD_INPUT_EXACT_PATHS.includes(candidate) ||
    STUDIO_ACCEPTANCE_OPTIONAL_ENV_PATHS.includes(candidate) ||
    (candidate.startsWith('src/') && !isStudioAcceptanceTestSource(candidate)) ||
    candidate.startsWith('swift/TaskWraithBridge/Sources/')
  )
}

function parseStudioAcceptanceStatus(statusText) {
  if (typeof statusText !== 'string') {
    throw new Error('Studio acceptance Git status receipt must be a string')
  }
  if (statusText.length > 0 && !statusText.endsWith('\0')) {
    throw new Error('Studio acceptance Git status receipt is not NUL terminated')
  }
  const fields = statusText.split('\0')
  fields.pop()
  const entries = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field.length < 4 || field[2] !== ' ') {
      throw new Error('Studio acceptance Git status receipt has an invalid entry')
    }
    const status = field.slice(0, 2)
    const relativePath = normalizeStudioAcceptanceCustodyPath(field.slice(3))
    let originalPath = null
    if (/[RC]/.test(status)) {
      index += 1
      if (index >= fields.length || fields[index].length === 0) {
        throw new Error('Studio acceptance Git rename receipt is incomplete')
      }
      originalPath = normalizeStudioAcceptanceCustodyPath(fields[index])
    }
    entries.push({ status, path: relativePath, originalPath })
  }
  return entries
}

async function classifyStudioAcceptanceDirt(statusText, digestPath) {
  if (typeof digestPath !== 'function') {
    throw new Error('Studio acceptance dirty-path digester is missing')
  }
  const entries = []
  for (const entry of parseStudioAcceptanceStatus(statusText)) {
    const worktreeSha256 = await digestPath(entry.path)
    if (worktreeSha256 !== null && !/^[a-f0-9]{64}$/.test(worktreeSha256)) {
      throw new Error('Studio acceptance dirty-path hash is invalid')
    }
    entries.push({ ...entry, worktreeSha256 })
  }

  const studioTrackedDirt = []
  const studioUntrackedDirt = []
  const foreignTrackedDirt = []
  const foreignUntrackedDirt = []
  for (const entry of entries) {
    const studioPath =
      isStudioAcceptanceBuildInputPath(entry.path) ||
      (entry.originalPath !== null && isStudioAcceptanceBuildInputPath(entry.originalPath))
    const untracked = entry.status === '??'
    if (studioPath && untracked) studioUntrackedDirt.push(entry)
    else if (studioPath) studioTrackedDirt.push(entry)
    else if (untracked) foreignUntrackedDirt.push(entry)
    else foreignTrackedDirt.push(entry)
  }
  return {
    wholeTrackedTreeClean: entries.every((entry) => entry.status === '??'),
    wholeWorkspaceClean: entries.length === 0,
    studioPathsClean: studioTrackedDirt.length === 0 && studioUntrackedDirt.length === 0,
    studioTrackedDirt,
    studioUntrackedDirt,
    foreignTrackedDirt,
    foreignUntrackedDirt
  }
}

async function hashStudioAcceptanceWorkspacePath(repoRoot, relativePath) {
  const candidate = normalizeStudioAcceptanceCustodyPath(relativePath)
  const absolutePath = path.resolve(repoRoot, candidate)
  if (!absolutePath.startsWith(path.resolve(repoRoot) + path.sep)) {
    throw new Error('Studio acceptance dirty path escaped the workspace')
  }
  let stat
  try {
    stat = await fsPromises.lstat(absolutePath)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  if (stat.isSymbolicLink()) {
    return sha256Text(await fsPromises.readlink(absolutePath))
  }
  if (!stat.isFile()) {
    throw new Error('Studio acceptance dirty path is not a regular file')
  }
  return sha256Hex(absolutePath)
}

async function collectStudioAcceptanceCustodyEntries(repoRoot, relativePath, includeFile) {
  const root = path.resolve(repoRoot)
  const startRelative = normalizeStudioAcceptanceCustodyPath(relativePath)
  const start = path.resolve(root, startRelative)
  if (!start.startsWith(root + path.sep)) {
    throw new Error('Studio acceptance custody source escaped the workspace')
  }
  const entries = []
  const pending = [start]
  while (pending.length > 0) {
    const current = pending.pop()
    const stat = await fsPromises.lstat(current)
    if (stat.isSymbolicLink()) {
      throw new Error('Studio acceptance custody source contains a symlink')
    }
    if (stat.isDirectory()) {
      const children = await fsPromises.readdir(current, { withFileTypes: true })
      for (const child of children.sort((left, right) => right.name.localeCompare(left.name))) {
        pending.push(path.join(current, child.name))
      }
      continue
    }
    if (!stat.isFile()) {
      throw new Error('Studio acceptance custody source is not regular')
    }
    const entryPath = path.relative(root, current).split(path.sep).join('/')
    if (!includeFile || includeFile(entryPath)) {
      entries.push({ path: entryPath, sha256: await sha256Hex(current) })
    }
  }
  return entries
}

function digestStudioAcceptanceEntries(entries) {
  const ordered = [...entries].sort((left, right) => left.path.localeCompare(right.path))
  return {
    fileCount: ordered.length,
    digest: sha256Text(JSON.stringify(ordered))
  }
}

async function measureStudioAcceptanceSource(repoRoot) {
  const entries = [
    ...(await collectStudioAcceptanceCustodyEntries(
      repoRoot,
      'src',
      (relativePath) => !isStudioAcceptanceTestSource(relativePath)
    )),
    ...(await collectStudioAcceptanceCustodyEntries(repoRoot, 'swift/TaskWraithBridge/Sources'))
  ]
  for (const relativePath of STUDIO_ACCEPTANCE_BUILD_INPUT_EXACT_PATHS) {
    entries.push(...(await collectStudioAcceptanceCustodyEntries(repoRoot, relativePath)))
  }
  for (const relativePath of STUDIO_ACCEPTANCE_OPTIONAL_ENV_PATHS) {
    try {
      entries.push(...(await collectStudioAcceptanceCustodyEntries(repoRoot, relativePath)))
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
  }
  return digestStudioAcceptanceEntries(entries)
}

async function measureStudioAcceptanceSelectedNativeProduct(repoRoot, product) {
  const absolutePath = path.resolve(repoRoot, product.relativePath)
  const stat = await assertSafeRegularFile(absolutePath, product.label, { allowMissing: true })
  if (!stat) {
    throw new Error(
      `Studio acceptance ${product.label} is missing after its exact debug build: ${product.relativePath}`
    )
  }
  return {
    path: product.relativePath,
    sha256: await sha256Hex(absolutePath)
  }
}

async function measureStudioAcceptanceArtifacts(repoRoot) {
  const outEntries = await collectStudioAcceptanceCustodyEntries(repoRoot, 'out')
  const companionEntry = await measureStudioAcceptanceSelectedNativeProduct(
    repoRoot,
    STUDIO_ACCEPTANCE_SELECTED_NATIVE_PRODUCTS.companion
  )
  const bridgeEntry = await measureStudioAcceptanceSelectedNativeProduct(
    repoRoot,
    STUDIO_ACCEPTANCE_SELECTED_NATIVE_PRODUCTS.bridgeDaemon
  )
  const out = digestStudioAcceptanceEntries(outEntries)
  const artifact = digestStudioAcceptanceEntries([...outEntries, companionEntry, bridgeEntry])
  return {
    artifactDigest: artifact.digest,
    artifactCount: artifact.fileCount,
    outDigest: out.digest,
    outCount: out.fileCount,
    companionPath: companionEntry.path,
    companionSha256: companionEntry.sha256,
    bridgeDaemonPath: bridgeEntry.path,
    bridgeDaemonSha256: bridgeEntry.sha256
  }
}

function studioAcceptanceBuildEnvironment(env = process.env) {
  const names = [
    ...new Set([
      ...STUDIO_ACCEPTANCE_BUILD_ENVIRONMENT_NAMES,
      ...Object.keys(env).filter((name) => name.startsWith('VITE_'))
    ])
  ].sort()
  const entries = names
    .filter((name) => Object.prototype.hasOwnProperty.call(env, name))
    .map((name) => ({ name, valueSha256: sha256Text(env[name]) }))
  return {
    buildEnvironmentCount: entries.length,
    buildEnvironmentDigest: sha256Text(JSON.stringify(entries)),
    buildEnvironmentVariables: entries
  }
}

async function measureStudioAcceptanceCustody(options = {}, adapters = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'))
  const runExec = adapters.execFile || defaultExecFile
  const head = (await runExec('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim()
  let productAncestorPresent = false
  try {
    await runExec(
      'git',
      ['merge-base', '--is-ancestor', STUDIO_ACCEPTANCE_REQUIRED_PRODUCT_ANCESTOR, head],
      { cwd: repoRoot }
    )
    productAncestorPresent = true
  } catch {
    productAncestorPresent = false
  }
  const status = await runExec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: repoRoot
  })
  const dirt = await classifyStudioAcceptanceDirt(status.stdout, (relativePath) =>
    hashStudioAcceptanceWorkspacePath(repoRoot, relativePath)
  )
  const source = await measureStudioAcceptanceSource(repoRoot)
  const supportHashes = {}
  for (const relativePath of Object.keys(STUDIO_ACCEPTANCE_EXPECTED_SUPPORT_HASHES)) {
    supportHashes[relativePath] = await sha256Hex(path.join(repoRoot, relativePath))
  }
  const supportMatches = Object.entries(STUDIO_ACCEPTANCE_EXPECTED_SUPPORT_HASHES).every(
    ([relativePath, expected]) => supportHashes[relativePath] === expected
  )
  const buildEnvironment = studioAcceptanceBuildEnvironment(options.env || process.env)
  const built =
    options.buildReady === true
      ? await measureStudioAcceptanceArtifacts(repoRoot)
      : {
          artifactDigest: null,
          artifactCount: null,
          outDigest: null,
          outCount: null,
          companionPath: null,
          companionSha256: null,
          bridgeDaemonPath: null,
          bridgeDaemonSha256: null
        }
  let fixtureSha256 = null
  let fixtureByteLength = null
  if (options.buildReady === true) {
    const fixtureStat = await assertSafeRegularFile(
      path.resolve(String(options.fixturePath || '')),
      'Studio acceptance generated fixture'
    )
    fixtureSha256 = await sha256Hex(path.resolve(options.fixturePath))
    fixtureByteLength = fixtureStat.size
  }
  return {
    head,
    requiredProductAncestor: STUDIO_ACCEPTANCE_REQUIRED_PRODUCT_ANCESTOR,
    productAncestorPresent,
    protectedPathScope: {
      runnerPath: STUDIO_ACCEPTANCE_RUNNER_PATH,
      supportPaths: Object.keys(STUDIO_ACCEPTANCE_EXPECTED_SUPPORT_HASHES),
      buildInputExactPaths: STUDIO_ACCEPTANCE_BUILD_INPUT_EXACT_PATHS,
      optionalEnvironmentPaths: STUDIO_ACCEPTANCE_OPTIONAL_ENV_PATHS,
      selectedNativeProducts: Object.fromEntries(
        Object.entries(STUDIO_ACCEPTANCE_SELECTED_NATIVE_PRODUCTS).map(([name, product]) => [
          name,
          product.relativePath
        ])
      ),
      sourcePrefix: 'src/',
      swiftSourcePrefix: 'swift/TaskWraithBridge/Sources/',
      sourceTestsExcluded: true
    },
    ...dirt,
    sourceDigest: source.digest,
    sourceCount: source.fileCount,
    ...buildEnvironment,
    expectedSupportHashes: STUDIO_ACCEPTANCE_EXPECTED_SUPPORT_HASHES,
    supportHashes,
    supportMatches,
    runnerSha256: await sha256Hex(path.join(repoRoot, STUDIO_ACCEPTANCE_RUNNER_PATH)),
    ...built,
    fixtureSha256,
    fixtureByteLength
  }
}

function custodyValuesMatch(left, right, fields) {
  return fields.every((field) => left[field] === right[field])
}

function assertStudioAcceptanceCustody(actual, options = {}) {
  const phase = options.phase
  const expected = options.expected || STUDIO_ACCEPTANCE_EXPECTED_CUSTODY_PINS
  if (!isRecord(actual)) throw new Error('Studio acceptance custody receipt is missing')
  if (!['source', 'before-run', 'after-run'].includes(phase)) {
    throw new Error('Studio acceptance custody phase is invalid')
  }
  if (
    actual.productAncestorPresent !== true ||
    typeof actual.head !== 'string' ||
    !/^[a-f0-9]{40,64}$/.test(actual.head)
  ) {
    throw new Error('Studio acceptance required product ancestor is absent')
  }
  if (actual.studioPathsClean !== true) {
    throw new Error(
      `Studio acceptance build-input dirt is present: ${JSON.stringify({
        studioTrackedDirt: actual.studioTrackedDirt,
        studioUntrackedDirt: actual.studioUntrackedDirt
      }).slice(0, 4000)}`
    )
  }
  if (
    typeof actual.sourceDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(actual.sourceDigest) ||
    !Number.isSafeInteger(actual.sourceCount) ||
    actual.sourceCount < 1
  ) {
    throw new Error('Studio acceptance source custody is invalid')
  }
  if (
    typeof actual.buildEnvironmentDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(actual.buildEnvironmentDigest) ||
    !Number.isSafeInteger(actual.buildEnvironmentCount) ||
    actual.buildEnvironmentCount < 0
  ) {
    throw new Error('Studio acceptance source build environment custody is invalid')
  }
  if (
    actual.sourceDigest !== expected.sourceDigest ||
    actual.sourceCount !== expected.sourceCount ||
    actual.buildEnvironmentDigest !== expected.buildEnvironmentDigest ||
    actual.buildEnvironmentCount !== expected.buildEnvironmentCount
  ) {
    throw new Error('Studio acceptance source custody pins do not match')
  }
  if (
    actual.supportMatches !== true ||
    !isRecord(actual.supportHashes) ||
    typeof actual.runnerSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(actual.runnerSha256)
  ) {
    throw new Error('Studio acceptance support custody is invalid')
  }
  if (phase === 'source') return actual

  const sourceCustody = options.sourceCustody
  if (
    !isRecord(sourceCustody) ||
    !custodyValuesMatch(actual, sourceCustody, [
      'head',
      'sourceDigest',
      'sourceCount',
      'buildEnvironmentDigest',
      'buildEnvironmentCount',
      'runnerSha256'
    ]) ||
    JSON.stringify(actual.supportHashes) !== JSON.stringify(sourceCustody.supportHashes)
  ) {
    throw new Error('Studio acceptance source custody changed before or during the run')
  }
  if (
    typeof actual.artifactDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(actual.artifactDigest) ||
    !Number.isSafeInteger(actual.artifactCount) ||
    actual.artifactCount < 3 ||
    typeof actual.outDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(actual.outDigest) ||
    !Number.isSafeInteger(actual.outCount) ||
    actual.outCount < 1 ||
    typeof actual.companionPath !== 'string' ||
    actual.companionPath.length === 0 ||
    typeof actual.companionSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(actual.companionSha256) ||
    typeof actual.bridgeDaemonPath !== 'string' ||
    actual.bridgeDaemonPath.length === 0 ||
    typeof actual.bridgeDaemonSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(actual.bridgeDaemonSha256)
  ) {
    throw new Error('Studio acceptance built artifact custody is invalid')
  }
  if (
    actual.companionPath !== expected.companionPath ||
    actual.companionSha256 !== expected.companionSha256 ||
    actual.bridgeDaemonPath !== expected.bridgeDaemonPath ||
    actual.bridgeDaemonSha256 !== expected.bridgeDaemonSha256
  ) {
    throw new Error('Studio acceptance built artifact custody pins do not match')
  }
  const fixture = options.fixture
  if (
    !isRecord(fixture) ||
    actual.fixtureSha256 !== fixture.sha256 ||
    actual.fixtureByteLength !== fixture.byteLength
  ) {
    throw new Error('Studio acceptance generated fixture custody changed')
  }
  if (phase === 'before-run') return actual

  const custodyBefore = options.custodyBefore
  if (
    !isRecord(custodyBefore) ||
    !custodyValuesMatch(actual, custodyBefore, [
      'artifactDigest',
      'artifactCount',
      'outDigest',
      'outCount',
      'companionPath',
      'companionSha256',
      'bridgeDaemonPath',
      'bridgeDaemonSha256',
      'fixtureSha256',
      'fixtureByteLength'
    ])
  ) {
    throw new Error('Studio acceptance built artifact custody changed during the run')
  }
  return actual
}

function assertStudioCompanionMatchesCustody(companion, custody, repoRoot) {
  if (
    !isRecord(companion) ||
    typeof companion.command !== 'string' ||
    !isRecord(custody) ||
    typeof custody.companionPath !== 'string'
  ) {
    throw new Error('Studio acceptance companion custody receipt is incomplete')
  }
  const expected = path.resolve(repoRoot, custody.companionPath)
  if (companion.command !== expected && !companion.command.startsWith(expected + ' ')) {
    throw new Error(
      `Studio acceptance companion does not match the custodied binary: ${JSON.stringify({
        expected,
        command: companion.command
      }).slice(0, 2000)}`
    )
  }
  return { ok: true, expectedPath: expected, sha256: custody.companionSha256 }
}

async function assertSafeRegularFile(filePath, label, options = {}) {
  let stat
  try {
    stat = await fsPromises.lstat(filePath)
  } catch (error) {
    if (options.allowMissing && error && error.code === 'ENOENT') return null
    throw error
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink or directory`)
  }
  if (options.maxBytes && stat.size > options.maxBytes) {
    throw new Error(`${label} exceeds the ${options.maxBytes}-byte bound`)
  }
  return stat
}

async function readBoundedJsonFile(filePath, label, maxBytes = ACCEPTANCE_RECEIPT_MAX_BYTES) {
  await assertSafeRegularFile(filePath, label, { maxBytes })
  let parsed
  try {
    parsed = JSON.parse(await fsPromises.readFile(filePath, 'utf8'))
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!isRecord(parsed)) throw new Error(`${label} must contain a JSON object`)
  return parsed
}

async function atomicWriteDetachedManifest(manifestPath, manifest, options = {}) {
  const existing = await assertSafeRegularFile(manifestPath, 'detached coordinator manifest', {
    allowMissing: true,
    maxBytes: ACCEPTANCE_RECEIPT_MAX_BYTES
  })
  if (options.initial === true && existing) {
    throw new Error('detached coordinator manifest already exists; refuse duplicate launch')
  }
  if (options.initial !== true && !existing) {
    throw new Error('detached coordinator manifest disappeared during an active run')
  }
  const tempPath = path.join(
    path.dirname(manifestPath),
    `.${path.basename(manifestPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  )
  try {
    await fsPromises.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await fsPromises.rename(tempPath, manifestPath)
  } finally {
    await fsPromises.rm(tempPath, { force: true }).catch(() => undefined)
  }
}

let detachedIdentityPromise = null
function buildDetachedCoordinatorIdentity() {
  if (detachedIdentityPromise) return detachedIdentityPromise
  detachedIdentityPromise = (async () => {
    const entries = {
      node: await fsPromises.realpath(process.execPath),
      harness: await fsPromises.realpath(__filename),
      coordinator: await fsPromises.realpath(DETACHED_COORDINATOR_PATH)
    }
    const identity = {}
    for (const [label, filePath] of Object.entries(entries)) {
      await assertSafeRegularFile(filePath, `detached coordinator ${label} identity`)
      identity[label] = { path: filePath, sha256: await sha256Hex(filePath) }
    }
    return identity
  })()
  return detachedIdentityPromise
}

const DETACHED_REQUEST_ARG_KEYS = new Set([
  'launch',
  'detach',
  'detachedStatus',
  'detachedToken',
  'acceptLaunch',
  'ownerConfirmsOrphansCleared',
  'pretty',
  'help',
  'instanceId',
  'generateSpeechFixture',
  'mediaPath',
  'mimeType',
  'remoteDebuggingPort',
  'mainInspectorPort',
  'timeoutMs',
  'transcriptTimeoutMs'
])

function validateDetachedCoordinatorRequest(request, options = {}) {
  if (!isRecord(request)) throw new Error('detached coordinator request must be an object')
  const allowed = new Set([
    'schemaVersion',
    'kind',
    'type',
    'token',
    'launcherPid',
    'artifactRoot',
    'args',
    ...(options.allowSelfTest === true ? ['selfTest'] : [])
  ])
  for (const key of Object.keys(request)) {
    if (!allowed.has(key)) throw new Error(`unexpected detached coordinator field ${key}`)
  }
  if (
    request.schemaVersion !== DETACHED_COORDINATOR_SCHEMA_VERSION ||
    request.kind !== DETACHED_START_KIND ||
    request.type !== 'start'
  ) {
    throw new Error('detached coordinator request schema/kind/type is unsupported')
  }
  const token = assertDetachedToken(request.token)
  if (!Number.isInteger(request.launcherPid) || request.launcherPid <= 0) {
    throw new Error('detached coordinator launcherPid must be a positive integer')
  }
  if (typeof request.artifactRoot !== 'string' || !path.isAbsolute(request.artifactRoot)) {
    throw new Error('detached coordinator artifactRoot must be absolute')
  }
  const artifactRoot = path.resolve(request.artifactRoot)
  if (!isRecord(request.args)) throw new Error('detached coordinator args must be an object')
  for (const key of Object.keys(request.args)) {
    if (!DETACHED_REQUEST_ARG_KEYS.has(key)) {
      throw new Error(`unexpected detached coordinator args field ${key}`)
    }
  }
  if (request.args.detach !== true || request.args.launch !== true) {
    throw new Error('detached coordinator request must carry launch=true and detach=true')
  }
  if (typeof request.args.instanceId !== 'string') {
    throw new Error('detached coordinator request requires an explicit instance id')
  }
  assertStudioInstanceId(request.args.instanceId)
  if (options.allowSelfTest !== true && request.selfTest !== undefined) {
    throw new Error('detached coordinator self-test mode is unavailable')
  }
  if (request.selfTest !== undefined && request.selfTest !== true) {
    throw new Error('detached coordinator selfTest must be true when present')
  }
  return { ...request, token, artifactRoot, args: { ...request.args } }
}

async function prepareDetachedCoordinatorArtifactRoot(plan) {
  const paths = buildDetachedCoordinatorPaths(plan)
  const parent = path.dirname(paths.artifactRoot)
  await fsPromises.mkdir(parent, { recursive: true, mode: 0o700 })
  const parentStat = await fsPromises.lstat(parent)
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error('detached coordinator artifact parent must be a real directory')
  }
  try {
    await fsPromises.mkdir(paths.artifactRoot, { mode: 0o700 })
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      let detail = 'artifact root already exists'
      try {
        const rootStat = await fsPromises.lstat(paths.artifactRoot)
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
          detail = 'artifact root is a symlink or non-directory'
        } else {
          const manifest = await assertSafeRegularFile(
            paths.manifestPath,
            'preexisting detached coordinator manifest',
            { allowMissing: true }
          )
          if (manifest) detail = 'detached coordinator manifest already exists'
        }
      } catch (inspectionError) {
        detail =
          inspectionError instanceof Error ? inspectionError.message : String(inspectionError)
      }
      throw new Error(`Detached launch requires a fresh unique instance: ${detail}`)
    }
    throw error
  }
  const realRoot = await fsPromises.realpath(paths.artifactRoot)
  const expectedRealRoot = path.join(
    await fsPromises.realpath(parent),
    path.basename(paths.artifactRoot)
  )
  if (realRoot !== expectedRealRoot) {
    throw new Error('detached coordinator artifact root changed after creation')
  }
  const stdoutFd = fs.openSync(paths.stdoutLogPath, 'wx', 0o600)
  let stderrFd
  try {
    stderrFd = fs.openSync(paths.stderrLogPath, 'wx', 0o600)
  } catch (error) {
    fs.closeSync(stdoutFd)
    throw error
  }
  return { paths, stdoutFd, stderrFd }
}

async function verifyDetachedReadyManifest(paths, token, coordinatorPid) {
  const manifest = await readBoundedJsonFile(
    paths.manifestPath,
    'detached coordinator ready manifest'
  )
  if (
    manifest.schemaVersion !== DETACHED_COORDINATOR_SCHEMA_VERSION ||
    manifest.kind !== DETACHED_COORDINATOR_KIND ||
    (manifest.state !== 'ready' && manifest.state !== 'running') ||
    manifest.token !== token ||
    manifest.coordinatorPid !== coordinatorPid ||
    manifest.manifestPath !== paths.manifestPath
  ) {
    throw new Error('detached coordinator ready manifest does not match the launched coordinator')
  }
  return manifest
}

function launchDetachedCoordinator(args, adapters = {}) {
  const selfTest = adapters.selfTest === true
  if (selfTest && process.env.TASKWRAITH_STUDIO_ACCEPTANCE_TEST !== '1') {
    return Promise.reject(new Error('detached coordinator stub workflow is test-only'))
  }
  const plan = buildStudioAcceptancePlan({
    instanceId: args.instanceId || undefined,
    transcriptTimeoutMs: args.transcriptTimeoutMs,
    remoteDebuggingPort: args.remoteDebuggingPort,
    mainInspectorPort: args.mainInspectorPort,
    ...(adapters.planOptions || {})
  })
  try {
    if (!selfTest) {
      assertDetachedLaunchAuthorized(args, plan)
    } else {
      if (args.detach !== true || args.launch !== true || typeof args.instanceId !== 'string') {
        throw new Error('detached coordinator self-test requires explicit launch/detach/instance')
      }
      assertStudioInstanceId(args.instanceId)
    }
  } catch (error) {
    return Promise.reject(error)
  }

  return (async () => {
    const prepared = await prepareDetachedCoordinatorArtifactRoot(plan)
    const token = adapters.token || crypto.randomBytes(24).toString('base64url')
    assertDetachedToken(token)
    const forkProcess =
      adapters.fork ||
      ((modulePath, childArgs, options) => {
        return fork(modulePath, childArgs, options)
      })
    let controller
    try {
      controller = forkProcess(DETACHED_COORDINATOR_PATH, [], {
        detached: process.platform !== 'win32',
        execPath: process.execPath,
        stdio: ['ignore', prepared.stdoutFd, prepared.stderrFd, 'ipc'],
        env: {
          ...process.env,
          ...(selfTest ? { TASKWRAITH_STUDIO_ACCEPTANCE_TEST: '1' } : {}),
          ...(adapters.coordinatorEnv || {})
        }
      })
    } finally {
      fs.closeSync(prepared.stdoutFd)
      fs.closeSync(prepared.stderrFd)
    }
    if (!controller || !Number.isInteger(controller.pid) || controller.pid <= 0) {
      throw new Error('detached Studio acceptance coordinator returned no pid')
    }

    const request = validateDetachedCoordinatorRequest(
      {
        schemaVersion: DETACHED_COORDINATOR_SCHEMA_VERSION,
        kind: DETACHED_START_KIND,
        type: 'start',
        token,
        launcherPid: process.pid,
        artifactRoot: prepared.paths.artifactRoot,
        args: { ...args },
        ...(selfTest ? { selfTest: true } : {})
      },
      { allowSelfTest: selfTest }
    )
    const readyTimeoutMs = adapters.readyTimeoutMs || DETACHED_READY_TIMEOUT_MS
    const verifyReadyManifest = adapters.verifyReadyManifest || verifyDetachedReadyManifest

    return await new Promise((resolve, reject) => {
      let settled = false
      const disconnect = () => {
        if (!controller.connected) return
        try {
          controller.disconnect()
        } catch {
          // The child may have exited between the connected check and disconnect.
        }
      }
      const fail = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        disconnect()
        reject(error)
      }
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              `detached Studio acceptance coordinator readiness timed out after ${readyTimeoutMs}ms`
            )
          ),
        readyTimeoutMs
      )

      controller.on('message', async (message) => {
        if (!isRecord(message) || message.type !== 'ready' || settled) return
        try {
          if (
            message.token !== token ||
            message.coordinatorPid !== controller.pid ||
            message.manifestPath !== prepared.paths.manifestPath
          ) {
            throw new Error('detached coordinator ready acknowledgement identity mismatch')
          }
          await verifyReadyManifest(prepared.paths, token, controller.pid)
          await new Promise((accept, deny) => {
            controller.send(
              {
                type: 'ready-accepted',
                token,
                coordinatorPid: controller.pid
              },
              (error) => (error ? deny(error) : accept())
            )
          })
          settled = true
          clearTimeout(timer)
          disconnect()
          if (typeof controller.unref === 'function') controller.unref()
          resolve({
            schemaVersion: DETACHED_COORDINATOR_SCHEMA_VERSION,
            kind: DETACHED_TOKEN_KIND,
            token,
            instanceId: plan.instanceId,
            artifactRoot: prepared.paths.artifactRoot,
            manifestPath: prepared.paths.manifestPath,
            evidencePath: prepared.paths.evidencePath,
            watchdogReceiptPath: prepared.paths.watchdogReceiptPath,
            coordinatorPid: controller.pid,
            readyAt:
              typeof message.readyAt === 'string' ? message.readyAt : new Date().toISOString()
          })
        } catch (error) {
          fail(error)
        }
      })
      controller.once('error', fail)
      controller.once('exit', (code, signal) => {
        if (!settled) {
          fail(
            new Error(
              `detached Studio acceptance coordinator exited before ready code=${code} signal=${signal}`
            )
          )
        }
      })
      try {
        controller.send(request, (error) => {
          if (error) fail(error)
        })
      } catch (error) {
        fail(error)
      }
    })
  })()
}

function boundedDetachedError(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error)
  return message.slice(0, DETACHED_ERROR_MAX_CHARS)
}

function validateDetachedManifestPaths(manifest, paths) {
  for (const key of [
    'artifactRoot',
    'manifestPath',
    'evidencePath',
    'watchdogReceiptPath',
    'stdoutLogPath',
    'stderrLogPath'
  ]) {
    if (manifest[key] !== paths[key]) {
      throw new Error(`detached coordinator ${key} path escaped or changed`)
    }
  }
}

function validateDetachedManifestEnvelope(manifest, options) {
  if (
    manifest.schemaVersion !== DETACHED_COORDINATOR_SCHEMA_VERSION ||
    manifest.kind !== DETACHED_COORDINATOR_KIND
  ) {
    return { supported: false }
  }
  if (manifest.token !== options.token) throw new Error('detached coordinator token mismatch')
  if (manifest.instanceId !== options.instanceId) {
    throw new Error('detached coordinator instance id mismatch')
  }
  if (!Number.isInteger(manifest.coordinatorPid) || manifest.coordinatorPid <= 0) {
    throw new Error('detached coordinator manifest pid is invalid')
  }
  if (!Number.isInteger(manifest.launcherPid) || manifest.launcherPid <= 0) {
    throw new Error('detached coordinator launcher pid is invalid')
  }
  if (!['ready', 'running', 'succeeded', 'failed'].includes(manifest.state)) {
    return { supported: false }
  }
  if (!Number.isSafeInteger(manifest.revision) || manifest.revision < 1) {
    throw new Error('detached coordinator manifest revision is invalid')
  }
  validateDetachedManifestPaths(manifest, options.paths)
  for (const key of ['startedAt', 'updatedAt', 'heartbeatAt']) {
    if (typeof manifest[key] !== 'string' || !Number.isFinite(Date.parse(manifest[key]))) {
      throw new Error(`detached coordinator ${key} is invalid`)
    }
  }
  const startedMs = Date.parse(manifest.startedAt)
  const updatedMs = Date.parse(manifest.updatedAt)
  const heartbeatMs = Date.parse(manifest.heartbeatAt)
  if (updatedMs < startedMs || heartbeatMs < startedMs || heartbeatMs > updatedMs) {
    throw new Error('detached coordinator timestamps moved backwards')
  }
  const terminal = manifest.state === 'succeeded' || manifest.state === 'failed'
  if (terminal) {
    if (
      typeof manifest.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(manifest.completedAt)) ||
      Date.parse(manifest.completedAt) < startedMs
    ) {
      throw new Error('detached coordinator completion timestamp is invalid')
    }
  } else if (manifest.completedAt !== null) {
    throw new Error('running detached coordinator cannot carry a completion timestamp')
  }
  if (
    manifest.error !== null &&
    (typeof manifest.error !== 'string' || manifest.error.length > DETACHED_ERROR_MAX_CHARS)
  ) {
    throw new Error('detached coordinator error is not bounded')
  }
  return { supported: true }
}

function equalIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function detachedRed(state, reason, extra = {}) {
  return { state, verdict: 'RED', green: false, reason, ...extra }
}

async function validateDetachedCompletion(paths, manifest) {
  await assertSafeRegularFile(paths.evidencePath, 'detached acceptance evidence', {
    maxBytes: ACCEPTANCE_RECEIPT_MAX_BYTES
  })
  await assertSafeRegularFile(paths.watchdogReceiptPath, 'detached watchdog receipt', {
    maxBytes: ACCEPTANCE_RECEIPT_MAX_BYTES
  })
  const actualEvidenceSha256 = await sha256Hex(paths.evidencePath)
  if (manifest.evidenceSha256 !== actualEvidenceSha256) {
    return detachedRed('succeeded', 'detached evidence hash mismatch', {
      evidenceSha256: actualEvidenceSha256
    })
  }
  const actualWatchdogSha256 = await sha256Hex(paths.watchdogReceiptPath)
  if (manifest.watchdogReceiptSha256 !== actualWatchdogSha256) {
    return detachedRed('succeeded', 'detached watchdog receipt hash mismatch', {
      evidenceSha256: actualEvidenceSha256
    })
  }
  const evidence = await readBoundedJsonFile(paths.evidencePath, 'detached acceptance evidence')
  const receipt = await readBoundedJsonFile(paths.watchdogReceiptPath, 'detached watchdog receipt')
  if (
    evidence.schemaVersion !== ACCEPTANCE_SCHEMA_VERSION ||
    evidence.kind !== 'taskwraith-studio-in-product-acceptance' ||
    evidence.ok !== true ||
    evidence.instanceId !== manifest.instanceId
  ) {
    return detachedRed(
      'succeeded',
      'detached acceptance evidence is not a successful exact-instance receipt',
      {
        evidenceSha256: actualEvidenceSha256
      }
    )
  }
  if (
    receipt.schemaVersion !== TRUSTED_RECEIPT_SCHEMA_VERSION ||
    receipt.kind !== WATCHDOG_RECEIPT_KIND
  ) {
    return detachedRed('succeeded', 'detached watchdog schema is not trusted v2', {
      evidenceSha256: actualEvidenceSha256
    })
  }
  if (
    !VERIFIED_TERMINAL_RECEIPT_STATUSES.has(receipt.status) ||
    receipt.status !== 'reaped' ||
    receipt.reason !== 'owner_requested' ||
    !Number.isInteger(receipt.childPgid) ||
    receipt.childPgid <= 0 ||
    receipt.groupExitVerified !== true ||
    receipt.detachedGroupExitVerified !== true ||
    !Array.isArray(receipt.detachedProcessGroups) ||
    receipt.artifactScanError !== undefined
  ) {
    return detachedRed('succeeded', 'detached watchdog did not verify every process group exited', {
      evidenceSha256: actualEvidenceSha256
    })
  }
  for (const key of ['lostOwnershipGroups', 'mixedOwnershipGroups', 'protectedInstalledGroups']) {
    if (!Array.isArray(receipt[key]) || receipt[key].length !== 0) {
      return detachedRed('succeeded', `detached watchdog reported unsafe ${key}`, {
        evidenceSha256: actualEvidenceSha256
      })
    }
  }
  if (receipt.survivors !== undefined) {
    if (!Array.isArray(receipt.survivors) || receipt.survivors.length !== 0) {
      return detachedRed('succeeded', 'detached watchdog reported a survivor', {
        evidenceSha256: actualEvidenceSha256
      })
    }
  }
  if (!isRecord(evidence.watchdogTerminal)) {
    return detachedRed('succeeded', 'detached evidence is missing the terminal watchdog join', {
      evidenceSha256: actualEvidenceSha256
    })
  }
  for (const key of ['status', 'reason', 'groupExitVerified', 'detachedGroupExitVerified']) {
    if (evidence.watchdogTerminal[key] !== receipt[key]) {
      return detachedRed('succeeded', `detached evidence/watchdog ${key} mismatch`, {
        evidenceSha256: actualEvidenceSha256
      })
    }
  }
  if (
    JSON.stringify(evidence.watchdogTerminal.detachedProcessGroups) !==
    JSON.stringify(receipt.detachedProcessGroups)
  ) {
    return detachedRed('succeeded', 'detached evidence/watchdog process-group mismatch', {
      evidenceSha256: actualEvidenceSha256
    })
  }
  return {
    state: 'succeeded',
    verdict: 'GREEN',
    green: true,
    reason: null,
    evidenceSha256: actualEvidenceSha256,
    watchdogReceiptSha256: actualWatchdogSha256
  }
}

async function validateDetachedFailure(paths, manifest, reason) {
  const hasEvidenceHash = typeof manifest.evidenceSha256 === 'string'
  const hasWatchdogHash = typeof manifest.watchdogReceiptSha256 === 'string'
  if (!hasEvidenceHash && !hasWatchdogHash) {
    return detachedRed('failed', reason)
  }
  if (!hasEvidenceHash || !hasWatchdogHash) {
    return detachedRed('failed', 'detached RED artifact hash join is incomplete')
  }
  await assertSafeRegularFile(paths.evidencePath, 'detached RED acceptance evidence', {
    maxBytes: ACCEPTANCE_RECEIPT_MAX_BYTES
  })
  await assertSafeRegularFile(paths.watchdogReceiptPath, 'detached RED watchdog receipt', {
    maxBytes: ACCEPTANCE_RECEIPT_MAX_BYTES
  })
  const actualEvidenceSha256 = await sha256Hex(paths.evidencePath)
  const actualWatchdogSha256 = await sha256Hex(paths.watchdogReceiptPath)
  if (
    manifest.evidenceSha256 !== actualEvidenceSha256 ||
    manifest.watchdogReceiptSha256 !== actualWatchdogSha256
  ) {
    return detachedRed('failed', 'detached RED artifact hash mismatch', {
      evidenceSha256: actualEvidenceSha256,
      watchdogReceiptSha256: actualWatchdogSha256
    })
  }
  const evidence = await readBoundedJsonFile(paths.evidencePath, 'detached RED acceptance evidence')
  if (
    evidence.schemaVersion !== ACCEPTANCE_SCHEMA_VERSION ||
    evidence.kind !== 'taskwraith-studio-in-product-acceptance' ||
    evidence.ok !== false ||
    evidence.verdict !== 'RED' ||
    evidence.instanceId !== manifest.instanceId ||
    !isRecord(evidence.failure) ||
    !isRecord(evidence.artifactReferences) ||
    !isRecord(evidence.artifactJoinPolicy) ||
    evidence.artifactJoinPolicy.exactSemanticPathSet !== true ||
    evidence.artifactJoinPolicy.sha256EveryPresentRegularFile !== true ||
    evidence.artifactJoinPolicy.revalidateEveryLeafAtStatusRead !== true ||
    evidence.artifactJoinPolicy.missingFilesRemainExplicit !== true
  ) {
    return detachedRed(
      'failed',
      'detached RED acceptance evidence is not an exact joined failure receipt',
      {
        evidenceSha256: actualEvidenceSha256,
        watchdogReceiptSha256: actualWatchdogSha256
      }
    )
  }

  let currentArtifactReferences
  try {
    currentArtifactReferences = await measureStudioAcceptanceFailureArtifacts(
      { artifactRoot: paths.artifactRoot },
      studioAcceptanceFailureArtifactCandidates(evidence)
    )
  } catch {
    return detachedRed('failed', 'detached RED artifact leaf join mismatch', {
      evidenceSha256: actualEvidenceSha256,
      watchdogReceiptSha256: actualWatchdogSha256
    })
  }
  if (
    JSON.stringify(evidence.artifactReferences) !== JSON.stringify(currentArtifactReferences) ||
    currentArtifactReferences.watchdogReceipt?.present !== true ||
    currentArtifactReferences.watchdogReceipt?.sha256 !== actualWatchdogSha256
  ) {
    return detachedRed('failed', 'detached RED artifact leaf join mismatch', {
      evidenceSha256: actualEvidenceSha256,
      watchdogReceiptSha256: actualWatchdogSha256
    })
  }
  return detachedRed('failed', reason, {
    evidenceSha256: actualEvidenceSha256,
    watchdogReceiptSha256: actualWatchdogSha256,
    failureEvidenceVerified: true
  })
}

async function readDetachedCoordinatorStatus(options, adapters = {}) {
  const instanceId = assertStudioInstanceId(options.instanceId)
  const token = assertDetachedToken(options.token)
  if (typeof options.artifactRoot !== 'string' || !path.isAbsolute(options.artifactRoot)) {
    throw new Error('detached coordinator status requires an absolute artifact root')
  }
  const artifactRoot = path.resolve(options.artifactRoot)
  const plan = {
    artifactRoot,
    evidencePath: path.join(artifactRoot, 'studio-acceptance-evidence.json'),
    receiptPath: path.join(artifactRoot, 'watchdog-receipt.json')
  }
  const paths = buildDetachedCoordinatorPaths(plan)
  let rootStat
  try {
    rootStat = await fsPromises.lstat(paths.artifactRoot)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        state: 'unknown',
        verdict: 'UNKNOWN',
        green: false,
        reason: 'artifact root missing'
      }
    }
    throw error
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('detached coordinator artifact root must be a real directory')
  }
  let manifest
  try {
    manifest = await readBoundedJsonFile(paths.manifestPath, 'detached coordinator manifest')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { state: 'unknown', verdict: 'UNKNOWN', green: false, reason: 'manifest missing' }
    }
    throw error
  }
  const envelope = validateDetachedManifestEnvelope(manifest, {
    instanceId,
    token,
    paths
  })
  if (!envelope.supported) {
    return {
      state: 'unknown',
      verdict: 'UNKNOWN',
      green: false,
      reason: 'unsupported detached coordinator manifest'
    }
  }
  const expectedIdentity = await (adapters.buildIdentity || buildDetachedCoordinatorIdentity)()
  if (!equalIdentity(manifest.identity, expectedIdentity)) {
    return detachedRed('failed', 'detached coordinator executable identity mismatch')
  }
  if (manifest.state === 'ready' || manifest.state === 'running') {
    if (manifest.revision < (manifest.state === 'ready' ? 1 : 2)) {
      return detachedRed('failed', 'detached coordinator state revision is not monotonic')
    }
    const nowMs = options.nowMs === undefined ? Date.now() : Number(options.nowMs)
    const staleAfterMs =
      options.staleAfterMs === undefined ? DETACHED_STALE_AFTER_MS : Number(options.staleAfterMs)
    const heartbeatMs = Date.parse(manifest.heartbeatAt || manifest.updatedAt)
    if (
      !Number.isFinite(nowMs) ||
      !Number.isSafeInteger(staleAfterMs) ||
      staleAfterMs < 1 ||
      !Number.isFinite(heartbeatMs)
    ) {
      return detachedRed('failed', 'detached coordinator heartbeat fields are invalid')
    }
    if (nowMs - heartbeatMs > staleAfterMs) {
      return detachedRed('stale', 'detached coordinator heartbeat is stale')
    }
    return {
      state: 'running',
      verdict: 'UNKNOWN',
      green: false,
      reason: 'detached coordinator is still running',
      revision: manifest.revision,
      updatedAt: manifest.updatedAt
    }
  }
  if (manifest.state === 'failed') {
    if (manifest.revision < 3) {
      return detachedRed('failed', 'detached coordinator failure revision is not monotonic')
    }
    const reason =
      typeof manifest.error === 'string' && manifest.error.length > 0
        ? manifest.error.slice(0, DETACHED_ERROR_MAX_CHARS)
        : 'detached coordinator failed without a bounded error'
    return validateDetachedFailure(paths, manifest, reason)
  }
  if (manifest.state !== 'succeeded') {
    return {
      state: 'unknown',
      verdict: 'UNKNOWN',
      green: false,
      reason: 'unsupported detached coordinator state'
    }
  }
  if (manifest.revision < 3) {
    return detachedRed('failed', 'detached coordinator success revision is not monotonic')
  }
  return validateDetachedCompletion(paths, manifest)
}

function createDetachedManifestWriter(paths, initialManifest) {
  let current = initialManifest
  let tail = Promise.resolve()
  const stateRank = { ready: 1, running: 2, succeeded: 3, failed: 3 }
  const update = (patch) => {
    tail = tail.then(async () => {
      const nextState = patch.state || current.state
      if (!stateRank[nextState] || stateRank[nextState] < stateRank[current.state]) {
        throw new Error('detached coordinator state cannot move backwards')
      }
      const now = new Date().toISOString()
      const next = {
        ...current,
        ...patch,
        state: nextState,
        revision: current.revision + 1,
        updatedAt: now
      }
      await atomicWriteDetachedManifest(paths.manifestPath, next)
      current = next
      return current
    })
    return tail
  }
  return {
    update,
    drain: () => tail,
    current: () => current
  }
}

async function runDetachedCoordinatorStub(plan) {
  const spec = buildStubSpec({
    directory: plan.artifactRoot,
    timeoutMs: 30_000,
    forceAfterMs: 250
  })
  const session = await launchUnderWatchdog(spec, {
    controllerEnv: { TASKWRAITH_STUDIO_ACCEPTANCE_TEST: '1' }
  })
  await fsPromises.writeFile(
    path.join(plan.artifactRoot, 'detached-stub-running.json'),
    `${JSON.stringify({
      coordinatorPid: process.pid,
      watchdogControllerPid: session.controllerPid,
      childPid: session.pid,
      childPgid: session.pgid || session.pid
    })}\n`,
    { encoding: 'utf8', mode: 0o600 }
  )
  const stopPath = path.join(plan.artifactRoot, 'detached-stub-stop')
  while (true) {
    try {
      const stat = await fsPromises.lstat(stopPath)
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('detached stub stop sentinel must be a regular file')
      }
      break
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
    }
    await sleep(25)
  }
  const watchdogTerminal = assertCleanWatchdogTerminal(await session.stop())
  const evidence = {
    ok: true,
    instanceId: plan.instanceId,
    selfTest: true,
    watchdogTerminal
  }
  await writeEvidence(plan, evidence)
  return { launched: true, plan, evidence }
}

async function sendCoordinatorReady(message) {
  if (typeof process.send !== 'function' || !process.connected) {
    throw new Error('detached coordinator lost launcher IPC before readiness')
  }
  await new Promise((resolve, reject) => {
    process.send(message, (error) => (error ? reject(error) : resolve()))
  })
}

async function waitForCoordinatorReadyAcceptance(token, timeoutMs = DETACHED_READY_TIMEOUT_MS) {
  await new Promise((resolve, reject) => {
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.removeListener('message', onMessage)
      process.removeListener('disconnect', onDisconnect)
      if (error) reject(error)
      else resolve()
    }
    const onMessage = (message) => {
      if (
        !isRecord(message) ||
        message.type !== 'ready-accepted' ||
        message.token !== token ||
        message.coordinatorPid !== process.pid
      ) {
        finish(new Error('detached coordinator received an invalid ready acceptance'))
        return
      }
      finish()
    }
    const onDisconnect = () => {
      finish(new Error('detached coordinator launcher disconnected before accepting readiness'))
    }
    const timer = setTimeout(
      () =>
        finish(new Error(`detached coordinator ready acceptance timed out after ${timeoutMs}ms`)),
      timeoutMs
    )
    process.once('message', onMessage)
    process.once('disconnect', onDisconnect)
  })
}

async function runDetachedCoordinatorProcess() {
  const allowSelfTest = process.env.TASKWRAITH_STUDIO_ACCEPTANCE_TEST === '1'
  const request = await new Promise((resolve, reject) => {
    let accepted = false
    const onDisconnect = () => {
      if (!accepted) reject(new Error('detached coordinator launcher disconnected before request'))
    }
    process.once('disconnect', onDisconnect)
    process.once('message', (message) => {
      try {
        const validated = validateDetachedCoordinatorRequest(message, { allowSelfTest })
        accepted = true
        process.removeListener('disconnect', onDisconnect)
        resolve(validated)
      } catch (error) {
        process.removeListener('disconnect', onDisconnect)
        reject(error)
      }
    })
  })

  let plan
  if (request.selfTest === true) {
    plan = buildStudioAcceptancePlan({
      instanceId: request.args.instanceId,
      artifactRoot: request.artifactRoot,
      home: path.join(request.artifactRoot, 'home'),
      platform: 'darwin',
      adapters: { resolveElectronPath: () => '/virtual/Electron' }
    })
  } else {
    plan = buildStudioAcceptancePlan({
      instanceId: request.args.instanceId,
      transcriptTimeoutMs: request.args.transcriptTimeoutMs,
      remoteDebuggingPort: request.args.remoteDebuggingPort,
      mainInspectorPort: request.args.mainInspectorPort
    })
    assertDetachedLaunchAuthorized(request.args, plan)
  }
  const paths = buildDetachedCoordinatorPaths(plan)
  if (paths.artifactRoot !== request.artifactRoot) {
    throw new Error('detached coordinator request escaped the derived artifact root')
  }
  const rootStat = await fsPromises.lstat(paths.artifactRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('detached coordinator artifact root is not a real directory')
  }
  await assertSafeRegularFile(paths.stdoutLogPath, 'detached coordinator stdout log')
  await assertSafeRegularFile(paths.stderrLogPath, 'detached coordinator stderr log')
  const startedAt = new Date().toISOString()
  const initialManifest = {
    schemaVersion: DETACHED_COORDINATOR_SCHEMA_VERSION,
    kind: DETACHED_COORDINATOR_KIND,
    state: 'ready',
    revision: 1,
    token: request.token,
    instanceId: plan.instanceId,
    coordinatorPid: process.pid,
    launcherPid: request.launcherPid,
    identity: await buildDetachedCoordinatorIdentity(),
    artifactRoot: paths.artifactRoot,
    manifestPath: paths.manifestPath,
    evidencePath: paths.evidencePath,
    watchdogReceiptPath: paths.watchdogReceiptPath,
    stdoutLogPath: paths.stdoutLogPath,
    stderrLogPath: paths.stderrLogPath,
    startedAt,
    updatedAt: startedAt,
    heartbeatAt: startedAt,
    completedAt: null,
    evidenceSha256: null,
    watchdogReceiptSha256: null,
    error: null
  }
  await atomicWriteDetachedManifest(paths.manifestPath, initialManifest, { initial: true })
  await sendCoordinatorReady({
    type: 'ready',
    token: request.token,
    coordinatorPid: process.pid,
    manifestPath: paths.manifestPath,
    readyAt: startedAt
  })
  await waitForCoordinatorReadyAcceptance(request.token)

  const writer = createDetachedManifestWriter(paths, initialManifest)
  await writer.update({ state: 'running', heartbeatAt: new Date().toISOString() })
  let heartbeatStopped = false
  const heartbeat = setInterval(() => {
    if (heartbeatStopped) return
    writer
      .update({ state: 'running', heartbeatAt: new Date().toISOString() })
      .catch(() => undefined)
  }, DETACHED_HEARTBEAT_MS)

  try {
    const result =
      request.selfTest === true
        ? await runDetachedCoordinatorStub(plan)
        : await runStudioAcceptance(request.args)
    heartbeatStopped = true
    clearInterval(heartbeat)
    await writer.drain()
    const evidenceSha256 = await sha256Hex(paths.evidencePath)
    const watchdogReceiptSha256 = await sha256Hex(paths.watchdogReceiptPath)
    const provisional = {
      ...writer.current(),
      state: 'succeeded',
      evidenceSha256,
      watchdogReceiptSha256
    }
    const completion = await validateDetachedCompletion(paths, provisional)
    if (!completion.green) throw new Error(completion.reason)
    await writer.update({
      state: 'succeeded',
      heartbeatAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      evidenceSha256,
      watchdogReceiptSha256,
      error: null
    })
    return result
  } catch (error) {
    heartbeatStopped = true
    clearInterval(heartbeat)
    await writer.drain().catch(() => undefined)
    let evidenceSha256 = null
    let watchdogReceiptSha256 = null
    let artifactHashError = null
    try {
      evidenceSha256 = await sha256SafeRegularFileIfPresent(
        paths.evidencePath,
        'detached RED acceptance evidence'
      )
      watchdogReceiptSha256 = await sha256SafeRegularFileIfPresent(
        paths.watchdogReceiptPath,
        'detached RED watchdog receipt'
      )
    } catch (hashError) {
      artifactHashError = hashError
    }
    const terminalError = artifactHashError
      ? new AggregateError(
          [error, artifactHashError],
          'Studio acceptance failed and its RED artifact hash join failed'
        )
      : error
    await writer.update({
      state: 'failed',
      heartbeatAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      evidenceSha256,
      watchdogReceiptSha256,
      error: boundedDetachedError(terminalError)
    })
    throw terminalError
  }
}

async function runDetachedLauncherSelfTest(controlRoot, instanceId) {
  if (process.env.TASKWRAITH_STUDIO_ACCEPTANCE_TEST !== '1') {
    throw new Error('detached launcher self-test is test-only')
  }
  const root = path.resolve(controlRoot)
  await fsPromises.mkdir(root, { recursive: true, mode: 0o700 })
  const artifactRoot = path.join(root, 'acceptance', assertStudioInstanceId(instanceId))
  const token = await launchDetachedCoordinator(
    {
      ...parseArgs([]),
      launch: true,
      detach: true,
      acceptLaunch: true,
      ownerConfirmsOrphansCleared: true,
      instanceId,
      mediaPath: '/test-only/unused.mov',
      mimeType: 'video/quicktime'
    },
    {
      selfTest: true,
      planOptions: {
        artifactRoot,
        home: path.join(artifactRoot, 'home'),
        platform: 'darwin',
        adapters: { resolveElectronPath: () => '/virtual/Electron' }
      }
    }
  )
  await fsPromises.writeFile(path.join(root, 'launcher-ready.json'), `${JSON.stringify(token)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  setInterval(() => {}, 1_000)
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

/**
 * Materialize the short real-speech fixture inside this run's artifact root.
 *
 * The commands come from the separately tested deterministic generator. This
 * function is deliberately the executor and sealer: a command plan alone is
 * reproducible, but it is not evidence that the exact bytes later opened by
 * Studio came from that plan.
 */
async function generateAcceptanceSpeechFixture(options, adapters = {}) {
  const artifactRoot = path.resolve(String(options.artifactRoot || ''))
  if (!path.isAbsolute(artifactRoot) || artifactRoot === path.parse(artifactRoot).root) {
    throw new Error('generated speech fixture requires a bounded absolute artifact root')
  }
  const fixtureDirectory = path.join(artifactRoot, 'fixtures')
  const speechPath = path.join(fixtureDirectory, 'acceptance-speech.aiff')
  const outputPath = path.join(fixtureDirectory, 'acceptance-speech-30s.mp4')
  const manifestPath = path.join(fixtureDirectory, 'speech-fixture-manifest.json')
  await fsPromises.mkdir(fixtureDirectory, { recursive: true, mode: 0o700 })
  for (const [label, candidate] of [
    ['speech', speechPath],
    ['muxed output', outputPath],
    ['manifest', manifestPath]
  ]) {
    if (
      await assertSafeRegularFile(candidate, `generated fixture ${label}`, { allowMissing: true })
    ) {
      throw new Error(`generated fixture ${label} already exists; require a fresh artifact root`)
    }
  }

  const fixturePlan = describeFixturePlan({
    durationSeconds: SHORT_SPEECH_FIXTURE_DURATION_SECONDS
  })
  const sayCommand = buildSayCommand({ outputPath: speechPath })
  const muxCommand = buildMuxCommand({
    speechPath,
    outputPath,
    durationSeconds: SHORT_SPEECH_FIXTURE_DURATION_SECONDS
  })
  const runExec = adapters.execFile || defaultExecFile
  await runExec(sayCommand[0], sayCommand.slice(1), { timeoutMs: 120_000 })
  const speechStat = await assertSafeRegularFile(speechPath, 'generated fixture speech')
  if (speechStat.size < 1) throw new Error('generated fixture speech is empty')
  await fsPromises.chmod(speechPath, 0o600)

  await runExec(muxCommand[0], muxCommand.slice(1), { timeoutMs: 10 * 60 * 1_000 })
  const outputStat = await assertSafeRegularFile(outputPath, 'generated fixture muxed output')
  if (outputStat.size < 1) throw new Error('generated fixture muxed output is empty')
  await fsPromises.chmod(outputPath, 0o600)

  const manifest = {
    schemaVersion: 1,
    kind: 'taskwraith-studio-generated-speech-fixture',
    durationSeconds: fixturePlan.durationSeconds,
    frameRate: fixturePlan.frameRate,
    expectedFrameCount: fixturePlan.expectedFrameCount,
    size: fixturePlan.size,
    speechText: fixturePlan.speechText,
    expectedPhrases: fixturePlan.expectedPhrases,
    provenanceNote: fixturePlan.provenanceNote,
    speechPath,
    outputPath,
    manifestPath,
    mimeType: 'video/mp4',
    speechSha256: await sha256Hex(speechPath),
    outputSha256: await sha256Hex(outputPath),
    speechByteLength: speechStat.size,
    outputByteLength: outputStat.size,
    sayCommand,
    muxCommand,
    sayExitCode: 0,
    muxExitCode: 0
  }
  const verification = verifyFixtureManifest(manifest)
  if (!verification.ok) {
    throw new Error(
      `generated speech fixture manifest is invalid: ${verification.failures.join('; ')}`
    )
  }

  const tempPath = path.join(
    fixtureDirectory,
    `.${path.basename(manifestPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  )
  try {
    await fsPromises.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await fsPromises.rename(tempPath, manifestPath)
  } finally {
    await fsPromises.rm(tempPath, { force: true }).catch(() => undefined)
  }
  return manifest
}

async function assertGeneratedSpeechFixtureCustody(fixture, asset, artifactRootValue) {
  if (!isRecord(fixture) || !isRecord(asset)) {
    throw new Error('generated speech fixture custody requires fixture and asset records')
  }
  const artifactRoot = path.resolve(String(artifactRootValue || ''))
  if (!path.isAbsolute(artifactRoot) || artifactRoot === path.parse(artifactRoot).root) {
    throw new Error('generated speech fixture custody requires a bounded artifact root')
  }
  const fixtureDirectory = path.join(artifactRoot, 'fixtures')
  const [realArtifactRoot, realFixtureDirectory] = await Promise.all([
    fsPromises.realpath(artifactRoot),
    fsPromises.realpath(fixtureDirectory)
  ])
  if (realFixtureDirectory !== path.join(realArtifactRoot, 'fixtures')) {
    throw new Error('generated speech fixture directory is not the exact artifact-root path')
  }
  const expectedPaths = {
    speechPath: path.join(fixtureDirectory, 'acceptance-speech.aiff'),
    outputPath: path.join(fixtureDirectory, 'acceptance-speech-30s.mp4'),
    manifestPath: path.join(fixtureDirectory, 'speech-fixture-manifest.json')
  }
  for (const [field, expectedPath] of Object.entries(expectedPaths)) {
    if (
      typeof fixture[field] !== 'string' ||
      path.resolve(fixture[field]) !== path.resolve(expectedPath)
    ) {
      throw new Error(`generated speech fixture ${field} is not the exact artifact-root path`)
    }
  }

  const manifestStat = await assertSafeRegularFile(
    expectedPaths.manifestPath,
    'generated speech fixture persisted manifest',
    { maxBytes: ACCEPTANCE_RECEIPT_MAX_BYTES }
  )
  const speechStat = await assertSafeRegularFile(
    expectedPaths.speechPath,
    'generated speech fixture speech'
  )
  const outputStat = await assertSafeRegularFile(
    expectedPaths.outputPath,
    'generated speech fixture output'
  )
  if (speechStat.size < 1 || outputStat.size < 1) {
    throw new Error('generated speech fixture custody refuses empty media')
  }
  const persisted = await readBoundedJsonFile(
    expectedPaths.manifestPath,
    'generated speech fixture persisted manifest'
  )
  const expectedPlan = describeFixturePlan({
    durationSeconds: SHORT_SPEECH_FIXTURE_DURATION_SECONDS
  })
  for (const [label, candidate] of [
    ['returned', fixture],
    ['persisted', persisted]
  ]) {
    const verification = verifyFixtureManifest(candidate)
    if (!verification.ok) {
      throw new Error(
        `generated speech fixture ${label} manifest is invalid: ${verification.failures.join('; ')}`
      )
    }
    if (
      candidate.schemaVersion !== 1 ||
      candidate.kind !== 'taskwraith-studio-generated-speech-fixture' ||
      candidate.mimeType !== 'video/mp4' ||
      candidate.durationSeconds !== expectedPlan.durationSeconds ||
      candidate.frameRate !== expectedPlan.frameRate ||
      candidate.expectedFrameCount !== expectedPlan.expectedFrameCount ||
      candidate.size !== expectedPlan.size ||
      candidate.speechText !== expectedPlan.speechText ||
      JSON.stringify(candidate.expectedPhrases) !== JSON.stringify(expectedPlan.expectedPhrases) ||
      candidate.provenanceNote !== expectedPlan.provenanceNote ||
      candidate.sayExitCode !== 0 ||
      candidate.muxExitCode !== 0
    ) {
      throw new Error(
        `generated speech fixture ${label} manifest does not match the exact short-fixture contract`
      )
    }
  }
  if (JSON.stringify(persisted) !== JSON.stringify(fixture)) {
    throw new Error('generated speech fixture returned and persisted manifests do not agree')
  }
  if (
    !Number.isSafeInteger(fixture.speechByteLength) ||
    fixture.speechByteLength !== speechStat.size
  ) {
    throw new Error('generated speech fixture speech byte length does not match persisted bytes')
  }
  if (
    !Number.isSafeInteger(fixture.outputByteLength) ||
    fixture.outputByteLength !== outputStat.size
  ) {
    throw new Error('generated speech fixture output byte length does not match persisted bytes')
  }

  const [speechSha256, outputSha256, manifestSha256] = await Promise.all([
    sha256Hex(expectedPaths.speechPath),
    sha256Hex(expectedPaths.outputPath),
    sha256Hex(expectedPaths.manifestPath)
  ])
  if (fixture.speechSha256 !== speechSha256) {
    throw new Error('generated speech fixture speech digest does not match persisted bytes')
  }
  if (fixture.outputSha256 !== outputSha256) {
    throw new Error('generated speech fixture output digest does not match persisted bytes')
  }

  const realOutputPath = await fsPromises.realpath(expectedPaths.outputPath)
  const realAssetSourcePath = await fsPromises.realpath(String(asset.sourcePath || ''))
  if (realAssetSourcePath !== realOutputPath) {
    throw new Error('generated speech fixture output is not the exact opened asset source')
  }
  const assetStat = await assertSafeRegularFile(
    String(asset.assetPath || ''),
    'generated speech fixture isolated opened asset'
  )
  if (assetStat.size !== outputStat.size || asset.byteLength !== outputStat.size) {
    throw new Error('generated speech fixture opened asset byte length does not match output')
  }
  const [openedOutputSha256, assetSha256] = await Promise.all([
    sha256Hex(String(asset.assetPath)),
    sha256Base64Url(String(asset.assetPath))
  ])
  if (openedOutputSha256 !== outputSha256 || asset.sha256 !== assetSha256) {
    throw new Error('generated speech fixture opened asset digest does not match output')
  }

  return {
    ok: true,
    manifestPath: expectedPaths.manifestPath,
    manifestSha256,
    manifestByteLength: manifestStat.size,
    speechPath: expectedPaths.speechPath,
    speechSha256,
    speechByteLength: speechStat.size,
    outputPath: expectedPaths.outputPath,
    outputSha256,
    outputByteLength: outputStat.size,
    assetPath: String(asset.assetPath),
    assetSha256
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
          const failure = new Error(
            `${path.basename(file)} failed: ${String(
              (stderr && String(stderr).trim()) || error.message || error
            ).slice(0, 1000)}`
          )
          failure.stdout = String(stdout || '')
          failure.stderr = String(stderr || '')
          reject(failure)
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
  const selectedNativeEntries = Object.entries(STUDIO_ACCEPTANCE_SELECTED_NATIVE_PRODUCTS)
  const steps = [
    ...selectedNativeEntries.map(([, product]) => ({
      command: product.command,
      args: [...product.args]
    })),
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
  return {
    ok: true,
    steps: steps.map((step) => [step.command, ...step.args].join(' ')),
    selectedNativeProducts: Object.fromEntries(
      selectedNativeEntries.map(([name, product]) => [name, product.relativePath])
    ),
    results
  }
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
    if (action.type === 'read-workspace') {
      return { type: 'read-workspace' }
    }
    if (action.type === 'read-av-sync' || action.type === 'coreaudio-route-health') {
      return { type: action.type }
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

const STUDIO_WORKSPACE_NORMALIZED_KEYS = Object.freeze({
  [STUDIO_WORKSPACE_ROOT_ID]: 'root',
  [STUDIO_WORKSPACE_SOURCE_ROUTE_ID]: 'sourceRoute',
  [STUDIO_WORKSPACE_TIMELINE_ROUTE_ID]: 'timelineRoute',
  [STUDIO_WORKSPACE_SOURCE_HOST_ID]: 'sourceHost',
  [STUDIO_WORKSPACE_TIMELINE_HOST_ID]: 'timelineHost',
  [STUDIO_WORKSPACE_CURRENT_VERSION_ID]: 'currentVersion',
  [STUDIO_WORKSPACE_PROPOSED_VERSION_ID]: 'proposedVersion'
})

function resolveStudioWorkspaceWindow(target) {
  const window = target && target.window
  if (!isRecord(window) || !Array.isArray(window.windows)) {
    throw new Error('Studio UI journey requires an exact visible-window set')
  }
  const windows = window.windows
  if (windows.length !== 1 || window.visibleWindowCount !== 1) {
    throw new Error('Studio UI journey requires exactly one visible workspace window')
  }
  const entry = windows[0]
  if (!isRecord(entry) || entry.title !== STUDIO_WORKSPACE_WINDOW_TITLE) {
    throw new Error(
      `Studio UI journey requires the single ${STUDIO_WORKSPACE_WINDOW_TITLE} workspace window`
    )
  }
  return { ...target, expectedWindowTitle: entry.title }
}

function studioWorkspaceFrameWithinWindow(frame, windowBounds) {
  if (
    !isRecord(windowBounds) ||
    !['x', 'y', 'width', 'height'].every(
      (key) => typeof windowBounds[key] === 'number' && Number.isFinite(windowBounds[key])
    ) ||
    windowBounds.width <= 0 ||
    windowBounds.height <= 0
  ) {
    return false
  }
  if (
    !isRecord(frame) ||
    !['x', 'y', 'width', 'height'].every(
      (key) => typeof frame[key] === 'number' && Number.isFinite(frame[key])
    ) ||
    frame.width <= 0 ||
    frame.height <= 0
  ) {
    return false
  }
  const tolerance = 1
  return (
    frame.x >= windowBounds.x - tolerance &&
    frame.y >= windowBounds.y - tolerance &&
    frame.x + frame.width <= windowBounds.x + windowBounds.width + tolerance &&
    frame.y + frame.height <= windowBounds.y + windowBounds.height + tolerance
  )
}

function validateStudioWorkspaceElement(element, id, windowBounds) {
  const { visible, role, value, enabled, frame } = element
  if (id === STUDIO_WORKSPACE_ROOT_ID) {
    if (!visible) throw new Error('Studio workspace root must be visible')
    if (role !== 'AXGroup') throw new Error('Studio workspace root is not an AXGroup')
    if (value !== null) throw new Error('Studio workspace root must not carry a value')
    if (enabled !== null) throw new Error('Studio workspace root must not carry an enabled flag')
    if (!studioWorkspaceFrameWithinWindow(frame, windowBounds)) {
      throw new Error('Studio workspace root frame is outside the immutable window bounds')
    }
    return { visible, role, value, enabled, frame }
  }
  if (STUDIO_WORKSPACE_HOST_IDS.has(id)) {
    if (!visible) {
      if (role !== null || value !== null || enabled !== null || frame !== null) {
        throw new Error(
          `Studio hidden workspace host ${id} must not carry role/value/enabled/frame`
        )
      }
      return { visible, role, value, enabled, frame }
    }
    if (role !== 'AXGroup') throw new Error(`Studio workspace host ${id} is not an AXGroup`)
    if (value !== null) throw new Error(`Studio workspace host ${id} must not carry a value`)
    if (enabled !== null) throw new Error(`Studio workspace host ${id} must not carry an enabled flag`)
    if (!studioWorkspaceFrameWithinWindow(frame, windowBounds)) {
      throw new Error(`Studio workspace host ${id} frame is outside the immutable window bounds`)
    }
    return { visible, role, value, enabled, frame }
  }
  if (STUDIO_WORKSPACE_ROUTE_IDS.has(id)) {
    if (!visible) throw new Error(`Studio workspace route control ${id} must be visible`)
    if (role !== 'AXCheckBox') {
      throw new Error(`Studio workspace route control ${id} is not an AXCheckBox`)
    }
    if (value !== 'selected' && value !== 'not selected') {
      throw new Error(`Studio workspace route control ${id} has an invalid value`)
    }
    if (enabled !== true) {
      throw new Error(`Studio workspace route control ${id} must be enabled`)
    }
    if (!studioWorkspaceFrameWithinWindow(frame, windowBounds)) {
      throw new Error(`Studio workspace route control ${id} frame is outside the immutable window bounds`)
    }
    return { visible, role, value, enabled, frame }
  }
  if (STUDIO_WORKSPACE_VERSION_IDS.has(id)) {
    if (!visible) throw new Error(`Studio workspace version control ${id} must be visible`)
    if (role !== 'AXRadioButton') {
      throw new Error(`Studio workspace version control ${id} is not an AXRadioButton`)
    }
    if (value !== 'selected' && value !== 'not selected' && value !== 'unavailable') {
      throw new Error(`Studio workspace version control ${id} has an invalid value`)
    }
    if (enabled !== (value !== 'unavailable')) {
      throw new Error(
        `Studio workspace version control ${id} enabled state does not match its value`
      )
    }
    if (!studioWorkspaceFrameWithinWindow(frame, windowBounds)) {
      throw new Error(`Studio workspace version control ${id} frame is outside the immutable window bounds`)
    }
    return { visible, role, value, enabled, frame }
  }
  throw new Error(`Studio workspace observation carries an unknown identifier ${id}`)
}

function validateStudioWorkspaceObservation(workspace, windowBounds) {
  if (
    !isRecord(workspace) ||
    Object.keys(workspace).length !== 1 ||
    !Array.isArray(workspace.elements)
  ) {
    throw new Error('Studio workspace observation is not one exact elements array')
  }
  const elements = workspace.elements
  if (elements.length !== STUDIO_WORKSPACE_ELEMENT_IDS.length) {
    throw new Error('Studio workspace observation does not carry the exact element count')
  }
  const elementKeys = ['identifier', 'visible', 'role', 'value', 'enabled', 'frame']
  const byId = new Map()
  for (const element of elements) {
    if (!isRecord(element) || Object.keys(element).length !== elementKeys.length) {
      throw new Error('Studio workspace observation carries a malformed or extra element field')
    }
    for (const key of elementKeys) {
      if (!(key in element)) {
        throw new Error(`Studio workspace observation is missing element field ${key}`)
      }
    }
    if (typeof element.identifier !== 'string' || !element.identifier) {
      throw new Error('Studio workspace observation element identifier is not an exact string')
    }
    if (typeof element.visible !== 'boolean') {
      throw new Error('Studio workspace observation element visibility is not boolean')
    }
    if (byId.has(element.identifier)) {
      throw new Error(`Studio workspace observation duplicates identifier ${element.identifier}`)
    }
    byId.set(element.identifier, element)
  }
  for (const id of STUDIO_WORKSPACE_ELEMENT_IDS) {
    if (!byId.has(id)) {
      throw new Error(`Studio workspace observation is missing identifier ${id}`)
    }
  }
  const normalized = {}
  for (const id of STUDIO_WORKSPACE_ELEMENT_IDS) {
    normalized[STUDIO_WORKSPACE_NORMALIZED_KEYS[id]] = validateStudioWorkspaceElement(
      byId.get(id),
      id,
      windowBounds
    )
  }
  return normalized
}

function readWorkspaceObservationFromReceipt(receipt, windowBounds) {
  const actions = Array.isArray(receipt && receipt.actions) ? receipt.actions : []
  const matches = actions.filter((action) => action && action.type === 'read-workspace')
  if (matches.length !== 1) {
    throw new Error('Studio workspace observation is missing from the driver receipt')
  }
  return validateStudioWorkspaceObservation(matches[0].workspace, windowBounds)
}

function studioWorkspaceAbReadyControl(control) {
  return (
    isRecord(control) &&
    control.role === 'AXRadioButton' &&
    control.visible === true &&
    control.enabled === true &&
    (control.value === 'selected' || control.value === 'not selected')
  )
}

// Timeline-route-selected plus a visible Timeline host is necessary but not
// sufficient: the journey is about to drive Current/Proposed actions, so both
// A/B controls must themselves be ready (visible, enabled, radio-role) and
// exactly one of the two may report selected. This does not require Source to
// be hidden, so wide-dual presentation still counts as Review-presented.
function studioWorkspaceReviewPresented(workspace) {
  if (
    !isRecord(workspace) ||
    !isRecord(workspace.timelineRoute) ||
    workspace.timelineRoute.value !== 'selected' ||
    !isRecord(workspace.timelineHost) ||
    workspace.timelineHost.visible !== true
  ) {
    return false
  }
  const current = workspace.currentVersion
  const proposed = workspace.proposedVersion
  if (!studioWorkspaceAbReadyControl(current) || !studioWorkspaceAbReadyControl(proposed)) {
    return false
  }
  const currentSelected = current.value === 'selected'
  const proposedSelected = proposed.value === 'selected'
  return currentSelected !== proposedSelected
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

function normalizeRecognizedSpeech(value) {
  return (
    String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .match(/[\p{L}\p{N}]+/gu)
      ?.join(' ') || ''
  )
}

function boundedRecognizedSpeechEditDistance(left, right, maximumDistance = 1) {
  if (
    typeof left !== 'string' ||
    typeof right !== 'string' ||
    !Number.isSafeInteger(maximumDistance) ||
    maximumDistance < 0 ||
    maximumDistance > 4
  ) {
    throw new Error('recognized-speech edit-distance operands are invalid')
  }
  if (Math.abs(left.length - right.length) > maximumDistance) return maximumDistance + 1
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex]
    let rowMinimum = current[0]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      const value = Math.min(previous[rightIndex] + 1, current[rightIndex - 1] + 1, substitution)
      current.push(value)
      rowMinimum = Math.min(rowMinimum, value)
    }
    if (rowMinimum > maximumDistance) return maximumDistance + 1
    previous = current
  }
  return previous[right.length]
}

function assertRecognizedTranscriptRational(value, label) {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.n) ||
    !Number.isSafeInteger(value.d) ||
    value.n < 0 ||
    value.d <= 0
  ) {
    throw new Error(`${label} must be a finite nonnegative rational`)
  }
  return value
}

function compareRecognizedTranscriptRationals(left, right) {
  const difference = BigInt(left.n) * BigInt(right.d) - BigInt(right.n) * BigInt(left.d)
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}

function assertRecognizedTranscriptTiming(entry, boundary) {
  if (
    !isRecord(boundary) ||
    typeof boundary.assetId !== 'string' ||
    !boundary.assetId ||
    boundary.assetId.length > 512 ||
    !Number.isSafeInteger(boundary.durationSeconds) ||
    boundary.durationSeconds <= 0 ||
    !Number.isSafeInteger(boundary.frameRate) ||
    boundary.frameRate <= 0 ||
    boundary.frameRate > 240 ||
    !Number.isSafeInteger(boundary.durationSeconds * boundary.frameRate + 1)
  ) {
    throw new Error('recognized transcript timing boundary is invalid')
  }
  const transcript = entry?.op?.transcript
  if (
    entry?.op?.type !== 'set_transcript' ||
    !isRecord(transcript) ||
    transcript.schemaVersion !== 1 ||
    typeof transcript.transcriptId !== 'string' ||
    !transcript.transcriptId ||
    transcript.transcriptId.length > 512 ||
    transcript.assetId !== boundary.assetId ||
    !Array.isArray(transcript.segments) ||
    transcript.segments.length < 1 ||
    transcript.segments.length > 2_048
  ) {
    throw new Error('recognized transcript has an invalid schema or asset identity')
  }

  const segmentIds = new Set()
  const texts = []
  let previousSourceOut = null
  const durationWithTail = {
    n: boundary.durationSeconds * boundary.frameRate + 1,
    d: boundary.frameRate
  }
  for (const [index, segment] of transcript.segments.entries()) {
    if (
      !isRecord(segment) ||
      typeof segment.segmentId !== 'string' ||
      !segment.segmentId ||
      segment.segmentId.length > 512 ||
      typeof segment.text !== 'string' ||
      !segment.text.trim() ||
      Buffer.byteLength(segment.text) > 16 * 1_024
    ) {
      throw new Error(`recognized timed transcript segment ${index} has an invalid shape`)
    }
    if (segmentIds.has(segment.segmentId)) {
      throw new Error('recognized transcript requires a unique segmentId for every segment')
    }
    segmentIds.add(segment.segmentId)
    const sourceIn = assertRecognizedTranscriptRational(
      segment.sourceIn,
      `recognized timed transcript segment ${index} sourceIn`
    )
    const sourceOut = assertRecognizedTranscriptRational(
      segment.sourceOut,
      `recognized timed transcript segment ${index} sourceOut`
    )
    if (compareRecognizedTranscriptRationals(sourceIn, sourceOut) >= 0) {
      throw new Error(`recognized transcript segment ${index} is not a positive timed range`)
    }
    if (
      previousSourceOut &&
      compareRecognizedTranscriptRationals(sourceIn, previousSourceOut) < 0
    ) {
      throw new Error('recognized transcript segments are not ordered and nonoverlapping')
    }
    if (compareRecognizedTranscriptRationals(sourceOut, durationWithTail) > 0) {
      throw new Error('recognized transcript segment exceeds the fixture duration plus one frame')
    }
    previousSourceOut = sourceOut
    texts.push(segment.text.trim())
  }
  return {
    texts,
    timingPolicy: {
      exactAssetId: boundary.assetId,
      positiveRanges: true,
      orderedNonOverlapping: true,
      durationSeconds: boundary.durationSeconds,
      frameRate: boundary.frameRate,
      tailToleranceFrames: 1
    }
  }
}

function adjudicateRecognizedTranscript(entry, expectedPhrases, boundary) {
  if (
    !Array.isArray(expectedPhrases) ||
    expectedPhrases.length < 1 ||
    expectedPhrases.length > 32 ||
    expectedPhrases.some(
      (phrase) => typeof phrase !== 'string' || !phrase.trim() || phrase.length > 256
    )
  ) {
    throw new Error('expected transcript phrases must contain 1–32 bounded nonempty strings')
  }
  const normalizedPhrases = expectedPhrases.map(normalizeRecognizedSpeech)
  if (
    normalizedPhrases.some((phrase) => !phrase) ||
    new Set(normalizedPhrases).size !== normalizedPhrases.length
  ) {
    throw new Error(
      'expected transcript phrases must remain nonempty and unique after normalization'
    )
  }

  const { texts, timingPolicy } = assertRecognizedTranscriptTiming(entry, boundary)
  const transcriptText = texts.join(' ')
  const textByteLength = Buffer.byteLength(transcriptText)
  if (textByteLength > 256 * 1_024) {
    throw new Error('recognized transcript exceeds the bounded text length')
  }
  const normalizedTranscript = normalizeRecognizedSpeech(transcriptText)
  const transcriptTokens = normalizedTranscript ? normalizedTranscript.split(' ') : []
  const matchedPhrases = []
  const missingPhrases = []
  const phraseMatches = []
  let searchTokenIndex = 0
  for (const [index, normalizedPhrase] of normalizedPhrases.entries()) {
    const phraseTokens = normalizedPhrase.split(' ')
    let match = null
    for (
      let candidateStart = searchTokenIndex;
      candidateStart + phraseTokens.length <= transcriptTokens.length;
      candidateStart += 1
    ) {
      const candidate = transcriptTokens
        .slice(candidateStart, candidateStart + phraseTokens.length)
        .join(' ')
      const editDistance = boundedRecognizedSpeechEditDistance(normalizedPhrase, candidate, 1)
      if (editDistance <= 1) {
        match = {
          phrase: expectedPhrases[index],
          normalizedExpected: normalizedPhrase,
          normalizedObserved: candidate,
          editDistance,
          tokenStart: candidateStart,
          tokenEnd: candidateStart + phraseTokens.length
        }
        break
      }
    }
    if (match) {
      matchedPhrases.push(expectedPhrases[index])
      phraseMatches.push(match)
      searchTokenIndex = match.tokenEnd
    } else {
      missingPhrases.push(expectedPhrases[index])
    }
  }
  return {
    ok: missingPhrases.length === 0,
    segmentCount: texts.length,
    textByteLength,
    transcriptSha256: crypto.createHash('sha256').update(transcriptText).digest('hex'),
    timingPolicy,
    matchPolicy: {
      ordered: true,
      contiguousTokenWindow: true,
      maximumCharacterEditDistancePerPhrase: 1
    },
    matchedPhrases,
    missingPhrases,
    phraseMatches
  }
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

async function persistStudioUiDriverRawReceipt(plan, requestPath, stdout) {
  const rawStdout = typeof stdout === 'string' ? stdout : String(stdout || '')
  const rawStdoutByteLength = Buffer.byteLength(rawStdout)
  const rawStdoutSha256 = crypto.createHash('sha256').update(rawStdout).digest('hex')
  if (rawStdoutByteLength > STUDIO_UI_DRIVER_RAW_RECEIPT_MAX_BYTES) {
    const failure = new Error(
      `Studio UI driver raw receipt exceeds ${STUDIO_UI_DRIVER_RAW_RECEIPT_MAX_BYTES} bytes`
    )
    failure.rawReceiptEvidence = {
      rawReceiptPath: null,
      rawStdoutSha256,
      rawStdoutByteLength
    }
    throw failure
  }
  const rawReceiptEvidence = {
    rawReceiptPath: null,
    rawStdoutSha256,
    rawStdoutByteLength
  }
  try {
    const rawReceiptDirectory = path.join(plan.artifactRoot, 'ui-driver-raw-receipts')
    await fsPromises.mkdir(rawReceiptDirectory, { recursive: true, mode: 0o700 })
    const rawReceiptPath = path.join(rawReceiptDirectory, `${path.basename(requestPath)}.stdout`)
    const rawReceiptTemp = `${rawReceiptPath}.tmp-${process.pid}`
    await fsPromises.writeFile(rawReceiptTemp, rawStdout, { encoding: 'utf8', mode: 0o600 })
    await fsPromises.rename(rawReceiptTemp, rawReceiptPath)
    return { ...rawReceiptEvidence, rawReceiptPath }
  } catch (error) {
    if (error && typeof error === 'object') {
      error.rawReceiptEvidence = rawReceiptEvidence
    }
    throw error
  }
}

function attachStudioUiDriverFailureEvidence(error, evidence) {
  const failure = error instanceof Error ? error : new Error(String(error))
  failure.studioUiDriverEvidence = {
    requestPath: evidence.requestPath,
    rawReceiptPath: evidence.rawReceiptPath,
    rawStdoutSha256: evidence.rawStdoutSha256,
    rawStdoutByteLength: evidence.rawStdoutByteLength,
    validatedReceiptPath: evidence.validatedReceiptPath,
    failureStage: evidence.failureStage
  }
  return failure
}

function coreAudioRouteHealthReceiptFailure(route) {
  if (!isRecord(route)) return 'routeHealth is absent'
  if (!Number.isSafeInteger(route.id) || route.id <= 0 || route.id > 0xffffffff) {
    return 'id is not a positive UInt32'
  }
  if (typeof route.name !== 'string' || !route.name.trim()) return 'name is empty'
  if (typeof route.uid !== 'string' || !route.uid.trim()) return 'uid is empty'
  if (
    typeof route.nominalSampleRate !== 'number' ||
    !Number.isFinite(route.nominalSampleRate) ||
    route.nominalSampleRate <= 0
  ) {
    return 'nominalSampleRate is not positive'
  }
  if (typeof route.alive !== 'boolean') return 'alive is not a boolean'
  if (typeof route.running !== 'boolean') return 'running is not a boolean'
  if (typeof route.hasOutputStream !== 'boolean') {
    return 'hasOutputStream is not a boolean'
  }
  if (!Number.isSafeInteger(route.outputStreamCount) || route.outputStreamCount < 0) {
    return 'outputStreamCount is not a non-negative exact integer'
  }
  if (!Number.isSafeInteger(route.outputChannelCount) || route.outputChannelCount < 0) {
    return 'outputChannelCount is not a non-negative exact integer'
  }
  const countsHaveOutput = route.outputStreamCount > 0 && route.outputChannelCount > 0
  if (route.hasOutputStream !== countsHaveOutput) {
    return 'hasOutputStream is inconsistent with raw output counts'
  }
  if (typeof route.muteSupported !== 'boolean') return 'muteSupported is not a boolean'
  if (route.muteSupported) {
    if (typeof route.muted !== 'boolean') return 'muted is absent for a supported property'
  } else if (route.muted !== undefined && route.muted !== null) {
    return 'muted is present for an unsupported property'
  }
  if (typeof route.volumeSupported !== 'boolean') return 'volumeSupported is not a boolean'
  if (route.volumeSupported) {
    if (
      typeof route.volume !== 'number' ||
      !Number.isFinite(route.volume) ||
      route.volume < 0 ||
      route.volume > 1
    ) {
      return 'volume is absent or outside the normalized range'
    }
  } else if (route.volume !== undefined && route.volume !== null) {
    return 'volume is present for an unsupported property'
  }
  return null
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
  const failureEvidence = {
    requestPath,
    rawReceiptPath: null,
    rawStdoutSha256: null,
    rawStdoutByteLength: null,
    validatedReceiptPath: null,
    failureStage: 'native-exec'
  }
  try {
    let result
    try {
      result = await runExec('/usr/bin/swift', [UI_DRIVER_PATH, requestPath], {
        timeoutMs: Math.max(60_000, longestAudioProbeSeconds * 1000 + 30_000)
      })
    } catch (error) {
      if (error && typeof error.stdout === 'string') {
        failureEvidence.failureStage = 'raw-receipt-write'
        Object.assign(
          failureEvidence,
          await persistStudioUiDriverRawReceipt(plan, requestPath, error.stdout)
        )
      }
      failureEvidence.failureStage = 'native-exec'
      throw error
    }

    failureEvidence.failureStage = 'raw-receipt-write'
    Object.assign(
      failureEvidence,
      await persistStudioUiDriverRawReceipt(plan, requestPath, result.stdout)
    )

    failureEvidence.failureStage = 'json-parse'
    let receipt
    try {
      receipt = JSON.parse(result.stdout)
    } catch {
      throw new Error('Studio UI driver did not return a JSON receipt')
    }
    failureEvidence.failureStage = 'receipt-schema'
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
      throw new Error(
        `Studio UI driver returned an invalid receipt: ${result.stdout.slice(0, 1000)}`
      )
    }
    for (const [index, action] of request.actions.entries()) {
      failureEvidence.failureStage = 'action-receipt'
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
          observed.playheadMaximumForwardAdvanceTicks !==
            action.playheadMaximumForwardAdvanceTicks ||
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
        failureEvidence.failureStage = 'tm1-validation'
        try {
          parseStudioTransportMutationText(observed.accessibilityValue)
        } catch (error) {
          throw new Error(
            `Studio UI driver transport-mutation receipt is invalid: ${error.message}`
          )
        }
      }
      if (action.type === 'read-workspace') {
        failureEvidence.failureStage = 'workspace-observation-validation'
        try {
          validateStudioWorkspaceObservation(observed.workspace, request.windowBounds)
        } catch (error) {
          throw new Error(
            `Studio UI driver workspace receipt is invalid: ${error.message}`
          )
        }
      }
      if (action.type === 'read-av-sync') {
        failureEvidence.failureStage = 'av-sync-validation'
        const peak = parseAvSyncPeakExport(observed.avSyncPeakValue)
        if (!peak.ok) {
          throw new Error(
            `Studio UI driver A/V sync peak receipt is invalid (expected av1): ${peak.reason}`
          )
        }
        const current = parseAvSyncCurrentExport(observed.avSyncCurrentValue)
        if (!current.ok) {
          throw new Error(`Studio UI driver A/V sync current receipt is invalid: ${current.reason}`)
        }
      }
      if (action.type === 'coreaudio-route-health') {
        failureEvidence.failureStage = 'coreaudio-route-health-validation'
        const routeFailure = coreAudioRouteHealthReceiptFailure(observed.routeHealth)
        if (routeFailure) {
          throw new Error(
            `Studio UI driver CoreAudio route-health receipt is invalid: ${routeFailure}`
          )
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
    failureEvidence.failureStage = 'validated-receipt-write'
    const receiptDirectory = path.join(plan.artifactRoot, 'ui-driver-receipts')
    await fsPromises.mkdir(receiptDirectory, { recursive: true, mode: 0o700 })
    const receiptPath = path.join(receiptDirectory, path.basename(requestPath))
    const receiptTemp = `${receiptPath}.tmp-${process.pid}`
    await fsPromises.writeFile(receiptTemp, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    await fsPromises.rename(receiptTemp, receiptPath)
    failureEvidence.validatedReceiptPath = receiptPath
    return {
      ...receipt,
      requestPath,
      rawReceiptPath: failureEvidence.rawReceiptPath,
      rawStdoutSha256: failureEvidence.rawStdoutSha256,
      rawStdoutByteLength: failureEvidence.rawStdoutByteLength,
      receiptPath
    }
  } catch (error) {
    if (error && isRecord(error.rawReceiptEvidence)) {
      Object.assign(failureEvidence, error.rawReceiptEvidence)
    }
    throw attachStudioUiDriverFailureEvidence(error, failureEvidence)
  }
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
    { id: 'reject', actions: ['r'], wait: { type: 'resolve_proposal', decision: 'reject' } }
  ]
}

function screenshotPaths(receipt) {
  return receipt.actions
    .filter((action) => action && action.type === 'screenshot')
    .map((action) => action.screenshotPath)
}

function readStudioJourneyCapture(capturePath) {
  const stat = fs.lstatSync(capturePath)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > STUDIO_JOURNEY_CAPTURE_MAX_BYTES
  ) {
    throw new Error('Studio journey capture is not a bounded safe regular file')
  }
  const bytes = fs.readFileSync(capturePath)
  return {
    bytes,
    image: PNG.sync.read(bytes)
  }
}

function studioReviewHostCaptureRegion(image, windowBounds, hostFrame) {
  const logicalX = Number(windowBounds?.x)
  const logicalY = Number(windowBounds?.y)
  const logicalWidth = Number(windowBounds?.width)
  const logicalHeight = Number(windowBounds?.height)
  if (
    !Number.isInteger(logicalWidth) ||
    !Number.isInteger(logicalHeight) ||
    logicalWidth <= 0 ||
    logicalHeight <= 0 ||
    !Number.isFinite(logicalX) ||
    !Number.isFinite(logicalY)
  ) {
    throw new Error('Studio journey capture window bounds are invalid')
  }
  const captureWidth = logicalWidth * 2
  const captureHeight = logicalHeight * 2
  if (image.width !== captureWidth || image.height !== captureHeight) {
    throw new Error('Studio journey capture does not match the exact 2x window bounds')
  }
  if (
    !isRecord(hostFrame) ||
    !['x', 'y', 'width', 'height'].every(
      (key) => typeof hostFrame[key] === 'number' && Number.isFinite(hostFrame[key])
    ) ||
    hostFrame.width <= 0 ||
    hostFrame.height <= 0
  ) {
    throw new Error('Studio review host frame is not a bounded finite rectangle')
  }
  const localX = hostFrame.x - logicalX
  const localY = hostFrame.y - logicalY
  const clipX = Math.max(0, localX)
  const clipY = Math.max(0, localY)
  const clipRight = Math.min(logicalWidth, localX + hostFrame.width)
  const clipBottom = Math.min(logicalHeight, localY + hostFrame.height)
  const clipWidth = clipRight - clipX
  const clipHeight = clipBottom - clipY
  if (clipWidth <= 0 || clipHeight <= 0) {
    throw new Error('Studio review host frame is outside the immutable window bounds')
  }
  // The Timeline host is always a strict sub-region of the workspace window
  // (browser/inspector panes beside it, chrome above it, transcript/timeline/
  // proposal-bar strip below it), so a clip that fills the entire window is a
  // materiality violation, not a legitimate one-window layout: it would let
  // Source-pane changes count as Review evidence. Reject rather than crop it.
  if (clipX <= 0 && clipY <= 0 && clipWidth >= logicalWidth && clipHeight >= logicalHeight) {
    throw new Error('Studio review host capture region must not equal the whole window')
  }
  const x = Math.round(clipX * 2)
  const y = Math.round(clipY * 2)
  const width = Math.round(clipWidth * 2)
  const height = Math.round(clipHeight * 2)
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > image.width || y + height > image.height) {
    throw new Error('Studio review host capture region is outside the screenshot')
  }
  return { x, y, width, height }
}

// The transcript/HUD overlay is a fixed-height band along the bottom edge of
// the live Source host, not the whole window. Deliberately duplicates
// studioReviewHostCaptureRegion's clip/scale math (own error text) rather
// than sharing it, so a change to one host-relative crop cannot silently
// alter the other's already-accepted behavior.
function studioSourceHostOverlayCaptureRegion(image, windowBounds, hostFrame) {
  const logicalX = Number(windowBounds?.x)
  const logicalY = Number(windowBounds?.y)
  const logicalWidth = Number(windowBounds?.width)
  const logicalHeight = Number(windowBounds?.height)
  if (
    !Number.isInteger(logicalWidth) ||
    !Number.isInteger(logicalHeight) ||
    logicalWidth <= 0 ||
    logicalHeight <= 0 ||
    !Number.isFinite(logicalX) ||
    !Number.isFinite(logicalY)
  ) {
    throw new Error('Studio journey capture window bounds are invalid')
  }
  const captureWidth = logicalWidth * 2
  const captureHeight = logicalHeight * 2
  if (image.width !== captureWidth || image.height !== captureHeight) {
    throw new Error('Studio journey capture does not match the exact 2x window bounds')
  }
  if (
    !isRecord(hostFrame) ||
    !['x', 'y', 'width', 'height'].every(
      (key) => typeof hostFrame[key] === 'number' && Number.isFinite(hostFrame[key])
    ) ||
    hostFrame.width <= 0 ||
    hostFrame.height <= 0
  ) {
    throw new Error('Studio source host frame is not a bounded finite rectangle')
  }
  const localX = hostFrame.x - logicalX
  const localY = hostFrame.y - logicalY
  const clipX = Math.max(0, localX)
  const clipY = Math.max(0, localY)
  const clipRight = Math.min(logicalWidth, localX + hostFrame.width)
  const clipBottom = Math.min(logicalHeight, localY + hostFrame.height)
  const clipWidth = clipRight - clipX
  const clipHeight = clipBottom - clipY
  if (clipWidth <= 0 || clipHeight <= 0) {
    throw new Error('Studio source host frame is outside the immutable window bounds')
  }
  if (clipX <= 0 && clipY <= 0 && clipWidth >= logicalWidth && clipHeight >= logicalHeight) {
    throw new Error('Studio source host capture region must not equal the whole window')
  }
  const hostX = Math.round(clipX * 2)
  const hostY = Math.round(clipY * 2)
  const hostWidth = Math.round(clipWidth * 2)
  const hostHeight = Math.round(clipHeight * 2)
  if (
    hostX < 0 ||
    hostY < 0 ||
    hostWidth <= 0 ||
    hostHeight <= 0 ||
    hostX + hostWidth > image.width ||
    hostY + hostHeight > image.height
  ) {
    throw new Error('Studio source host capture region is outside the screenshot')
  }
  const overlayHeight = STUDIO_JOURNEY_OVERLAY_POINTS * 2
  if (overlayHeight <= 0 || overlayHeight > hostHeight) {
    throw new Error('Studio source host overlay band does not fit the live host frame')
  }
  return {
    x: hostX,
    y: hostY + hostHeight - overlayHeight,
    width: hostWidth,
    height: overlayHeight
  }
}

function studioJourneyCaptureRegion(image, windowBounds, region, reviewHostFrame = null) {
  if (region === 'review-host') {
    return studioReviewHostCaptureRegion(image, windowBounds, reviewHostFrame)
  }
  if (region === 'source-host-overlay') {
    return studioSourceHostOverlayCaptureRegion(image, windowBounds, reviewHostFrame)
  }
  const logicalWidth = Number(windowBounds?.width)
  const logicalHeight = Number(windowBounds?.height)
  if (
    !Number.isInteger(logicalWidth) ||
    !Number.isInteger(logicalHeight) ||
    logicalWidth <= 0 ||
    logicalHeight <= 0
  ) {
    throw new Error('Studio journey capture window bounds are invalid')
  }
  const captureWidth = logicalWidth * 2
  const captureHeight = logicalHeight * 2
  if (image.width !== captureWidth || image.height !== captureHeight) {
    throw new Error('Studio journey capture does not match the exact 2x window bounds')
  }
  const logicalVideoHeight = Math.round((logicalWidth * 9) / 16)
  const logicalTitleBarHeight = logicalHeight - logicalVideoHeight
  if (logicalTitleBarHeight < 20 || logicalTitleBarHeight > 40) {
    throw new Error('Studio journey capture is outside the bounded Companion geometry')
  }
  const videoTop = logicalTitleBarHeight * 2
  const videoBottom = videoTop + logicalVideoHeight * 2
  const materialBottom = videoBottom - STUDIO_JOURNEY_OVERLAY_POINTS * 2
  if (materialBottom <= videoTop || videoBottom > image.height) {
    throw new Error('Studio journey capture comparison region is invalid')
  }
  if (region === 'material') {
    return { x: 0, y: videoTop, width: image.width, height: materialBottom - videoTop }
  }
  if (region === 'timeline') {
    return { x: 0, y: materialBottom, width: image.width, height: videoBottom - materialBottom }
  }
  throw new Error('Studio journey capture comparison region is unsupported')
}

function compareStudioJourneyCaptures(beforePath, afterPath, windowBounds, region, reviewHostFrame = null) {
  const before = readStudioJourneyCapture(beforePath)
  const after = readStudioJourneyCapture(afterPath)
  if (before.image.width !== after.image.width || before.image.height !== after.image.height) {
    throw new Error('Studio journey captures do not have identical dimensions')
  }
  const isMaterialRegion = region === 'material' || region === 'review-host'
  const comparisonRegion = studioJourneyCaptureRegion(before.image, windowBounds, region, reviewHostFrame)
  const afterRegion = studioJourneyCaptureRegion(after.image, windowBounds, region, reviewHostFrame)
  if (JSON.stringify(comparisonRegion) !== JSON.stringify(afterRegion)) {
    throw new Error('Studio journey capture comparison regions do not agree')
  }

  let changedPixelCount = 0
  let maximumChannelDelta = 0
  let channelDeltaSum = 0
  let minimumChangedX = Number.POSITIVE_INFINITY
  let maximumChangedX = Number.NEGATIVE_INFINITY
  let minimumChangedY = Number.POSITIVE_INFINITY
  let maximumChangedY = Number.NEGATIVE_INFINITY
  const materialCellCounts = isMaterialRegion
    ? Array(STUDIO_JOURNEY_MATERIAL_GRID_COLUMNS * STUDIO_JOURNEY_MATERIAL_GRID_ROWS).fill(0)
    : null
  for (let y = comparisonRegion.y; y < comparisonRegion.y + comparisonRegion.height; y += 1) {
    for (let x = comparisonRegion.x; x < comparisonRegion.x + comparisonRegion.width; x += 1) {
      const offset = (y * before.image.width + x) * 4
      let pixelDelta = 0
      for (let channel = 0; channel < 3; channel += 1) {
        const delta = Math.abs(
          before.image.data[offset + channel] - after.image.data[offset + channel]
        )
        pixelDelta = Math.max(pixelDelta, delta)
        maximumChannelDelta = Math.max(maximumChannelDelta, delta)
        channelDeltaSum += delta
      }
      if (pixelDelta > STUDIO_JOURNEY_PIXEL_DELTA) {
        changedPixelCount += 1
        minimumChangedX = Math.min(minimumChangedX, x)
        maximumChangedX = Math.max(maximumChangedX, x)
        minimumChangedY = Math.min(minimumChangedY, y)
        maximumChangedY = Math.max(maximumChangedY, y)
        if (materialCellCounts) {
          const column = Math.min(
            STUDIO_JOURNEY_MATERIAL_GRID_COLUMNS - 1,
            Math.floor(
              ((x - comparisonRegion.x) * STUDIO_JOURNEY_MATERIAL_GRID_COLUMNS) /
                comparisonRegion.width
            )
          )
          const row = Math.min(
            STUDIO_JOURNEY_MATERIAL_GRID_ROWS - 1,
            Math.floor(
              ((y - comparisonRegion.y) * STUDIO_JOURNEY_MATERIAL_GRID_ROWS) /
                comparisonRegion.height
            )
          )
          materialCellCounts[row * STUDIO_JOURNEY_MATERIAL_GRID_COLUMNS + column] += 1
        }
      }
    }
  }
  const pixelCount = comparisonRegion.width * comparisonRegion.height
  const changedPixelFraction = changedPixelCount / pixelCount
  const gridCellPixelCount = Math.ceil(
    pixelCount / (STUDIO_JOURNEY_MATERIAL_GRID_COLUMNS * STUDIO_JOURNEY_MATERIAL_GRID_ROWS)
  )
  const minimumChangedPixelsPerOccupiedCell = Math.ceil(
    gridCellPixelCount / STUDIO_JOURNEY_MATERIAL_POLICY.occupiedCellPixelDivisor
  )
  const occupiedCellCount = materialCellCounts
    ? materialCellCounts.filter((count) => count >= minimumChangedPixelsPerOccupiedCell).length
    : 0
  const horizontalSpanFraction =
    changedPixelCount > 0 ? (maximumChangedX - minimumChangedX + 1) / comparisonRegion.width : 0
  const verticalSpanFraction =
    changedPixelCount > 0 ? (maximumChangedY - minimumChangedY + 1) / comparisonRegion.height : 0
  const spatialSpread = {
    gridColumns: STUDIO_JOURNEY_MATERIAL_GRID_COLUMNS,
    gridRows: STUDIO_JOURNEY_MATERIAL_GRID_ROWS,
    minimumChangedPixelsPerOccupiedCell,
    occupiedCellCount,
    horizontalSpanFraction,
    verticalSpanFraction
  }
  if (isMaterialRegion) {
    if (
      changedPixelFraction < STUDIO_JOURNEY_MATERIAL_MIN_CHANGED_FRACTION ||
      occupiedCellCount < STUDIO_JOURNEY_MATERIAL_MIN_OCCUPIED_CELLS ||
      horizontalSpanFraction < STUDIO_JOURNEY_MATERIAL_MIN_SPAN_FRACTION ||
      verticalSpanFraction < STUDIO_JOURNEY_MATERIAL_MIN_SPAN_FRACTION
    ) {
      throw new Error(
        `Studio journey material region did not show spatially distributed material change: ${changedPixelCount}/${pixelCount} pixels across ${occupiedCellCount} cells`
      )
    }
  } else if (
    changedPixelCount < STUDIO_JOURNEY_TIMELINE_MIN_CHANGED_PIXELS ||
    changedPixelFraction < STUDIO_JOURNEY_TIMELINE_MIN_CHANGED_FRACTION
  ) {
    throw new Error(
      `Studio journey ${region} region did not materially change: ${changedPixelCount}/${pixelCount} pixels`
    )
  }
  return {
    ok: true,
    region,
    beforeSha256: crypto.createHash('sha256').update(before.bytes).digest('hex'),
    afterSha256: crypto.createHash('sha256').update(after.bytes).digest('hex'),
    pixelCount,
    changedPixelCount,
    changedPixelFraction,
    ...(isMaterialRegion ? { spatialSpread } : {}),
    meanAbsoluteChannelDelta: channelDeltaSum / (pixelCount * 3),
    maximumChannelDelta,
    threshold: {
      channelDelta: STUDIO_JOURNEY_PIXEL_DELTA,
      ...(isMaterialRegion
        ? {
            minimumChangedFraction: STUDIO_JOURNEY_MATERIAL_MIN_CHANGED_FRACTION,
            minimumOccupiedCells: STUDIO_JOURNEY_MATERIAL_MIN_OCCUPIED_CELLS,
            minimumSpanFraction: STUDIO_JOURNEY_MATERIAL_MIN_SPAN_FRACTION,
            policy: STUDIO_JOURNEY_MATERIAL_POLICY
          }
        : {
            minimumChangedPixels: STUDIO_JOURNEY_TIMELINE_MIN_CHANGED_PIXELS,
            minimumChangedFraction: STUDIO_JOURNEY_TIMELINE_MIN_CHANGED_FRACTION
          })
    }
  }
}

function studioProposalInsertionEvidence(entry, boundary) {
  const proposal = entry?.op?.proposal
  const edit = proposal?.op
  const rationals = [edit?.sourceIn, edit?.sourceOut, edit?.at]
  if (
    !isRecord(boundary) ||
    typeof boundary.assetId !== 'string' ||
    !boundary.assetId ||
    !Number.isSafeInteger(boundary.durationSeconds) ||
    boundary.durationSeconds <= 0
  ) {
    throw new Error('Studio journey proposal requires an opened asset and known fixture duration')
  }
  if (
    !isRecord(proposal) ||
    typeof proposal.proposalId !== 'string' ||
    !proposal.proposalId ||
    !isRecord(edit) ||
    edit.type !== 'insert_range' ||
    typeof edit.assetId !== 'string' ||
    !edit.assetId ||
    rationals.some(
      (value) =>
        !isRecord(value) ||
        !Number.isSafeInteger(value.n) ||
        !Number.isSafeInteger(value.d) ||
        value.d <= 0
    ) ||
    edit.sourceIn.d !== edit.sourceOut.d ||
    edit.sourceIn.d !== edit.at.d ||
    edit.sourceIn.n < 0 ||
    edit.sourceOut.n <= edit.sourceIn.n ||
    edit.at.n < 0
  ) {
    throw new Error('Studio journey proposal does not contain one exact bounded insert_range')
  }
  if (edit.assetId !== boundary.assetId) {
    throw new Error('Studio journey proposal does not reference the exact opened asset')
  }
  const durationBoundTicks = BigInt(boundary.durationSeconds) * BigInt(edit.at.d)
  if (
    BigInt(edit.sourceIn.n) > durationBoundTicks ||
    BigInt(edit.sourceOut.n) > durationBoundTicks ||
    BigInt(edit.at.n) > durationBoundTicks
  ) {
    throw new Error('Studio journey proposal exceeds the known fixture duration')
  }
  return {
    proposalId: proposal.proposalId,
    assetId: edit.assetId,
    insertionTicks: edit.at.n,
    timebase: edit.at.d,
    sourceInTicks: edit.sourceIn.n,
    sourceOutTicks: edit.sourceOut.n,
    durationSeconds: boundary.durationSeconds,
    durationBoundTicks: durationBoundTicks.toString()
  }
}

function exactDriverAction(receipt, type) {
  const matches = Array.isArray(receipt?.actions)
    ? receipt.actions.filter((action) => action?.type === type)
    : []
  if (matches.length !== 1) {
    throw new Error(`Studio journey expected exactly one ${type} action receipt`)
  }
  return matches[0]
}

function adjudicateSharedStudioClock(sourceReceipt, reviewReceipt) {
  const source = exactDriverAction(sourceReceipt, 'step-playhead-frame')
  const review = exactDriverAction(reviewReceipt, 'step-playhead-frame')
  if (
    source.playheadStepFrames !== 1 ||
    review.playheadStepFrames !== -1 ||
    review.playheadTicksBefore !== source.observedPlayheadTicks ||
    review.observedPlayheadTicks !== source.playheadTicksBefore
  ) {
    throw new Error('Studio Source and Review playhead steps do not prove one shared clock')
  }
  return {
    ok: true,
    sourceBeforeTicks: source.playheadTicksBefore,
    sourceAfterTicks: source.observedPlayheadTicks,
    reviewBeforeTicks: review.playheadTicksBefore,
    reviewAfterTicks: review.observedPlayheadTicks
  }
}

function adjudicatePlaybackRoundTrip(receipt) {
  const actions = Array.isArray(receipt?.actions)
    ? receipt.actions.filter((action) => action?.type === 'press-playback')
    : []
  if (
    actions.length !== 2 ||
    actions[0].playbackValueBefore !== 'paused' ||
    actions[0].playbackValueAfter !== 'playing' ||
    actions[1].playbackValueBefore !== 'playing' ||
    actions[1].playbackValueAfter !== 'paused'
  ) {
    throw new Error('Studio Playback actions do not prove one paused/playing round trip')
  }
  return {
    ok: true,
    accessibilityLabel: 'Playback',
    accessibilityAction: 'AXPress',
    initial: 'paused',
    intermediate: 'playing',
    final: 'paused'
  }
}

async function driveStudioUiJourney(plan, target, adapters = {}) {
  const waitJournal = adapters.waitForJournalOperation || waitForStudioJournalOperation
  const runDriver = adapters.runUiDriver || runStudioUiDriver
  const compareCaptures = adapters.compareCaptures || compareStudioJourneyCaptures
  const journeyTarget = resolveStudioWorkspaceWindow(target)
  const windowBounds = assertSafeUiDriverTarget(journeyTarget).bounds
  const waitForWorkspaceReview = () =>
    waitFor({
      label: 'exact visible Studio Review workspace presentation',
      timeoutMs: 10_000,
      intervalMs: 100,
      probe: async () => {
        const receipt = await runDriver(plan, journeyTarget, [{ type: 'read-workspace' }], {
          ...(adapters.driverAdapters || {}),
          inputDelivery: 'background-observation-only',
          allowForegroundInput: false
        })
        const workspace = readWorkspaceObservationFromReceipt(receipt, windowBounds)
        if (!studioWorkspaceReviewPresented(workspace)) {
          return null
        }
        return workspace
      }
    })
  const driverReceipts = []
  const screenshots = []
  const drive = async (actions, driverTarget = journeyTarget) => {
    const normalizedActions = actions.map((action) =>
      typeof action === 'string' ? { type: 'key', key: action } : action
    )
    const hasInteractiveActions = normalizedActions.some(
      (action) => action.type === 'key' || action.type === 'click'
    )
    const receipt = await runDriver(plan, driverTarget, normalizedActions, {
      ...(adapters.driverAdapters || {}),
      inputDelivery: hasInteractiveActions
        ? 'foreground-global-explicit'
        : 'background-observation-only',
      allowForegroundInput: hasInteractiveActions
    })
    driverReceipts.push(receipt)
    screenshots.push(...screenshotPaths(receipt))
    return receipt
  }
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
  let recognition = null
  if (target.speechFixture) {
    recognition = adjudicateRecognizedTranscript(transcript, target.speechFixture.expectedPhrases, {
      assetId,
      durationSeconds: target.speechFixture.durationSeconds,
      frameRate: target.speechFixture.frameRate
    })
    if (!recognition.ok) {
      throw new Error(
        `Studio recognized transcript is not the generated fixture passage; missing phrases: ${recognition.missingPhrases.join(', ')}`
      )
    }
    recognition = {
      ...recognition,
      fixtureManifestPath: target.speechFixture.manifestPath,
      fixtureOutputSha256: target.speechFixture.outputSha256,
      provenanceNote: target.speechFixture.provenanceNote
    }
  }
  // The transcript-band/selected comparison crops the live Source host's
  // overlay band, not the whole window, so it needs the host's real AX frame
  // before the first screenshot rather than assuming Source is presented.
  const initialWorkspaceReceipt = await runDriver(
    plan,
    journeyTarget,
    [{ type: 'read-workspace' }],
    {
      ...(adapters.driverAdapters || {}),
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false
    }
  )
  const initialWorkspace = readWorkspaceObservationFromReceipt(initialWorkspaceReceipt, windowBounds)
  if (
    !isRecord(initialWorkspace.sourceRoute) ||
    initialWorkspace.sourceRoute.value !== 'selected' ||
    !isRecord(initialWorkspace.sourceHost) ||
    initialWorkspace.sourceHost.visible !== true
  ) {
    throw new Error('Studio UI journey requires Source selected and visible at journey start')
  }
  const sourceHostFrame = initialWorkspace.sourceHost.frame
  await drive([
    {
      type: 'press-playback',
      playbackValueBefore: 'playing',
      playbackValueAfter: 'paused'
    }
  ])
  let afterRevision = transcript.revision
  const transcriptBandCapture = await drive([{ type: 'screenshot', name: 'transcript-band' }])
  await drive(['tab'])
  const transcriptSelectedCapture = await drive([
    { type: 'screenshot', name: 'transcript-selected' }
  ])
  await drive(['bracket-left'])
  await drive([{ type: 'screenshot', name: 'trim-pending' }])
  await drive(['return'])
  await drive([{ type: 'screenshot', name: 'proposal-sent' }])
  const transcriptBandScreenshots = screenshotPaths(transcriptBandCapture)
  const transcriptSelectedScreenshots = screenshotPaths(transcriptSelectedCapture)
  if (transcriptBandScreenshots.length !== 1 || transcriptSelectedScreenshots.length !== 1) {
    throw new Error('Studio transcript journey did not capture both exact selection states')
  }
  const transcriptPixels = compareCaptures(
    transcriptBandScreenshots[0],
    transcriptSelectedScreenshots[0],
    windowBounds,
    'source-host-overlay',
    sourceHostFrame
  )
  const acceptedProposal = await waitJournal(plan, { type: 'propose_edit' }, { afterRevision })
  const proposalBoundary = {
    assetId,
    durationSeconds: target.speechFixture?.durationSeconds
  }
  const acceptedProposalEvidence = studioProposalInsertionEvidence(
    acceptedProposal,
    proposalBoundary
  )
  const acceptedProposalId = acceptedProposalEvidence.proposalId
  afterRevision = acceptedProposal.revision
  await drive([{ type: 'screenshot', name: 'ghost' }], journeyTarget)
  await drive(['w'], journeyTarget)
  const acceptedWorkspace = await waitForWorkspaceReview()
  const acceptedReviewHostFrame = acceptedWorkspace.timelineHost.frame
  await drive(
    [
      {
        type: 'set-playhead-ticks',
        playheadTicks: acceptedProposalEvidence.insertionTicks,
        playheadToleranceTicks: 0,
        playheadMaximumForwardAdvanceTicks: 0
      }
    ],
    journeyTarget
  )
  const currentCapture = await drive(
    [{ type: 'screenshot', name: 'current' }],
    journeyTarget
  )
  await drive(['v'], journeyTarget)
  await drive(
    [
      {
        type: 'set-playhead-ticks',
        playheadTicks: acceptedProposalEvidence.insertionTicks,
        playheadToleranceTicks: 0,
        playheadMaximumForwardAdvanceTicks: 0
      }
    ],
    journeyTarget
  )
  const proposedCapture = await drive(
    [{ type: 'screenshot', name: 'proposed' }],
    journeyTarget
  )
  const currentScreenshots = screenshotPaths(currentCapture)
  const proposedScreenshots = screenshotPaths(proposedCapture)
  if (currentScreenshots.length !== 1 || proposedScreenshots.length !== 1) {
    throw new Error('Studio Current/Proposed journey did not capture both exact states')
  }
  const currentProposedPixels = compareCaptures(
    currentScreenshots[0],
    proposedScreenshots[0],
    windowBounds,
    'review-host',
    acceptedReviewHostFrame
  )
  const sourceStep = await drive(
    [{ type: 'step-playhead-frame', playheadStepFrames: 1 }],
    journeyTarget
  )
  const reviewStep = await drive(
    [{ type: 'step-playhead-frame', playheadStepFrames: -1 }],
    journeyTarget
  )
  const sharedClock = adjudicateSharedStudioClock(sourceStep, reviewStep)
  await drive(['a', { type: 'screenshot', name: 'accept-sent' }], journeyTarget)
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

  await drive(['w', 'tab', 'bracket-right', 'return'], journeyTarget)
  const rejectedProposal = await waitJournal(plan, { type: 'propose_edit' }, { afterRevision })
  const rejectedProposalEvidence = studioProposalInsertionEvidence(
    rejectedProposal,
    proposalBoundary
  )
  const rejectedProposalId = rejectedProposalEvidence.proposalId
  if (rejectedProposalId === acceptedProposalId) {
    throw new Error('Studio accept and reject journeys reused one proposal identity')
  }
  afterRevision = rejectedProposal.revision
  await drive(['w'], journeyTarget)
  const rejectedWorkspace = await waitForWorkspaceReview()
  const rejectedReviewHostFrame = rejectedWorkspace.timelineHost.frame
  // ADJUDICATE THE GHOST, DO NOT MERELY PHOTOGRAPH IT.
  //
  // Both of these screenshots were previously captured and then discarded, so
  // proposal ghost rendering had NO adjudication at all: a Review route that
  // drew no ghost, or drew one that rejection failed to remove, produced the
  // same ok:true journey as a correct one. The pair is adjacent in time on one
  // target, so the only difference between them is the live proposal itself.
  const ghostRejectCapture = await drive(
    [{ type: 'screenshot', name: 'ghost-reject' }],
    journeyTarget
  )
  const rejectSentCapture = await drive(
    ['r', { type: 'screenshot', name: 'reject-sent' }],
    journeyTarget
  )
  const ghostRejectScreenshots = screenshotPaths(ghostRejectCapture)
  const rejectSentScreenshots = screenshotPaths(rejectSentCapture)
  if (ghostRejectScreenshots.length !== 1 || rejectSentScreenshots.length !== 1) {
    throw new Error('Studio proposal ghost journey did not capture both exact rejection states')
  }
  const ghostRejectPixels = compareCaptures(
    ghostRejectScreenshots[0],
    rejectSentScreenshots[0],
    windowBounds,
    'review-host',
    rejectedReviewHostFrame
  )
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
  const playbackRoundTripReceipt = await drive([
    {
      type: 'press-playback',
      playbackValueBefore: 'paused',
      playbackValueAfter: 'playing'
    },
    {
      type: 'press-playback',
      playbackValueBefore: 'playing',
      playbackValueAfter: 'paused'
    }
  ])
  const playbackRoundTrip = adjudicatePlaybackRoundTrip(playbackRoundTripReceipt)

  return {
    schemaVersion: 1,
    kind: 'taskwraith-studio-ui-journey-receipt',
    ok: true,
    transcript: {
      revision: transcript.revision,
      ...(recognition ? { recognition } : {})
    },
    accepted: {
      proposalId: acceptedProposalId,
      proposalRevision: acceptedProposal.revision,
      resolutionRevision: acceptedResolution.revision,
      proposal: acceptedProposalEvidence
    },
    rejected: {
      proposalId: rejectedProposalId,
      proposalRevision: rejectedProposal.revision,
      resolutionRevision: rejectedResolution.revision,
      proposal: rejectedProposalEvidence
    },
    finalRevision: afterRevision,
    adjudication: {
      transcriptPixels,
      currentProposedPixels,
      ghostRejectPixels,
      sharedClock,
      playbackRoundTrip,
      workspace: {
        accepted: acceptedWorkspace,
        rejected: rejectedWorkspace
      }
    },
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

function boundedAcceptanceFailure(error) {
  const failure = error instanceof Error ? error : new Error(String(error))
  const driverEvidence = isRecord(failure.studioUiDriverEvidence)
    ? failure.studioUiDriverEvidence
    : null
  return {
    name: String(failure.name || 'Error').slice(0, 128),
    message: String(failure.message || failure).slice(0, DETACHED_ERROR_MAX_CHARS),
    stage:
      typeof driverEvidence?.failureStage === 'string'
        ? driverEvidence.failureStage.slice(0, 128)
        : 'acceptance',
    driverEvidence
  }
}

function studioAcceptanceFailureArtifactCandidates(evidence) {
  const driverEvidence = isRecord(evidence?.failure?.driverEvidence)
    ? evidence.failure.driverEvidence
    : null
  return [
    { name: 'fixtureManifest', path: evidence?.speechFixture?.manifestPath ?? null },
    { name: 'generatedFixture', path: evidence?.speechFixture?.outputPath ?? null },
    { name: 'openedMedia', path: evidence?.asset?.assetPath ?? null },
    { name: 'journal', path: evidence?.durable?.journalPath ?? evidence?.journalPath ?? null },
    { name: 'driverRequest', path: driverEvidence?.requestPath ?? null },
    { name: 'driverRaw', path: driverEvidence?.rawReceiptPath ?? null },
    { name: 'driverValidated', path: driverEvidence?.validatedReceiptPath ?? null },
    { name: 'watchdogReceipt', path: evidence?.watchdogReceiptPath ?? null }
  ]
}

async function measureStudioAcceptanceFailureArtifacts(plan, candidates) {
  if (!Array.isArray(candidates) || candidates.length > 16) {
    throw new Error('Studio acceptance failure artifact list is not bounded')
  }
  const artifactRoot = path.resolve(plan.artifactRoot)
  const canonicalArtifactRoot = await fsPromises.realpath(artifactRoot)
  const references = {}
  const seenNames = new Set()
  for (const candidate of candidates) {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== 'string' ||
      !/^[a-z][a-zA-Z0-9]{0,63}$/.test(candidate.name) ||
      (candidate.path !== null &&
        candidate.path !== undefined &&
        typeof candidate.path !== 'string') ||
      seenNames.has(candidate.name)
    ) {
      throw new Error('Studio acceptance failure artifact descriptor is invalid')
    }
    seenNames.add(candidate.name)
    if (candidate.path === null || candidate.path === undefined) {
      references[candidate.name] = { path: null, present: false }
      continue
    }
    const artifactPath = path.resolve(candidate.path)
    const relative = path.relative(artifactRoot, artifactPath)
    const canonicalRelativeCandidate = path.relative(canonicalArtifactRoot, artifactPath)
    const lexicallyInside =
      Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
    const canonicallyPrefixed =
      Boolean(canonicalRelativeCandidate) &&
      !canonicalRelativeCandidate.startsWith('..') &&
      !path.isAbsolute(canonicalRelativeCandidate)
    if (!lexicallyInside && !canonicallyPrefixed) {
      throw new Error(`Studio acceptance failure artifact ${candidate.name} escaped its root`)
    }
    let stat
    try {
      stat = await fsPromises.lstat(artifactPath)
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        references[candidate.name] = { path: artifactPath, present: false }
        continue
      }
      throw error
    }
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size < 0 ||
      stat.size > STUDIO_FAILURE_ARTIFACT_MAX_BYTES
    ) {
      throw new Error(
        `Studio acceptance failure artifact ${candidate.name} is not a bounded regular file`
      )
    }
    const canonicalArtifactPath = await fsPromises.realpath(artifactPath)
    const canonicalRelative = path.relative(canonicalArtifactRoot, canonicalArtifactPath)
    if (
      !canonicalRelative ||
      canonicalRelative.startsWith('..') ||
      path.isAbsolute(canonicalRelative)
    ) {
      throw new Error(
        `Studio acceptance failure artifact ${candidate.name} resolves outside its root`
      )
    }
    references[candidate.name] = {
      path: artifactPath,
      present: true,
      byteLength: stat.size,
      sha256: await sha256Hex(artifactPath)
    }
  }
  return references
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
  const measureCustody = adapters.measureCustody || measureStudioAcceptanceCustody
  const custodyExpected = adapters.custodyExpected || STUDIO_ACCEPTANCE_EXPECTED_CUSTODY_PINS
  const custodySource = assertStudioAcceptanceCustody(
    await measureCustody(
      {
        phase: 'source',
        repoRoot: plan.repoRoot,
        env: process.env,
        buildReady: false
      },
      adapters.custodyAdapters || {}
    ),
    { phase: 'source', expected: custodyExpected }
  )

  await fsPromises.mkdir(plan.home, { recursive: true, mode: 0o700 })
  await fsPromises.mkdir(plan.artifactRoot, { recursive: true, mode: 0o700 })
  const providerGuards = await (
    adapters.materializeProviderGuards || materializeIsolatedProviderGuards
  )({ home: plan.home })
  plan.spawnPlan.env.TASKWRAITH_GROK_USAGE_BINARY_OVERRIDE = providerGuards.grokBinaryPath
  const speechFixture =
    args.generateSpeechFixture === true
      ? await (adapters.generateSpeechFixture || generateAcceptanceSpeechFixture)(
          { artifactRoot: plan.artifactRoot },
          adapters.speechFixtureAdapters || {}
        )
      : null
  const asset = await materializeOwnedMedia({
    mediaPath: speechFixture ? speechFixture.outputPath : args.mediaPath,
    mimeType: speechFixture ? speechFixture.mimeType : args.mimeType,
    userDataPath: plan.profile.userDataPath
  })
  const speechFixtureCustody = speechFixture
    ? await assertGeneratedSpeechFixtureCustody(speechFixture, asset, plan.artifactRoot)
    : null
  const custodyFixture = {
    sha256:
      speechFixtureCustody?.outputSha256 ?? Buffer.from(asset.sha256, 'base64url').toString('hex'),
    byteLength: asset.byteLength,
    provenance: speechFixtureCustody ? 'generated-speech-fixture' : 'owner-supplied-media'
  }

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
  const custodyBefore = assertStudioAcceptanceCustody(
    await measureCustody(
      {
        phase: 'before-run',
        repoRoot: plan.repoRoot,
        env: process.env,
        buildReady: true,
        fixturePath: asset.assetPath
      },
      adapters.custodyAdapters || {}
    ),
    {
      phase: 'before-run',
      sourceCustody: custodySource,
      fixture: custodyFixture,
      expected: custodyExpected
    }
  )

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
  let openResult = null
  let durable = null
  let companion = null
  let companionCustody = null
  let window = null
  let journey = null
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
    openResult = await (adapters.invokeStudioOpen || invokeAuthorizedStudioOpen)(renderer, asset)
    durable = await (adapters.verifyDurableOpen || verifyDurableOpen)(plan, asset)
    companion = await (adapters.findCompanion || findStudioCompanion)(
      session.pid,
      adapters.processAdapters || {}
    )
    companionCustody = assertStudioCompanionMatchesCustody(companion, custodyBefore, plan.repoRoot)
    window = await (adapters.probeWindow || probeNativeWindow)(
      companion.pid,
      adapters.windowAdapters || {}
    )
    journey = await (adapters.driveUiJourney || driveStudioUiJourney)(
      plan,
      {
        companion,
        electronPgid: session.pgid || null,
        window,
        asset,
        speechFixture
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
      speechFixture,
      speechFixtureCustody,
      custodyFixture,
      custodySource,
      custodyBefore,
      companionCustody,
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

  let custodyAfter = null
  let custodyError = null
  try {
    custodyAfter = assertStudioAcceptanceCustody(
      await measureCustody(
        {
          phase: 'after-run',
          repoRoot: plan.repoRoot,
          env: process.env,
          buildReady: true,
          fixturePath: asset.assetPath
        },
        adapters.custodyAdapters || {}
      ),
      {
        phase: 'after-run',
        sourceCustody: custodySource,
        custodyBefore,
        fixture: custodyFixture,
        expected: custodyExpected
      }
    )
  } catch (error) {
    custodyError = error
  }

  const failures = [acceptanceError, rendererCloseError, watchdogError, custodyError].filter(
    Boolean
  )
  let failureEvidenceWriteError = null
  if (failures.length > 0) {
    try {
      const primaryFailure = boundedAcceptanceFailure(failures[0])
      const redEvidenceBase = {
        ok: false,
        verdict: 'RED',
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
        speechFixture,
        speechFixtureCustody,
        custodyFixture,
        custodySource,
        custodyBefore,
        custodyAfter,
        companionCustody,
        providerGuards,
        openResult,
        durable,
        journalPath: path.join(plan.studioStateDirectory, STUDIO_JOURNAL_FILE),
        journey,
        failure: {
          ...primaryFailure,
          errors: failures.map(boundedAcceptanceFailure)
        },
        artifactJoinPolicy: {
          root: plan.artifactRoot,
          exactSemanticPathSet: true,
          sha256EveryPresentRegularFile: true,
          revalidateEveryLeafAtStatusRead: true,
          missingFilesRemainExplicit: true
        },
        watchdogReceiptPath: plan.receiptPath,
        watchdogTerminal,
        priorOrphanScan,
        safety: plan.safety
      }
      const artifactReferences = await (
        adapters.measureFailureArtifacts || measureStudioAcceptanceFailureArtifacts
      )(plan, studioAcceptanceFailureArtifactCandidates(redEvidenceBase))
      const redEvidence = { ...redEvidenceBase, artifactReferences }
      await (adapters.writeEvidence || writeEvidence)(plan, redEvidence)
    } catch (error) {
      failureEvidenceWriteError = error
    }
  }
  const completedFailures = failureEvidenceWriteError
    ? [...failures, failureEvidenceWriteError]
    : failures
  if (completedFailures.length === 1) throw completedFailures[0]
  if (completedFailures.length > 1) {
    throw new AggregateError(
      completedFailures,
      `Studio acceptance, cleanup, or RED evidence sealing failed: ${completedFailures
        .map((failure) => boundedAcceptanceFailure(failure).message)
        .join(' | ')}`
    )
  }

  const completedEvidence = { ...evidence, watchdogTerminal, custodyAfter }
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
  Exactly one media source:
    --generate-speech-fixture
    OR --media=/absolute/path/to/clip.mov --mime=video/mp4|video/quicktime

Optional:
  --detach (requires --launch and an explicit unique --instance-id)
  --detached-status --instance-id=<id> --detached-token=<token>
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
  if (argv.length === 3 && argv[0] === '--self-test-detached-launcher') {
    await runDetachedLauncherSelfTest(argv[1], argv[2])
    return
  }
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(helpText())
    return
  }
  let result
  if (args.detachedStatus) {
    if (args.launch || args.detach) {
      throw new Error('--detached-status cannot be combined with --launch or --detach')
    }
    if (typeof args.instanceId !== 'string' || typeof args.detachedToken !== 'string') {
      throw new Error('--detached-status requires --instance-id and --detached-token')
    }
    const plan = buildStudioAcceptancePlan({ instanceId: args.instanceId })
    result = await readDetachedCoordinatorStatus({
      instanceId: plan.instanceId,
      artifactRoot: plan.artifactRoot,
      token: args.detachedToken
    })
  } else if (args.detach) {
    result = await launchDetachedCoordinator(args)
  } else {
    if (args.detachedToken !== null) {
      throw new Error('--detached-token is valid only with --detached-status')
    }
    result = await runStudioAcceptance(args)
  }
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
  adjudicateRecognizedTranscript,
  buildDetachedCoordinatorPaths,
  buildDetachedCoordinatorIdentity,
  assertLaunchAuthorized,
  assertDetachedLaunchAuthorized,
  validateDetachedCoordinatorRequest,
  launchDetachedCoordinator,
  readDetachedCoordinatorStatus,
  runDetachedCoordinatorProcess,
  materializeOwnedMedia,
  generateAcceptanceSpeechFixture,
  assertGeneratedSpeechFixtureCustody,
  classifyStudioAcceptanceDirt,
  measureStudioAcceptanceCustody,
  measureStudioAcceptanceArtifacts,
  assertStudioAcceptanceCustody,
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
  adjudicatePlaybackRoundTrip,
  adjudicateSharedStudioClock,
  buildStudioAcceptanceJourney,
  compareStudioJourneyCaptures,
  resolveStudioWorkspaceWindow,
  validateStudioWorkspaceObservation,
  studioReviewHostCaptureRegion,
  studioSourceHostOverlayCaptureRegion,
  studioWorkspaceReviewPresented,
  driveStudioUiJourney,
  studioProposalInsertionEvidence,
  verifyDurableOpen,
  buildStubSpec,
  runAbandonOwnerSelfTest,
  runStudioAcceptance
}
