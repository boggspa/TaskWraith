#!/usr/bin/env node
'use strict'

/**
 * Outcome 7 packaged acceptance: revisioned insert_range and host-owned state.
 *
 * Plan-only by default. A live run is accepted only when one disposable signed
 * package proves the proposal, visible ghost, immediate accepted Current,
 * stale-base CAS, host-owned restart hydration, and replayed Current pixels.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')

const harness = require('./studio-acceptance-harness.cjs')
const { hasVerifiedLaunchServicesExit } = require('./studio-acceptance-watchdog.cjs')
const session = require('./studio-acceptance-session.cjs')
const lifecycle = require('./studio-bounded-lifecycle-runner.cjs')
const diagnostics = require('./studio-bounded-diagnostics-runner.cjs')
const pixels = require('./studio-pixel-evidence-verifier.cjs')
const {
  attachMainInspectorSession,
  attachRendererCdpSession,
  discoverMainInspectorUrl
} = require('./perf/cdpWebSocketSession.cjs')

const KIND = 'taskwraith-studio-source-range-lifecycle'
const SCHEMA_VERSION = 1
const DEFAULT_TIMEOUT_MS = 8 * 60 * 1000
const DEFAULT_TRANSCRIPT_TIMEOUT_MS = 3 * 60 * 1000
const DEFAULT_OPEN_TIMEOUT_MS = 3 * 60 * 1000
const RUNNER_RELATIVE_PATH = 'scripts/studio-source-range-lifecycle-runner.cjs'
const TEST_RELATIVE_PATH = 'scripts/studio-source-range-lifecycle-runner.test.ts'
const EXACT_KEYS = Object.freeze({
  rational: Object.freeze(['d', 'n']),
  insert: Object.freeze(['assetId', 'at', 'itemId', 'sourceIn', 'sourceOut', 'type']),
  track: Object.freeze(['items', 'kind', 'trackId']),
  item: Object.freeze(['assetId', 'duration', 'itemId', 'position', 'sourceIn', 'sourceOut']),
  asset: Object.freeze(['assetId', 'mediaKind', 'path']),
  materialMetrics: Object.freeze([
    'fractionAbove40',
    'fractionAbove80',
    'materialPixelCount',
    'maximumChannelResidual',
    'meanAbsoluteChannelResidual',
    'p95ChannelResidual',
    'p99ChannelResidual'
  ]),
  materialThresholds: Object.freeze([
    'maximumFractionAbove40',
    'maximumFractionAbove80',
    'maximumMeanAbsoluteChannelResidual',
    'maximumP99ChannelResidual'
  ])
})
const HARNESS_EVIDENCE_KEYS = Object.freeze([
  'asset',
  'companion',
  'companionCustody',
  'custodyAfter',
  'custodyBefore',
  'custodyFixture',
  'custodySource',
  'durable',
  'electron',
  'instanceId',
  'journey',
  'kind',
  'ok',
  'openResult',
  'packagedExecutionAfter',
  'packagedExecutionBefore',
  'priorOrphanScan',
  'providerGuards',
  'recordedAt',
  'safety',
  'schemaVersion',
  'speechFixture',
  'speechFixtureCustody',
  'watchdogReceiptPath',
  'watchdogTerminal',
  'window'
])
const PACKAGE_KEYS = Object.freeze([
  'appRoot',
  'bridgeBundleIdentifier',
  'bridgeDaemonPath',
  'bridgeDaemonSha256',
  'bridgeSpeechUsageDescription',
  'bundleIdentityDigest',
  'codeSignatureVerified',
  'companionPath',
  'companionSha256',
  'executablePath',
  'executableSha256',
  'files',
  'speechUsageDescription'
])
const PACKAGE_FILE_KEYS = Object.freeze([
  'appAsar',
  'bridgeDaemon',
  'bridgeInfoPlist',
  'companion',
  'executable',
  'infoPlist'
])
const CUSTODY_KEYS = Object.freeze([
  'artifactCount',
  'artifactDigest',
  'bridgeDaemonPath',
  'bridgeDaemonSha256',
  'buildEnvironmentCount',
  'buildEnvironmentDigest',
  'buildEnvironmentVariables',
  'companionPath',
  'companionSha256',
  'expectedSupportHashes',
  'fixtureByteLength',
  'fixtureSha256',
  'foreignTrackedDirt',
  'foreignUntrackedDirt',
  'head',
  'outCount',
  'outDigest',
  'productAncestorPresent',
  'protectedPathScope',
  'requiredProductAncestor',
  'runnerSha256',
  'sourceCount',
  'sourceDigest',
  'studioPathsClean',
  'studioTrackedDirt',
  'studioUntrackedDirt',
  'supportHashes',
  'supportMatches',
  'wholeTrackedTreeClean',
  'wholeWorkspaceClean'
])

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected, label) {
  invariant(isRecord(value), `${label} is not an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  invariant(JSON.stringify(actual) === JSON.stringify(wanted), `${label} keys are not exact`)
  return value
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath))
}

function readExactJsonReceipt(filePath, label, maximumBytes = 32 * 1024 * 1024) {
  const resolved = safeAbsolute(filePath, `${label} path`)
  const stat = fs.lstatSync(resolved)
  invariant(stat.isFile() && !stat.isSymbolicLink(), `${label} is not a regular file`)
  invariant(stat.size > 0 && stat.size <= maximumBytes, `${label} byte length is unsafe`)
  const raw = fs.readFileSync(resolved)
  let value
  try {
    value = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
  return {
    path: resolved,
    byteLength: raw.length,
    sha256: sha256Bytes(raw),
    verifiedFromDisk: true,
    value
  }
}

function safeAbsolute(value, label) {
  const resolved = path.resolve(String(value || ''))
  invariant(
    path.isAbsolute(resolved) && resolved !== path.parse(resolved).root,
    `${label} is unsafe`
  )
  return resolved
}

function safeInstanceId(value) {
  const result = String(value || '')
  invariant(/^[a-z0-9][a-z0-9-]{1,15}$/.test(result), 'instance-id is invalid')
  return result
}

function boundedInteger(value, label, minimum, maximum) {
  const result = Number(value)
  invariant(
    Number.isSafeInteger(result) && result >= minimum && result <= maximum,
    `${label} is invalid`
  )
  return result
}

function defaultArtifactRoot(instanceId, repoRoot = session.repoRoot) {
  return path.join(
    repoRoot,
    '.local-only',
    'taskwraith-studio',
    'acceptance',
    safeInstanceId(instanceId)
  )
}

function parseCli(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true }
  const parsed = {
    help: false,
    launch: false,
    acceptLaunch: false,
    ownerConfirmsOrphansCleared: false,
    artifactRoot: null,
    instanceId: null,
    packagedExecutablePath: null,
    generateSpeechFixture: false,
    mediaPath: null,
    mimeType: null,
    remoteDebuggingPort: null,
    mainInspectorPort: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    transcriptTimeoutMs: DEFAULT_TRANSCRIPT_TIMEOUT_MS,
    openTimeoutMs: DEFAULT_OPEN_TIMEOUT_MS
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = () => {
      invariant(index + 1 < argv.length, `${argument} requires a value`)
      index += 1
      return argv[index]
    }
    if (argument === '--launch') parsed.launch = true
    else if (argument === '--i-accept-studio-isolated-launch') parsed.acceptLaunch = true
    else if (argument === '--owner-confirms-existing-orphans-cleared') {
      parsed.ownerConfirmsOrphansCleared = true
    } else if (argument === '--generate-speech-fixture') parsed.generateSpeechFixture = true
    else if (argument.startsWith('--artifact-root=')) parsed.artifactRoot = argument.slice(16)
    else if (argument === '--artifact-root') parsed.artifactRoot = next()
    else if (argument.startsWith('--instance-id=')) parsed.instanceId = argument.slice(14)
    else if (argument === '--instance-id') parsed.instanceId = next()
    else if (argument.startsWith('--packaged-executable=')) {
      parsed.packagedExecutablePath = argument.slice('--packaged-executable='.length)
    } else if (argument === '--packaged-executable') parsed.packagedExecutablePath = next()
    else if (argument.startsWith('--media=')) parsed.mediaPath = argument.slice(8)
    else if (argument === '--media') parsed.mediaPath = next()
    else if (argument.startsWith('--mime=')) parsed.mimeType = argument.slice(7)
    else if (argument === '--mime') parsed.mimeType = next()
    else if (argument.startsWith('--remote-debugging-port=')) {
      parsed.remoteDebuggingPort = boundedInteger(
        argument.slice(24),
        'remote-debugging-port',
        1024,
        65535
      )
    } else if (argument.startsWith('--main-inspector-port=')) {
      parsed.mainInspectorPort = boundedInteger(
        argument.slice(22),
        'main-inspector-port',
        1024,
        65535
      )
    } else if (argument.startsWith('--timeout-ms=')) {
      parsed.timeoutMs = boundedInteger(argument.slice(13), 'timeout-ms', 60_000, 30 * 60_000)
    } else if (argument.startsWith('--transcript-timeout-ms=')) {
      parsed.transcriptTimeoutMs = boundedInteger(
        argument.slice(24),
        'transcript-timeout-ms',
        10_000,
        30 * 60_000
      )
    } else if (argument.startsWith('--open-timeout-ms=')) {
      parsed.openTimeoutMs = boundedInteger(
        argument.slice(18),
        'open-timeout-ms',
        45_000,
        5 * 60_000
      )
    } else throw new Error(`unknown argument ${argument}`)
  }
  return parsed
}

function normalizeOptions(options = {}) {
  const instanceId = safeInstanceId(options.instanceId || `o7-${process.pid}`)
  const artifactRoot = safeAbsolute(
    options.artifactRoot || defaultArtifactRoot(instanceId),
    'artifact-root'
  )
  const acceptanceRoot = path.join(
    session.repoRoot,
    '.local-only',
    'taskwraith-studio',
    'acceptance'
  )
  const relative = path.relative(acceptanceRoot, artifactRoot)
  invariant(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'artifact-root escaped acceptance custody'
  )
  invariant(
    path.basename(artifactRoot) === instanceId,
    'artifact-root basename must equal instance-id'
  )
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    'timeout-ms',
    60_000,
    30 * 60_000
  )
  const transcriptTimeoutMs = boundedInteger(
    options.transcriptTimeoutMs ?? DEFAULT_TRANSCRIPT_TIMEOUT_MS,
    'transcript-timeout-ms',
    10_000,
    timeoutMs
  )
  const openTimeoutMs = boundedInteger(
    options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS,
    'open-timeout-ms',
    45_000,
    Math.min(5 * 60_000, timeoutMs - 30_000)
  )
  const packagedExecutablePath = options.packagedExecutablePath
    ? safeAbsolute(options.packagedExecutablePath, 'packaged-executable')
    : null
  const mediaPath = options.mediaPath ? safeAbsolute(options.mediaPath, 'media') : null
  const generateSpeechFixture = options.generateSpeechFixture === true
  invariant(!(generateSpeechFixture && mediaPath), 'choose generated fixture or media, not both')
  invariant(
    !mediaPath || ['video/mp4', 'video/quicktime'].includes(options.mimeType),
    'owner media requires an allowed mime'
  )
  if (options.launch) {
    invariant(options.acceptLaunch === true, 'launch requires explicit isolated-launch acceptance')
    invariant(
      options.ownerConfirmsOrphansCleared === true,
      'launch requires owner orphan-clearance confirmation'
    )
    invariant(packagedExecutablePath, 'live Outcome 7 requires a packaged executable')
    invariant(generateSpeechFixture || mediaPath, 'live Outcome 7 requires exact media')
    invariant(!fs.existsSync(artifactRoot), 'live Outcome 7 requires a fresh artifact-root')
    invariant(
      options.remoteDebuggingPort == null ||
        options.remoteDebuggingPort !== options.mainInspectorPort,
      'renderer and inspector ports must differ'
    )
  }
  return {
    launch: options.launch === true,
    acceptLaunch: options.acceptLaunch === true,
    ownerConfirmsOrphansCleared: options.ownerConfirmsOrphansCleared === true,
    artifactRoot,
    instanceId,
    packagedExecutablePath,
    generateSpeechFixture,
    mediaPath,
    mimeType: mediaPath ? options.mimeType : null,
    remoteDebuggingPort: options.remoteDebuggingPort ?? null,
    mainInspectorPort: options.mainInspectorPort ?? null,
    timeoutMs,
    transcriptTimeoutMs,
    openTimeoutMs
  }
}

function buildPlan(options = {}) {
  const normalized = normalizeOptions(options)
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: `${KIND}-plan`,
    launched: false,
    ...normalized,
    safety: {
      planOnlyByDefault: true,
      packageRequiredForLaunch: true,
      disposableProfile: true,
      freshArtifactRoot: true,
      exactPidPgidExecutable: true,
      foregroundInputExplicitOnly: true,
      hostPauseMustResumeInFinally: true,
      watchdogRequired: true,
      noRestartOnlyMaterializationCredit: true,
      runnerMustMatchTrackedHeadBlob: true
    }
  }
}

function gitOutput(args, adapters = {}) {
  const run = adapters.runExact || session.runExact
  return run('/usr/bin/git', ['-C', session.repoRoot, ...args], {
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024
  }).stdout
}

function assertSelfCustody(adapters = {}) {
  const runnerPath = path.join(session.repoRoot, RUNNER_RELATIVE_PATH)
  const testPath = path.join(session.repoRoot, TEST_RELATIVE_PATH)
  const tracked = gitOutput(['ls-files', '--', RUNNER_RELATIVE_PATH, TEST_RELATIVE_PATH], adapters)
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort()
  invariant(
    JSON.stringify(tracked) === JSON.stringify([RUNNER_RELATIVE_PATH, TEST_RELATIVE_PATH].sort()),
    'Outcome 7 runner and test must be tracked before live launch'
  )
  const status = gitOutput(
    ['status', '--porcelain=v1', '--', RUNNER_RELATIVE_PATH, TEST_RELATIVE_PATH],
    adapters
  ).trim()
  invariant(status === '', 'Outcome 7 runner or test is dirty at live boundary')
  const runnerHead = Buffer.from(gitOutput(['show', `HEAD:${RUNNER_RELATIVE_PATH}`], adapters))
  const testHead = Buffer.from(gitOutput(['show', `HEAD:${TEST_RELATIVE_PATH}`], adapters))
  const observed = {
    runner: { path: RUNNER_RELATIVE_PATH, sha256: sha256File(runnerPath) },
    test: { path: TEST_RELATIVE_PATH, sha256: sha256File(testPath) }
  }
  invariant(observed.runner.sha256 === sha256Bytes(runnerHead), 'runner bytes differ from HEAD')
  invariant(observed.test.sha256 === sha256Bytes(testHead), 'runner test bytes differ from HEAD')
  return observed
}

function exactElectronParent(expected, adapters = {}) {
  invariant(
    Number.isSafeInteger(expected?.pid) &&
      expected.pid > 0 &&
      Number.isSafeInteger(expected?.pgid) &&
      expected.pgid > 0,
    'Electron signal target identity is incomplete'
  )
  const executable = safeAbsolute(expected.executable, 'Electron signal target executable')
  const run = adapters.runExact || session.runExact
  const receipt = run('/bin/ps', ['-p', String(expected.pid), '-o', 'pid=,ppid=,pgid=,command='], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024
  })
  const rows = harness.parseProcessTable(receipt.stdout)
  invariant(rows.length === 1, 'Electron signal target is not one exact process-table row')
  const row = rows[0]
  invariant(row.pid === expected.pid, 'Electron signal target PID changed')
  invariant(row.ppid > 0, 'Electron signal target parent is invalid')
  invariant(row.pgid === expected.pgid, 'Electron signal target PGID changed')
  invariant(
    row.command === executable || row.command.startsWith(`${executable} `),
    'Electron signal target executable changed'
  )
  return {
    pid: row.pid,
    ppid: row.ppid,
    pgid: row.pgid,
    executable,
    command: row.command,
    processTableReceipt: {
      command: receipt.command,
      stdoutSha256: sha256Bytes(receipt.stdout),
      stderrSha256: sha256Bytes(receipt.stderr || '')
    }
  }
}

function exactCompanionSignalTarget(expected, adapters = {}) {
  invariant(
    expected?.pid > 0 &&
      expected?.ppid > 0 &&
      expected?.pgid > 0 &&
      typeof expected?.command === 'string' &&
      expected.command &&
      typeof expected?.expectedExecutable === 'string',
    'Companion signal target identity is incomplete'
  )
  const executable = safeAbsolute(expected.expectedExecutable, 'Companion signal executable')
  const run = adapters.runExact || session.runExact
  const receipt = run('/bin/ps', ['-p', String(expected.pid), '-o', 'pid=,ppid=,pgid=,command='], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024
  })
  const rows = harness.parseProcessTable(receipt.stdout)
  invariant(rows.length === 1, 'Companion signal target is not one exact process-table row')
  const row = rows[0]
  invariant(
    row.pid === expected.pid &&
      row.ppid === expected.ppid &&
      row.pgid === expected.pgid &&
      row.command === expected.command &&
      (row.command === executable || row.command.startsWith(`${executable} `)),
    'Companion signal target PID/parent/group/executable changed'
  )
  return {
    pid: row.pid,
    ppid: row.ppid,
    pgid: row.pgid,
    executable,
    command: row.command,
    processTableReceipt: {
      command: receipt.command,
      stdoutSha256: sha256Bytes(receipt.stdout),
      stderrSha256: sha256Bytes(receipt.stderr || '')
    }
  }
}

function rational(value, label) {
  exactKeys(value, EXACT_KEYS.rational, label)
  invariant(Number.isSafeInteger(value.n), `${label}.n is not exact`)
  invariant(Number.isSafeInteger(value.d) && value.d > 0, `${label}.d is not positive`)
  return { n: value.n, d: value.d }
}

function sameRational(left, right) {
  const a = rational(left, 'left rational')
  const b = rational(right, 'right rational')
  return BigInt(a.n) * BigInt(b.d) === BigInt(b.n) * BigInt(a.d)
}

function rationalCompare(left, right) {
  const a = rational(left, 'left rational')
  const b = rational(right, 'right rational')
  const delta = BigInt(a.n) * BigInt(b.d) - BigInt(b.n) * BigInt(a.d)
  return delta < 0n ? -1 : delta > 0n ? 1 : 0
}

function durationMatchesRange(sourceIn, sourceOut, duration) {
  const start = rational(sourceIn, 'range sourceIn')
  const end = rational(sourceOut, 'range sourceOut')
  const span = rational(duration, 'range duration')
  return (
    (BigInt(end.n) * BigInt(start.d) - BigInt(start.n) * BigInt(end.d)) * BigInt(span.d) ===
    BigInt(span.n) * BigInt(end.d) * BigInt(start.d)
  )
}

function endAtOrBefore(position, duration, nextPosition) {
  const start = rational(position, 'item position')
  const span = rational(duration, 'item duration')
  const next = rational(nextPosition, 'next item position')
  const endNumerator = BigInt(start.n) * BigInt(span.d) + BigInt(span.n) * BigInt(start.d)
  const endDenominator = BigInt(start.d) * BigInt(span.d)
  return endNumerator * BigInt(next.d) <= BigInt(next.n) * endDenominator
}

function exactInsert(op, expected = {}) {
  exactKeys(op, EXACT_KEYS.insert, 'insert_range')
  invariant(op.type === 'insert_range', 'proposal is not insert_range')
  invariant(typeof op.itemId === 'string' && op.itemId, 'insert_range itemId is empty')
  invariant(typeof op.assetId === 'string' && op.assetId, 'insert_range assetId is empty')
  if (expected.assetId) invariant(op.assetId === expected.assetId, 'insert_range asset is wrong')
  const sourceIn = rational(op.sourceIn, 'insert_range.sourceIn')
  const sourceOut = rational(op.sourceOut, 'insert_range.sourceOut')
  const at = rational(op.at, 'insert_range.at')
  invariant(
    sourceIn.d === sourceOut.d && sourceIn.d === at.d,
    'insert_range rationals do not share one exact timebase'
  )
  invariant(
    sourceIn.n >= 0 && sourceOut.n > sourceIn.n && at.n >= 0,
    'insert_range bounds are invalid'
  )
  return { itemId: op.itemId, assetId: op.assetId, sourceIn, sourceOut, at }
}

function hashEntries(entries) {
  return sha256Bytes(JSON.stringify(entries))
}

function journalBoundary(entries) {
  invariant(Array.isArray(entries), 'journal entries are absent')
  return {
    count: entries.length,
    revision: entries.at(-1)?.revision || 0,
    sha256: hashEntries(entries)
  }
}

function validateJournalDelta(before, after, expectedOp) {
  const left = journalBoundary(before)
  const right = journalBoundary(after)
  invariant(after.length === before.length + 1, 'journal delta is not exactly one entry')
  invariant(hashEntries(after.slice(0, before.length)) === left.sha256, 'journal prefix changed')
  const appended = after.at(-1)
  invariant(
    appended.revision === left.revision + 1,
    'journal revision did not advance exactly once'
  )
  invariant(
    JSON.stringify(appended.op) === JSON.stringify(expectedOp),
    'journal appended the wrong operation'
  )
  return { before: left, after: right, appended }
}

function validateGhostCheckpoint(checkpoint, label) {
  invariant(isRecord(checkpoint), `${label} is absent`)
  invariant(checkpoint.region === 'review-host', `${label} used the wrong pixel region`)
  invariant(checkpoint.comparison?.ok === true, `${label} pixels are not Green`)
  invariant(
    checkpoint.comparison?.region === 'review-host' &&
      Number.isSafeInteger(checkpoint.comparison?.changedPixelCount) &&
      checkpoint.comparison.changedPixelCount > 0 &&
      Number.isFinite(checkpoint.comparison?.changedPixelFraction) &&
      checkpoint.comparison.changedPixelFraction > 0,
    `${label} pixel metric schema is invalid`
  )
  invariant(
    typeof checkpoint.captureSha256 === 'string' && checkpoint.captureSha256.length === 64,
    `${label} capture hash is absent`
  )
  invariant(
    typeof checkpoint.referenceSha256 === 'string' && checkpoint.referenceSha256.length === 64,
    `${label} reference hash is absent`
  )
  return checkpoint
}

function validateMaterialCheckpoint(checkpoint, label) {
  invariant(isRecord(checkpoint), `${label} is absent`)
  invariant(checkpoint.region === 'review-host', `${label} used the wrong pixel region`)
  invariant(checkpoint.comparison?.clean === true, `${label} pixels are not Green`)
  exactKeys(checkpoint.comparison.metrics, EXACT_KEYS.materialMetrics, `${label} metrics`)
  exactKeys(checkpoint.comparison.thresholds, EXACT_KEYS.materialThresholds, `${label} thresholds`)
  invariant(
    Number.isSafeInteger(checkpoint.comparison.metrics.materialPixelCount) &&
      checkpoint.comparison.metrics.materialPixelCount > 0,
    `${label} material pixel count is invalid`
  )
  for (const key of EXACT_KEYS.materialMetrics.filter((key) => key !== 'materialPixelCount')) {
    invariant(
      Number.isFinite(checkpoint.comparison.metrics[key]) &&
        checkpoint.comparison.metrics[key] >= 0,
      `${label} metric ${key} is invalid`
    )
  }
  for (const key of EXACT_KEYS.materialThresholds) {
    invariant(
      Number.isFinite(checkpoint.comparison.thresholds[key]) &&
        checkpoint.comparison.thresholds[key] >= 0,
      `${label} threshold ${key} is invalid`
    )
  }
  invariant(
    typeof checkpoint.captureSha256 === 'string' && checkpoint.captureSha256.length === 64,
    `${label} capture hash is absent`
  )
  invariant(
    typeof checkpoint.referenceSha256 === 'string' && checkpoint.referenceSha256.length === 64,
    `${label} reference hash is absent`
  )
  invariant(
    Array.isArray(checkpoint.referenceExecution?.command) &&
      checkpoint.referenceExecution.command.length > 1 &&
      /(?:^|\/)ffmpeg$/.test(checkpoint.referenceExecution.command[0]) &&
      checkpoint.referenceExecution.exitCode === 0 &&
      typeof checkpoint.referenceExecution.stdoutSha256 === 'string' &&
      checkpoint.referenceExecution.stdoutSha256.length === 64 &&
      typeof checkpoint.referenceExecution.stderrSha256 === 'string' &&
      checkpoint.referenceExecution.stderrSha256.length === 64,
    `${label} ffmpeg execution receipt is invalid`
  )
  return checkpoint
}

function validateStaleControl(control) {
  invariant(isRecord(control), 'stale-base control is absent')
  invariant(
    control.hostPaused === true && control.hostResumed === true,
    'stale-base host pause was not safely bracketed'
  )
  invariant(control.acceptRequests === 2, 'stale-base control did not send two accepts')
  const beforeStop = control.hostSignalTarget?.beforeStop
  const beforeContinue = control.hostSignalTarget?.beforeContinue
  invariant(
    beforeStop?.pid > 0 &&
      beforeStop.pid === beforeContinue?.pid &&
      beforeStop.ppid === beforeContinue.ppid &&
      beforeStop.pgid === beforeContinue.pgid &&
      beforeStop.executable === beforeContinue.executable &&
      beforeStop.command === beforeContinue.command,
    'stale-base Electron signal target custody changed'
  )
  for (const [label, observed] of [
    ['before SIGSTOP', beforeStop],
    ['before SIGCONT', beforeContinue]
  ]) {
    invariant(
      Array.isArray(observed.processTableReceipt?.command) &&
        observed.processTableReceipt.command[0] === '/bin/ps' &&
        typeof observed.processTableReceipt.stdoutSha256 === 'string' &&
        observed.processTableReceipt.stdoutSha256.length === 64 &&
        typeof observed.processTableReceipt.stderrSha256 === 'string' &&
        observed.processTableReceipt.stderrSha256.length === 64,
      `stale-base process-table custody ${label} is invalid`
    )
  }
  invariant(control.responses?.length === 2, 'stale-base raw response pair is absent')
  const accepted = control.responses.filter((entry) => entry.kind === 'accepted')
  const stale = control.responses.filter((entry) => entry.kind === 'stale_base')
  invariant(
    accepted.length === 1 && stale.length === 1,
    'stale-base pair is not one accept and one refusal'
  )
  invariant(
    accepted[0].proposalId === control.proposalId,
    'accepted response proposal identity changed'
  )
  invariant(stale[0].proposalId === control.proposalId, 'stale response proposal identity changed')
  invariant(
    stale[0].currentRevision === accepted[0].revision,
    'stale response currentRevision is wrong'
  )
  invariant(
    stale[0].baseRevision === accepted[0].revision - 1,
    'stale request did not carry the prior base'
  )
  return { accepted: accepted[0], stale: stale[0] }
}

function validateReplacement(restart, acceptedInsert, expectedAsset) {
  invariant(isRecord(restart), 'restart evidence is absent')
  const oldProcess = restart.oldProcess
  const replacement = restart.replacementProcess
  invariant(oldProcess?.pid > 0 && replacement?.pid > 0, 'restart PID evidence is absent')
  invariant(oldProcess.pid !== replacement.pid, 'replacement reused the old PID')
  const beforeKill = restart.beforeKillProcess
  invariant(
    beforeKill?.pid === oldProcess.pid &&
      beforeKill.ppid === oldProcess.ppid &&
      beforeKill.pgid === oldProcess.pgid &&
      beforeKill.executable === oldProcess.executable &&
      beforeKill.command === oldProcess.command &&
      Array.isArray(beforeKill.processTableReceipt?.command) &&
      beforeKill.processTableReceipt.command[0] === '/bin/ps' &&
      typeof beforeKill.processTableReceipt.stdoutSha256 === 'string' &&
      beforeKill.processTableReceipt.stdoutSha256.length === 64 &&
      typeof beforeKill.processTableReceipt.stderrSha256 === 'string' &&
      beforeKill.processTableReceipt.stderrSha256.length === 64,
    'old Companion SIGKILL target custody is not fresh and exact'
  )
  invariant(oldProcess.ppid === replacement.ppid, 'replacement parent changed')
  invariant(oldProcess.pgid === replacement.pgid, 'replacement process group changed')
  invariant(oldProcess.executable === replacement.executable, 'replacement executable changed')
  invariant(restart.oldProcessDisappeared === true, 'old Companion still exists')
  invariant(restart.hydration?.ordered === true, 'replacement hydration order is not exact')
  invariant(
    restart.hydration?.proposalsEmpty === true,
    'accepted proposal replayed as an open ghost'
  )
  invariant(restart.hydration?.windowCount === 0, 'replacement presented a window during hydration')
  invariant(
    restart.hydration?.journalBeforeSha256 === restart.hydration?.journalAfterSha256 &&
      restart.hydration?.journalBeforeRevision === restart.hydration?.journalAfterRevision,
    'hydration mutated host durability'
  )
  const assets = restart.hydration?.assets
  invariant(Array.isArray(assets) && assets.length > 0, 'hydration assets are absent')
  const hydratedAssetIds = new Set()
  const hydratedAssetPaths = new Set()
  for (const asset of assets) {
    exactKeys(asset, EXACT_KEYS.asset, 'hydration asset')
    invariant(
      typeof asset.assetId === 'string' &&
        asset.assetId &&
        path.isAbsolute(asset.path) &&
        asset.path !== path.parse(asset.path).root &&
        path.resolve(asset.path) === asset.path &&
        asset.mediaKind === 'video',
      'hydration asset schema is invalid'
    )
    invariant(!hydratedAssetIds.has(asset.assetId), 'hydration duplicates an asset id')
    invariant(!hydratedAssetPaths.has(asset.path), 'hydration duplicates an asset path')
    hydratedAssetIds.add(asset.assetId)
    hydratedAssetPaths.add(asset.path)
  }
  const exactAsset = assets.find((asset) => asset.assetId === expectedAsset.assetId)
  invariant(exactAsset, 'hydration omitted the exact accepted asset')
  invariant(
    path.resolve(exactAsset.path) === path.resolve(expectedAsset.path),
    'hydration asset path changed'
  )
  invariant(exactAsset.mediaKind === expectedAsset.mediaKind, 'hydration asset mediaKind changed')
  const tracks = restart.hydration?.tracks
  invariant(Array.isArray(tracks) && tracks.length > 0, 'hydration tracks are absent')
  const trackIds = new Set()
  const globalItemIds = new Set()
  const acceptedMatches = []
  for (const track of tracks) {
    exactKeys(track, EXACT_KEYS.track, 'hydration track')
    invariant(
      typeof track.trackId === 'string' &&
        track.trackId &&
        (track.kind === 'video' || track.kind === 'audio') &&
        Array.isArray(track.items),
      'hydration track schema is invalid'
    )
    invariant(!trackIds.has(track.trackId), 'hydration duplicates a track id')
    trackIds.add(track.trackId)
    for (const candidate of track.items) {
      exactKeys(candidate, EXACT_KEYS.item, 'hydration track item')
      invariant(
        typeof candidate.itemId === 'string' &&
          candidate.itemId &&
          typeof candidate.assetId === 'string' &&
          candidate.assetId &&
          hydratedAssetIds.has(candidate.assetId),
        'hydration track item identity is invalid'
      )
      invariant(!globalItemIds.has(candidate.itemId), 'hydration duplicates a global item id')
      globalItemIds.add(candidate.itemId)
      rational(candidate.sourceIn, 'hydration item sourceIn')
      rational(candidate.sourceOut, 'hydration item sourceOut')
      rational(candidate.position, 'hydration item position')
      rational(candidate.duration, 'hydration item duration')
      invariant(
        rationalCompare(candidate.sourceOut, candidate.sourceIn) > 0 &&
          rationalCompare(candidate.duration, { n: 0, d: 1 }) > 0 &&
          rationalCompare(candidate.position, { n: 0, d: 1 }) >= 0 &&
          durationMatchesRange(candidate.sourceIn, candidate.sourceOut, candidate.duration),
        'hydration track item range, duration, or position is invalid'
      )
      if (candidate.itemId === acceptedInsert.itemId) {
        acceptedMatches.push({ trackId: track.trackId, item: candidate })
      }
    }
    const ordered = [...track.items].sort((left, right) =>
      rationalCompare(left.position, right.position)
    )
    for (let index = 1; index < ordered.length; index += 1) {
      invariant(
        endAtOrBefore(
          ordered[index - 1].position,
          ordered[index - 1].duration,
          ordered[index].position
        ),
        `hydration track ${track.trackId} contains overlapping items`
      )
    }
  }
  const targetTrackId = 'V1'
  invariant(
    acceptedMatches.length === 1 && acceptedMatches[0].trackId === targetTrackId,
    'hydration did not contain exactly one accepted item on target track V1'
  )
  const item = acceptedMatches[0].item
  invariant(item.assetId === acceptedInsert.assetId, 'hydrated item asset changed')
  invariant(sameRational(item.sourceIn, acceptedInsert.sourceIn), 'hydrated sourceIn changed')
  invariant(sameRational(item.sourceOut, acceptedInsert.sourceOut), 'hydrated sourceOut changed')
  invariant(sameRational(item.position, acceptedInsert.at), 'hydrated insertion point changed')
  validateMaterialCheckpoint(restart.replayedCurrent, 'replayed Current')
  invariant(
    restart.explicitReopen?.sameAsset === true,
    'restart did not explicitly reopen the same asset'
  )
  invariant(
    restart.explicitReopen?.newVisibleWindow === true,
    'restart did not present a new exact window'
  )
  invariant(
    restart.explicitReopen?.journalEntry?.revision === restart.hydration.journalAfterRevision + 1,
    'restart reopen did not wait for one fresh journal revision'
  )
  const reopened = restart.explicitReopen?.journalEntry?.op?.asset
  exactKeys(reopened, EXACT_KEYS.asset, 'restart reopen asset')
  invariant(
    reopened.assetId === expectedAsset.assetId &&
      path.resolve(reopened.path) === path.resolve(expectedAsset.path) &&
      reopened.mediaKind === expectedAsset.mediaKind,
    'restart reopen target identity changed'
  )
  const window = restart.explicitReopen?.window
  invariant(
    window?.pid === replacement.pid &&
      Number.isSafeInteger(window.windowId) &&
      window.windowId > 0 &&
      window.windowId !== restart.oldWindowId &&
      window.title === 'TaskWraith Studio' &&
      window.executable === replacement.executable,
    'restart visible window identity is not exact'
  )
  return item
}

function validateRawHarnessEvidence(receipt) {
  invariant(isRecord(receipt), 'raw harness evidence receipt is absent')
  invariant(
    receipt.verifiedFromDisk === true &&
      path.isAbsolute(receipt.path) &&
      Number.isSafeInteger(receipt.byteLength) &&
      receipt.byteLength > 0 &&
      typeof receipt.sha256 === 'string' &&
      receipt.sha256.length === 64,
    'raw harness evidence file identity is invalid'
  )
  exactKeys(receipt.value, HARNESS_EVIDENCE_KEYS, 'raw harness evidence')
  invariant(
    receipt.value.schemaVersion === 1 &&
      receipt.value.kind === 'taskwraith-studio-in-product-acceptance' &&
      receipt.value.ok === true,
    'raw harness terminal schema is invalid'
  )
  invariant(
    receipt.value.watchdogReceiptPath === receipt.watchdogReceiptPath,
    'raw harness watchdog path join changed'
  )
  return receipt
}

function validateRawWatchdogEvidence(receipt, instanceId, electron) {
  invariant(isRecord(receipt), 'raw watchdog receipt is absent')
  invariant(
    receipt.verifiedFromDisk === true &&
      path.isAbsolute(receipt.path) &&
      Number.isSafeInteger(receipt.byteLength) &&
      receipt.byteLength > 0 &&
      typeof receipt.sha256 === 'string' &&
      receipt.sha256.length === 64,
    'raw watchdog file identity is invalid'
  )
  const value = receipt.value
  invariant(
    value?.schemaVersion === 2 &&
      value?.kind === 'taskwraith-studio-acceptance-watchdog' &&
      value?.instanceId === instanceId &&
      value?.status === 'reaped' &&
      value?.reason === 'owner_requested' &&
      value?.groupExitVerified === true &&
      value?.detachedGroupExitVerified === true,
    'raw watchdog terminal schema or reaping is invalid'
  )
  invariant(
    Array.isArray(value.lostOwnershipGroups) &&
      value.lostOwnershipGroups.length === 0 &&
      Array.isArray(value.mixedOwnershipGroups) &&
      value.mixedOwnershipGroups.length === 0 &&
      Array.isArray(value.protectedInstalledGroups),
    'raw watchdog retained unresolved mission groups or omitted protected-owner accounting'
  )
  const terminal = receipt.terminal
  invariant(
    terminal?.type === 'terminal' &&
      terminal.status === value.status &&
      terminal.childPid === value.childPid &&
      terminal.childPgid === value.childPgid &&
      terminal.groupExitVerified === value.groupExitVerified &&
      terminal.detachedGroupExitVerified === value.detachedGroupExitVerified &&
      terminal.reason === value.reason &&
      terminal.receiptPath === receipt.path,
    'watchdog IPC terminal does not join its raw receipt'
  )
  invariant(
    hasVerifiedLaunchServicesExit(value) && hasVerifiedLaunchServicesExit(terminal),
    'raw watchdog LaunchServices adoption or exact group reap is invalid'
  )
  invariant(
    value.launchServicesExecutable === terminal.launchServicesExecutable &&
      JSON.stringify(value.launchServicesAdoption) ===
        JSON.stringify(terminal.launchServicesAdoption),
    'raw watchdog LaunchServices adoption does not exactly match the terminal acknowledgment'
  )
  const launchServices = electron?.launchMode === 'launch-services'
  invariant(
    value.childPid === (launchServices ? electron.launcherPid : electron?.pid) &&
      value.childPgid === (launchServices ? electron.launcherPgid : electron?.pgid),
    'raw watchdog child identity does not join the exact harness launch owner'
  )
  if (launchServices) {
    invariant(
      JSON.stringify(value.detachedProcessGroups) ===
        JSON.stringify(terminal.detachedProcessGroups),
      'raw watchdog detached process groups do not match terminal evidence'
    )
    for (const proof of [value, terminal]) {
      invariant(
        isRecord(proof.launchServicesAdoption) &&
          proof.launchServicesAdoption.pid === electron.pid &&
          proof.launchServicesAdoption.pgid === electron.pgid,
        'raw watchdog LaunchServices adoption does not bind the exact reaped Electron identity'
      )
    }
  }
  return receipt
}

function validatePackageCustody(value, label) {
  exactKeys(value, PACKAGE_KEYS, label)
  invariant(
    typeof value.appRoot === 'string' &&
      value.appRoot &&
      typeof value.bundleIdentityDigest === 'string' &&
      value.bundleIdentityDigest.length === 64 &&
      value.codeSignatureVerified === true,
    `${label} identity or signature is invalid`
  )
  exactKeys(value.files, PACKAGE_FILE_KEYS, `${label} files`)
  for (const [name, file] of Object.entries(value.files)) {
    exactKeys(file, ['path', 'sha256'], `${label} ${name}`)
    invariant(
      typeof file.path === 'string' &&
        file.path &&
        typeof file.sha256 === 'string' &&
        file.sha256.length === 64,
      `${label} ${name} identity is invalid`
    )
  }
  for (const field of [
    'executablePath',
    'companionPath',
    'bridgeDaemonPath',
    'speechUsageDescription',
    'bridgeSpeechUsageDescription',
    'bridgeBundleIdentifier'
  ]) {
    invariant(typeof value[field] === 'string' && value[field], `${label} ${field} is empty`)
  }
  for (const field of ['executableSha256', 'companionSha256', 'bridgeDaemonSha256']) {
    invariant(
      typeof value[field] === 'string' && value[field].length === 64,
      `${label} ${field} is invalid`
    )
  }
  invariant(
    value.executablePath === value.files.executable.path &&
      value.executableSha256 === value.files.executable.sha256 &&
      value.companionPath === value.files.companion.path &&
      value.companionSha256 === value.files.companion.sha256 &&
      value.bridgeDaemonPath === value.files.bridgeDaemon.path &&
      value.bridgeDaemonSha256 === value.files.bridgeDaemon.sha256,
    `${label} selected file projection disagrees with its manifest`
  )
  return value
}

function validateSourceCustody(value, label) {
  exactKeys(value, CUSTODY_KEYS, label)
  invariant(
    typeof value.head === 'string' &&
      value.head.length === 40 &&
      typeof value.requiredProductAncestor === 'string' &&
      value.requiredProductAncestor.length === 40 &&
      value.productAncestorPresent === true &&
      value.wholeTrackedTreeClean === true &&
      value.wholeWorkspaceClean === true &&
      value.studioPathsClean === true &&
      value.supportMatches === true,
    `${label} clean/product/support boundary is invalid`
  )
  for (const field of [
    'studioTrackedDirt',
    'studioUntrackedDirt',
    'foreignTrackedDirt',
    'foreignUntrackedDirt',
    'buildEnvironmentVariables'
  ]) {
    invariant(
      Array.isArray(value[field]) && value[field].length === 0,
      `${label} ${field} is not empty`
    )
  }
  for (const field of [
    'sourceDigest',
    'buildEnvironmentDigest',
    'runnerSha256',
    'artifactDigest',
    'outDigest',
    'companionSha256',
    'bridgeDaemonSha256',
    'fixtureSha256'
  ]) {
    invariant(
      typeof value[field] === 'string' && value[field].length === 64,
      `${label} ${field} is invalid`
    )
  }
  for (const field of ['sourceCount', 'artifactCount', 'outCount', 'fixtureByteLength']) {
    invariant(
      Number.isSafeInteger(value[field]) && value[field] > 0,
      `${label} ${field} is invalid`
    )
  }
  invariant(
    value.buildEnvironmentCount === 0 &&
      JSON.stringify(value.expectedSupportHashes) === JSON.stringify(value.supportHashes),
    `${label} build environment or support hashes changed`
  )
  invariant(isRecord(value.protectedPathScope), `${label} protected path scope is absent`)
  return value
}

function validateExpectedAsset(value, sourceCustody) {
  invariant(isRecord(value), 'Outcome 7 asset is absent')
  const keys = Object.keys(value).sort()
  const base = [...EXACT_KEYS.asset].sort()
  const pinned = [...EXACT_KEYS.asset, 'sha256'].sort()
  invariant(
    JSON.stringify(keys) === JSON.stringify(base) ||
      JSON.stringify(keys) === JSON.stringify(pinned),
    'Outcome 7 asset keys are not exact'
  )
  invariant(
    typeof value.assetId === 'string' &&
      value.assetId &&
      path.isAbsolute(value.path) &&
      value.path !== path.parse(value.path).root &&
      value.mediaKind === 'video',
    'Outcome 7 asset identity is invalid'
  )
  if ('sha256' in value) {
    invariant(
      typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256),
      'Outcome 7 externally pinned asset digest is invalid'
    )
    invariant(
      Buffer.from(value.assetId, 'base64url').toString('hex') === value.sha256 &&
        sourceCustody.fixtureSha256 === value.sha256,
      'Outcome 7 asset id, external digest, and fixture custody disagree'
    )
  }
  return value
}

function validateOutcome7Evidence(evidence) {
  invariant(
    evidence?.schemaVersion === SCHEMA_VERSION && evidence?.kind === KIND,
    'Outcome 7 evidence identity is wrong'
  )
  invariant(evidence.ok === true, 'Outcome 7 evidence is not Green')
  invariant(
    JSON.stringify(evidence.selfCustodyBefore) === JSON.stringify(evidence.selfCustodyAfter),
    'runner or test mutated during the run'
  )
  validatePackageCustody(evidence.packageBefore, 'package before')
  validatePackageCustody(evidence.packageAfter, 'package after')
  invariant(
    JSON.stringify(evidence.packageBefore) === JSON.stringify(evidence.packageAfter),
    'package mutated during the run'
  )
  validateSourceCustody(evidence.sourceBefore, 'source before')
  validateSourceCustody(evidence.sourceAfter, 'source after')
  invariant(
    JSON.stringify(evidence.sourceBefore) === JSON.stringify(evidence.sourceAfter),
    'source custody mutated during the run'
  )
  validateExpectedAsset(evidence.asset, evidence.sourceBefore)
  const insert = exactInsert(evidence.proposal?.op, { assetId: evidence.asset.assetId })
  invariant(evidence.proposal?.visibleGhost === true, 'visible proposal ghost was not proven')
  validateGhostCheckpoint(evidence.proposal?.ghostPixels, 'visible ghost')
  invariant(
    evidence.proposal.proposalRevision + 1 === evidence.acceptance?.resolutionRevision,
    'proposal and acceptance revisions are not adjacent'
  )
  const acceptedOp = {
    type: 'resolve_proposal',
    proposalId: evidence.proposal.proposalId,
    decision: 'accept'
  }
  validateJournalDelta(
    evidence.acceptance.journalBefore,
    evidence.acceptance.journalAfter,
    acceptedOp
  )
  validateStaleControl(evidence.acceptance.staleControl)
  validateMaterialCheckpoint(evidence.acceptance.immediateCurrent, 'immediate Current')
  invariant(
    evidence.acceptance.immediateCurrent.beforeRestart === true,
    'Current was proven only after restart'
  )
  validateReplacement(evidence.restart, insert, evidence.asset)
  invariant(
    typeof evidence.supervisorBundle?.before?.bundlePath === 'string' &&
      evidence.supervisorBundle.before.bundlePath ===
        evidence.supervisorBundle?.after?.bundlePath &&
      typeof evidence.supervisorBundle.before.bundleSha256 === 'string' &&
      evidence.supervisorBundle.before.bundleSha256.length === 64 &&
      evidence.supervisorBundle.before.bundleSha256 ===
        evidence.supervisorBundle.after.bundleSha256,
    'compiled supervisor bundle custody changed'
  )
  validateRawHarnessEvidence(evidence.harness)
  const rawJourney = evidence.harness.value.journey
  invariant(
    JSON.stringify(rawJourney?.proposal) === JSON.stringify(evidence.proposal) &&
      JSON.stringify(rawJourney?.acceptance) === JSON.stringify(evidence.acceptance) &&
      JSON.stringify(rawJourney?.restart) === JSON.stringify(evidence.restart) &&
      JSON.stringify(rawJourney?.inspector) === JSON.stringify(evidence.supervisorBundle),
    'Outcome 7 projection differs from the sealed raw harness journey'
  )
  invariant(
    isRecord(evidence.harness.value.watchdogTerminal) &&
      JSON.stringify(evidence.harness.value.watchdogTerminal) ===
        JSON.stringify(evidence.watchdog?.terminal),
    'raw harness watchdog terminal does not join the promoted watchdog adoption proof'
  )
  validateRawWatchdogEvidence(
    evidence.watchdog,
    evidence.instanceId,
    evidence.harness.value.electron
  )
  return { ok: true, insert }
}

async function rawJournal(plan) {
  const entries = await harness.readStudioJournalOperations(plan)
  const journalPath = path.join(plan.studioStateDirectory, 'studio-project.journal.jsonl')
  const raw = await fsPromises.readFile(journalPath)
  return { entries, path: journalPath, byteLength: raw.length, sha256: sha256Bytes(raw) }
}

function workspaceFromReceipt(receipt, bounds) {
  const matches = (receipt?.actions || []).filter((action) => action.type === 'read-workspace')
  invariant(matches.length === 1, 'workspace receipt is not unique')
  return harness.validateStudioWorkspaceObservation(matches[0].workspace, bounds)
}

function screenshotFromReceipt(receipt) {
  const matches = (receipt?.actions || []).filter((action) => action.type === 'screenshot')
  invariant(matches.length === 1, 'screenshot receipt is not unique')
  return matches[0].screenshotPath
}

async function drive(plan, target, actions, adapters = {}) {
  const interactive = actions.some((action) => action.type === 'key' || action.type === 'click')
  return (adapters.runUiDriver || harness.runStudioUiDriver)(plan, target, actions, {
    ...(adapters.driverAdapters || {}),
    inputDelivery: interactive ? 'foreground-global-explicit' : 'background-observation-only',
    allowForegroundInput: interactive
  })
}

async function waitWorkspace(plan, target, predicate, adapters = {}) {
  const bounds = harness.resolveStudioWorkspaceWindow(target).bounds
  return (adapters.waitFor || harness.waitFor)({
    label: 'Outcome 7 exact workspace state',
    timeoutMs: 15_000,
    intervalMs: 100,
    probe: async () => {
      const receipt = await drive(plan, target, [{ type: 'read-workspace' }], adapters)
      const workspace = workspaceFromReceipt(receipt, bounds)
      return predicate(workspace) ? { receipt, workspace } : null
    }
  })
}

function locateSupervisorBundle() {
  const root = path.join(session.repoRoot, 'out', 'main')
  const pending = [root]
  const matches = []
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(candidate)
      else if (entry.isFile() && candidate.endsWith('.js')) {
        const source = fs.readFileSync(candidate, 'utf8')
        if (
          source.includes('await handleStudioMessage(this.store, value)') &&
          source.includes('hydration_served')
        ) {
          matches.push({ candidate, source })
        }
      }
    }
  }
  invariant(
    matches.length === 1,
    `Outcome 7 could not identify one compiled supervisor bundle: ${JSON.stringify(matches.map((entry) => entry.candidate))}`
  )
  const lines = matches[0].source.split(/\r?\n/)
  const responseAssignment = lines.findIndex((line) =>
    line.includes('await handleStudioMessage(this.store, value)')
  )
  const responseLine = lines.findIndex(
    (line, index) => index > responseAssignment && line.includes('if (response === null)')
  )
  const hydrationLine = lines.findIndex(
    (line) => line.includes('hydration_served') && line.includes('revision')
  )
  invariant(
    responseAssignment >= 0 && responseLine > responseAssignment && hydrationLine > responseLine,
    'compiled supervisor response/hydration seams are unavailable'
  )
  return {
    bundlePath: matches[0].candidate,
    bundleSha256: sha256File(matches[0].candidate),
    urlRegex: path.basename(matches[0].candidate).replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '$',
    responseLine,
    hydrationLine
  }
}

async function armSupervisorProbe(inspector) {
  const definition = locateSupervisorBundle()
  const hits = []
  let failure = null
  let pending = Promise.resolve()
  const remove = inspector.on('Debugger.paused', (params) => {
    pending = pending
      .then(async () => {
        const frame = params?.callFrames?.[0]
        invariant(frame?.callFrameId, 'supervisor probe paused without a call frame')
        const line = frame.location?.lineNumber
        const expression =
          line === definition.hydrationLine
            ? '({kind:"hydration",method:value?.method??null,childPid:child?.pid??null,revision:hydratedRevision,response})'
            : '({kind:"response",method:value?.method??null,params:value?.params??null,requestId:value?.id??null,childPid:child?.pid??null,response})'
        const evaluated = await inspector.post('Debugger.evaluateOnCallFrame', {
          callFrameId: frame.callFrameId,
          expression,
          returnByValue: true
        })
        invariant(!evaluated?.exceptionDetails, 'supervisor probe evaluation failed')
        hits.push({ line, observedAt: new Date().toISOString(), ...evaluated.result.value })
      })
      .catch((error) => {
        failure = error
      })
      .finally(() => inspector.post('Debugger.resume').catch((error) => (failure ||= error)))
  })
  await inspector.post('Debugger.enable')
  const response = await inspector.post('Debugger.setBreakpointByUrl', {
    lineNumber: definition.responseLine,
    urlRegex: definition.urlRegex
  })
  const hydration = await inspector.post('Debugger.setBreakpointByUrl', {
    lineNumber: definition.hydrationLine,
    urlRegex: definition.urlRegex
  })
  invariant(
    response?.breakpointId && response.locations?.length,
    'supervisor response breakpoint did not bind'
  )
  invariant(
    hydration?.breakpointId && hydration.locations?.length,
    'supervisor hydration breakpoint did not bind'
  )
  const waitForHits = async (predicate, label, timeoutMs = 30_000) => {
    const result = await harness.waitFor({
      label,
      timeoutMs,
      intervalMs: 25,
      probe: async () => {
        if (failure) throw failure
        await pending
        return predicate(hits) || null
      }
    })
    return result
  }
  return {
    definition,
    hits,
    waitForHits,
    async close() {
      await pending
      remove()
      await inspector
        .post('Debugger.removeBreakpoint', { breakpointId: response.breakpointId })
        .catch(() => {})
      await inspector
        .post('Debugger.removeBreakpoint', { breakpointId: hydration.breakpointId })
        .catch(() => {})
      await inspector.post('Debugger.disable').catch(() => {})
      if (failure) throw failure
    }
  }
}

function normalizedResolveHits(hits, proposalId, baseRevision) {
  return hits
    .filter(
      (hit) =>
        hit.kind === 'response' &&
        hit.method === 'studio/resolveProposal' &&
        hit.params?.proposalId === proposalId &&
        hit.params?.baseRevision === baseRevision
    )
    .map((hit) => {
      if (hit.response?.result) {
        return {
          kind: 'accepted',
          proposalId,
          baseRevision,
          revision: hit.response.result.revision,
          requestId: hit.requestId,
          raw: hit
        }
      }
      return {
        kind: hit.response?.error?.data?.studioCode,
        proposalId,
        baseRevision,
        currentRevision: hit.response?.error?.data?.currentRevision,
        requestId: hit.requestId,
        raw: hit
      }
    })
}

async function referenceCheckpoint(plan, target, workspace, insert, name, adapters = {}) {
  const captureReceipt = await drive(plan, target, [{ type: 'screenshot', name }], adapters)
  const capturePath = screenshotFromReceipt(captureReceipt)
  const referencePath = path.join(plan.artifactRoot, `${name}-source-reference.png`)
  const sourceSeconds = insert.sourceIn.n / insert.sourceIn.d
  const command = diagnostics.buildReferenceExtractCommand({
    assetPath: target.asset.assetPath,
    exactSourcePtsSeconds: sourceSeconds,
    referencePath
  })
  const referenceExecution = (adapters.runExact || session.runExact)(
    session.resolveMediaTool('ffmpeg'),
    command,
    {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024
    }
  )
  const bounds = harness.resolveStudioWorkspaceWindow(target).bounds
  const comparison = (adapters.compareReference || pixels.compareWindowCaptureToReference)(
    capturePath,
    referencePath,
    bounds,
    { sourceHostFrame: workspace.timelineHost.frame }
  )
  invariant(
    comparison.clean,
    `${name} material pixels are Red: ${JSON.stringify(comparison.metrics)}`
  )
  return {
    region: 'review-host',
    beforeRestart: name.startsWith('immediate'),
    capturePath,
    captureSha256: sha256File(capturePath),
    referencePath,
    referenceSha256: sha256File(referencePath),
    sourcePtsSeconds: sourceSeconds,
    comparison,
    referenceExecution: {
      command: referenceExecution.command,
      exitCode: referenceExecution.exitCode,
      stdoutSha256: sha256Bytes(referenceExecution.stdout || ''),
      stderrSha256: sha256Bytes(referenceExecution.stderr || '')
    },
    workspace,
    driverReceipt: captureReceipt
  }
}

function exactProcess(process, executableKey = 'expectedExecutable') {
  return {
    pid: process.pid,
    ppid: process.ppid,
    pgid: process.pgid,
    executable:
      process[executableKey] || process.expectedExecutable || process.command.split(' ')[0],
    command: process.command
  }
}

function hydrationDocument(hit, expectedRevision, expectedPid) {
  invariant(
    hit?.kind === 'hydration' && hit.childPid === expectedPid,
    'hydration hit child identity is wrong'
  )
  invariant(hit.revision === expectedRevision, 'hydration event revision is wrong')
  const result = hit.response?.result
  invariant(
    result?.revision === expectedRevision && isRecord(result.document),
    'hydration document response is absent'
  )
  return result.document
}

async function runSourceRangeJourney(plan, target, adapters = {}) {
  const base = await (adapters.driveBaseJourney || harness.driveStudioUiJourney)(
    plan,
    target,
    adapters
  )
  const currentTarget = { ...target, window: harness.resolveStudioWorkspaceWindow(target) }
  await drive(
    plan,
    currentTarget,
    [{ type: 'press-workspace-route', route: 'timeline', selectedAfter: false }],
    adapters
  )
  await drive(
    plan,
    currentTarget,
    [
      { type: 'key', key: 'tab' },
      { type: 'key', key: 'bracket-left' },
      { type: 'key', key: 'return' }
    ],
    adapters
  )
  const proposalEntry = await (adapters.waitJournal || harness.waitForStudioJournalOperation)(
    plan,
    { type: 'propose_edit' },
    { afterRevision: base.finalRevision }
  )
  const proposal = proposalEntry.op.proposal
  const insert = exactInsert(proposal.op, { assetId: target.asset.sha256 })
  const afterProposal = await rawJournal(plan)
  await drive(
    plan,
    currentTarget,
    [{ type: 'press-workspace-route', route: 'timeline', selectedAfter: true }],
    adapters
  )
  await waitWorkspace(
    plan,
    currentTarget,
    (workspace) =>
      workspace.timelineRoute.value === 'selected' && workspace.currentVersion.value === 'selected',
    adapters
  )
  const currentCapture = await drive(
    plan,
    currentTarget,
    [{ type: 'screenshot', name: 'outcome7-current-before-ghost' }],
    adapters
  )
  await drive(plan, currentTarget, [{ type: 'key', key: 'v' }], adapters)
  const proposed = await waitWorkspace(
    plan,
    currentTarget,
    (workspace) => workspace.proposedVersion.value === 'selected',
    adapters
  )
  const ghostCapture = await drive(
    plan,
    currentTarget,
    [{ type: 'screenshot', name: 'outcome7-visible-ghost' }],
    adapters
  )
  const ghostPixels = harness.compareStudioJourneyCaptures(
    screenshotFromReceipt(currentCapture),
    screenshotFromReceipt(ghostCapture),
    currentTarget.window.bounds,
    'review-host',
    proposed.workspace.timelineHost.frame
  )
  invariant(ghostPixels.ok === true, 'Outcome 7 visible ghost pixels are absent')

  const inspectorUrl = await (adapters.discoverMainInspectorUrl || discoverMainInspectorUrl)({
    port: plan.spawnPlan.mainInspectorPort
  })
  const inspector = await (adapters.attachMainInspector || attachMainInspectorSession)({
    webSocketDebuggerUrl: inspectorUrl
  })
  const probe = await (adapters.armSupervisorProbe || armSupervisorProbe)(inspector)
  const oldProcess = (adapters.exactCompanionProcess || session.exactCompanionProcess)(
    target.companion,
    target.electronPgid
  )
  const electronPid = oldProcess.ppid
  const expectedElectron = {
    pid: electronPid,
    pgid: target.electronPgid,
    executable: plan.packagedExecutablePath
  }
  const beforeAccept = await rawJournal(plan)
  let hostPaused = false
  let hostResumed = false
  const hostSignalTarget = { beforeStop: null, beforeContinue: null }
  try {
    hostSignalTarget.beforeStop = (adapters.exactElectronParent || exactElectronParent)(
      expectedElectron,
      adapters.processTableAdapters
    )
    ;(adapters.signal || process.kill)(electronPid, 'SIGSTOP')
    hostPaused = true
    await drive(
      plan,
      currentTarget,
      [
        { type: 'key', key: 'a' },
        { type: 'key', key: 'a' }
      ],
      adapters
    )
  } finally {
    if (hostPaused) {
      hostSignalTarget.beforeContinue = (adapters.exactElectronParent || exactElectronParent)(
        expectedElectron,
        adapters.processTableAdapters
      )
      ;(adapters.signal || process.kill)(electronPid, 'SIGCONT')
      hostResumed = true
    }
  }
  const resolutionEntry = await (adapters.waitJournal || harness.waitForStudioJournalOperation)(
    plan,
    { type: 'resolve_proposal', proposalId: proposal.proposalId, decision: 'accept' },
    { afterRevision: proposalEntry.revision }
  )
  const resolveHits = await probe.waitForHits((hits) => {
    const normalized = normalizedResolveHits(hits, proposal.proposalId, proposalEntry.revision)
    return normalized.length === 2 ? normalized : null
  }, 'one accepted and one stale Outcome 7 response')
  const afterAccept = await rawJournal(plan)
  const acceptedDelta = validateJournalDelta(beforeAccept.entries, afterAccept.entries, {
    type: 'resolve_proposal',
    proposalId: proposal.proposalId,
    decision: 'accept'
  })
  const staleControl = {
    proposalId: proposal.proposalId,
    hostPaused,
    hostResumed,
    acceptRequests: 2,
    hostSignalTarget,
    responses: resolveHits
  }
  validateStaleControl(staleControl)

  const immediate = await waitWorkspace(
    plan,
    currentTarget,
    (workspace) =>
      workspace.timelineRoute.value === 'selected' &&
      workspace.currentVersion.value === 'selected' &&
      workspace.proposedVersion.value === 'not selected',
    adapters
  )
  await drive(
    plan,
    currentTarget,
    [
      {
        type: 'set-playhead-ticks',
        playheadTicks: insert.at.n,
        playheadToleranceTicks: 0,
        playheadMaximumForwardAdvanceTicks: 0
      }
    ],
    adapters
  )
  const immediateCurrent = await referenceCheckpoint(
    plan,
    currentTarget,
    immediate.workspace,
    insert,
    'immediate-current',
    adapters
  )

  const journalBeforeRestart = await rawJournal(plan)
  const beforeKillProcess = (adapters.exactCompanionSignalTarget || exactCompanionSignalTarget)(
    oldProcess,
    adapters.processTableAdapters
  )
  ;(adapters.signal || process.kill)(beforeKillProcess.pid, 'SIGKILL')
  await harness.waitFor({
    label: 'old Outcome 7 Companion disappearance',
    timeoutMs: 20_000,
    intervalMs: 50,
    probe: async () => (lifecycle.processExists(oldProcess.pid) ? null : true)
  })
  const replacementCandidate = await harness.waitFor({
    label: 'replacement Outcome 7 Companion',
    timeoutMs: 30_000,
    intervalMs: 100,
    probe: async () => {
      const candidate = await harness.findStudioCompanion(electronPid)
      return candidate.pid === oldProcess.pid ? null : candidate
    }
  })
  const replacementProcess = (adapters.exactCompanionProcess || session.exactCompanionProcess)(
    replacementCandidate,
    oldProcess.pgid
  )
  const hydrationHit = await probe.waitForHits(
    (hits) =>
      hits.find(
        (hit) =>
          hit.kind === 'hydration' &&
          hit.childPid === replacementCandidate.pid &&
          hit.revision === resolutionEntry.revision
      ) || null,
    'replacement accepted-insertion hydration'
  )
  const document = hydrationDocument(
    hydrationHit,
    resolutionEntry.revision,
    replacementCandidate.pid
  )
  const journalAfterHydration = await rawJournal(plan)
  invariant(
    journalAfterHydration.sha256 === journalBeforeRestart.sha256,
    'restart hydration mutated journal bytes'
  )
  const hidden = await (adapters.probeHiddenWindow || lifecycle.probeNativeWindowIncludingZero)(
    replacementCandidate.pid
  )
  invariant(hidden.visibleWindowCount === 0, 'replacement presented a window during hydration')

  const renderer = await (adapters.attachRenderer || attachRendererCdpSession)({
    port: plan.spawnPlan.remoteDebuggingPort
  })
  let reopen
  try {
    reopen = await (adapters.invokeStudioOpen || session.invokeStudioOpen)(renderer, target.asset)
  } finally {
    renderer.close()
  }
  invariant(reopen?.ok === true, 'replacement same-asset reopen failed')
  const reopenEntry = await (adapters.waitJournal || harness.waitForStudioJournalOperation)(
    plan,
    { type: 'open_media', assetId: target.asset.sha256 },
    { afterRevision: resolutionEntry.revision }
  )
  invariant(
    reopenEntry.revision === resolutionEntry.revision + 1 &&
      reopenEntry.op?.asset?.assetId === target.asset.sha256 &&
      path.resolve(String(reopenEntry.op.asset.path || '')) ===
        path.resolve(target.asset.assetPath) &&
      reopenEntry.op.asset.mediaKind === 'video',
    'replacement reopen journal target is not exact'
  )
  const replacementWindow = await (adapters.waitForSourceWindow || session.waitForSourceWindow)(
    replacementCandidate
  )
  const replacementTarget = {
    ...target,
    companion: replacementCandidate,
    window: replacementWindow
  }
  const exactReplacementWindow = harness.resolveStudioWorkspaceWindow(replacementTarget)
  invariant(
    replacementWindow.pid === replacementCandidate.pid &&
      replacementWindow.visibleWindowCount === 1 &&
      replacementWindow.windows.length === 1 &&
      exactReplacementWindow.title === 'TaskWraith Studio' &&
      Number.isSafeInteger(exactReplacementWindow.windowId) &&
      exactReplacementWindow.windowId > 0 &&
      exactReplacementWindow.windowId !== currentTarget.window.windowId,
    'replacement visible window PID/title/id is not new and exact'
  )
  await drive(
    plan,
    replacementTarget,
    [{ type: 'press-workspace-route', route: 'timeline', selectedAfter: true }],
    adapters
  )
  const replayWorkspace = await waitWorkspace(
    plan,
    replacementTarget,
    (workspace) =>
      workspace.timelineRoute.value === 'selected' && workspace.currentVersion.value === 'selected',
    adapters
  )
  await drive(
    plan,
    replacementTarget,
    [
      {
        type: 'set-playhead-ticks',
        playheadTicks: insert.at.n,
        playheadToleranceTicks: 0,
        playheadMaximumForwardAdvanceTicks: 0
      }
    ],
    adapters
  )
  const replayedCurrent = await referenceCheckpoint(
    plan,
    replacementTarget,
    replayWorkspace.workspace,
    insert,
    'replayed-current',
    adapters
  )
  const journalAfterReopen = await rawJournal(plan)
  const explicitDelta = validateJournalDelta(
    journalAfterHydration.entries,
    journalAfterReopen.entries,
    {
      type: 'open_media',
      asset: journalAfterReopen.entries.at(-1).op.asset
    }
  )
  invariant(
    explicitDelta.appended.op.asset.assetId === target.asset.sha256,
    'replacement reopened the wrong asset'
  )
  const supervisorBundleAfter = (adapters.locateSupervisorBundle || locateSupervisorBundle)()
  invariant(
    supervisorBundleAfter.bundlePath === probe.definition.bundlePath &&
      supervisorBundleAfter.bundleSha256 === probe.definition.bundleSha256,
    'compiled supervisor bundle changed during Outcome 7'
  )
  await probe.close()
  inspector.close()

  return {
    kind: `${KIND}-journey`,
    baseJourney: base,
    proposal: {
      proposalId: proposal.proposalId,
      proposalRevision: proposalEntry.revision,
      op: proposal.op,
      visibleGhost: true,
      ghostPixels: {
        region: 'review-host',
        captureSha256: sha256File(screenshotFromReceipt(ghostCapture)),
        referenceSha256: sha256File(screenshotFromReceipt(currentCapture)),
        comparison: ghostPixels
      },
      journalAfterProposal: afterProposal
    },
    acceptance: {
      resolutionRevision: resolutionEntry.revision,
      journalBefore: beforeAccept.entries,
      journalAfter: afterAccept.entries,
      journalDelta: acceptedDelta,
      staleControl,
      immediateCurrent
    },
    restart: {
      oldProcess: exactProcess(oldProcess),
      beforeKillProcess,
      replacementProcess: exactProcess(replacementProcess),
      oldProcessDisappeared: !lifecycle.processExists(oldProcess.pid),
      hydration: {
        ordered: true,
        rawHit: hydrationHit,
        proposalsEmpty: Array.isArray(document.proposals) && document.proposals.length === 0,
        assets: document.assets,
        tracks: document.tracks,
        windowCount: hidden.visibleWindowCount,
        journalBeforeSha256: journalBeforeRestart.sha256,
        journalAfterSha256: journalAfterHydration.sha256,
        journalBeforeRevision: journalBeforeRestart.entries.at(-1).revision,
        journalAfterRevision: journalAfterHydration.entries.at(-1).revision
      },
      explicitReopen: {
        sameAsset: explicitDelta.appended.op.asset.assetId === target.asset.sha256,
        newVisibleWindow: replacementWindow.visibleWindowCount === 1,
        journalEntry: reopenEntry,
        window: {
          pid: replacementCandidate.pid,
          windowId: exactReplacementWindow.windowId,
          title: exactReplacementWindow.title,
          bounds: exactReplacementWindow.bounds,
          executable: exactProcess(replacementProcess).executable
        },
        journalDelta: explicitDelta
      },
      oldWindowId: currentTarget.window.windowId,
      replayedCurrent
    },
    inspector: {
      before: probe.definition,
      after: supervisorBundleAfter,
      hits: probe.hits
    }
  }
}

function rawTerminalReceipts(artifactRoot, returnedEvidence) {
  const harnessPath = path.join(artifactRoot, 'studio-acceptance-evidence.json')
  const harnessReceipt = readExactJsonReceipt(harnessPath, 'raw harness evidence')
  const watchdogPath = safeAbsolute(
    harnessReceipt.value?.watchdogReceiptPath,
    'raw harness watchdog receipt'
  )
  const watchdogReceipt = readExactJsonReceipt(
    watchdogPath,
    'raw watchdog receipt',
    4 * 1024 * 1024
  )
  const harness = {
    ...harnessReceipt,
    watchdogReceiptPath: watchdogPath
  }
  const watchdog = {
    ...watchdogReceipt,
    terminal: harnessReceipt.value.watchdogTerminal
  }
  invariant(
    isRecord(harnessReceipt.value.watchdogTerminal) &&
      JSON.stringify(harnessReceipt.value.watchdogTerminal) ===
        JSON.stringify(returnedEvidence.watchdogTerminal),
    'returned watchdog terminal differs from the sealed harness evidence'
  )
  invariant(
    isRecord(harnessReceipt.value.electron) &&
      JSON.stringify(harnessReceipt.value.electron) === JSON.stringify(returnedEvidence.electron),
    'disk harness Electron identity differs from the returned identity'
  )
  return { harness, watchdog }
}

function assertLiveAdapterBoundary(adapters) {
  if (Object.keys(adapters).length === 0) return
  invariant(
    process.env.TASKWRAITH_STUDIO_ACCEPTANCE_TEST === '1' && adapters.testOnly === true,
    'live Outcome 7 adapter overrides are test-only and unavailable to the CLI'
  )
}

function buildHarnessRunOptions(normalized, adapters = {}) {
  return {
    args: {
      launch: true,
      acceptLaunch: normalized.acceptLaunch,
      ownerConfirmsOrphansCleared: normalized.ownerConfirmsOrphansCleared,
      instanceId: normalized.instanceId,
      generateSpeechFixture: normalized.generateSpeechFixture,
      mediaPath: normalized.mediaPath,
      mimeType: normalized.mimeType,
      packagedExecutablePath: normalized.packagedExecutablePath,
      remoteDebuggingPort: normalized.remoteDebuggingPort,
      mainInspectorPort: normalized.mainInspectorPort,
      timeoutMs: normalized.timeoutMs,
      transcriptTimeoutMs: normalized.transcriptTimeoutMs
    },
    adapters: {
      ...adapters,
      openAdapters: {
        ...(adapters.openAdapters || {}),
        timeoutMs: normalized.openTimeoutMs
      },
      planOptions: { ...(adapters.planOptions || {}), artifactRoot: normalized.artifactRoot },
      driveUiJourney: (plan, target, journeyAdapters) =>
        runSourceRangeJourney(plan, target, { ...adapters, ...journeyAdapters })
    }
  }
}

async function runLiveAcceptance(options = {}, adapters = {}) {
  const normalized = normalizeOptions(options)
  if (!normalized.launch) return buildPlan(normalized)
  assertLiveAdapterBoundary(adapters)
  const selfCustodyBefore = (adapters.assertSelfCustody || assertSelfCustody)(adapters.selfAdapters)
  const runStudioAcceptance = adapters.runStudioAcceptance || harness.runStudioAcceptance
  const invocation = buildHarnessRunOptions(normalized, adapters)
  const result = await runStudioAcceptance(invocation.args, invocation.adapters)
  invariant(
    result?.launched === true && result.evidence?.ok === true,
    'base acceptance did not finish'
  )
  const selfCustodyAfter = (adapters.assertSelfCustody || assertSelfCustody)(adapters.selfAdapters)
  const journey = result.evidence.journey
  const terminals = rawTerminalReceipts(normalized.artifactRoot, result.evidence)
  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    ok: true,
    recordedAt: new Date().toISOString(),
    instanceId: normalized.instanceId,
    asset: {
      assetId: result.evidence.asset.sha256,
      path: result.evidence.asset.assetPath,
      mediaKind: 'video',
      sha256: result.evidence.custodyFixture.sha256
    },
    selfCustodyBefore,
    selfCustodyAfter,
    packageBefore: result.evidence.packagedExecutionBefore,
    packageAfter: result.evidence.packagedExecutionAfter,
    sourceBefore: result.evidence.custodyBefore,
    sourceAfter: result.evidence.custodyAfter,
    proposal: journey.proposal,
    acceptance: journey.acceptance,
    restart: journey.restart,
    supervisorBundle: journey.inspector,
    harness: terminals.harness,
    watchdog: terminals.watchdog
  }
  validateOutcome7Evidence(evidence)
  const evidencePath = path.join(normalized.artifactRoot, 'source-range-lifecycle-evidence.json')
  await (adapters.writeJson || session.writeJson)(evidencePath, evidence)
  return { launched: true, evidencePath, evidenceSha256: sha256File(evidencePath), evidence }
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv)
  if (parsed.help) {
    process.stdout.write(
      'Usage: studio-source-range-lifecycle-runner.cjs [--launch --i-accept-studio-isolated-launch --owner-confirms-existing-orphans-cleared] --instance-id ID --artifact-root PATH --packaged-executable PATH (--generate-speech-fixture | --media PATH --mime video/mp4) [--remote-debugging-port=N --main-inspector-port=N --open-timeout-ms=180000]\n'
    )
    return { help: true }
  }
  const result = await runLiveAcceptance(parsed)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[studio-source-range-lifecycle-runner] FAIL — ${error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TRANSCRIPT_TIMEOUT_MS,
  DEFAULT_OPEN_TIMEOUT_MS,
  KIND,
  SCHEMA_VERSION,
  armSupervisorProbe,
  assertSelfCustody,
  buildPlan,
  buildHarnessRunOptions,
  defaultArtifactRoot,
  exactInsert,
  journalBoundary,
  locateSupervisorBundle,
  main,
  normalizeOptions,
  normalizedResolveHits,
  parseCli,
  runLiveAcceptance,
  runSourceRangeJourney,
  validateJournalDelta,
  validateOutcome7Evidence,
  validateReplacement,
  validateStaleControl
}
