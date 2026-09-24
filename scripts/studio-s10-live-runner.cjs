#!/usr/bin/env node
'use strict'

/**
 * Packaged S10 Studio endurance acceptance orchestrator.
 *
 * This file composes the existing harness, A/V endurance join, diagnostics,
 * acceptance-session resource sampler, and exact window-close helper.  It is
 * plan-only by default.  A live run fails closed unless every operation that
 * cannot be proven by the existing harness is supplied as an explicit adapter;
 * no adapter is allowed to manufacture a green phase receipt.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsPromises = require('node:fs/promises')
const path = require('node:path')

const mediaLimits = require('../src/shared/mediaLimits.json')
const harness = require('./studio-acceptance-harness.cjs')
const { hasVerifiedLaunchServicesExit } = require('./studio-acceptance-watchdog.cjs')
const acceptanceSession = require('./studio-acceptance-session.cjs')
const diagnostics = require('./studio-bounded-diagnostics-runner.cjs')
const avAcceptance = require('./studio-av-endurance-acceptance-runner.cjs')
const avCore = require('./studio-av-endurance-runner.cjs')
const avLive = require('./studio-av-endurance-live-runner.cjs')
const pixelVerifier = require('./studio-pixel-evidence-verifier.cjs')
const ownedResourceEvidence = require('./studio-resource-evidence.cjs')

const S10_SCHEMA_VERSION = 1
const PRIMARY_MIN_DURATION_SECONDS = 630
const LOOP_MIN_DURATION_SECONDS = 600
const SAMPLE_COUNT = avAcceptance.SAMPLE_COUNT
const SEEK_COUNT = 100
const ALTERNATING_OPEN_COUNT = 20
const ROUTE_CYCLE_COUNT = 10
const CLOSE_REOPEN_COUNT = 10
const LOOP_SETUP_KEYS = ['i', 'o', 'l', 'p']
const MAX_VIDEO_BYTES = mediaLimits.transcriptMediaMaxVideoBytes
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024
const S10_RUNNER_RELATIVE_PATH = 'scripts/studio-s10-live-runner.cjs'
const S10_RESOURCE_HELPER_RELATIVE_PATH = 'scripts/studio-resource-evidence.cjs'
const EXPECTED_CLOSE_HELPER = 'scripts/studio-endurance-window-control.swift'
const COOLDOWN_MEMORY_RETURN_BUDGET_BYTES = 24 * 1_048_576
const COOLDOWN_SAMPLE_INTERVAL_MS = 2_000
const ZERO_COPY_PATHS = [
  'swift/TaskWraithBridge/Sources/TaskWraithStudioCore/StudioVideoTextureBridge.swift',
  'swift/TaskWraithBridge/Sources/TaskWraithStudioCore/StudioVideoFrameSource.swift',
  'src/renderer/src/App.tsx'
]

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function readBoundedJson(filePath, label) {
  const stat = await fsPromises.lstat(filePath)
  invariant(
    stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_EVIDENCE_BYTES,
    `${label} is not a bounded regular file`
  )
  return JSON.parse(await fsPromises.readFile(filePath, 'utf8'))
}

async function assertBoundedArtifactFile(filePath, artifactRoot, label) {
  const resolved = path.resolve(String(filePath || ''))
  const relative = path.relative(path.resolve(artifactRoot), resolved)
  invariant(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    `${label} escaped the artifact root`
  )
  const stat = await fsPromises.lstat(resolved)
  invariant(
    stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_EVIDENCE_BYTES,
    `${label} is not a bounded regular file`
  )
  const canonicalRoot = await fsPromises.realpath(artifactRoot)
  const canonical = await fsPromises.realpath(resolved)
  const canonicalRelative = path.relative(canonicalRoot, canonical)
  invariant(
    canonicalRelative && !canonicalRelative.startsWith('..') && !path.isAbsolute(canonicalRelative),
    `${label} resolves outside the artifact root`
  )
  return { path: resolved, byteLength: stat.size, sha256: await sha256File(resolved) }
}

async function assertNoVisibleStudioWindow(pid, probe) {
  try {
    await probe(pid)
  } catch (error) {
    invariant(
      error instanceof Error &&
        error.message === `No on-screen native Studio window for exact pid ${pid}`,
      `S10 native-window probe failed indeterminately: ${error instanceof Error ? error.message : String(error)}`
    )
    return { closed: true, exactPid: pid, reason: error.message }
  }
  throw new Error(`S10 exact pid ${pid} still has an on-screen native Studio window`)
}

async function measureHeadBoundSources(repoRoot, relativePaths, adapters = {}) {
  const runExact = adapters.runExact || acceptanceSession.runExact
  const measured = {}
  for (const relativePath of relativePaths) {
    await runExact('git', ['diff', '--quiet', 'HEAD', '--', relativePath], {
      cwd: repoRoot,
      timeout: 30_000,
      maxBuffer: 4_096
    })
    const headBlob = String(
      (
        await runExact('git', ['rev-parse', `HEAD:${relativePath}`], {
          cwd: repoRoot,
          timeout: 30_000,
          maxBuffer: 4_096
        })
      ).stdout
    ).trim()
    invariant(/^[a-f0-9]{40,64}$/.test(headBlob), `S10 HEAD blob is invalid for ${relativePath}`)
    measured[relativePath] = {
      sha256: await sha256File(path.join(repoRoot, relativePath)),
      headBlob
    }
  }
  return measured
}

async function measureS10RunnerCustody(repoRoot, adapters = {}) {
  const runExact = adapters.runExact || acceptanceSession.runExact
  const runGit = (args, maxBuffer = 4_096) =>
    runExact('git', args, { cwd: repoRoot, timeout: 30_000, maxBuffer })
  const gitHead = String((await runGit(['rev-parse', 'HEAD'])).stdout).trim()
  invariant(/^[a-f0-9]{40,64}$/.test(gitHead), 'S10 runner git HEAD receipt is invalid')
  const tracked = String((await runGit(['ls-files', '--', S10_RUNNER_RELATIVE_PATH])).stdout).trim()
  invariant(tracked === S10_RUNNER_RELATIVE_PATH, 'S10 runner must be tracked at the live boundary')
  const status = String(
    (await runGit(['status', '--porcelain=v1', '--', S10_RUNNER_RELATIVE_PATH])).stdout
  ).trim()
  invariant(status === '', 'S10 runner is dirty at the live boundary')
  const headSpec = `${gitHead}:${S10_RUNNER_RELATIVE_PATH}`
  const headBlob = String((await runGit(['rev-parse', headSpec])).stdout).trim()
  invariant(/^[a-f0-9]{40,64}$/.test(headBlob), 'S10 runner HEAD blob is invalid')
  const headSource = (await runGit(['show', headSpec], MAX_EVIDENCE_BYTES)).stdout
  const sha256 = await sha256File(path.join(repoRoot, S10_RUNNER_RELATIVE_PATH))
  invariant(sha256 === sha256Text(headSource), 'S10 runner bytes differ from HEAD')
  const dependencies = await measureHeadBoundSources(
    repoRoot,
    [S10_RESOURCE_HELPER_RELATIVE_PATH],
    adapters
  )
  const dependencySource = (
    await runGit(['show', `${gitHead}:${S10_RESOURCE_HELPER_RELATIVE_PATH}`], MAX_EVIDENCE_BYTES)
  ).stdout
  invariant(
    dependencies[S10_RESOURCE_HELPER_RELATIVE_PATH].sha256 === sha256Text(dependencySource),
    'S10 resource helper bytes differ from HEAD'
  )
  invariant(
    gitHead === String((await runGit(['rev-parse', 'HEAD'])).stdout).trim(),
    'S10 runner git HEAD changed while measuring source custody'
  )
  return { gitHead, headBlob, sha256, dependencies }
}

function originallyAbsolute(value, label) {
  const raw = String(value || '')
  invariant(path.isAbsolute(raw), `${label} must be originally absolute`)
  const resolved = path.resolve(raw)
  invariant(resolved !== path.parse(resolved).root, `${label} must not be filesystem root`)
  return resolved
}

function parseInteger(value, label, minimum, maximum) {
  const parsed = Number(value)
  invariant(
    Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum,
    `${label} is invalid`
  )
  return parsed
}

function companionExecutablePath(target) {
  const command = String(target?.companion?.command || '')
  const suffix = 'TaskWraithStudioCompanion'
  const suffixIndex = command.indexOf(suffix)
  invariant(suffixIndex >= 0, 'S10 exact Companion executable path is unavailable')
  return command.slice(0, suffixIndex + suffix.length)
}

function parseS10Cli(argv = []) {
  const parsed = {
    help: false,
    launch: false,
    acceptLaunch: false,
    ownerConfirmsOrphansCleared: false,
    acceptBoundedForegroundLoopSetup: false,
    artifactRoot: null,
    instanceId: null,
    packagedExecutablePath: null,
    primaryMediaPath: null,
    primaryMimeType: null,
    secondaryMediaPath: null,
    secondaryMimeType: null,
    loopStartTicks: null,
    loopEndTicks: null,
    loopTimebaseTicks: null,
    timeoutMs: 30 * 60 * 1_000,
    openTimeoutMs: 180_000
  }
  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') parsed.help = true
    else if (argument === '--launch') parsed.launch = true
    else if (argument === '--i-accept-studio-isolated-launch') parsed.acceptLaunch = true
    else if (argument === '--owner-confirms-existing-orphans-cleared')
      parsed.ownerConfirmsOrphansCleared = true
    else if (argument === '--i-accept-bounded-foreground-loop-setup')
      parsed.acceptBoundedForegroundLoopSetup = true
    else if (argument.startsWith('--artifact-root=')) parsed.artifactRoot = argument.slice(16)
    else if (argument.startsWith('--instance-id=')) parsed.instanceId = argument.slice(14)
    else if (argument.startsWith('--packaged-executable='))
      parsed.packagedExecutablePath = argument.slice('--packaged-executable='.length)
    else if (argument.startsWith('--primary-media='))
      parsed.primaryMediaPath = argument.slice('--primary-media='.length)
    else if (argument.startsWith('--primary-mime='))
      parsed.primaryMimeType = argument.slice('--primary-mime='.length)
    else if (argument.startsWith('--secondary-media='))
      parsed.secondaryMediaPath = argument.slice('--secondary-media='.length)
    else if (argument.startsWith('--secondary-mime='))
      parsed.secondaryMimeType = argument.slice('--secondary-mime='.length)
    else if (argument.startsWith('--loop-start-ticks='))
      parsed.loopStartTicks = parseInteger(
        argument.slice('--loop-start-ticks='.length),
        'loop-start-ticks',
        0,
        Number.MAX_SAFE_INTEGER
      )
    else if (argument.startsWith('--loop-end-ticks='))
      parsed.loopEndTicks = parseInteger(
        argument.slice('--loop-end-ticks='.length),
        'loop-end-ticks',
        1,
        Number.MAX_SAFE_INTEGER
      )
    else if (argument.startsWith('--loop-timebase-ticks='))
      parsed.loopTimebaseTicks = parseInteger(
        argument.slice('--loop-timebase-ticks='.length),
        'loop-timebase-ticks',
        1,
        Number.MAX_SAFE_INTEGER
      )
    else if (argument.startsWith('--timeout-ms='))
      parsed.timeoutMs = parseInteger(argument.slice(13), 'timeout-ms', 30_000, 30 * 60 * 1_000)
    else if (argument.startsWith('--open-timeout-ms='))
      parsed.openTimeoutMs = parseInteger(argument.slice(18), 'open-timeout-ms', 45_000, 5 * 60_000)
    else throw new Error(`unknown S10 argument: ${argument}`)
  }
  return parsed
}

function normalizeS10Options(options = {}) {
  const repoRoot = originallyAbsolute(options.repoRoot || acceptanceSession.repoRoot, 'repoRoot')
  const instanceId = String(options.instanceId || `s10-${crypto.randomBytes(6).toString('hex')}`)
  const artifactRoot = originallyAbsolute(
    options.artifactRoot ||
      path.join(repoRoot, '.local-only', 'taskwraith-studio', 'acceptance', instanceId),
    'artifactRoot'
  )
  const args = {
    launch: options.launch === true,
    acceptLaunch: options.acceptLaunch === true,
    ownerConfirmsOrphansCleared: options.ownerConfirmsOrphansCleared === true,
    acceptBoundedForegroundLoopSetup: options.acceptBoundedForegroundLoopSetup === true,
    repoRoot,
    artifactRoot,
    instanceId,
    packagedExecutablePath: options.packagedExecutablePath
      ? originallyAbsolute(options.packagedExecutablePath, 'packagedExecutablePath')
      : null,
    primaryMediaPath: options.primaryMediaPath
      ? originallyAbsolute(options.primaryMediaPath, 'primaryMediaPath')
      : null,
    primaryMimeType: options.primaryMimeType || null,
    secondaryMediaPath: options.secondaryMediaPath
      ? originallyAbsolute(options.secondaryMediaPath, 'secondaryMediaPath')
      : null,
    secondaryMimeType: options.secondaryMimeType || null,
    loopStartTicks:
      options.loopStartTicks == null
        ? null
        : parseInteger(options.loopStartTicks, 'loopStartTicks', 0, Number.MAX_SAFE_INTEGER),
    loopEndTicks:
      options.loopEndTicks == null
        ? null
        : parseInteger(options.loopEndTicks, 'loopEndTicks', 1, Number.MAX_SAFE_INTEGER),
    loopTimebaseTicks:
      options.loopTimebaseTicks == null
        ? null
        : parseInteger(options.loopTimebaseTicks, 'loopTimebaseTicks', 1, Number.MAX_SAFE_INTEGER),
    timeoutMs: parseInteger(
      options.timeoutMs ?? 30 * 60 * 1_000,
      'timeoutMs',
      30_000,
      30 * 60 * 1_000
    ),
    openTimeoutMs: parseInteger(
      options.openTimeoutMs ?? 180_000,
      'openTimeoutMs',
      45_000,
      5 * 60_000
    )
  }
  invariant(/^[A-Za-z0-9][A-Za-z0-9_-]{1,15}$/.test(args.instanceId), 'instanceId is invalid')
  invariant(
    args.openTimeoutMs + 30_000 <= args.timeoutMs,
    'openTimeoutMs leaves less than 30000ms watchdog budget'
  )
  if (args.launch) {
    invariant(
      args.acceptLaunch && args.ownerConfirmsOrphansCleared,
      'S10 launch requires both packaged launch interlocks'
    )
    invariant(
      args.acceptBoundedForegroundLoopSetup,
      'S10 launch requires --i-accept-bounded-foreground-loop-setup'
    )
    invariant(args.packagedExecutablePath, 'S10 launch requires --packaged-executable')
    invariant(
      args.primaryMediaPath && args.secondaryMediaPath,
      'S10 launch requires distinct primary and secondary media'
    )
    invariant(
      Number.isSafeInteger(args.loopStartTicks) &&
        Number.isSafeInteger(args.loopEndTicks) &&
        Number.isSafeInteger(args.loopTimebaseTicks) &&
        args.loopEndTicks - args.loopStartTicks >= SEEK_COUNT + 1,
      'S10 launch requires exact --loop-start-ticks and --loop-end-ticks because the tracked UI driver has no playhead-range read API'
    )
    const loopDurationSeconds = (args.loopEndTicks - args.loopStartTicks) / args.loopTimebaseTicks
    invariant(
      loopDurationSeconds > avCore.NOMINAL_CADENCE_SECONDS * 2 &&
        loopDurationSeconds <= LOOP_MIN_DURATION_SECONDS,
      'S10 loop duration must exceed the maximum 60s adjacent-sample interval and be at most 600s'
    )
    invariant(
      args.primaryMediaPath !== args.secondaryMediaPath,
      'S10 primary and secondary media must be distinct paths'
    )
    for (const [label, mediaPath, mime] of [
      ['primary', args.primaryMediaPath, args.primaryMimeType],
      ['secondary', args.secondaryMediaPath, args.secondaryMimeType]
    ]) {
      invariant(
        ['video/mp4', 'video/quicktime'].includes(String(mime || '').toLowerCase()),
        `S10 ${label} media MIME is unsupported`
      )
      const stat = fs.lstatSync(mediaPath)
      invariant(
        stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= MAX_VIDEO_BYTES,
        `S10 ${label} media is not a bounded regular file`
      )
    }
  }
  return args
}

function buildS10Plan(options = {}) {
  const args = normalizeS10Options(options)
  const blockers = []
  if (!args.primaryMediaPath || !args.secondaryMediaPath)
    blockers.push('launch requires absolute primary and secondary media paths')
  if (
    args.launch &&
    (!Number.isSafeInteger(args.loopStartTicks) || !Number.isSafeInteger(args.loopEndTicks))
  )
    blockers.push(
      'tracked UI driver has no playhead-range read API; launch requires explicit loop tick boundaries'
    )
  return {
    schemaVersion: S10_SCHEMA_VERSION,
    kind: 'taskwraith-studio-s10-acceptance-plan',
    instanceId: args.instanceId,
    artifactRoot: args.artifactRoot,
    launch: args.launch,
    interlocks: {
      packagedLaunch: '--i-accept-studio-isolated-launch',
      ownerOrphans: '--owner-confirms-existing-orphans-cleared',
      boundedForegroundLoopSetup: '--i-accept-bounded-foreground-loop-setup',
      foregroundInputOutsideSetup: false
    },
    workload: {
      primaryMinimumDurationSeconds: PRIMARY_MIN_DURATION_SECONDS,
      loopMinimumSeconds: LOOP_MIN_DURATION_SECONDS,
      alignedSamples: SAMPLE_COUNT,
      exactPlayheadSeeks: SEEK_COUNT,
      alternatingAssetOpens: ALTERNATING_OPEN_COUNT,
      sourceTimelineHideShowCycles: ROUTE_CYCLE_COUNT,
      exactWindowCloseReopenCycles: CLOSE_REOPEN_COUNT,
      loopSetupKeys: LOOP_SETUP_KEYS
    },
    phases: [
      'materialize-two-distinct-assets',
      'capture-renderer-before-open',
      'establish-real-marked-loop',
      'looped-playback-21-aligned-samples',
      '100-exact-playhead-seeks',
      '20-alternating-asset-opens',
      '10-source-timeline-hide-show-cycles',
      '10-exact-window-close-reopen-cycles',
      'final-close-cooldown-and-resource-verdict',
      'post-reap-final-evidence'
    ],
    blockers,
    safety: {
      planOnlyByDefault: true,
      disposableProfileRequired: true,
      noForegroundOutsideLoopSetup: true,
      noFakeLoopOrRepeatedSeekSubstitute: true,
      noGreenWhenPhaseMissing: true,
      noProductOrHarnessEdits: true
    },
    args
  }
}

async function materializeS10Assets(plan, args, adapters = {}) {
  invariant(
    args.primaryMediaPath && args.secondaryMediaPath,
    'S10 asset materialization requires both media paths'
  )
  const materialize = adapters.materializeOwnedMedia || harness.materializeOwnedMedia
  const primary = await materialize({
    mediaPath: args.primaryMediaPath,
    mimeType: args.primaryMimeType,
    userDataPath: plan.profile.userDataPath
  })
  const secondary = await materialize({
    mediaPath: args.secondaryMediaPath,
    mimeType: args.secondaryMimeType,
    userDataPath: plan.profile.userDataPath
  })
  invariant(
    primary.sha256 !== secondary.sha256,
    'S10 primary and secondary assets must have distinct hashes'
  )
  for (const [label, asset] of [
    ['primary', primary],
    ['secondary', secondary]
  ]) {
    invariant(
      asset.sourcePath ===
        fs.realpathSync(label === 'primary' ? args.primaryMediaPath : args.secondaryMediaPath),
      `S10 ${label} source path was not realpath-bound`
    )
    invariant(
      path.resolve(asset.assetPath).startsWith(path.resolve(plan.profile.userDataPath) + path.sep),
      `S10 ${label} materialized asset escaped disposable profile`
    )
  }
  return { primary, secondary }
}

async function probeMediaDuration(mediaPath, adapters = {}) {
  const runExact = adapters.runExact || acceptanceSession.runExact
  const executable = adapters.resolveMediaTool
    ? adapters.resolveMediaTool('ffprobe')
    : diagnostics.resolveMediaTool('ffprobe')
  const result = await Promise.resolve(
    runExact(
      executable,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', mediaPath],
      { timeout: 120_000, maxBuffer: 64 * 1024 }
    )
  )
  const parsed = JSON.parse(String(result.stdout || ''))
  const duration = Number(parsed?.format?.duration)
  invariant(
    Number.isFinite(duration) && duration >= PRIMARY_MIN_DURATION_SECONDS,
    `S10 primary media duration ${duration}s is below the required ${PRIMARY_MIN_DURATION_SECONDS}s`
  )
  return {
    seconds: duration,
    command: result.command,
    stdoutSha256: sha256Text(result.stdout),
    stderrSha256: sha256Text(result.stderr || '')
  }
}

function exactCount(list, expected, label) {
  invariant(
    Array.isArray(list) && list.length === expected,
    `${label} requires exactly ${expected} receipts`
  )
  return list
}

function validateLoopProof(proof) {
  invariant(isRecord(proof), 'S10 loop proof is missing')
  invariant(
    proof.loop === true && proof.hudText === 'LOOP',
    'S10 loop proof is not a visible exact LOOP HUD proof'
  )
  invariant(
    proof.accessibilityIdentifier === 'Transport mutation detail',
    'S10 loop AX static-text identity is not exact'
  )
  invariant(
    proof.accessibilityRole === 'AXStaticText' &&
      typeof proof.accessibilityValue === 'string' &&
      proof.accessibilityValue.startsWith('tm1 '),
    'S10 loop transport static-text value is not canonical'
  )
  invariant(
    proof.backgroundPositioning === true && proof.foregroundSetup === true,
    'S10 loop setup did not prove background positioning plus explicit foreground setup'
  )
  invariant(
    proof.focusBefore && proof.focusAfter && proof.focusRestored === true,
    'S10 loop focus restoration is missing'
  )
  invariant(
    Number.isSafeInteger(proof.loopStartTicks) &&
      Number.isSafeInteger(proof.loopEndTicks) &&
      proof.loopEndTicks > proof.loopStartTicks &&
      proof.startPositioning?.observedPlayheadTicks === proof.loopStartTicks &&
      proof.endPositioning?.observedPlayheadTicks === proof.loopEndTicks,
    'S10 loop marks are not bound to exact start/end positioning receipts'
  )
  return proof
}

async function establishS10Loop(plan, target, adapters) {
  const setup = adapters.establishLoop || defaultEstablishLoop
  const proof = await setup(
    plan,
    target,
    {
      exactBackgroundAction: 'set-playhead-ticks',
      foregroundKeys: [...LOOP_SETUP_KEYS],
      inputDelivery: 'foreground-global-explicit',
      allowForegroundInput: true,
      loopStartTicks: adapters.loopStartTicks,
      loopEndTicks: adapters.loopEndTicks,
      loopTimebaseTicks: adapters.loopTimebaseTicks
    },
    adapters
  )
  return validateLoopProof(proof)
}

function validateSeekReceipts(receipts, expectedAssetId) {
  exactCount(receipts, SEEK_COUNT, 'S10 playhead seek phase')
  receipts.forEach((receipt, index) => {
    invariant(
      receipt.index === index && receipt.assetId === expectedAssetId,
      `S10 seek ${index} has wrong order or asset`
    )
    invariant(
      receipt.action === 'set-playhead-ticks' && receipt.backgroundInput === true,
      `S10 seek ${index} was not an exact background action`
    )
    invariant(
      Number.isSafeInteger(receipt.playheadTicks),
      `S10 seek ${index} lacks exact playhead ticks`
    )
  })
  invariant(
    new Set(receipts.map((receipt) => receipt.playheadTicks)).size === SEEK_COUNT,
    'S10 seeks did not prove 100 unique exact playhead positions'
  )
  return {
    count: receipts.length,
    first: receipts[0],
    last: receipts.at(-1),
    selected: receipts[Math.floor(receipts.length / 2)],
    finalAssetId: receipts.at(-1).assetId
  }
}

function validateAlternatingOpens(receipts, assets) {
  exactCount(receipts, ALTERNATING_OPEN_COUNT, 'S10 alternating open phase')
  receipts.forEach((receipt, index) => {
    const expected = assets[index % 2]
    invariant(
      receipt.index === index && receipt.assetId === expected.sha256,
      `S10 alternating open ${index} has wrong asset/order`
    )
    invariant(
      receipt.foregroundInput === false && receipt.inputDelivery === 'background-observation-only',
      `S10 alternating open ${index} leaked foreground input`
    )
    invariant(
      Number.isSafeInteger(receipt.journalRevision) && receipt.journalRevision > 0,
      `S10 alternating open ${index} lacks journal revision`
    )
    invariant(
      receipt.journalPath === expected.assetPath && receipt.hudAssetId === expected.sha256,
      `S10 alternating open ${index} lacks exact journal/HUD identity`
    )
    if (index > 0)
      invariant(
        receipt.journalRevision > receipts[index - 1].journalRevision,
        `S10 alternating open ${index} journal revision did not advance`
      )
  })
  return { count: receipts.length, first: receipts[0], last: receipts.at(-1) }
}

function validateRouteCycles(receipts) {
  exactCount(receipts, ROUTE_CYCLE_COUNT, 'S10 Source/Timeline route phase')
  receipts.forEach((receipt, index) => {
    invariant(
      receipt.index === index && receipt.action === 'AXPress',
      `S10 route cycle ${index} was not AXPress`
    )
    invariant(
      receipt.inputDelivery === 'background-observation-only' && receipt.foregroundInput === false,
      `S10 route cycle ${index} leaked foreground input`
    )
    invariant(
      Array.isArray(receipt.transitions) && receipt.transitions.length === 4,
      `S10 route cycle ${index} did not execute four transitions`
    )
    invariant(
      JSON.stringify(receipt.transitions.map((transition) => transition.name)) ===
        JSON.stringify(['timeline-show', 'source-hide', 'source-show', 'timeline-hide']),
      `S10 route cycle ${index} transition order is not exact`
    )
    invariant(
      receipt.transitions.every(
        (transition) =>
          transition.accessibilityAction === 'AXPress' &&
          transition.routeValueBefore !== transition.routeValueAfter
      ),
      `S10 route cycle ${index} contains a no-op or non-AX transition`
    )
    invariant(
      receipt.sourceVisible === true &&
        receipt.timelineVisible === false &&
        receipt.hudAssetId &&
        isRecord(receipt.resource),
      `S10 route cycle ${index} lacks post-transition workspace/HUD/resource proof`
    )
    invariant(
      JSON.stringify(receipt.visibilitySnapshots) ===
        JSON.stringify([
          { source: true, timeline: true },
          { source: false, timeline: true },
          { source: true, timeline: true },
          { source: true, timeline: false }
        ]),
      `S10 route cycle ${index} visibility snapshots do not prove the four actions`
    )
  })
  return { count: receipts.length }
}

function validateCloseReopenCycles(receipts, expectedAssetId) {
  exactCount(receipts, CLOSE_REOPEN_COUNT, 'S10 close/reopen phase')
  receipts.forEach((receipt, index) => {
    invariant(
      receipt.index === index && receipt.helperPath === EXPECTED_CLOSE_HELPER,
      `S10 close/reopen ${index} did not use exact close helper`
    )
    invariant(
      receipt.closed === true && receipt.cooldownSample?.closed === true,
      `S10 close/reopen ${index} lacks process-level closed/cooldown proof`
    )
    invariant(
      receipt.windowIdBefore > 0 &&
        receipt.windowIdAfter > 0 &&
        receipt.windowIdBefore !== receipt.windowIdAfter,
      `S10 close/reopen ${index} reused the window ID`
    )
    invariant(
      receipt.assetId === expectedAssetId &&
        receipt.paused === true &&
        receipt.readiness === 'exact-asset-paused',
      `S10 close/reopen ${index} lacks exact paused readiness`
    )
  })
  return { count: receipts.length }
}

function validateExactCloseReceipt(receipt, request, label) {
  invariant(
    isRecord(receipt) &&
      receipt.schemaVersion === 1 &&
      receipt.kind === 'taskwraith-studio-endurance-window-control-receipt' &&
      receipt.pid === request.expectedPid &&
      receipt.pgid === request.expectedPgid &&
      receipt.executablePath === request.expectedExecutablePath &&
      receipt.windowId === request.windowId &&
      receipt.windowTitle === request.windowTitle &&
      receipt.accessibilityRole === 'AXButton' &&
      receipt.accessibilityAction === 'AXPress' &&
      receipt.stateBefore === 'visible' &&
      receipt.stateAfter === 'closed' &&
      receipt.focusIsolation?.focusPreserved === true &&
      receipt.focusIsolation?.cursorPreserved === true,
    `${label} close receipt is not exact`
  )
  return receipt
}

function validateS10ResourceVerdict(resources, options = {}) {
  exactCount(resources, SAMPLE_COUNT, 'S10 aligned resource phase')
  resources.forEach((sample, index) => {
    invariant(
      sample.index === index &&
        Number.isSafeInteger(sample.rssBytes) &&
        sample.rssBytes >= 0 &&
        Number.isSafeInteger(sample.physicalFootprintBytes) &&
        sample.physicalFootprintBytes >= 0 &&
        Number.isSafeInteger(sample.mallocLiveBytes) &&
        sample.mallocLiveBytes >= 0,
      `S10 resource sample ${index} is incomplete`
    )
    invariant(
      Array.isArray(sample.ioSurfaceIds) &&
        Number.isSafeInteger(sample.ioSurfaceCapacity) &&
        sample.ioSurfaceCapacity > 0 &&
        sample.ioSurfaceIds.length <= sample.ioSurfaceCapacity &&
        Number.isSafeInteger(sample.players) &&
        sample.players >= 1 &&
        sample.players <= 2 &&
        Number.isSafeInteger(sample.frames) &&
        sample.frames >= 0 &&
        Number.isSafeInteger(sample.textures) &&
        sample.textures >= 0 &&
        sample.textures <= sample.ioSurfaceCapacity &&
        Number.isSafeInteger(sample.cacheHits) &&
        sample.cacheHits >= 0 &&
        Number.isSafeInteger(sample.droppedFrames) &&
        sample.droppedFrames >= 0 &&
        Number.isSafeInteger(sample.residentDecoderCount) &&
        sample.residentDecoderCount >= 0,
      `S10 resource sample ${index} lacks bounded counters`
    )
  })
  if (Array.isArray(options.observedSamples)) {
    invariant(
      options.observedSamples.length === SAMPLE_COUNT &&
        Array.isArray(options.rawResources) &&
        options.rawResources.length === SAMPLE_COUNT,
      'S10 live HUD/resource observations are not aligned'
    )
    let segment = []
    for (let index = 0; index < options.observedSamples.length; index += 1) {
      segment.push(options.observedSamples[index])
      const wrapBoundary =
        index === options.observedSamples.length - 1 ||
        options.observedSamples[index + 1].contentPtsSeconds <
          options.observedSamples[index].contentPtsSeconds
      if (wrapBoundary) {
        if (segment.length >= 2)
          diagnostics.assertDiagnostics(
            segment,
            options.rawResources[index - segment.length + 1],
            options.rawResources[index],
            { expectedAssetId: options.expectedAssetId }
          )
        segment = []
      }
    }
  }
  const resourceReadings = resources.map((sample) => ({
    residentBytes: sample.rssBytes,
    footprintBytes: sample.physicalFootprintBytes,
    mallocInUseBytes: sample.mallocLiveBytes,
    liveIoSurfaceIds: sample.ioSurfaceIds,
    residentDecoderCount: sample.residentDecoderCount,
    cacheHits: sample.cacheHits,
    droppedFrames: sample.droppedFrames
  }))
  const growth = avCore.classifyResourceGrowth({
    readings: resourceReadings,
    ioSurfaceCapacity: resources[0].ioSurfaceCapacity,
    droppedFrames: Math.max(...resources.map((sample) => sample.droppedFrames))
  })
  invariant(
    growth.status === 'green',
    `S10 resource verdict is ${growth.status}: ${JSON.stringify(growth.failures)}`
  )
  return {
    status: growth.status,
    growth,
    baseline: resources[0],
    peak: resources.reduce(
      (peak, sample) => (sample.rssBytes > peak.rssBytes ? sample : peak),
      resources[0]
    ),
    final: resources.at(-1)
  }
}

function validateWorkloadResourceVerdict(resources, identity, resourcePlan) {
  const fixedPlan = ownedResourceEvidence.validateWarmPlan(resourcePlan)
  const schedule = [
    ...Array.from({ length: SAMPLE_COUNT }, (_, index) => ({ phase: 'loop', index })),
    ...Array.from({ length: SEEK_COUNT }, (_, index) => ({ phase: 'seek', index })),
    ...Array.from({ length: ALTERNATING_OPEN_COUNT }, (_, index) => ({ phase: 'switch', index })),
    ...Array.from({ length: ROUTE_CYCLE_COUNT * 4 }, (_, index) => ({ phase: 'route', index })),
    ...Array.from({ length: CLOSE_REOPEN_COUNT }, (_, index) => [
      { phase: 'closed', index },
      { phase: 'reopen', index }
    ]).flat(),
    { phase: 'final', index: 0 }
  ]
  exactCount(resources, schedule.length, 'S10 workload resource observations')
  invariant(
    Number.isSafeInteger(identity?.processPid) &&
      identity.processPid > 0 &&
      Number.isSafeInteger(identity?.processPgid) &&
      identity.processPgid > 0 &&
      typeof identity?.executablePath === 'string' &&
      identity.executablePath.endsWith('TaskWraithStudioCompanion') &&
      typeof identity?.primaryAssetId === 'string' &&
      identity.primaryAssetId.length > 0 &&
      typeof identity?.secondaryAssetId === 'string' &&
      identity.secondaryAssetId.length > 0 &&
      identity.primaryAssetId !== identity.secondaryAssetId,
    'S10 workload expected process/asset identity is incomplete'
  )
  const memoryFields = ['rssBytes', 'physicalFootprintBytes', 'mallocLiveBytes']
  const baseline = resources[0]
  const memoryBudgetBytes = COOLDOWN_MEMORY_RETURN_BUDGET_BYTES
  const phases = new Map()
  resources.forEach((sample, sequence) => {
    const expected = schedule[sequence]
    const expectedAssetId =
      expected.phase === 'loop' ||
      expected.phase === 'seek' ||
      (expected.phase === 'switch' && expected.index % 2 === 0)
        ? identity.primaryAssetId
        : identity.secondaryAssetId
    invariant(
      isRecord(sample) &&
        sample.phase === expected.phase &&
        sample.index === expected.index &&
        sample.sequence === sequence &&
        sample.assetId === expectedAssetId &&
        sample.processPid === identity.processPid &&
        sample.processPgid === identity.processPgid &&
        sample.executablePath === identity.executablePath &&
        Number.isFinite(sample.monotonicMs) &&
        sample.monotonicMs >= 0 &&
        (sequence === 0 || sample.monotonicMs > resources[sequence - 1].monotonicMs),
      `S10 workload sample ${sequence} has contradictory phase/process/asset/clock custody`
    )
    for (const field of memoryFields) {
      invariant(
        Number.isSafeInteger(sample[field]) && sample[field] >= 0,
        `S10 workload sample ${sequence} lacks measured ${field}`
      )
      invariant(
        sample[field] <= fixedPlan.memoryCeilings[field],
        `S10 workload sample ${sequence} exceeds the ${field} allocation-class budget`
      )
    }
    invariant(
      Number.isSafeInteger(sample.ioSurfaceCapacity) &&
        sample.ioSurfaceCapacity > 0 &&
        sample.ioSurfaceCapacity === baseline.ioSurfaceCapacity &&
        Array.isArray(sample.ioSurfaceIds) &&
        sample.ioSurfaceIds.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff) &&
        new Set(sample.ioSurfaceIds).size === sample.ioSurfaceIds.length &&
        sample.ioSurfaceIds.length <= sample.ioSurfaceCapacity,
      `S10 workload sample ${sequence} lacks stable bounded IOSurface custody`
    )
    invariant(
      Number.isSafeInteger(sample.residentDecoderCount) &&
        sample.residentDecoderCount >= 0 &&
        sample.residentDecoderCount <= fixedPlan.budget.decoderSessions,
      `S10 workload sample ${sequence} exceeds the resident decoder bound`
    )
    if (!phases.has(sample.phase)) phases.set(sample.phase, [])
    phases.get(sample.phase).push(sample)
  })
  const phaseSummaries = []
  for (const [phase, samples] of phases) {
    for (const field of memoryFields) {
      invariant(
        samples.length < 3 ||
          !samples.slice(1).every((sample, index) => sample[field] > samples[index][field]),
        `S10 workload ${phase} has sustained monotonic ${field} growth`
      )
    }
    let accumulatingTransitions = 0
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1].ioSurfaceIds
      const current = new Set(samples[index].ioSurfaceIds)
      accumulatingTransitions =
        current.size > previous.length && previous.every((id) => current.has(id))
          ? accumulatingTransitions + 1
          : 0
      invariant(accumulatingTransitions < 2, `S10 workload ${phase} accumulates live IOSurfaces`)
    }
    phaseSummaries.push({ phase, count: samples.length, first: samples[0], final: samples.at(-1) })
  }
  const peaks = Object.fromEntries(
    memoryFields.map((field) => [
      field,
      resources.reduce((peak, sample) => (sample[field] > peak[field] ? sample : peak), baseline)
    ])
  )
  const owned = ownedResourceEvidence.validateOwnedWorkload(resources, fixedPlan)
  return {
    status: 'green',
    scope: 'whole-workload-process-memory-and-application-owned-resource-bounds',
    owned,
    memoryBudgetBytes,
    sampleCount: resources.length,
    samples: resources,
    phaseSummaries,
    baseline,
    peak: peaks.rssBytes,
    peaks,
    final: resources.at(-1)
  }
}

function validateFinalCooldown(cooldown, live) {
  invariant(isRecord(cooldown), 'S10 final cooldown receipt is missing')
  invariant(
    cooldown.closed === true &&
      cooldown.cooldown?.closed === true &&
      cooldown.decodeStopped === true,
    'S10 final cooldown did not prove closed/decode-stopped state'
  )
  invariant(
    live?.status === 'green' && live.owned?.status === 'measured',
    'S10 cooldown lacks the validated whole-workload resource evidence'
  )
  invariant(
    cooldown.terminalCounters?.status === 'measured',
    'S10 cooldown requires two measured native observations'
  )
  invariant(
    Number.isSafeInteger(cooldown.processPid) &&
      Number.isSafeInteger(cooldown.processPgid) &&
      typeof cooldown.executablePath === 'string' &&
      cooldown.executablePath.endsWith('TaskWraithStudioCompanion') &&
      cooldown.targetAssetId === live.final.assetId,
    'S10 final cooldown process/asset join is missing'
  )
  exactCount(cooldown.resourceSnapshots, 4, 'S10 baseline/peak/final/cooldown resource snapshots')
  for (const [index, label] of ['baseline', 'peak', 'final'].entries()) {
    invariant(
      JSON.stringify(cooldown.resourceSnapshots[index]) ===
        JSON.stringify({ ...live[label], label }),
      `S10 cooldown ${label} is not the actual whole-workload observation`
    )
  }
  invariant(
    cooldown.memoryReturnedWithinBudget === true &&
      cooldown.memoryReturnBudgetBytes === COOLDOWN_MEMORY_RETURN_BUDGET_BYTES,
    'S10 cooldown memory return budget is missing or changed'
  )
  const { first, second } = cooldown.terminalCounters
  const terminal = cooldown.resourceSnapshots[3]
  invariant(
    first?.windowReappeared === false &&
      second?.windowReappeared === false &&
      terminal?.windowReappeared === false,
    'S10 cooldown window reappeared'
  )
  invariant(
    JSON.stringify(terminal) === JSON.stringify({ ...second, label: 'cooldown' }),
    'S10 cooldown terminal snapshot does not match its measured counter receipt'
  )
  for (const sample of [first, second]) {
    invariant(
      sample.processPid === cooldown.processPid &&
        sample.processPgid === cooldown.processPgid &&
        sample.executablePath === cooldown.executablePath &&
        sample.assetId === cooldown.targetAssetId &&
        sample.closed === true &&
        sample.windowAbsence?.closed === true &&
        sample.windowAbsence.exactPid === cooldown.processPid,
      'S10 cooldown native/memory/window receipt departed from process/asset custody'
    )
  }
  ownedResourceEvidence.validateProgress(first.native, live.final.native)
  const measured = ownedResourceEvidence.validateNativeCooldown(
    first,
    second,
    live.baseline,
    live.owned.plan
  )
  invariant(
    JSON.stringify(measured) === JSON.stringify(cooldown.terminalCounters),
    'S10 cooldown measured verdict or fixed budget changed'
  )
  return cooldown
}

function validateLoopAwareAvVerdict(avEvidence, samples, census, loop = {}) {
  invariant(isRecord(avEvidence) && isRecord(avEvidence.verdict), 'S10 A/V verdict is missing')
  invariant(
    avEvidence.kind === 'taskwraith-studio-s10-loop-av-evidence' &&
      avEvidence.verdict.status === 'green' &&
      Array.isArray(avEvidence.verdict.failures) &&
      avEvidence.verdict.failures.length === 0,
    `S10 A/V evidence is not a validated loop-aware pass: ${JSON.stringify(avEvidence.verdict)}`
  )
  invariant(
    Array.isArray(samples) && samples.length === SAMPLE_COUNT,
    'S10 loop A/V sample sequence is incomplete'
  )
  invariant(
    samples.every((sample) => sample.syntheticClock !== true),
    'S10 synthetic clock refused'
  )
  const cadence = avCore.validateSampleSequence(samples)
  invariant(cadence.ok, `S10 loop cadence/wall-clock proof failed: ${cadence.failures.join('; ')}`)
  invariant(
    Array.isArray(avEvidence.samples) &&
      avEvidence.samples.length === SAMPLE_COUNT &&
      avEvidence.samples.every((sample) => sample.referencePixel?.pixelComparison?.clean === true),
    'S10 reference-pixel evidence is missing or not clean'
  )
  samples.forEach((sample, index) => {
    const current = avCore.parseAvSyncCurrentExport(sample.raw?.current)
    const peak = avCore.parseAvSyncPeakExport(sample.raw?.peak)
    invariant(current.ok !== false && peak.ok !== false, `S10 A/V sample ${index} is malformed`)
    invariant(
      avCore.classifyAvCurrentSample({ receipt: current, timebase: current.timebase }).status ===
        'green',
      `S10 current A/V sample ${index} is not green`
    )
    invariant(
      avCore.classifyAvPeakSample({ receipt: peak, timebase: current.timebase }).status !== 'red',
      `S10 peak A/V sample ${index} is red`
    )
  })
  const values = census?.values
  invariant(Array.isArray(values) && values.length > 1, 'S10 loop A/V source census is missing')
  invariant(
    Number.isSafeInteger(loop.startTicks) &&
      Number.isSafeInteger(loop.endTicks) &&
      Number.isSafeInteger(loop.timebaseTicks) &&
      loop.endTicks > loop.startTicks &&
      loop.timebaseTicks > 0,
    'S10 loop boundary validator lacks exact marked ticks/timebase'
  )
  const loopStartSeconds = loop.startTicks / loop.timebaseTicks
  const loopEndSeconds = loop.endTicks / loop.timebaseTicks
  const loopDurationSeconds = loopEndSeconds - loopStartSeconds
  invariant(
    loopDurationSeconds > avCore.NOMINAL_CADENCE_SECONDS * 2 &&
      loopDurationSeconds <= LOOP_MIN_DURATION_SECONDS,
    'S10 marked loop duration cannot produce exact 30s-cadence wrap evidence'
  )
  const positiveDeltas = values
    .slice(1)
    .map((value, index) => value - values[index])
    .filter((delta) => delta > 0)
  invariant(positiveDeltas.length > 0, 'S10 source PTS census has no positive frame delta')
  const frameToleranceSeconds = Math.max(0.000_001, Math.min(...positiveDeltas))
  const wraps = []
  invariant(samples[0].ptsWrap === false, 'S10 caller wrap flag at 0 must be false')
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1].observedPtsSeconds
    const current = samples[index].observedPtsSeconds
    if (!Number.isFinite(previous) || !Number.isFinite(current))
      throw new Error(`S10 loop sample ${index} lacks observed PTS`)
    const elapsedSeconds = (samples[index].monotonicMs - samples[index - 1].monotonicMs) / 1000
    const unwrapped = previous + elapsedSeconds
    const expectedWraps = Math.max(
      0,
      Math.floor((unwrapped - loopStartSeconds) / loopDurationSeconds)
    )
    const expectedCurrent =
      loopStartSeconds +
      ((((unwrapped - loopStartSeconds) % loopDurationSeconds) + loopDurationSeconds) %
        loopDurationSeconds)
    const didWrap = current < previous
    invariant(
      didWrap === expectedWraps > 0 &&
        Math.abs(current - expectedCurrent) <= frameToleranceSeconds * 2,
      `S10 PTS transition ${index} does not match the marked loop boundary`
    )
    invariant(
      sampleBoolean(samples[index].ptsWrap) === didWrap,
      `S10 caller wrap flag at ${index} does not match recomputed wrap index`
    )
    if (didWrap) wraps.push({ index, previous, current, expectedCurrent })
  }
  invariant(wraps.length >= 1, 'S10 loop playback did not produce a recomputed PTS wrap')
  return { status: 'green-non-acoustic', wraps, cadence }
}

function sampleBoolean(value) {
  invariant(typeof value === 'boolean', 'S10 wrap flag is not boolean')
  return value
}

async function runLoopAwareSampling(plan, target, prepared, adapters = {}) {
  const sampleState = {
    census: prepared.sourcePtsCensus,
    bounds: (adapters.windowBounds || acceptanceSession.windowBounds)(target.window),
    previousPtsSeconds: null
  }
  let clockStart = null
  const startedAtMs = Date.now()
  const sampleReceipts = []
  for (const entry of avCore.planSamples({ startedAtMs })) {
    const waitMs = adapters.testOnlyFastTimeline === true ? 0 : entry.plannedAtMs - Date.now()
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
    const sample = await (adapters.captureLoopSample || defaultCaptureLoopSample)(
      plan,
      target,
      entry,
      sampleState,
      adapters
    )
    const capturedAtMs = Number.isFinite(sample.captureMonotonicMs)
      ? sample.captureMonotonicMs
      : Number(process.hrtime.bigint()) / 1_000_000
    if (clockStart === null) clockStart = capturedAtMs
    const measuredElapsedMs = capturedAtMs - clockStart
    sample.index = entry.index
    sample.actualElapsedMs =
      adapters.testOnlyFastTimeline === true ? entry.plannedElapsedMs : measuredElapsedMs
    sample.monotonicMs =
      adapters.testOnlyFastTimeline === true ? entry.plannedElapsedMs : measuredElapsedMs
    sample.wallClockElapsedMs = Date.now() - startedAtMs
    sample.syntheticClock = adapters.testOnlyFastTimeline === true
    sample.plannedElapsedMs = entry.plannedElapsedMs
    sampleReceipts.push(sample)
  }
  return {
    evidence: {
      kind: 'taskwraith-studio-s10-loop-av-evidence',
      verdict: { status: 'green', failures: [] },
      samples: sampleReceipts
    },
    samples: sampleReceipts
  }
}

async function defaultEstablishLoop(plan, target, context, adapters = {}) {
  const runDriver = adapters.runStudioUiDriver || harness.runStudioUiDriver
  const focusSnapshot = adapters.focusSnapshot || acceptanceSession.focusSnapshot
  const assertFocus =
    adapters.assertSourceWindowFocusIsolation || acceptanceSession.assertSourceWindowFocusIsolation
  const bounds = (adapters.windowBounds || acceptanceSession.windowBounds)(target.window)
  const startTicks = Number.isSafeInteger(context.loopStartTicks) ? context.loopStartTicks : null
  const endTicks = Number.isSafeInteger(context.loopEndTicks) ? context.loopEndTicks : null
  invariant(
    startTicks !== null && endTicks !== null && endTicks > startTicks,
    'S10 default loop setup blocker: exact loop tick boundaries are unavailable'
  )
  const before = focusSnapshot(target.companion.pid)
  const positioned = await runDriver(
    plan,
    target,
    [
      {
        type: 'set-playhead-ticks',
        playheadTicks: startTicks,
        playheadToleranceTicks: 0,
        playheadMaximumForwardAdvanceTicks: 0
      }
    ],
    {
      ...(adapters.driverAdapters || {}),
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false
    }
  )
  const positionedAction = positioned.actions?.find(
    (action) => action.type === 'set-playhead-ticks'
  )
  invariant(
    positionedAction?.observedPlayheadTicks === startTicks,
    'S10 loop background start positioning was not exact'
  )
  const markIn = await runDriver(plan, target, [{ type: 'key', key: 'i' }], {
    ...(adapters.driverAdapters || {}),
    inputDelivery: 'foreground-global-explicit',
    allowForegroundInput: true
  })
  const endPositioned = await runDriver(
    plan,
    target,
    [
      {
        type: 'set-playhead-ticks',
        playheadTicks: endTicks,
        playheadToleranceTicks: 0,
        playheadMaximumForwardAdvanceTicks: 0
      }
    ],
    {
      ...(adapters.driverAdapters || {}),
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false
    }
  )
  const endAction = endPositioned.actions?.find((action) => action.type === 'set-playhead-ticks')
  invariant(
    endAction?.observedPlayheadTicks === endTicks,
    'S10 loop background end positioning was not exact'
  )
  const markOutLoopPlay = await runDriver(
    plan,
    target,
    ['o', 'l', 'p'].map((key) => ({ type: 'key', key })),
    {
      ...(adapters.driverAdapters || {}),
      inputDelivery: 'foreground-global-explicit',
      allowForegroundInput: true
    }
  )
  const foregroundActions = [...(markIn.actions || []), ...(markOutLoopPlay.actions || [])]
  invariant(
    foregroundActions.length === LOOP_SETUP_KEYS.length &&
      foregroundActions.every(
        (action, index) => action.type === 'key' && action.key === LOOP_SETUP_KEYS[index]
      ),
    'S10 foreground I/O/L/P setup receipt is not exact'
  )
  const after = focusSnapshot(target.companion.pid)
  const focus = assertFocus(before, after, target.companion.pid)
  const observation = await runDriver(
    plan,
    target,
    [
      { type: 'read-transport-mutation', accessibilityLabel: 'Transport mutation detail' },
      { type: 'screenshot', name: 's10-loop-proof' }
    ],
    {
      ...(adapters.driverAdapters || {}),
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false
    }
  )
  const transport = observation.actions?.find((action) => action.type === 'read-transport-mutation')
  invariant(
    transport?.accessibilityRole === 'AXStaticText' &&
      transport.accessibilityMatchCount === 1 &&
      typeof transport.accessibilityValue === 'string' &&
      transport.accessibilityValue.startsWith('tm1 '),
    'S10 loop static-text transport proof is not exact'
  )
  const screenshot = observation.actions?.find((action) => action.type === 'screenshot')
  const hud = (adapters.ocrScreenshot || acceptanceSession.ocrScreenshot)(screenshot.screenshotPath)
  invariant(
    hud.texts?.some((text) => text === 'LOOP') === true || hud.texts?.join(' ').includes('LOOP'),
    'S10 loop HUD proof did not visibly contain LOOP'
  )
  return {
    loop: true,
    hudText: 'LOOP',
    staticText: transport,
    accessibilityIdentifier: 'Transport mutation detail',
    accessibilityRole: transport.accessibilityRole,
    accessibilityValue: transport.accessibilityValue,
    backgroundPositioning: true,
    foregroundSetup: true,
    focusBefore: before,
    focusAfter: after,
    focusRestored: focus.focusPreserved && focus.cursorPreserved,
    startPositioning: positionedAction,
    endPositioning: endAction,
    loopStartTicks: startTicks,
    loopEndTicks: endTicks,
    loopTimebaseTicks: context.loopTimebaseTicks,
    windowBounds: bounds
  }
}

async function defaultCaptureLoopSample(plan, target, entry, state, adapters = {}) {
  const bounds = state.bounds
  const rawSample = await avLive.captureRawPlayableSample(
    plan,
    target,
    state.census,
    bounds,
    entry.index,
    state.previousPtsSeconds,
    adapters,
    { captureName: `s10-loop-${String(entry.index).padStart(2, '0')}` }
  )
  const captureMonotonicMs = Number(process.hrtime.bigint()) / 1_000_000
  const screenshotFile = await assertBoundedArtifactFile(
    rawSample.capture.path,
    plan.artifactRoot,
    `S10 sample ${entry.index} screenshot`
  )
  invariant(
    screenshotFile.sha256 === rawSample.capture.sha256,
    `S10 sample ${entry.index} screenshot hash changed`
  )
  const ui = await avLive.readSampleUi(plan, target, bounds, entry.index, {}, adapters)
  const resourceProbe = (adapters.resourceSample || acceptanceSession.resourceSample)(
    target.companion.pid,
    entry.index,
    rawSample.observed.contentPtsSeconds,
    adapters.resourceAdapters || {}
  )
  const resource = avLive.resourceReceipt(resourceProbe, ui.avSync, entry.index)
  const parsedResource = avCore.parseResourceDetailExport(resource.resourceDetailValue)
  invariant(parsedResource.ok, `S10 sample ${entry.index} resource export is invalid`)
  const previous = state.previousPtsSeconds
  const ptsWrap =
    previous !== null &&
    rawSample.observed.contentPtsSeconds < previous &&
    previous - rawSample.observed.contentPtsSeconds > 1
  invariant(
    rawSample.playable?.valid === true ||
      (ptsWrap === true &&
        JSON.stringify(rawSample.playable?.reasons) ===
          JSON.stringify(['playhead-did-not-advance'])),
    `S10 sample ${entry.index} is not a playable exact-asset HUD sample: ${JSON.stringify(rawSample.playable?.reasons || [])}`
  )
  state.previousPtsSeconds = rawSample.observed.contentPtsSeconds
  const exactSourcePtsSeconds = diagnostics.resolveExactSourcePts(
    state.census.values,
    rawSample.observed.contentPtsSeconds
  )
  const referencePath = path.join(
    plan.artifactRoot,
    `s10-loop-reference-${String(entry.index).padStart(2, '0')}.png`
  )
  const referenceCommand = diagnostics.buildReferenceExtractCommand({
    assetPath: target.asset.assetPath,
    exactSourcePtsSeconds,
    referencePath
  })
  const referenceExecutable = diagnostics.resolveMediaTool('ffmpeg')
  const referenceExecution = await (adapters.runExact || acceptanceSession.runExact)(
    referenceExecutable,
    referenceCommand,
    { timeout: 120_000, maxBuffer: 64 * 1024 }
  )
  const referenceFile = await assertBoundedArtifactFile(
    referencePath,
    plan.artifactRoot,
    `S10 sample ${entry.index} reference`
  )
  const pixelComparison = pixelVerifier.compareWindowCaptureToReference(
    rawSample.capture.path,
    referencePath,
    bounds,
    {
      sourceHostFrame: rawSample.sourceHostFrame,
      hudOverlayHeight: pixelVerifier.DEFAULT_STUDIO_OVERLAY_EXCLUSION_POINTS
    }
  )
  invariant(
    pixelComparison.clean === true,
    `S10 sample ${entry.index} reference pixels are not clean`
  )
  const rawOcrText = JSON.stringify(rawSample.hud.observations)
  return {
    loopActive: true,
    assetId: target.asset.sha256,
    ptsWrap,
    observed: rawSample.observed,
    observedPtsSeconds: rawSample.observed.contentPtsSeconds,
    captureMonotonicMs,
    referencePixel: {
      exactSourcePtsSeconds,
      referencePath,
      referenceSha256: referenceFile.sha256,
      referenceByteLength: referenceFile.byteLength,
      referenceCommand,
      referenceExecution: {
        command: referenceExecution.command,
        stdoutSha256: sha256Text(referenceExecution.stdout || ''),
        stderrSha256: sha256Text(referenceExecution.stderr || '')
      },
      pixelComparison
    },
    hudCounters: {
      index: entry.index,
      rssBytes: resource.residentBytes,
      physicalFootprintBytes: resource.physicalFootprintBytes,
      mallocLiveBytes: resource.mallocAllocatedBytes,
      ioSurfaceIds: parsedResource.liveIoSurfaceIds,
      ioSurfaceCapacity: parsedResource.ioSurfaceCapacity,
      residentDecoderCount: parsedResource.residentDecoderCount,
      players: rawSample.observed.players.count,
      presentedFrames: rawSample.observed.diagnostics.shownFrames,
      cumulativeTextureBinds: rawSample.observed.diagnostics.textures,
      cacheHits: rawSample.observed.diagnostics.cacheHits,
      droppedFrames: rawSample.observed.diagnostics.droppedFrames
    },
    raw: {
      current: ui.avSync.current,
      peak: ui.avSync.peak,
      resource,
      capture: {
        screenshotPath: rawSample.capture.path,
        screenshotSha256: rawSample.capture.sha256,
        screenshotByteLength: screenshotFile.byteLength,
        windowBounds: bounds,
        sourceHostFrame: rawSample.sourceHostFrame,
        rawOcrText,
        rawOcrSha256: sha256Text(rawOcrText)
      }
    }
  }
}

async function defaultPerformSeeks(plan, target, count, context, adapters = {}) {
  const runDriver = adapters.runStudioUiDriver || harness.runStudioUiDriver
  const ticks = Array.from(
    { length: count },
    (_, index) =>
      context.loopStartTicks +
      Math.floor(((context.loopEndTicks - context.loopStartTicks) * (index + 1)) / (count + 1))
  )
  const receipts = []
  for (let index = 0; index < ticks.length; index += 1) {
    const result = await runDriver(
      plan,
      target,
      [
        {
          type: 'set-playhead-ticks',
          playheadTicks: ticks[index],
          playheadToleranceTicks: 0,
          playheadMaximumForwardAdvanceTicks: 0
        }
      ],
      {
        ...(adapters.driverAdapters || {}),
        inputDelivery: 'background-observation-only',
        allowForegroundInput: false
      }
    )
    const action = result.actions?.find((candidate) => candidate.type === 'set-playhead-ticks')
    receipts.push({
      index,
      assetId: target.asset.sha256,
      action: action?.type,
      backgroundInput: true,
      requestedPlayheadTicks: ticks[index],
      playheadTicks: action?.observedPlayheadTicks,
      rawAction: action,
      resourceSample: await adapters.observeWorkloadResource?.('seek', index, target)
    })
  }
  return receipts
}

async function defaultPerformAlternatingOpens(plan, target, assets, adapters = {}) {
  const renderer = target.renderer
  invariant(renderer, 'S10 default alternating opens require the wrapped renderer')
  const invokeOpen = adapters.invokeStudioOpen || harness.invokeAuthorizedStudioOpen
  const readJournal = adapters.readJournalOperations || harness.readStudioJournalOperations
  const runDriver = adapters.runStudioUiDriver || harness.runStudioUiDriver
  const receipts = []
  const orderedAssets = Array.isArray(assets) ? assets : [assets.primary, assets.secondary]
  invariant(
    orderedAssets.length === 2 && orderedAssets.every(isRecord),
    'S10 alternating opens require two exact assets'
  )
  let revision = 0
  const deadline = Date.now() + 20 * 60 * 1_000
  for (let index = 0; index < ALTERNATING_OPEN_COUNT; index += 1) {
    invariant(Date.now() < deadline, 'S10 alternating opens exceeded one shared absolute deadline')
    const asset = orderedAssets[index % 2]
    await invokeOpen(renderer, asset, {
      timeoutMs: Math.max(
        45_000,
        Math.min(adapters.openTimeoutMs || 180_000, deadline - Date.now())
      )
    })
    const entries = await readJournal(plan)
    const match = entries
      .filter(
        (entry) =>
          entry.op?.type === 'open_media' &&
          entry.op.asset?.assetId === asset.sha256 &&
          path.resolve(entry.op.asset.path) === path.resolve(asset.assetPath)
      )
      .at(-1)
    invariant(
      match && match.revision > revision,
      `S10 alternating open ${index} did not produce a new exact journal revision/path`
    )
    revision = match.revision
    const ui = await runDriver(
      plan,
      { ...target, asset },
      [{ type: 'read-workspace' }, { type: 'screenshot', name: `s10-open-${index}` }],
      {
        ...(adapters.driverAdapters || {}),
        inputDelivery: 'background-observation-only',
        allowForegroundInput: false
      }
    )
    const screenshot = ui.actions?.find((action) => action.type === 'screenshot')
    const hud = (adapters.ocrScreenshot || acceptanceSession.ocrScreenshot)(
      screenshot.screenshotPath
    )
    const observed = diagnostics.parseVisibleHud(hud, asset.sha256, {
      matchAsset: adapters.hudContainsAsset || acceptanceSession.hudContainsAsset
    })
    invariant(
      observed.state === 'PAUSE' &&
        observed.assetMatch?.matched === true &&
        observed.assetMatch.distance === 0,
      `S10 alternating open ${index} HUD was not exact paused asset`
    )
    target.asset = asset
    const resourceSample = await adapters.observeWorkloadResource?.('switch', index, target)
    receipts.push({
      index,
      assetId: asset.sha256,
      journalRevision: revision,
      journalPath: asset.assetPath,
      hudAssetId: observed.assetMatch.assetId,
      foregroundInput: false,
      inputDelivery: 'background-observation-only',
      resourceSample
    })
  }
  return receipts
}

function assertRouteNativePresentation(sample, visibility) {
  invariant(
    typeof visibility?.source === 'boolean' &&
      typeof visibility.timeline === 'boolean' &&
      sample?.native?.workspace?.windowVisible === true &&
      sample.native.workspace.sourcePresentationAttached === visibility.source,
    'S10 route native presentation contradicts source visibility'
  )
  // A visible Timeline does not require an attached Review presentation, but
  // native detaches Review whenever the Timeline route is hidden.
  invariant(
    visibility.timeline || sample.native.workspace.reviewPresentationAttached === false,
    'S10 route native Review stays attached while Timeline is hidden'
  )
}

function assertClosedNativePresentation(sample) {
  invariant(
    sample?.native?.workspace?.windowVisible === false &&
      sample.native.workspace.sourcePresentationAttached === false &&
      sample.native.workspace.reviewPresentationAttached === false,
    'S10 closed native snapshot still has a visible/attached presentation'
  )
}

async function defaultPerformRouteCycles(plan, target, count, adapters = {}) {
  const runDriver = adapters.runStudioUiDriver || harness.runStudioUiDriver
  const receipts = []
  for (let index = 0; index < count; index += 1) {
    const routeSteps = [
      { route: 'timeline', selectedAfter: true },
      { route: 'source', selectedAfter: false },
      { route: 'source', selectedAfter: true },
      { route: 'timeline', selectedAfter: false }
    ]
    const transitions = []
    const visibilitySnapshots = []
    const resourceSamples = []
    let terminalReceipt = null
    for (let stepIndex = 0; stepIndex < routeSteps.length; stepIndex += 1) {
      const step = routeSteps[stepIndex]
      const actions = [{ type: 'press-workspace-route', ...step }, { type: 'read-workspace' }]
      if (stepIndex === routeSteps.length - 1) {
        actions.push(
          { type: 'read-av-sync' },
          { type: 'screenshot', name: `${adapters.routeScreenshotPrefix || 's10-route'}-${index}` }
        )
      }
      const receipt = await runDriver(plan, target, actions, {
        ...(adapters.driverAdapters || {}),
        inputDelivery: 'background-observation-only',
        allowForegroundInput: false
      })
      const action = receipt.actions?.find(
        (candidate) => candidate.type === 'press-workspace-route'
      )
      const workspace = receipt.actions?.find(
        (candidate) => candidate.type === 'read-workspace'
      )?.workspace
      invariant(
        action?.accessibilityAction === 'AXPress' &&
          action.routeValueBefore === (step.selectedAfter ? 'not selected' : 'selected') &&
          action.routeValueAfter === (step.selectedAfter ? 'selected' : 'not selected'),
        `S10 route cycle ${index} step ${stepIndex} was not an exact AXPress transition`
      )
      transitions.push({
        name: `${step.route}-${action.routeValueAfter === 'selected' ? 'show' : 'hide'}`,
        accessibilityAction: action.accessibilityAction,
        routeValueBefore: action.routeValueBefore,
        routeValueAfter: action.routeValueAfter,
        pairedRouteValueBefore: action.pairedRouteValueBefore,
        pairedRouteValueAfter: action.pairedRouteValueAfter
      })
      visibilitySnapshots.push({
        source: workspace?.sourceHost?.visible === true,
        timeline: workspace?.timelineHost?.visible === true
      })
      terminalReceipt = receipt
      const resourceSample = await adapters.observeWorkloadResource?.(
        'route',
        index * 4 + stepIndex,
        target
      )
      assertRouteNativePresentation(resourceSample, visibilitySnapshots.at(-1))
      resourceSamples.push(resourceSample)
    }
    const terminalWorkspace = terminalReceipt.actions?.find(
      (action) => action.type === 'read-workspace'
    )?.workspace
    const screenshot = terminalReceipt.actions?.find((action) => action.type === 'screenshot')
    const hud = (adapters.ocrScreenshot || acceptanceSession.ocrScreenshot)(
      screenshot.screenshotPath
    )
    const observed = diagnostics.parseVisibleHud(hud, target.asset.sha256, {
      matchAsset: adapters.hudContainsAsset || acceptanceSession.hudContainsAsset
    })
    const avAction = terminalReceipt.actions?.find((action) => action.type === 'read-av-sync')
    const parsedResource = avCore.parseResourceDetailExport(avAction?.resourceDetailValue)
    invariant(parsedResource.ok, `S10 route cycle ${index} resource detail is invalid`)
    const resource = (adapters.resourceSample || acceptanceSession.resourceSample)(
      target.companion.pid,
      index,
      observed.contentPtsSeconds,
      adapters.resourceAdapters || {}
    )
    receipts.push({
      index,
      action: 'AXPress',
      inputDelivery: 'background-observation-only',
      foregroundInput: false,
      transitions,
      visibilitySnapshots,
      resourceSamples,
      sourceVisible: terminalWorkspace?.sourceHost?.visible === true,
      timelineVisible: terminalWorkspace?.timelineHost?.visible === true,
      hudAssetId:
        observed.assetMatch?.matched === true && observed.assetMatch.distance === 0
          ? target.asset.sha256
          : null,
      resource: {
        physicalFootprintBytes: resource.physicalFootprintBytes,
        mallocAllocatedBytes: resource.mallocAllocatedBytes,
        residentBytes: resource.residentBytes,
        resourceDetailValue: avAction.resourceDetailValue
      },
      finalWorkspace: terminalWorkspace
    })
  }
  return receipts
}

async function defaultObserveClosedResource(plan, target, index, adapters = {}, phase = 'closed') {
  invariant(
    typeof adapters.observeWorkloadResource === 'function',
    'S10 closed resource query is unavailable'
  )
  const sample = await adapters.observeWorkloadResource(phase, index, target)
  assertClosedNativePresentation(sample)
  const windowAbsence = await assertNoVisibleStudioWindow(target.companion.pid, (pid) =>
    (adapters.probeNativeWindow || harness.probeNativeWindow)(pid, adapters)
  )
  Object.assign(sample, { closed: true, windowReappeared: false, windowAbsence })
  return sample
}

async function defaultPerformCloseReopenCycles(plan, target, count, adapters = {}) {
  const runExact = adapters.runExact || acceptanceSession.runExact
  const helperPath = path.join(plan.repoRoot, EXPECTED_CLOSE_HELPER)
  const invokeOpen = adapters.invokeStudioOpen || harness.invokeAuthorizedStudioOpen
  const verifyOpen = adapters.verifyDurableOpen || harness.verifyDurableOpen
  const probeWindow = adapters.probeNativeWindow || harness.probeNativeWindow
  const runDriver = adapters.runStudioUiDriver || harness.runStudioUiDriver
  const initialMatches = (target.window?.windows || []).filter(
    (window) => window.title === 'TaskWraith Studio'
  )
  invariant(
    target.window?.visibleWindowCount === 1 && initialMatches.length === 1,
    'S10 close/reopen requires exactly one titled visible Studio window'
  )
  const windowBefore = initialMatches[0]
  const initialWindowId = windowBefore?.windowId || windowBefore?.id
  invariant(
    Number.isSafeInteger(initialWindowId) && initialWindowId > 0,
    'S10 close/reopen requires an exact initial window ID'
  )
  const executablePath = companionExecutablePath(target)
  invariant(
    executablePath.endsWith('TaskWraithStudioCompanion'),
    'S10 close/reopen requires the exact Companion executable path'
  )
  const receipts = []
  for (let index = 0; index < count; index += 1) {
    const windowIdBefore = index === 0 ? initialWindowId : receipts.at(-1).windowIdAfter
    const requestPath = path.join(
      plan.artifactRoot,
      's10-window-requests',
      `${String(index).padStart(2, '0')}.json`
    )
    await fsPromises.mkdir(path.dirname(requestPath), { recursive: true, mode: 0o700 })
    const request = {
      schemaVersion: 1,
      kind: 'taskwraith-studio-endurance-window-control-request',
      expectedPid: target.companion.pid,
      expectedPgid: target.companion.pgid,
      expectedExecutablePath: executablePath,
      windowId: windowIdBefore,
      windowTitle: 'TaskWraith Studio',
      timeoutMilliseconds: 10_000
    }
    const journalBefore = await (
      adapters.readJournalOperations || harness.readStudioJournalOperations
    )(plan)
    const revisionBefore = Math.max(
      0,
      ...journalBefore.map((entry) => entry.revision).filter(Number.isSafeInteger)
    )
    await fsPromises.writeFile(requestPath, `${JSON.stringify(request)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    const raw = runExact('/usr/bin/swift', [helperPath, requestPath], {
      timeout: 30_000,
      maxBuffer: 64 * 1024
    })
    const closeReceipt = validateExactCloseReceipt(
      JSON.parse(raw.stdout),
      request,
      `S10 close/reopen ${index}`
    )
    const windowAbsence = await assertNoVisibleStudioWindow(target.companion.pid, (pid) =>
      probeWindow(pid, adapters)
    )
    const cooldownSample = await (adapters.closedResourceSample || defaultObserveClosedResource)(
      plan,
      target,
      index,
      adapters
    )
    await invokeOpen(target.renderer, target.asset, {
      timeoutMs: adapters.openTimeoutMs || 180_000
    })
    await verifyOpen(plan, target.asset)
    const journalAfter = await (
      adapters.readJournalOperations || harness.readStudioJournalOperations
    )(plan)
    const reopenedJournal = journalAfter
      .filter(
        (entry) =>
          entry.op?.type === 'open_media' &&
          entry.op.asset?.assetId === target.asset.sha256 &&
          path.resolve(entry.op.asset.path) === path.resolve(target.asset.assetPath)
      )
      .at(-1)
    invariant(
      reopenedJournal && reopenedJournal.revision > revisionBefore,
      `S10 close/reopen ${index} did not produce a fresh post-action journal revision`
    )
    const reopenedWindow = await probeWindow(target.companion.pid, adapters)
    const reopenedMatches = (reopenedWindow.windows || []).filter(
      (window) => window.title === 'TaskWraith Studio'
    )
    invariant(
      reopenedWindow.visibleWindowCount === 1 && reopenedMatches.length === 1,
      `S10 close/reopen ${index} did not restore exactly one titled window`
    )
    const windowIdAfter = reopenedMatches[0].windowId
    invariant(
      Number.isSafeInteger(windowIdAfter) && windowIdAfter !== windowIdBefore,
      `S10 close/reopen ${index} did not produce a new window ID`
    )
    const ui = await runDriver(
      plan,
      target,
      [{ type: 'screenshot', name: `s10-reopen-${index}` }],
      {
        ...(adapters.driverAdapters || {}),
        inputDelivery: 'background-observation-only',
        allowForegroundInput: false
      }
    )
    const shot = ui.actions?.find((action) => action.type === 'screenshot')
    const hud = (adapters.ocrScreenshot || acceptanceSession.ocrScreenshot)(shot.screenshotPath)
    const observed = diagnostics.parseVisibleHud(hud, target.asset.sha256, {
      matchAsset: adapters.hudContainsAsset || acceptanceSession.hudContainsAsset
    })
    invariant(
      observed.state === 'PAUSE' &&
        observed.assetMatch?.matched === true &&
        observed.assetMatch.distance === 0,
      `S10 close/reopen ${index} paused readiness was not exact`
    )
    target.window = reopenedWindow
    const reopenSample = await adapters.observeWorkloadResource?.('reopen', index, target)
    receipts.push({
      index,
      helperPath: EXPECTED_CLOSE_HELPER,
      closed: true,
      windowAbsence,
      cooldownSample,
      reopenSample,
      windowIdBefore,
      windowIdAfter,
      journalRevisionBefore: revisionBefore,
      journalRevisionAfter: reopenedJournal.revision,
      assetId: target.asset.sha256,
      paused: true,
      readiness: 'exact-asset-paused',
      rawCloseReceipt: closeReceipt
    })
  }
  return receipts
}

async function defaultStopLoopAndReadFinal(plan, target, adapters = {}, context = {}) {
  const runDriver = adapters.runStudioUiDriver || harness.runStudioUiDriver
  const pausedReceipt = await runDriver(
    plan,
    target,
    [{ type: 'screenshot', name: 's10-final-paused-before-close' }],
    {
      ...(adapters.driverAdapters || {}),
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false
    }
  )
  const pausedScreenshot = pausedReceipt.actions?.find((action) => action.type === 'screenshot')
  invariant(
    typeof pausedScreenshot?.screenshotPath === 'string',
    'S10 final paused observation has no screenshot receipt'
  )
  const pausedHud = (adapters.ocrScreenshot || acceptanceSession.ocrScreenshot)(
    pausedScreenshot.screenshotPath
  )
  const paused = diagnostics.parseVisibleHud(pausedHud, target.asset.sha256, {
    matchAsset: adapters.hudContainsAsset || acceptanceSession.hudContainsAsset
  })
  invariant(
    paused.state === 'PAUSE' &&
      paused.assetMatch?.matched === true &&
      paused.assetMatch.distance === 0,
    'S10 final close did not prove the reopened exact asset was already paused'
  )
  const currentMatches = (target.window?.windows || []).filter(
    (window) => window.title === 'TaskWraith Studio'
  )
  invariant(
    target.window?.visibleWindowCount === 1 && currentMatches.length === 1,
    'S10 final close requires exactly one titled visible Studio window'
  )
  const currentWindow = currentMatches[0]
  const windowId = currentWindow?.windowId || currentWindow?.id
  const executablePath = companionExecutablePath(target)
  invariant(
    Number.isSafeInteger(windowId) && executablePath.endsWith('TaskWraithStudioCompanion'),
    'S10 final close requires exact live window/executable identity'
  )
  const requestPath = path.join(plan.artifactRoot, 's10-window-requests', 'final.json')
  await fsPromises.mkdir(path.dirname(requestPath), { recursive: true, mode: 0o700 })
  await fsPromises.writeFile(
    requestPath,
    `${JSON.stringify({ schemaVersion: 1, kind: 'taskwraith-studio-endurance-window-control-request', expectedPid: target.companion.pid, expectedPgid: target.companion.pgid, expectedExecutablePath: executablePath, windowId, windowTitle: 'TaskWraith Studio', timeoutMilliseconds: 10_000 })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' }
  )
  const closeRaw = (adapters.runExact || acceptanceSession.runExact)(
    '/usr/bin/swift',
    [path.join(plan.repoRoot, EXPECTED_CLOSE_HELPER), requestPath],
    { timeout: 30_000, maxBuffer: 64 * 1024 }
  )
  const closeReceipt = JSON.parse(closeRaw.stdout)
  validateExactCloseReceipt(
    closeReceipt,
    {
      expectedPid: target.companion.pid,
      expectedPgid: target.companion.pgid,
      expectedExecutablePath: executablePath,
      windowId,
      windowTitle: 'TaskWraith Studio'
    },
    'S10 final'
  )
  const windowAbsence = await assertNoVisibleStudioWindow(target.companion.pid, (pid) =>
    (adapters.probeNativeWindow || harness.probeNativeWindow)(pid, adapters)
  )
  const live = context.liveResourceEvidence
  invariant(
    isRecord(live?.baseline) && isRecord(live?.peak) && isRecord(live?.final),
    'S10 final stop requires live baseline/peak/final resource evidence captured before close'
  )
  const snapshots = ['baseline', 'peak', 'final'].map((label) => ({ ...live[label], label }))
  const wait =
    adapters.waitCooldownInterval || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  // Fixed settling interval allows already committed GPU work to retire. Neither
  // query flushes a cache, clears a counter, stops an engine or renders a frame.
  await wait(COOLDOWN_SAMPLE_INTERVAL_MS)
  const first = await defaultObserveClosedResource(plan, target, 0, adapters, 'cooldown')
  await wait(COOLDOWN_SAMPLE_INTERVAL_MS)
  const second = await defaultObserveClosedResource(plan, target, 1, adapters, 'cooldown')
  const terminalCounters = ownedResourceEvidence.validateNativeCooldown(
    first,
    second,
    live.baseline,
    live.owned.plan
  )
  snapshots.push({ ...second, label: 'cooldown' })
  return {
    closed: true,
    cooldown: { closed: true },
    decodeStopped: terminalCounters.decodeStopped,
    resourceSnapshots: snapshots,
    memoryReturnedWithinBudget: true,
    memoryReturnBudgetBytes: COOLDOWN_MEMORY_RETURN_BUDGET_BYTES,
    processPid: target.companion.pid,
    processPgid: target.companion.pgid,
    executablePath,
    targetAssetId: target.asset.sha256,
    windowAbsence,
    rawCloseReceipt: closeReceipt,
    terminalCounters
  }
}

async function prewarmS10Resources(plan, target, collector, adapters = {}) {
  const ordered = [target.s10Assets.primary, target.s10Assets.secondary]
  const declarations = []
  const runExact = adapters.runExact || acceptanceSession.runExact
  const ffprobe = (adapters.resolveMediaTool || diagnostics.resolveMediaTool)('ffprobe')
  for (const asset of ordered) {
    const stat = await fsPromises.lstat(asset.assetPath)
    invariant(
      stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size === asset.byteLength &&
        Buffer.from(await sha256File(asset.assetPath), 'hex').toString('base64url') ===
          asset.sha256,
      'S10 resource preflight asset bytes departed from harness custody'
    )
    const probe = await runExact(
      ffprobe,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-show_streams',
        '-of',
        'json',
        asset.assetPath
      ],
      { timeout: 120_000, maxBuffer: 256 * 1024 }
    )
    const metadata = JSON.parse(probe.stdout)
    invariant(
      Array.isArray(metadata.streams),
      'S10 resource preflight stream metadata is unavailable'
    )
    const video = metadata.streams.find(
      (stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic
    )
    invariant(
      Number.isSafeInteger(video?.width) &&
        video.width > 0 &&
        Number.isSafeInteger(video?.height) &&
        video.height > 0,
      'S10 resource preflight video dimensions are unavailable'
    )
    declarations.push({
      assetId: asset.sha256,
      byteLength: asset.byteLength,
      audioExpected: metadata.streams.some((stream) => stream.codec_type === 'audio'),
      video: {
        width: video.width,
        height: video.height,
        codec: video.codec_name,
        pixelFormat: video.pix_fmt
      },
      probe: {
        command: probe.command,
        stdout: probe.stdout,
        stdoutSha256: sha256Text(probe.stdout),
        stderrSha256: sha256Text(probe.stderr || '')
      }
    })
  }
  const invokeOpen = adapters.invokeStudioOpen || harness.invokeAuthorizedStudioOpen
  const verifyOpen = adapters.verifyDurableOpen || harness.verifyDurableOpen
  for (let pass = 0; pass < 3; pass += 1) {
    target.asset = ordered[pass % 2]
    await invokeOpen(target.renderer, target.asset, {
      timeoutMs: adapters.openTimeoutMs || 180_000
    })
    await verifyOpen(plan, target.asset)
    await (
      adapters.waitCooldownInterval || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    )(COOLDOWN_SAMPLE_INTERVAL_MS)
    await collector.observe('warm-open', pass, target)
    await defaultPerformRouteCycles(plan, target, 1, {
      ...adapters,
      routeScreenshotPrefix: `s10-warm-${pass}`,
      observeWorkloadResource: (_phase, index, observedTarget) =>
        collector.observe('warm-route', pass * 4 + index, observedTarget)
    })
  }
  return collector.finishWarmup(declarations)
}

async function runS10Journey(plan, target, adapters = {}) {
  invariant(
    target.renderer &&
      Number.isSafeInteger(target.companion?.pid) &&
      Number.isSafeInteger(target.companion?.pgid),
    'S10 resource sample requires the actual harness process and renderer'
  )
  const resourceCollector = ownedResourceEvidence.createResourceCollector(target, {
    runExact: adapters.runExact || acceptanceSession.runExact,
    evaluateByValue: adapters.evaluateByValue || harness.evaluateByValue,
    resourceSample: adapters.resourceSample || acceptanceSession.resourceSample,
    resourceAdapters: adapters.resourceAdapters || {}
  })
  adapters = {
    ...adapters,
    observeWorkloadResource: (phase, index, observedTarget = target) =>
      resourceCollector.observe(phase, index, observedTarget)
  }
  const assets = target.s10Assets
  invariant(
    isRecord(assets?.primary) && isRecord(assets?.secondary),
    'S10 target assets are incomplete'
  )
  const resourcePlan = await prewarmS10Resources(plan, target, resourceCollector, adapters)
  const loopProof = await establishS10Loop(plan, target, adapters)
  const prepared = (
    adapters.prepareAvEnduranceSourceEvidence || avAcceptance.prepareAvEnduranceSourceEvidence
  )(
    {
      artifactRoot: plan.artifactRoot,
      expectedAssetId: assets.primary.sha256,
      sourceAssetPath: assets.primary.assetPath
    },
    adapters
  )
  const sampleState = {
    census: prepared.sourcePtsCensus,
    bounds: (adapters.windowBounds || acceptanceSession.windowBounds)(target.window),
    previousPtsSeconds: null
  }
  const sampleReceipts = []
  let sampleClockAnchor = null
  const sampleWallAnchor = Date.now()
  const captureSample = async (entry) => {
    const sample = await (adapters.captureLoopSample || defaultCaptureLoopSample)(
      plan,
      target,
      entry,
      sampleState,
      adapters
    )
    invariant(
      sample.loopActive === true && sample.assetId === assets.primary.sha256,
      `S10 loop sample ${entry.index} lacks active exact-asset loop proof`
    )
    const capturedAtMs = Number.isFinite(sample.captureMonotonicMs)
      ? sample.captureMonotonicMs
      : Number(process.hrtime.bigint()) / 1_000_000
    if (sampleClockAnchor === null) sampleClockAnchor = capturedAtMs
    const elapsedMs = capturedAtMs - sampleClockAnchor
    sample.index = entry.index
    sample.plannedElapsedMs = entry.plannedElapsedMs
    sample.actualElapsedMs = elapsedMs
    sample.monotonicMs = elapsedMs
    sample.wallClockElapsedMs = Date.now() - sampleWallAnchor
    sample.syntheticClock = false
    sample.resource = await adapters.observeWorkloadResource('loop', entry.index, target)
    sampleReceipts.push(sample)
    return sample.raw || sample
  }
  const avResult = await (adapters.runLoopAwareAcceptance || runLoopAwareSampling)(
    plan,
    target,
    prepared,
    {
      ...adapters,
      captureLoopSample: async (_plan, _target, entry) => {
        await captureSample(entry)
        return sampleReceipts.at(-1)
      }
    }
  )
  exactCount(sampleReceipts, SAMPLE_COUNT, 'S10 loop sample')
  invariant(
    sampleReceipts.some((sample) => sample.ptsWrap === true),
    'S10 loop samples did not prove a PTS wrap'
  )
  const loopAvVerdict = validateLoopAwareAvVerdict(
    avResult.evidence,
    sampleReceipts,
    prepared.sourcePtsCensus,
    {
      startTicks: adapters.loopStartTicks,
      endTicks: adapters.loopEndTicks,
      timebaseTicks: adapters.loopTimebaseTicks
    }
  )
  const seeks = await (adapters.performSeeks || defaultPerformSeeks)(
    plan,
    target,
    SEEK_COUNT,
    { loopStartTicks: adapters.loopStartTicks, loopEndTicks: adapters.loopEndTicks },
    adapters
  )
  const seekEvidence = validateSeekReceipts(seeks, assets.primary.sha256)
  const opens = await (adapters.performAlternatingOpens || defaultPerformAlternatingOpens)(
    plan,
    target,
    assets,
    adapters
  )
  const openEvidence = validateAlternatingOpens(opens, [assets.primary, assets.secondary])
  const finalOpenedAsset = [assets.primary, assets.secondary].find(
    (asset) => asset.sha256 === opens.at(-1).assetId
  )
  invariant(finalOpenedAsset, 'S10 final alternating-open asset is unknown')
  target.asset = finalOpenedAsset
  const routes = await (adapters.performRouteCycles || defaultPerformRouteCycles)(
    plan,
    target,
    ROUTE_CYCLE_COUNT,
    adapters
  )
  const routeEvidence = validateRouteCycles(routes)
  const closes = await (adapters.performCloseReopenCycles || defaultPerformCloseReopenCycles)(
    plan,
    target,
    CLOSE_REOPEN_COUNT,
    adapters
  )
  const closeEvidence = validateCloseReopenCycles(closes, target.asset.sha256)
  await adapters.observeWorkloadResource('final', 0, target)
  const resourceEvidence = validateWorkloadResourceVerdict(
    [...resourceCollector.samples],
    {
      processPid: target.companion.pid,
      processPgid: target.companion.pgid,
      executablePath: companionExecutablePath(target),
      primaryAssetId: assets.primary.sha256,
      secondaryAssetId: assets.secondary.sha256
    },
    resourcePlan
  )
  const loopEnd = validateFinalCooldown(
    await (adapters.stopLoopAndReadFinal || defaultStopLoopAndReadFinal)(plan, target, adapters, {
      liveResourceEvidence: resourceEvidence
    }),
    resourceEvidence
  )
  return {
    schemaVersion: S10_SCHEMA_VERSION,
    kind: 'taskwraith-studio-s10-live-journey',
    loop: {
      proof: loopProof,
      avEndurance: avResult.evidence,
      avVerdict: loopAvVerdict,
      sourcePtsCensus: prepared.sourcePtsCensus,
      bounds: {
        startTicks: adapters.loopStartTicks,
        endTicks: adapters.loopEndTicks,
        timebaseTicks: adapters.loopTimebaseTicks
      },
      samples: sampleReceipts,
      loopSeconds: LOOP_MIN_DURATION_SECONDS
    },
    seeks: { ...seekEvidence, receipts: seeks },
    alternatingOpens: { ...openEvidence, receipts: opens },
    routeCycles: { ...routeEvidence, receipts: routes },
    closeReopenCycles: { ...closeEvidence, receipts: closes },
    resources: resourceEvidence,
    finalCloseCooldown: loopEnd,
    phasesComplete: true,
    green: (avResult.evidence.verdict.blockers || []).length === 0,
    blockers: [
      ...(Array.isArray(avResult.evidence.verdict.blockers)
        ? avResult.evidence.verdict.blockers
        : [])
    ]
  }
}

function validateCanonicalLoopEvidence(loop, primary) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  invariant(
    loop.proof.loopStartTicks === loop.bounds.startTicks &&
      loop.proof.loopEndTicks === loop.bounds.endTicks &&
      loop.proof.loopTimebaseTicks === loop.bounds.timebaseTicks,
    'S10 loop setup marks/timebase differ from the adjudicated bounds'
  )
  loop.samples.forEach((sample, index) => {
    invariant(
      same(sample, loop.avEndurance.samples[index]),
      `S10 loop ${index} differs from its canonical A/V/reference record`
    )
    invariant(
      sample.index === index &&
        sample.loopActive === true &&
        sample.assetId === primary.sha256 &&
        sample.observed?.state === 'PLAY' &&
        sample.observed.assetMatch?.matched === true &&
        sample.observed.assetMatch.distance === 0 &&
        sample.observed.assetMatch.assetId === primary.sha256 &&
        sample.observed.contentPtsSeconds === sample.observedPtsSeconds,
      `S10 loop ${index} lacks exact playing primary-asset identity`
    )
    invariant(
      Number.isFinite(sample.captureMonotonicMs) &&
        sample.captureMonotonicMs >= 0 &&
        sample.captureMonotonicMs - loop.samples[0].captureMonotonicMs === sample.monotonicMs &&
        avCore.parseAvSyncCurrentExport(sample.raw.current).timebase.timescale ===
          loop.bounds.timebaseTicks,
      `S10 loop ${index} clock/timebase differs from its captured A/V record`
    )
    const capture = sample.raw.capture
    const reference = sample.referencePixel
    invariant(
      isRecord(capture) &&
        isRecord(reference) &&
        typeof capture.screenshotPath === 'string' &&
        path.isAbsolute(capture.screenshotPath) &&
        digest(capture.screenshotSha256) &&
        Number.isSafeInteger(capture.screenshotByteLength) &&
        capture.screenshotByteLength > 0 &&
        typeof reference.referencePath === 'string' &&
        path.isAbsolute(reference.referencePath) &&
        digest(reference.referenceSha256) &&
        Number.isSafeInteger(reference.referenceByteLength) &&
        reference.referenceByteLength > 0 &&
        typeof capture.rawOcrText === 'string' &&
        digest(capture.rawOcrSha256) &&
        sha256Text(capture.rawOcrText) === capture.rawOcrSha256 &&
        isRecord(capture.windowBounds) &&
        isRecord(capture.sourceHostFrame) &&
        reference.pixelComparison?.clean === true,
      `S10 loop ${index} lacks complete capture/reference custody`
    )
    const exactPts = diagnostics.resolveExactSourcePts(
      loop.sourcePtsCensus.values,
      sample.observedPtsSeconds
    )
    const command = diagnostics.buildReferenceExtractCommand({
      assetPath: primary.assetPath,
      exactSourcePtsSeconds: exactPts,
      referencePath: reference.referencePath
    })
    invariant(
      reference.exactSourcePtsSeconds === exactPts &&
        same(reference.referenceCommand, command) &&
        Array.isArray(reference.referenceExecution?.command) &&
        path.basename(reference.referenceExecution.command[0] || '') === 'ffmpeg' &&
        same(reference.referenceExecution.command.slice(1), command) &&
        digest(reference.referenceExecution.stdoutSha256) &&
        digest(reference.referenceExecution.stderrSha256),
      `S10 loop ${index} reference does not bind the exact primary source PTS/command`
    )
  })
}

function validateCanonicalPhaseEvidence(journey, assets, companion, measured) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const join = (receiptSample, phase, index, assetId) => {
    const sample = measured.samples.find((value) => value.phase === phase && value.index === index)
    invariant(
      sample && sample.assetId === assetId && same(receiptSample, sample),
      `S10 ${phase} ${index} receipt differs from its canonical native observation`
    )
    return sample
  }
  journey.loop.samples.forEach((sample, index) =>
    join(sample.resource, 'loop', index, assets.primary.sha256)
  )
  journey.seeks.receipts.forEach((receipt, index) => {
    join(receipt.resourceSample, 'seek', index, assets.primary.sha256)
    const ticks =
      journey.loop.bounds.startTicks +
      Math.floor(
        ((journey.loop.bounds.endTicks - journey.loop.bounds.startTicks) * (index + 1)) /
          (SEEK_COUNT + 1)
      )
    invariant(
      receipt.requestedPlayheadTicks === ticks &&
        receipt.playheadTicks === ticks &&
        receipt.rawAction?.type === 'set-playhead-ticks' &&
        receipt.rawAction.observedPlayheadTicks === ticks,
      `S10 seek ${index} does not bind its exact requested/observed action`
    )
  })
  journey.alternatingOpens.receipts.forEach((receipt, index) => {
    const sample = join(
      receipt.resourceSample,
      'switch',
      index,
      [assets.primary, assets.secondary][index % 2].sha256
    )
    invariant(
      sample.native.documentRevision === receipt.journalRevision,
      `S10 switch ${index} native/journal revision differs`
    )
  })
  journey.routeCycles.receipts.forEach((receipt, index) => {
    invariant(
      receipt.hudAssetId === assets.secondary.sha256,
      `S10 route ${index} HUD is not the expected secondary asset`
    )
    exactCount(receipt.resourceSamples, 4, `S10 route ${index} native observations`)
    receipt.transitions.forEach((transition, step) => {
      const selectedAfter = step === 0 || step === 2
      invariant(
        transition.routeValueBefore === (selectedAfter ? 'not selected' : 'selected') &&
          transition.routeValueAfter === (selectedAfter ? 'selected' : 'not selected') &&
          transition.pairedRouteValueBefore === 'selected' &&
          transition.pairedRouteValueAfter === 'selected',
        `S10 route ${index}/${step} is not the exact selected-state transition`
      )
      const sample = join(
        receipt.resourceSamples[step],
        'route',
        index * 4 + step,
        assets.secondary.sha256
      )
      assertRouteNativePresentation(sample, receipt.visibilitySnapshots[step])
    })
  })
  const closeRequest = (windowId) => ({
    expectedPid: companion.pid,
    expectedPgid: companion.pgid,
    expectedExecutablePath: companionExecutablePath({ companion }),
    windowId,
    windowTitle: 'TaskWraith Studio'
  })
  journey.closeReopenCycles.receipts.forEach((receipt, index) => {
    const closed = join(receipt.cooldownSample, 'closed', index, assets.secondary.sha256)
    assertClosedNativePresentation(closed)
    const reopened = join(receipt.reopenSample, 'reopen', index, assets.secondary.sha256)
    const preceding = measured.samples[closed.sequence - 1]
    validateExactCloseReceipt(
      receipt.rawCloseReceipt,
      closeRequest(receipt.windowIdBefore),
      `S10 close/reopen ${index}`
    )
    invariant(
      receipt.windowAbsence?.closed === true &&
        receipt.windowAbsence.exactPid === companion.pid &&
        preceding.native.workspace.windowVisible === true &&
        preceding.native.workspace.windowNumber === receipt.windowIdBefore &&
        (closed.native.workspace.windowNumber === null ||
          closed.native.workspace.windowNumber === receipt.windowIdBefore) &&
        reopened.native.workspace.windowNumber === receipt.windowIdAfter &&
        receipt.journalRevisionBefore === closed.native.documentRevision &&
        receipt.journalRevisionBefore >= preceding.native.documentRevision &&
        receipt.journalRevisionAfter === reopened.native.documentRevision &&
        receipt.journalRevisionAfter > receipt.journalRevisionBefore,
      `S10 close/reopen ${index} window/process/revision history differs`
    )
  })
  const lastReopen = journey.closeReopenCycles.receipts.at(-1).reopenSample
  invariant(
    measured.final.native.workspace.windowNumber === lastReopen.native.workspace.windowNumber &&
      measured.final.native.documentRevision === lastReopen.native.documentRevision,
    'S10 final observation differs from the last reopened workspace'
  )
  validateExactCloseReceipt(
    journey.finalCloseCooldown.rawCloseReceipt,
    closeRequest(measured.final.native.workspace.windowNumber),
    'S10 final'
  )
  for (const sample of [
    journey.finalCloseCooldown.terminalCounters.first,
    journey.finalCloseCooldown.terminalCounters.second
  ]) {
    invariant(
      sample.native.documentRevision === measured.final.native.documentRevision &&
        (sample.native.workspace.windowNumber === null ||
          sample.native.workspace.windowNumber === measured.final.native.workspace.windowNumber),
      'S10 final cooldown differs from the closed workspace/revision'
    )
  }
}

async function verifyCanonicalLoopFiles(loop, artifactRoot) {
  for (const sample of loop.samples) {
    const capture = sample.raw.capture
    const reference = sample.referencePixel
    for (const [label, filePath, hash, length] of [
      ['capture', capture.screenshotPath, capture.screenshotSha256, capture.screenshotByteLength],
      [
        'reference',
        reference.referencePath,
        reference.referenceSha256,
        reference.referenceByteLength
      ]
    ]) {
      const file = await assertBoundedArtifactFile(
        filePath,
        artifactRoot,
        `S10 loop ${sample.index} ${label}`
      )
      invariant(
        file.sha256 === hash && file.byteLength === length,
        `S10 loop ${sample.index} ${label} bytes differ from the canonical receipt`
      )
    }
  }
}

function validateCompleteS10Journey(journey, assets, companion) {
  invariant(
    journey?.green === true &&
      journey.phasesComplete === true &&
      Array.isArray(journey.blockers) &&
      journey.blockers.length === 0,
    'S10 complete journey has unresolved phases or blockers'
  )
  validateLoopProof(journey.loop.proof)
  validateLoopAwareAvVerdict(
    journey.loop.avEndurance,
    journey.loop.samples,
    journey.loop.sourcePtsCensus,
    journey.loop.bounds
  )
  validateCanonicalLoopEvidence(journey.loop, assets.primary)
  validateSeekReceipts(journey.seeks.receipts, assets.primary.sha256)
  validateAlternatingOpens(journey.alternatingOpens.receipts, [assets.primary, assets.secondary])
  validateRouteCycles(journey.routeCycles.receipts)
  validateCloseReopenCycles(journey.closeReopenCycles.receipts, assets.secondary.sha256)
  const resourcePlan = journey.resources.owned.plan
  for (const [index, asset] of [assets.primary, assets.secondary].entries()) {
    invariant(
      resourcePlan.assets[index].assetId === asset.sha256 &&
        resourcePlan.assets[index].byteLength === asset.byteLength,
      'S10 fixed resource plan departed from materialized asset custody'
    )
  }
  const measured = validateWorkloadResourceVerdict(
    journey.resources.samples,
    {
      processPid: companion?.pid,
      processPgid: companion?.pgid,
      executablePath: companionExecutablePath({ companion }),
      primaryAssetId: assets.primary.sha256,
      secondaryAssetId: assets.secondary.sha256
    },
    resourcePlan
  )
  invariant(
    resourcePlan.samples[0].processBirth.ppid === companion.ppid &&
      JSON.stringify(measured) === JSON.stringify(journey.resources),
    'S10 whole-workload verdict or harness parent changed'
  )
  validateFinalCooldown(journey.finalCloseCooldown, measured)
  validateCanonicalPhaseEvidence(journey, assets, companion, measured)
  return true
}

async function writeFinalS10Evidence(plan, result, assets, adapters = {}) {
  const finalPath = path.join(plan.artifactRoot, 's10-final-evidence.json')
  try {
    await fsPromises.lstat(finalPath)
    throw new Error('S10 final evidence already exists')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const baseEvidencePath = plan.evidencePath
  const watchdogPath = plan.receiptPath
  const baseEvidenceSha256 = await sha256File(baseEvidencePath)
  const watchdogSha256 = await sha256File(watchdogPath)
  const baseEvidence = await readBoundedJson(baseEvidencePath, 'S10 base harness evidence')
  const watchdogReceipt = await readBoundedJson(watchdogPath, 'S10 watchdog receipt')
  invariant(
    baseEvidence.schemaVersion === 1 &&
      baseEvidence.kind === 'taskwraith-studio-in-product-acceptance' &&
      baseEvidence.ok === true &&
      isRecord(baseEvidence.electron) &&
      isRecord(baseEvidence.watchdogTerminal),
    'S10 base harness evidence is not a successful joined receipt'
  )
  invariant(
    typeof plan.instanceId === 'string' &&
      plan.instanceId.length > 0 &&
      [baseEvidence, result?.evidence, watchdogReceipt].every(
        (receipt) => receipt?.instanceId === plan.instanceId
      ),
    'S10 disk harness, promoted evidence, and watchdog instance mismatch'
  )
  invariant(
    isRecord(baseEvidence.journey) &&
      isRecord(result?.evidence?.journey) &&
      JSON.stringify(baseEvidence.journey) === JSON.stringify(result.evidence.journey),
    'S10 disk harness journey is missing or does not exactly match the promoted journey'
  )
  invariant(
    watchdogReceipt.schemaVersion === 2 &&
      watchdogReceipt.kind === 'taskwraith-studio-acceptance-watchdog',
    'S10 watchdog schema is not trusted'
  )
  harness.assertCleanWatchdogTerminal(watchdogReceipt)
  harness.assertCleanWatchdogTerminal(baseEvidence.watchdogTerminal)
  const electron = baseEvidence.electron
  const usesLaunchServices = electron.launchMode === 'launch-services'
  const expectedWatchdogPid = usesLaunchServices ? electron.launcherPid : electron.pid
  const expectedWatchdogPgid = usesLaunchServices ? electron.launcherPgid : electron.pgid
  for (const receipt of [watchdogReceipt, baseEvidence.watchdogTerminal]) {
    invariant(
      expectedWatchdogPid === receipt.childPid && expectedWatchdogPgid === receipt.childPgid,
      'S10 base harness/watchdog child identity mismatch'
    )
    invariant(
      Array.isArray(receipt.detachedProcessGroups) && receipt.detachedGroupExitVerified === true,
      'S10 detached LaunchServices group reap is not proven'
    )
    if (usesLaunchServices) {
      invariant(
        [electron.pid, electron.pgid, expectedWatchdogPid, expectedWatchdogPgid].every(
          (pid) => Number.isSafeInteger(pid) && pid > 0
        ) &&
          receipt.detachedProcessGroups.filter(
            (group) =>
              isRecord(group) &&
              group.pgid === electron.pgid &&
              Array.isArray(group.memberPids) &&
              group.memberPids.includes(electron.pid)
          ).length === 1,
        'S10 watchdog does not bind the exact reaped detached Electron group'
      )
      invariant(
        isRecord(receipt.launchServicesAdoption) &&
          hasVerifiedLaunchServicesExit(receipt) &&
          receipt.launchServicesAdoption.pid === electron.pid &&
          receipt.launchServicesAdoption.pgid === electron.pgid,
        'S10 watchdog LaunchServices adoption does not bind the exact reaped Electron identity'
      )
    }
  }
  invariant(
    watchdogReceipt.launchServicesExecutable ===
      baseEvidence.watchdogTerminal.launchServicesExecutable &&
      JSON.stringify(watchdogReceipt.launchServicesAdoption) ===
        JSON.stringify(baseEvidence.watchdogTerminal.launchServicesAdoption),
    'S10 watchdog LaunchServices adoption does not exactly match the terminal acknowledgment'
  )
  const runnerBefore = assets.runnerCustodyBefore
  invariant(
    isRecord(runnerBefore) &&
      /^[a-f0-9]{64}$/.test(runnerBefore.sha256 || '') &&
      /^[a-f0-9]{40,64}$/.test(runnerBefore.headBlob || '') &&
      /^[a-f0-9]{40,64}$/.test(runnerBefore.gitHead || ''),
    'S10 runner custody before launch is missing or invalid'
  )
  const journalPath = path.join(plan.studioStateDirectory, 'studio-project.journal.jsonl')
  const journalSha256 = await sha256File(journalPath)
  const zeroCopyAfter = await measureHeadBoundSources(plan.repoRoot, ZERO_COPY_PATHS, adapters)
  const zeroCopySources = {}
  for (const relativePath of ZERO_COPY_PATHS) {
    const before = assets.zeroCopyBefore?.[relativePath]
    const after = zeroCopyAfter[relativePath]
    zeroCopySources[relativePath] = {
      beforeSha256: before?.sha256 || null,
      afterSha256: after.sha256,
      headBlobBefore: before?.headBlob || null,
      headBlobAfter: after.headBlob
    }
    invariant(
      before && before.sha256 === after.sha256 && before.headBlob === after.headBlob,
      `S10 zero-copy source ${relativePath} changed or departed from HEAD during acceptance`
    )
  }
  invariant(
    result?.evidence?.journey?.phasesComplete === true,
    'S10 final evidence refuses an incomplete phase set'
  )
  const referencePixelReceipts = result.evidence.journey.loop.avEndurance.samples.map((sample) => ({
    sampleIndex: sample.index,
    screenshotSha256: sample.raw?.capture?.screenshotSha256,
    referenceSha256: sample.referencePixel?.referenceSha256,
    referenceContentPtsSeconds: sample.referencePixel?.exactSourcePtsSeconds,
    pixelComparison: sample.referencePixel?.pixelComparison
  }))
  invariant(
    referencePixelReceipts.length === SAMPLE_COUNT &&
      referencePixelReceipts.every(
        (receipt, index) => receipt.sampleIndex === index && receipt.pixelComparison?.clean === true
      ),
    'S10 final evidence lacks 21 exact clean reference-pixel receipts'
  )
  const runnerAfter = await measureS10RunnerCustody(plan.repoRoot, adapters)
  invariant(
    JSON.stringify(runnerBefore.dependencies) === JSON.stringify(runnerAfter.dependencies),
    'S10 resource helper changed or departed from HEAD during acceptance'
  )
  const green =
    result.evidence.journey.green === true
      ? validateCompleteS10Journey(result.evidence.journey, assets, baseEvidence.companion)
      : false
  if (green) await verifyCanonicalLoopFiles(result.evidence.journey.loop, plan.artifactRoot)
  const evidence = {
    schemaVersion: S10_SCHEMA_VERSION,
    kind: 'taskwraith-studio-s10-final-evidence',
    instanceId: plan.instanceId,
    gitHead: runnerAfter.gitHead,
    gitHeadBefore: assets.gitHeadBefore || null,
    runner: {
      workspaceRelativePath: S10_RUNNER_RELATIVE_PATH,
      beforeSha256: runnerBefore.sha256,
      afterSha256: runnerAfter.sha256,
      headBlobBefore: runnerBefore.headBlob,
      headBlobAfter: runnerAfter.headBlob,
      dependencies: runnerAfter.dependencies
    },
    baseHarnessEvidence: { path: baseEvidencePath, sha256: baseEvidenceSha256 },
    watchdog: { path: watchdogPath, sha256: watchdogSha256 },
    assets: {
      primary: {
        ...assets.primary,
        beforeSourceSha256:
          assets.primarySourceSha256 || (await sha256File(assets.primary.sourcePath)),
        afterSourceSha256: await sha256File(assets.primary.sourcePath)
      },
      secondary: {
        ...assets.secondary,
        beforeSourceSha256:
          assets.secondarySourceSha256 || (await sha256File(assets.secondary.sourcePath)),
        afterSourceSha256: await sha256File(assets.secondary.sourcePath)
      }
    },
    journal: { path: journalPath, sha256: journalSha256 },
    outcome2: {
      boundary:
        'observed-presented-pixel/source identity + real resource/IOSurface observations; no direct GPU-internal claim',
      zeroCopySourceFiles: zeroCopySources,
      loopPresentedPixelReceipts: result.evidence.journey.loop.samples.map((sample) => ({
        assetId: sample.assetId,
        screenshotSha256: sample.raw?.capture?.screenshotSha256,
        observedPtsSeconds: sample.observedPtsSeconds
      })),
      referencePixelReceipts,
      resourceObservations: result.evidence.journey.resources
    },
    phases: result.evidence.journey,
    terminalResourceVerdict: {
      live: result.evidence.journey.resources,
      cooldown: result.evidence.journey.finalCloseCooldown
    },
    green,
    blockers: result.evidence.journey.blockers,
    noGreenIfPhaseMissing: result.evidence.journey.phasesComplete === true
  }
  invariant(
    evidence.runner.beforeSha256 === evidence.runner.afterSha256 &&
      evidence.runner.headBlobBefore === evidence.runner.headBlobAfter,
    'S10 runner source changed or departed from HEAD during acceptance'
  )
  invariant(
    evidence.assets.primary.beforeSourceSha256 === evidence.assets.primary.afterSourceSha256 &&
      evidence.assets.secondary.beforeSourceSha256 === evidence.assets.secondary.afterSourceSha256,
    'S10 source asset bytes changed during acceptance'
  )
  invariant(/^[a-f0-9]{40,64}$/.test(evidence.gitHead), 'S10 git HEAD receipt is invalid')
  invariant(
    evidence.gitHeadBefore === runnerBefore.gitHead && evidence.gitHeadBefore === evidence.gitHead,
    'S10 git HEAD changed during acceptance'
  )
  const encoded = `${JSON.stringify(evidence, null, 2)}\n`
  invariant(
    Buffer.byteLength(encoded, 'utf8') <= MAX_EVIDENCE_BYTES,
    'S10 final evidence exceeds its bounded byte length'
  )
  const temp = `${finalPath}.tmp-${process.pid}`
  try {
    await fsPromises.writeFile(temp, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fsPromises.link(temp, finalPath)
  } finally {
    await fsPromises.rm(temp, { force: true }).catch(() => undefined)
  }
  const sealed = await fsPromises.readFile(finalPath, 'utf8')
  invariant(
    sha256Text(sealed) === sha256Text(encoded),
    'S10 final evidence changed after atomic seal'
  )
  return { path: finalPath, sha256: sha256Text(sealed), evidence: JSON.parse(sealed) }
}

async function runS10Acceptance(options = {}, adapters = {}) {
  const args = normalizeS10Options(options)
  const plan = buildS10Plan(args)
  if (!args.launch) return { launched: false, plan, blockers: plan.blockers }
  try {
    await fsPromises.lstat(args.artifactRoot)
    throw new Error('S10 live launch requires a fresh nonexistent artifact root')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const runnerCustodyBefore = await measureS10RunnerCustody(args.repoRoot, adapters)
  const primarySourceSha256 = await sha256File(args.primaryMediaPath)
  const secondarySourceSha256 = await sha256File(args.secondaryMediaPath)
  invariant(
    primarySourceSha256 !== secondarySourceSha256,
    'S10 launch blocked before process start: primary and secondary bytes have the same hash'
  )
  const duration = await (adapters.probeMediaDuration || probeMediaDuration)(
    args.primaryMediaPath,
    adapters
  )
  invariant(
    args.loopEndTicks <= Math.ceil(duration.seconds * args.loopTimebaseTicks),
    'S10 launch blocked before native driver: loop-end-ticks exceeds the probed primary duration/timebase bound'
  )
  const runStudioAcceptance = adapters.runStudioAcceptance || harness.runStudioAcceptance
  const runnerBeforeSha256 = runnerCustodyBefore.sha256
  const gitHeadBefore = runnerCustodyBefore.gitHead
  const zeroCopyBefore = await measureHeadBoundSources(args.repoRoot, ZERO_COPY_PATHS, adapters)
  const prePlan = harness.buildStudioAcceptancePlan({
    repoRoot: args.repoRoot,
    artifactRoot: args.artifactRoot,
    instanceId: args.instanceId,
    packagedExecutablePath: args.packagedExecutablePath
  })
  const secondary = await (adapters.materializeOwnedMedia || harness.materializeOwnedMedia)({
    mediaPath: args.secondaryMediaPath,
    mimeType: args.secondaryMimeType,
    userDataPath: prePlan.profile.userDataPath
  })
  let renderer = null
  const baseInvoke = adapters.invokeStudioOpen || harness.invokeAuthorizedStudioOpen
  const result = await runStudioAcceptance(
    {
      launch: true,
      acceptLaunch: true,
      ownerConfirmsOrphansCleared: true,
      instanceId: args.instanceId,
      packagedExecutablePath: args.packagedExecutablePath,
      mediaPath: args.primaryMediaPath,
      mimeType: args.primaryMimeType,
      timeoutMs: args.timeoutMs,
      transcriptTimeoutMs: Math.min(args.timeoutMs, 30 * 60 * 1_000)
    },
    {
      ...adapters,
      planOptions: {
        repoRoot: args.repoRoot,
        artifactRoot: args.artifactRoot,
        packagedExecutablePath: args.packagedExecutablePath
      },
      invokeStudioOpen: async (candidateRenderer, asset, openOptions) => {
        renderer = candidateRenderer
        return baseInvoke(candidateRenderer, asset, openOptions)
      },
      driveUiJourney: async (acceptancePlan, target, journeyAdapters) => {
        const s10Assets = { primary: target.asset, secondary }
        return (adapters.driveS10Journey || runS10Journey)(
          acceptancePlan,
          { ...target, s10Assets, renderer },
          {
            ...adapters,
            ...journeyAdapters,
            renderer,
            loopStartTicks: args.loopStartTicks,
            loopEndTicks: args.loopEndTicks,
            loopTimebaseTicks: args.loopTimebaseTicks,
            openTimeoutMs: args.openTimeoutMs
          }
        )
      }
    }
  )
  const finalEvidence = await (adapters.writeFinalEvidence || writeFinalS10Evidence)(
    result.plan,
    result,
    {
      primary: result.evidence.asset,
      secondary,
      primaryDuration: duration,
      primarySourceSha256,
      secondarySourceSha256,
      runnerBeforeSha256,
      runnerCustodyBefore,
      gitHeadBefore,
      zeroCopyBefore
    },
    adapters
  )
  return { launched: true, plan, result, duration, finalEvidence }
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseS10Cli(argv)
  if (parsed.help) {
    process.stdout.write(
      'S10 plan/live runner: --launch --i-accept-studio-isolated-launch --owner-confirms-existing-orphans-cleared --i-accept-bounded-foreground-loop-setup --primary-media=ABS --primary-mime=video/mp4 --secondary-media=ABS --secondary-mime=video/mp4 --loop-start-ticks=N --loop-end-ticks=N --loop-timebase-ticks=N\n'
    )
    return { help: true }
  }
  const result = await runS10Acceptance(parsed)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result
}

if (require.main === module)
  main().catch((error) => {
    process.stderr.write(`[studio-s10] FAIL — ${error.message}\n`)
    process.exitCode = 1
  })

module.exports = {
  S10_SCHEMA_VERSION,
  PRIMARY_MIN_DURATION_SECONDS,
  LOOP_MIN_DURATION_SECONDS,
  SAMPLE_COUNT,
  SEEK_COUNT,
  ALTERNATING_OPEN_COUNT,
  ROUTE_CYCLE_COUNT,
  CLOSE_REOPEN_COUNT,
  LOOP_SETUP_KEYS,
  EXPECTED_CLOSE_HELPER,
  parseS10Cli,
  normalizeS10Options,
  buildS10Plan,
  materializeS10Assets,
  probeMediaDuration,
  validateLoopProof,
  defaultEstablishLoop,
  validateSeekReceipts,
  validateAlternatingOpens,
  validateRouteCycles,
  defaultPerformRouteCycles,
  defaultPerformAlternatingOpens,
  defaultPerformCloseReopenCycles,
  validateCloseReopenCycles,
  validateS10ResourceVerdict,
  validateWorkloadResourceVerdict,
  validateFinalCooldown,
  validateCompleteS10Journey,
  defaultStopLoopAndReadFinal,
  runLoopAwareSampling,
  validateLoopAwareAvVerdict,
  runS10Journey,
  writeFinalS10Evidence,
  runS10Acceptance,
  sha256Text,
  readBoundedJson,
  measureHeadBoundSources,
  assertNoVisibleStudioWindow,
  assertBoundedArtifactFile
}
