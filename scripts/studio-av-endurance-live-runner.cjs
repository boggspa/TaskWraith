#!/usr/bin/env node
'use strict'

/**
 * Packaged, ten-minute Outcome 5 runner.
 *
 * Launch, custody, process ownership, and cleanup remain the harness contract.
 * This file supplies only the live Source journey and its adapter boundary so
 * the journey can be tested without starting Electron or the native driver.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const harness = require('./studio-acceptance-harness.cjs')
const acceptanceSession = require('./studio-acceptance-session.cjs')
const diagnostics = require('./studio-bounded-diagnostics-runner.cjs')
const avAcceptance = require('./studio-av-endurance-acceptance-runner.cjs')
const avCore = require('./studio-av-endurance-runner.cjs')
const { compareWindowCaptureToReference } = require('./studio-pixel-evidence-verifier.cjs')

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1_000
const AUDIO_PROBE_SECONDS = 2

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function isSafeAbsolute(value, label) {
  const resolved = path.resolve(String(value || ''))
  invariant(
    path.isAbsolute(resolved) && resolved !== path.parse(resolved).root,
    `${label} is unbounded`
  )
  return resolved
}

function safeInstanceId(value) {
  const instanceId = String(value || '')
  invariant(/^[a-z0-9][a-z0-9-]{0,63}$/.test(instanceId), 'instanceId is invalid')
  return instanceId
}

function defaultArtifactRoot(repoRoot = acceptanceSession.repoRoot) {
  const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  return path.join(
    repoRoot,
    '.local-only',
    'taskwraith-studio',
    'acceptance',
    `av-endurance-${suffix}`
  )
}

function parseInteger(value, label, minimum, maximum) {
  const parsed = Number(value)
  invariant(
    Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum,
    `${label} is invalid`
  )
  return parsed
}

function parseLiveCli(argv = process.argv.slice(2)) {
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
    timeoutMs: DEFAULT_TIMEOUT_MS
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--launch') parsed.launch = true
    else if (argument === '--i-accept-studio-isolated-launch') parsed.acceptLaunch = true
    else if (argument === '--owner-confirms-existing-orphans-cleared') {
      parsed.ownerConfirmsOrphansCleared = true
    } else if (argument === '--generate-speech-fixture') {
      throw new Error('live endurance requires an owner-supplied 600-second media file')
    } else if (argument.startsWith('--artifact-root=')) parsed.artifactRoot = argument.slice(16)
    else if (argument === '--artifact-root' && index + 1 < argv.length)
      parsed.artifactRoot = argv[++index]
    else if (argument.startsWith('--instance-id=')) parsed.instanceId = argument.slice(14)
    else if (argument === '--instance-id' && index + 1 < argv.length)
      parsed.instanceId = argv[++index]
    else if (argument.startsWith('--packaged-executable='))
      parsed.packagedExecutablePath = argument.slice(23)
    else if (argument === '--packaged-executable' && index + 1 < argv.length)
      parsed.packagedExecutablePath = argv[++index]
    else if (argument.startsWith('--timeout-ms='))
      parsed.timeoutMs = parseInteger(argument.slice(13), 'timeout-ms', 30_000, 30 * 60 * 1_000)
    else if (argument === '--timeout-ms' && index + 1 < argv.length)
      parsed.timeoutMs = parseInteger(argv[++index], 'timeout-ms', 30_000, 30 * 60 * 1_000)
    else if (argument.startsWith('--media=')) {
      parsed.mediaPath = argument.slice(8)
      parsed.generateSpeechFixture = false
    } else if (argument === '--media' && index + 1 < argv.length) {
      parsed.mediaPath = argv[++index]
      parsed.generateSpeechFixture = false
    } else if (argument.startsWith('--mime=')) {
      parsed.mimeType = argument.slice(7)
    } else if (argument === '--mime' && index + 1 < argv.length) parsed.mimeType = argv[++index]
    else throw new Error(`unknown live endurance argument: ${argument}`)
  }
  return parsed
}

function normalizeRunOptions(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || acceptanceSession.repoRoot)
  const artifactRoot = isSafeAbsolute(
    options.artifactRoot || defaultArtifactRoot(repoRoot),
    'artifactRoot'
  )
  const instanceId = safeInstanceId(
    options.instanceId || `av-endurance-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  )
  const launch = options.launch === true
  const generateSpeechFixture = false
  const args = {
    launch,
    acceptLaunch: options.acceptLaunch === true,
    ownerConfirmsOrphansCleared: options.ownerConfirmsOrphansCleared === true,
    artifactRoot,
    instanceId,
    packagedExecutablePath: options.packagedExecutablePath ?? null,
    generateSpeechFixture,
    mediaPath: options.mediaPath ?? null,
    mimeType: options.mimeType ?? null,
    timeoutMs: parseInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'timeoutMs',
      30_000,
      30 * 60 * 1_000
    ),
    transcriptTimeoutMs: options.transcriptTimeoutMs
  }
  if (args.launch && (!args.mediaPath || !path.isAbsolute(args.mediaPath))) {
    throw new Error('live endurance launch requires an absolute owner-supplied media path')
  }
  if (
    args.launch &&
    !['video/mp4', 'video/quicktime'].includes(String(args.mimeType || '').toLowerCase())
  ) {
    throw new Error('live endurance launch requires mimeType video/mp4 or video/quicktime')
  }
  if (args.packagedExecutablePath !== null) {
    args.packagedExecutablePath = isSafeAbsolute(
      args.packagedExecutablePath,
      'packagedExecutablePath'
    )
  }
  return args
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

function assertAssetInsideArtifactRoot(asset, artifactRoot) {
  invariant(
    isRecord(asset) && typeof asset.assetPath === 'string',
    'live endurance asset receipt is missing'
  )
  const root = path.resolve(artifactRoot)
  const assetPath = path.resolve(asset.assetPath)
  invariant(assetPath.startsWith(root + path.sep), 'live endurance asset escaped artifactRoot')
  const stat = fs.lstatSync(assetPath)
  invariant(stat.isFile() && !stat.isSymbolicLink(), 'live endurance asset is not a regular file')
}

function actionOf(receipt, type) {
  const actions = Array.isArray(receipt?.actions)
    ? receipt.actions.filter((action) => action?.type === type)
    : []
  invariant(actions.length === 1, `live endurance UI receipt requires exactly one ${type} action`)
  return actions[0]
}

function validatePostStopPausedState(
  hud,
  expectedAssetId,
  census,
  expectedContentPtsSeconds,
  index,
  matchAsset = acceptanceSession.hudContainsAsset
) {
  invariant(
    isRecord(census) && Array.isArray(census.values) && Number.isFinite(expectedContentPtsSeconds),
    `live endurance paused-state contract is incomplete at sample ${index}`
  )
  const observed = diagnostics.parseVisibleHud(hud, expectedAssetId, { matchAsset })
  const expectedPts = diagnostics.resolveExactSourcePts(census.values, expectedContentPtsSeconds)
  const pausedPts = diagnostics.resolveExactSourcePts(census.values, observed.contentPtsSeconds)
  invariant(
    observed.state === 'PAUSE' &&
      observed.assetMatch?.matched === true &&
      observed.assetMatch?.distance === 0 &&
      pausedPts >= expectedPts &&
      pausedPts - expectedPts <= 1,
    `live endurance post-stop audio is not bound to PAUSE at sample ${index}: ${JSON.stringify({
      observed,
      expectedPts,
      pausedPts
    })}`
  )
  return { observed, exactSourcePtsSeconds: pausedPts }
}

async function buildPtsCensus(assetPath, adapters = {}) {
  const runExact = adapters.runExact || acceptanceSession.runExact
  const command = diagnostics.buildFramePtsCensusCommand(assetPath)
  const receipt = runExact(acceptanceSession.resolveMediaTool('ffprobe'), command, {
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024
  })
  const parsed = diagnostics.parseFramePtsCensus(receipt.stdout)
  invariant(parsed.count > 1, 'live endurance PTS census is empty or singular')
  const span = parsed.values.at(-1) - parsed.values[0]
  invariant(
    span >= avAcceptance.MIN_ELAPSED_SECONDS - 1,
    `live endurance media is shorter than 600 seconds: ${span}`
  )
  return { ...parsed, command: receipt.command }
}

async function readSampleUi(plan, target, bounds, index, options = {}, adapters = {}) {
  const runDriver = adapters.runStudioUiDriver || harness.runStudioUiDriver
  const actions = [{ type: 'read-workspace' }, { type: 'read-av-sync' }]
  if (options.requirePausedState) {
    actions.push({ type: 'screenshot', name: `av_endurance_paused_${String(index)}` })
  }
  if (options.includeAudio) {
    actions.push(
      { type: 'coreaudio-route-health' },
      { type: 'audio-probe', durationSeconds: AUDIO_PROBE_SECONDS }
    )
  }
  const receipt = await runDriver(plan, target, actions, {
    ...(adapters.driverAdapters || {}),
    inputDelivery: 'background-observation-only',
    allowForegroundInput: false
  })
  const workspaceAction = actionOf(receipt, 'read-workspace')
  const workspace = harness.validateStudioWorkspaceObservation(workspaceAction.workspace, bounds)
  invariant(
    workspace.sourceRoute?.value === 'selected' &&
      workspace.sourceHost?.visible === true &&
      workspace.sourceHost?.frame,
    `live endurance Source workspace was not selected/visible at sample ${index}`
  )
  const avAction = actionOf(receipt, 'read-av-sync')
  const current = avCore.parseAvSyncCurrentExport(avAction.avSyncCurrentValue)
  const peak = avCore.parseAvSyncPeakExport(avAction.avSyncPeakValue)
  invariant(
    current.ok && peak.ok,
    `live endurance A/V receipts were not canonical at sample ${index}`
  )
  const result = {
    receipt,
    workspaceObservation: { receipt, workspace, sourceHostFrame: workspace.sourceHost.frame },
    avSync: {
      current: avAction.avSyncCurrentValue,
      peak: avAction.avSyncPeakValue,
      resourceDetailValue: avAction.resourceDetailValue,
      resourceMatchCount: avAction.resourceMatchCount
    }
  }
  if (options.includeAudio) {
    const routeAction = actionOf(receipt, 'coreaudio-route-health')
    const audioAction = actionOf(receipt, 'audio-probe')
    result.routeHealth = routeAction.routeHealth
    result.audioProbe = audioAction.audioProbe
  }
  if (options.requirePausedState) {
    const screenshot = actionOf(receipt, 'screenshot')
    const hud = (adapters.ocrScreenshot || acceptanceSession.ocrScreenshot)(
      screenshot.screenshotPath
    )
    const paused = validatePostStopPausedState(
      hud,
      target.asset.sha256,
      options.census,
      options.expectedContentPtsSeconds,
      index,
      adapters.hudContainsAsset || acceptanceSession.hudContainsAsset
    )
    result.pausedState = {
      screenshotPath: screenshot.screenshotPath,
      screenshotSha256: acceptanceSession.sha256File(screenshot.screenshotPath),
      hud,
      ...paused
    }
  }
  return result
}

async function captureTerminalSample(
  plan,
  target,
  census,
  bounds,
  index,
  previousPtsSeconds,
  adapters = {}
) {
  const workspaceObservation = await (
    adapters.readSourceWorkspaceObservation || diagnostics.readSourceWorkspaceObservation
  )(plan, target, bounds, adapters)
  const capture = await (adapters.captureNative || acceptanceSession.captureNative)(
    plan,
    target,
    `diagnostics-${String(index)}-terminal`
  )
  const hud = (adapters.ocrScreenshot || acceptanceSession.ocrScreenshot)(capture.path)
  const observed = diagnostics.parseVisibleHud(hud, target.asset.sha256, {
    matchAsset: adapters.hudContainsAsset || acceptanceSession.hudContainsAsset
  })
  const playable = diagnostics.isPlayableSample(observed, previousPtsSeconds)
  const terminalPaused =
    observed.state === 'PAUSE' &&
    Number.isFinite(observed.contentPtsSeconds) &&
    observed.assetMatch?.matched === true &&
    Number.isFinite(previousPtsSeconds) &&
    observed.contentPtsSeconds > previousPtsSeconds &&
    observed.contentPtsSeconds <= diagnostics.describeFixtureContract().durationSeconds
  invariant(
    playable.valid || terminalPaused,
    `live endurance terminal sample was not exact: ${JSON.stringify({ observed, playable })}`
  )
  const exactSourcePtsSeconds = diagnostics.resolveExactSourcePts(
    census.values,
    observed.contentPtsSeconds
  )
  const referencePath = path.join(
    plan.artifactRoot,
    `diagnostics-reference-${String(index)}-terminal.png`
  )
  const runExact = adapters.runExact || acceptanceSession.runExact
  const command = diagnostics.buildReferenceExtractCommand({
    assetPath: target.asset.assetPath,
    exactSourcePtsSeconds,
    referencePath
  })
  const referenceReceipt = runExact(acceptanceSession.resolveMediaTool('ffmpeg'), command, {
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024
  })
  const reference = {
    path: referencePath,
    sha256: acceptanceSession.sha256File(referencePath),
    exactSourcePtsSeconds,
    command: referenceReceipt.command
  }
  const materialPixels = (
    adapters.compareWindowCaptureToReference || compareWindowCaptureToReference
  )(capture.path, reference.path, bounds, { sourceHostFrame: workspaceObservation.sourceHostFrame })
  invariant(
    materialPixels.clean === true,
    `live endurance terminal pixel comparison failed: ${JSON.stringify(materialPixels.metrics)}`
  )
  return {
    index,
    sourceHostFrame: workspaceObservation.sourceHostFrame,
    capture,
    hud,
    observed,
    playable: terminalPaused ? { valid: true, reasons: ['terminal-paused-at-end'] } : playable,
    terminalPaused,
    exactSourcePtsSeconds,
    reference,
    materialPixels,
    workspaceObservation
  }
}

function resourceReceipt(resource, avSync, index) {
  invariant(
    isRecord(resource) && isRecord(resource.ps),
    `live endurance resource probe is missing at sample ${index}`
  )
  invariant(
    Number.isSafeInteger(resource.ps.rssKilobytes) && resource.ps.rssKilobytes >= 0,
    `live endurance resource RSS is invalid at sample ${index}`
  )
  return {
    ...resource,
    resourceDetailValue: avSync.resourceDetailValue,
    residentBytes: resource.ps.rssKilobytes * 1024
  }
}

async function runOutcome5Journey(plan, target, adapters = {}) {
  assertAssetInsideArtifactRoot(target.asset, plan.artifactRoot)
  const bounds = (adapters.windowBounds || acceptanceSession.windowBounds)(target.window)
  const readiness = await (
    adapters.waitForPausedMediaReadiness || diagnostics.waitForPausedMediaReadiness
  )(plan, target, bounds, adapters)
  const focusSnapshot = adapters.focusSnapshot || acceptanceSession.focusSnapshot
  const assertFocus =
    adapters.assertSourceWindowFocusIsolation || acceptanceSession.assertSourceWindowFocusIsolation
  const focusBeforeStart = focusSnapshot(target.companion.pid)
  const pressTransition = adapters.pressPlaybackTransition || diagnostics.pressPlaybackTransition
  const playbackStart = await pressTransition(plan, target, 'paused', 'playing', adapters)
  const focusAfterStart = focusSnapshot(target.companion.pid)
  const startFocusIsolation = assertFocus(focusBeforeStart, focusAfterStart, target.companion.pid)
  const census = await (adapters.buildPtsCensus || buildPtsCensus)(target.asset.assetPath, adapters)
  let previousPtsSeconds = null
  let positiveAudio = null
  let priorRouteHealth = null
  let stopEvidence = null
  const samples = []
  const audioEvidence = {
    windowAudio: null,
    silenceWindow: null,
    routeHealth: null,
    priorRouteHealth: null
  }
  const avRun = adapters.runAvEnduranceAcceptance || avAcceptance.runAvEnduranceAcceptance
  const avResult = await avRun(
    {
      artifactRoot: plan.artifactRoot,
      expectedAssetId: target.asset.sha256,
      sourceAssetPath: target.asset.assetPath
    },
    {
      ...adapters,
      audioEvidence,
      sampleAt: async (planEntry) => {
        const fresh =
          planEntry.index === avAcceptance.SAMPLE_COUNT - 1
            ? await (adapters.captureTerminalSample || captureTerminalSample)(
                plan,
                target,
                census,
                bounds,
                planEntry.index,
                previousPtsSeconds,
                adapters
              )
            : await (adapters.waitForFreshPlayableSample || diagnostics.waitForFreshPlayableSample)(
                plan,
                target,
                census,
                bounds,
                planEntry.index,
                previousPtsSeconds,
                adapters
              )
        const ui = await (adapters.readSampleUi || readSampleUi)(
          plan,
          target,
          bounds,
          planEntry.index,
          { includeAudio: planEntry.index === 0 },
          adapters
        )
        const resourceProbe = await (adapters.resourceSample || acceptanceSession.resourceSample)(
          target.companion.pid,
          planEntry.index,
          fresh.observed.contentPtsSeconds,
          adapters.resourceAdapters || {}
        )
        const rawOcrText = JSON.stringify(fresh.hud.observations)
        const raw = {
          current: ui.avSync.current,
          peak: ui.avSync.peak,
          resource: resourceReceipt(resourceProbe, ui.avSync, planEntry.index),
          capture: {
            screenshotPath: fresh.capture.path,
            screenshotSha256: fresh.capture.sha256,
            windowBounds: bounds,
            sourceHostFrame: fresh.sourceHostFrame,
            hudOverlayHeight: fresh.materialPixels.registration.logicalHudOverlayHeight,
            rawOcrText,
            rawOcrSha256: sha256Text(rawOcrText)
          }
        }
        previousPtsSeconds = fresh.observed.contentPtsSeconds
        samples.push({ index: planEntry.index, fresh, ui, resourceProbe })
        if (planEntry.index === 0) {
          positiveAudio = ui.audioProbe
          priorRouteHealth = ui.routeHealth
        }
        if (planEntry.index === avAcceptance.SAMPLE_COUNT - 1) {
          const focusBeforeStop = focusSnapshot(target.companion.pid)
          const playbackStop = fresh.terminalPaused
            ? { terminalPaused: true, reason: 'media-reached-final-frame-before-explicit-stop' }
            : await pressTransition(plan, target, 'playing', 'paused', adapters)
          const focusAfterStop = focusSnapshot(target.companion.pid)
          const stopFocusIsolation = assertFocus(
            focusBeforeStop,
            focusAfterStop,
            target.companion.pid
          )
          const stopped = await (adapters.readSampleUi || readSampleUi)(
            plan,
            target,
            bounds,
            planEntry.index,
            {
              includeAudio: true,
              requirePausedState: true,
              expectedContentPtsSeconds: fresh.observed.contentPtsSeconds,
              census
            },
            adapters
          )
          invariant(
            isRecord(stopped.pausedState),
            'live endurance silence probe has no exact post-stop PAUSE observation'
          )
          stopEvidence = {
            playbackStop,
            stopFocusIsolation,
            pausedState: stopped.pausedState,
            routeHealth: stopped.routeHealth
          }
          audioEvidence.windowAudio = positiveAudio
          audioEvidence.silenceWindow = stopped.audioProbe
          audioEvidence.routeHealth = stopped.routeHealth
          audioEvidence.priorRouteHealth = priorRouteHealth
        }
        return raw
      },
      writeEvidence:
        adapters.writeAvEvidence ||
        (async (artifactRoot, evidence) => {
          await acceptanceSession.writeJson(
            path.join(artifactRoot, 'av-endurance-evidence.json'),
            evidence
          )
        })
    }
  )
  invariant(stopEvidence, 'live endurance did not complete the playing-to-paused transition')
  invariant(
    isRecord(audioEvidence.windowAudio) &&
      isRecord(audioEvidence.silenceWindow) &&
      isRecord(audioEvidence.routeHealth) &&
      isRecord(audioEvidence.priorRouteHealth),
    'live endurance did not capture complete positive/silence route evidence'
  )
  const focusAtEnd = focusSnapshot(target.companion.pid)
  const finalFocusIsolation = assertFocus(focusAfterStart, focusAtEnd, target.companion.pid)
  return {
    kind: 'taskwraith-studio-av-endurance-live-journey',
    readiness,
    playback: {
      start: playbackStart,
      stop: stopEvidence.playbackStop,
      postStopPausedState: stopEvidence.pausedState,
      focusIsolation: {
        start: startFocusIsolation,
        stop: stopEvidence.stopFocusIsolation,
        final: finalFocusIsolation
      }
    },
    census,
    samples,
    avEndurance: avResult,
    audio: avResult.evidence.audio,
    outcome11Stress: 'not-run-by-this-bounded-outcome-5-journey',
    outcomePromotionAuthorized: false,
    physicalAudibility: 'blocked'
  }
}

async function runLiveAcceptance(options = {}, adapters = {}) {
  const args = normalizeRunOptions(options)
  const runStudioAcceptance = adapters.runStudioAcceptance || harness.runStudioAcceptance
  return runStudioAcceptance(args, {
    ...adapters,
    planOptions: { ...(adapters.planOptions || {}), artifactRoot: args.artifactRoot },
    driveUiJourney: (plan, target, journeyAdapters) =>
      runOutcome5Journey(plan, target, { ...adapters, ...journeyAdapters })
  })
}

async function main(argv = process.argv.slice(2)) {
  const parsed = parseLiveCli(argv)
  if (parsed.help) {
    process.stdout.write(
      'Usage: studio-av-endurance-live-runner.cjs [--launch --i-accept-studio-isolated-launch --owner-confirms-existing-orphans-cleared] [--artifact-root PATH] [--packaged-executable PATH] [--media /absolute/600s.mp4 --mime video/mp4]\n'
    )
    return { help: true }
  }
  const result = await runLiveAcceptance(parsed)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[studio-av-endurance-live-runner] FAIL — ${error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  AUDIO_PROBE_SECONDS,
  DEFAULT_TIMEOUT_MS,
  assertAssetInsideArtifactRoot,
  buildPtsCensus,
  defaultArtifactRoot,
  main,
  normalizeRunOptions,
  parseLiveCli,
  readSampleUi,
  resourceReceipt,
  runLiveAcceptance,
  runOutcome5Journey,
  sha256Text,
  validatePostStopPausedState
}
