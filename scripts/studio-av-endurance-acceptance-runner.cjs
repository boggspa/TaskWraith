#!/usr/bin/env node
'use strict'

/**
 * Pure, adapter-driven Outcome 5/11 orchestration.
 *
 * This module owns the 21-sample join and evidence boundary. Platform launch,
 * AX capture, and audio probing are deliberately injected so this layer can be
 * tested without starting a real process.
 */

const path = require('node:path')
const crypto = require('node:crypto')
const fs = require('node:fs')
const endurance = require('./studio-av-endurance-runner.cjs')
const diagnostics = require('./studio-bounded-diagnostics-runner.cjs')
const acceptanceSession = require('./studio-acceptance-session.cjs')
const { compareWindowCaptureToReference } = require('./studio-pixel-evidence-verifier.cjs')

const SAMPLE_COUNT = endurance.SAMPLE_COUNT
const NOMINAL_CADENCE_SECONDS = endurance.NOMINAL_CADENCE_SECONDS
const MIN_ELAPSED_SECONDS = endurance.MIN_ELAPSED_SECONDS
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024
const MAX_OCR_BYTES = 4 * 1024 * 1024
const MAX_SOURCE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_CENSUS_BYTES = 32 * 1024 * 1024
const CLOCK_SOURCE = 'process-hrtime-bigint+date-now'
const TEST_CLOCK_SOURCE = 'synthetic-test-only'
const REFERENCE_SOURCE = 'runner-ffprobe+ffmpeg'
const TEST_REFERENCE_SOURCE = 'synthetic-test-only'

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function requireExactKeys(value, expected, label) {
  if (!isRecord(value)) throw new Error(`${label} is not an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has an unexpected schema key set`)
  }
}

function cloneJson(value, label) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (error) {
    throw new Error(`${label} is not JSON-serializable: ${error.message}`)
  }
}

function sha256File(filePath, encoding = 'hex') {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest(encoding)
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function exactJsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function ensureSafeRegularPath(filePath, artifactRoot, label, maximumBytes = MAX_CAPTURE_BYTES) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error(`${label} must be an absolute path`)
  }
  const relative = path.relative(artifactRoot, filePath)
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside artifactRoot`)
  }
  let current = artifactRoot
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    let stat
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      throw new Error(`${label} is unreadable: ${error.message}`)
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse a symlink`)
    if (current === filePath) {
      if (!stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`)
      if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > maximumBytes) {
        throw new Error(`${label} exceeds its bounded byte length`)
      }
      return stat
    }
  }
  throw new Error(`${label} could not be resolved inside artifactRoot`)
}

function ensureSafeRegularPathEvidenceRoot(artifactRoot) {
  let stat
  try {
    stat = fs.lstatSync(artifactRoot)
  } catch (error) {
    throw new Error(`Outcome 5 evidence artifactRoot is unreadable: ${error.message}`)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Outcome 5 evidence artifactRoot must be a regular directory')
  }
}

function exactFiniteGeometry(value, keys, label) {
  requireExactKeys(value, keys, label)
  for (const key of keys) {
    if (!isFiniteNumber(value[key])) throw new Error(`${label}.${key} is not finite`)
  }
  if (value.width <= 0 || value.height <= 0) throw new Error(`${label} is empty`)
}

function normalizeSourceAsset(sourceAssetPath, artifactRoot, expectedAssetId) {
  const stat = ensureSafeRegularPath(
    sourceAssetPath,
    artifactRoot,
    'Outcome 5 source asset',
    MAX_SOURCE_BYTES
  )
  const digest = sha256File(sourceAssetPath, 'base64url')
  if (digest !== expectedAssetId) {
    throw new Error('Outcome 5 source asset bytes do not match expectedAssetId')
  }
  return {
    path: sourceAssetPath,
    sha256Base64Url: digest,
    byteLength: stat.size
  }
}

function executionReceipt(authority, result, expectedCommand, label) {
  if (
    !isRecord(result) ||
    result.exitCode !== 0 ||
    !Array.isArray(result.command) ||
    !exactJsonEqual(result.command, expectedCommand) ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string'
  ) {
    throw new Error(`${label} did not return one exact successful process receipt`)
  }
  return {
    authority,
    command: [...result.command],
    exitCode: result.exitCode,
    stdoutSha256: sha256Text(result.stdout),
    stderrSha256: sha256Text(result.stderr)
  }
}

function requireExecutionReceipt(receipt, authority, expectedCommand, label) {
  requireExactKeys(
    receipt,
    ['authority', 'command', 'exitCode', 'stdoutSha256', 'stderrSha256'],
    label
  )
  if (
    receipt.authority !== authority ||
    receipt.exitCode !== 0 ||
    !exactJsonEqual(receipt.command, expectedCommand)
  ) {
    throw new Error(`${label} is not bound to the canonical successful command`)
  }
  for (const field of ['stdoutSha256', 'stderrSha256']) {
    if (typeof receipt[field] !== 'string' || !/^[0-9a-f]{64}$/.test(receipt[field])) {
      throw new Error(`${label}.${field} is not a canonical SHA-256`)
    }
  }
}

function createReferenceAuthority(options, adapters) {
  const testAuthority = adapters.testOnlyReferenceAuthority
  if (testAuthority !== undefined) {
    if (
      options.testOnlyAllowSyntheticClock !== true ||
      !isRecord(testAuthority) ||
      typeof testAuthority.census !== 'function' ||
      typeof testAuthority.generate !== 'function'
    ) {
      throw new Error('Outcome 5 synthetic reference authority is invalid or unauthorized')
    }
    return {
      source: TEST_REFERENCE_SOURCE,
      census: testAuthority.census,
      generate: testAuthority.generate
    }
  }
  return {
    source: REFERENCE_SOURCE,
    census(sourceAsset) {
      const executable = diagnostics.resolveMediaTool('ffprobe')
      const args = diagnostics.buildFramePtsCensusCommand(sourceAsset.path)
      return acceptanceSession.runExact(executable, args, {
        timeout: 180_000,
        maxBuffer: MAX_CENSUS_BYTES
      })
    },
    generate(sourceAsset, exactSourcePtsSeconds, referencePath) {
      const executable = diagnostics.resolveMediaTool('ffmpeg')
      const args = diagnostics.buildReferenceExtractCommand({
        assetPath: sourceAsset.path,
        exactSourcePtsSeconds,
        referencePath
      })
      return acceptanceSession.runExact(executable, args, {
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024
      })
    }
  }
}

function collectSourcePtsCensus(sourceAsset, authority) {
  const executable = diagnostics.resolveMediaTool('ffprobe')
  const args = diagnostics.buildFramePtsCensusCommand(sourceAsset.path)
  const expectedCommand = [executable, ...args]
  const result = authority.census(sourceAsset, { executable, args })
  if (
    !isRecord(result) ||
    typeof result.stdout !== 'string' ||
    Buffer.byteLength(result.stdout, 'utf8') > MAX_CENSUS_BYTES
  ) {
    throw new Error('Outcome 5 source PTS census is missing or oversized')
  }
  const parsed = diagnostics.parseFramePtsCensus(result.stdout)
  const expectedCount = diagnostics.describeFixtureContract().expectedFrameCount
  if (
    parsed.count !== expectedCount ||
    parsed.values.some((value, index) => index > 0 && value <= parsed.values[index - 1])
  ) {
    throw new Error(
      `Outcome 5 source PTS census is not the canonical strictly advancing fixture: ${parsed.count}/${expectedCount}`
    )
  }
  return {
    authority: authority.source,
    count: parsed.count,
    values: parsed.values,
    rawText: result.stdout,
    rawSha256: sha256Text(result.stdout),
    execution: executionReceipt(
      authority.source,
      result,
      expectedCommand,
      'Outcome 5 source PTS census'
    )
  }
}

function requireSourcePtsCensus(census, sourceAsset) {
  requireExactKeys(
    census,
    ['authority', 'count', 'values', 'rawText', 'rawSha256', 'execution'],
    'Outcome 5 source PTS census'
  )
  if (![REFERENCE_SOURCE, TEST_REFERENCE_SOURCE].includes(census.authority)) {
    throw new Error('Outcome 5 source PTS census authority is invalid')
  }
  if (
    typeof census.rawText !== 'string' ||
    Buffer.byteLength(census.rawText, 'utf8') > MAX_CENSUS_BYTES ||
    sha256Text(census.rawText) !== census.rawSha256
  ) {
    throw new Error('Outcome 5 source PTS census raw bytes are invalid')
  }
  const parsed = diagnostics.parseFramePtsCensus(census.rawText)
  if (
    census.count !== diagnostics.describeFixtureContract().expectedFrameCount ||
    parsed.count !== census.count ||
    !exactJsonEqual(parsed.values, census.values) ||
    parsed.values.some((value, index) => index > 0 && value <= parsed.values[index - 1])
  ) {
    throw new Error('Outcome 5 source PTS census values were forged or changed')
  }
  const executable = diagnostics.resolveMediaTool('ffprobe')
  const args = diagnostics.buildFramePtsCensusCommand(sourceAsset.path)
  requireExecutionReceipt(
    census.execution,
    census.authority,
    [executable, ...args],
    'Outcome 5 source PTS census execution'
  )
  return parsed
}

function parseBoundOcr(rawOcrText, rawOcrSha256, expectedAssetId, index) {
  if (
    typeof rawOcrText !== 'string' ||
    rawOcrText.length === 0 ||
    Buffer.byteLength(rawOcrText, 'utf8') > MAX_OCR_BYTES
  ) {
    throw new Error(`sample ${index} raw OCR observation is missing or oversized`)
  }
  if (typeof rawOcrSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(rawOcrSha256)) {
    throw new Error(`sample ${index} rawOcrSha256 is not a canonical SHA-256`)
  }
  if (sha256Text(rawOcrText) !== rawOcrSha256) {
    throw new Error(`sample ${index} raw OCR bytes do not match rawOcrSha256`)
  }
  let observations
  try {
    observations = JSON.parse(rawOcrText)
  } catch (error) {
    throw new Error(`sample ${index} raw OCR is not JSON: ${error.message}`)
  }
  if (!Array.isArray(observations)) {
    throw new Error(`sample ${index} raw OCR must decode to an observation array`)
  }
  const hudReceipt = {
    observations,
    texts: observations.map((observation) => observation?.text),
    stdoutSha256: rawOcrSha256
  }
  const hud = diagnostics.parseVisibleHud(hudReceipt, expectedAssetId, {
    matchAsset: acceptanceSession.hudContainsAsset
  })
  const playable = diagnostics.isPlayableSample(hud, null, {
    maximumPtsSeconds: Number.MAX_SAFE_INTEGER
  })
  if (!playable.valid) {
    throw new Error(
      `sample ${index} raw OCR has no exact playable HUD observation: ${playable.reasons.join(', ')}`
    )
  }
  return hud
}

function authorizeCaptureReference(
  rawCapture,
  artifactRoot,
  sourceAsset,
  expectedAssetId,
  sourcePtsCensus,
  authority,
  index
) {
  requireExactKeys(
    rawCapture,
    [
      'screenshotPath',
      'screenshotSha256',
      'windowBounds',
      'sourceHostFrame',
      'hudOverlayHeight',
      'rawOcrText',
      'rawOcrSha256'
    ],
    `sample ${index} raw capture`
  )
  const hud = parseBoundOcr(rawCapture.rawOcrText, rawCapture.rawOcrSha256, expectedAssetId, index)
  const exactSourcePtsSeconds = diagnostics.resolveExactSourcePts(
    sourcePtsCensus.values,
    hud.contentPtsSeconds
  )
  const referencePath = path.join(
    artifactRoot,
    `av-endurance-reference-${String(index).padStart(2, '0')}.png`
  )
  const executable = diagnostics.resolveMediaTool('ffmpeg')
  const referenceCommand = diagnostics.buildReferenceExtractCommand({
    assetPath: sourceAsset.path,
    exactSourcePtsSeconds,
    referencePath
  })
  const result = authority.generate(sourceAsset, exactSourcePtsSeconds, referencePath, {
    executable,
    args: referenceCommand,
    index
  })
  const referenceExecution = executionReceipt(
    authority.source,
    result,
    [executable, ...referenceCommand],
    `sample ${index} reference generation`
  )
  ensureSafeRegularPath(
    referencePath,
    artifactRoot,
    `sample ${index} referencePath`,
    MAX_CAPTURE_BYTES
  )
  return {
    ...cloneJson(rawCapture, `sample ${index} raw capture`),
    referencePath,
    referenceSha256: sha256File(referencePath),
    referenceContentPtsSeconds: exactSourcePtsSeconds,
    referenceAssetId: expectedAssetId,
    referenceCommand,
    referenceExecution
  }
}

function requireCaptureBinding(
  rawCapture,
  artifactRoot,
  sourceAsset,
  expectedAssetId,
  referenceAuthority,
  index,
  normalized = false
) {
  if (!isRecord(rawCapture)) throw new Error(`sample ${index} has no capture binding`)
  const captureKeys = [
    'screenshotPath',
    'referencePath',
    'screenshotSha256',
    'referenceSha256',
    'referenceContentPtsSeconds',
    'referenceAssetId',
    'referenceCommand',
    'referenceExecution',
    'windowBounds',
    'sourceHostFrame',
    'hudOverlayHeight',
    'rawOcrText',
    'rawOcrSha256'
  ]
  if (normalized) captureKeys.push('pixelComparison')
  requireExactKeys(rawCapture, captureKeys, `sample ${index} capture binding`)
  ensureSafeRegularPath(
    rawCapture.screenshotPath,
    artifactRoot,
    `sample ${index} screenshotPath`,
    MAX_CAPTURE_BYTES
  )
  ensureSafeRegularPath(
    rawCapture.referencePath,
    artifactRoot,
    `sample ${index} referencePath`,
    MAX_CAPTURE_BYTES
  )
  for (const [label, value] of [
    ['screenshotSha256', rawCapture.screenshotSha256],
    ['referenceSha256', rawCapture.referenceSha256],
    ['rawOcrSha256', rawCapture.rawOcrSha256]
  ]) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`sample ${index} ${label} is not a canonical SHA-256`)
    }
  }
  exactFiniteGeometry(
    rawCapture.windowBounds,
    ['x', 'y', 'width', 'height'],
    `sample ${index} windowBounds`
  )
  exactFiniteGeometry(
    rawCapture.sourceHostFrame,
    ['x', 'y', 'width', 'height'],
    `sample ${index} sourceHostFrame`
  )
  if (!Number.isInteger(rawCapture.hudOverlayHeight) || rawCapture.hudOverlayHeight < 0) {
    throw new Error(`sample ${index} hudOverlayHeight is invalid`)
  }
  const geometryTolerance = 1
  if (
    rawCapture.sourceHostFrame.x < rawCapture.windowBounds.x - geometryTolerance ||
    rawCapture.sourceHostFrame.y < rawCapture.windowBounds.y - geometryTolerance ||
    rawCapture.sourceHostFrame.x + rawCapture.sourceHostFrame.width >
      rawCapture.windowBounds.x + rawCapture.windowBounds.width + geometryTolerance ||
    rawCapture.sourceHostFrame.y + rawCapture.sourceHostFrame.height >
      rawCapture.windowBounds.y + rawCapture.windowBounds.height + geometryTolerance
  ) {
    throw new Error(`sample ${index} sourceHostFrame is outside windowBounds`)
  }
  if (
    !isFiniteNumber(rawCapture.referenceContentPtsSeconds) ||
    rawCapture.referenceContentPtsSeconds < 0 ||
    rawCapture.referenceAssetId !== expectedAssetId
  ) {
    throw new Error(`sample ${index} reference is not bound to the source asset and PTS`)
  }
  const expectedReferenceCommand = diagnostics.buildReferenceExtractCommand({
    assetPath: sourceAsset.path,
    exactSourcePtsSeconds: rawCapture.referenceContentPtsSeconds,
    referencePath: rawCapture.referencePath
  })
  if (!exactJsonEqual(rawCapture.referenceCommand, expectedReferenceCommand)) {
    throw new Error(`sample ${index} reference command is not the canonical exact-PTS extraction`)
  }
  const referenceExecutable = diagnostics.resolveMediaTool('ffmpeg')
  requireExecutionReceipt(
    rawCapture.referenceExecution,
    referenceAuthority,
    [referenceExecutable, ...expectedReferenceCommand],
    `sample ${index} reference execution`
  )
  if (![REFERENCE_SOURCE, TEST_REFERENCE_SOURCE].includes(referenceAuthority)) {
    throw new Error(`sample ${index} reference execution authority is invalid`)
  }
  if (sha256File(rawCapture.screenshotPath) !== rawCapture.screenshotSha256) {
    throw new Error(`sample ${index} screenshot bytes do not match screenshotSha256`)
  }
  if (sha256File(rawCapture.referencePath) !== rawCapture.referenceSha256) {
    throw new Error(`sample ${index} reference bytes do not match referenceSha256`)
  }
  const hud = parseBoundOcr(rawCapture.rawOcrText, rawCapture.rawOcrSha256, expectedAssetId, index)
  if (
    Math.abs(rawCapture.referenceContentPtsSeconds - hud.contentPtsSeconds) >
    diagnostics.PTS_SELECTION_TOLERANCE_SECONDS
  ) {
    throw new Error(`sample ${index} reference PTS disagrees with the OCR-derived decoded PTS`)
  }
  let comparison
  try {
    comparison = compareWindowCaptureToReference(
      rawCapture.screenshotPath,
      rawCapture.referencePath,
      rawCapture.windowBounds,
      {
        sourceHostFrame: rawCapture.sourceHostFrame,
        hudOverlayHeight: rawCapture.hudOverlayHeight
      }
    )
  } catch (error) {
    throw new Error(`sample ${index} pixel comparison is invalid: ${error.message}`)
  }
  if (!comparison.clean) throw new Error(`sample ${index} pixel comparison is not clean`)
  if (normalized && !exactJsonEqual(rawCapture.pixelComparison, comparison)) {
    throw new Error(`sample ${index} stored pixel comparison was forged or changed`)
  }
  const registration = comparison.registration
  if (
    !exactJsonEqual(registration.sourceHostFrame, rawCapture.sourceHostFrame) ||
    !exactJsonEqual(registration.logicalHudOverlayHeight, rawCapture.hudOverlayHeight)
  ) {
    throw new Error(`sample ${index} pixel registration geometry was changed`)
  }
  return {
    capture: {
      ...cloneJson(rawCapture, `sample ${index} capture binding`),
      pixelComparison: comparison
    },
    hud
  }
}

function requireExactAssetObservation(hud, expectedAssetId, index) {
  requireExactKeys(
    hud,
    [
      'contentPtsText',
      'contentPtsSeconds',
      'state',
      'diagnostics',
      'players',
      'assetMatch',
      'rawOcrSha256'
    ],
    `sample ${index} HUD`
  )
  requireExactKeys(
    hud.diagnostics,
    ['droppedFrames', 'heldFrames', 'shownFrames', 'cacheHits', 'textures'],
    `sample ${index} HUD diagnostics`
  )
  requireExactKeys(hud.players, ['count', 'rssMegabytes'], `sample ${index} HUD players`)
  requireExactKeys(
    hud.assetMatch,
    [
      'matched',
      'expected',
      'observedCandidate',
      'observationIndex',
      'comparedLength',
      'distance',
      'threshold',
      'assetId'
    ],
    `sample ${index} HUD assetMatch`
  )
  if (
    !isFiniteNumber(hud.contentPtsSeconds) ||
    hud.contentPtsSeconds < 0 ||
    hud.state !== 'PLAY' ||
    hud.assetMatch.matched !== true ||
    hud.assetMatch.distance !== 0 ||
    hud.assetMatch.assetId !== expectedAssetId ||
    hud.rawOcrSha256 === null
  ) {
    throw new Error(`sample ${index} has no exact decoded PTS/asset observation`)
  }
  if (!Number.isSafeInteger(hud.diagnostics.droppedFrames) || hud.diagnostics.droppedFrames < 0) {
    throw new Error(`sample ${index} has no exact droppedFrames observation`)
  }
}

function normalizeResource(raw, index) {
  if (!isRecord(raw)) throw new Error(`sample ${index} has no resource receipt`)
  const resourceText = raw.resourceDetailValue
  const parsed = endurance.parseResourceDetailExport(resourceText)
  if (!parsed.ok) throw new Error(`sample ${index} resource receipt is invalid: ${parsed.reason}`)
  for (const field of ['physicalFootprintBytes', 'mallocAllocatedBytes', 'residentBytes']) {
    if (!Number.isSafeInteger(raw[field]) || raw[field] < 0) {
      throw new Error(`sample ${index} resource ${field} is missing or invalid`)
    }
  }
  return {
    resourceDetailValue: resourceText,
    residentDecoderCount: parsed.residentDecoderCount,
    ioSurfaceCapacity: parsed.ioSurfaceCapacity,
    liveIoSurfaceIds: parsed.liveIoSurfaceIds,
    footprintBytes: raw.physicalFootprintBytes,
    mallocInUseBytes: raw.mallocAllocatedBytes,
    residentBytes: raw.residentBytes,
    physicalFootprintBytes: raw.physicalFootprintBytes,
    mallocAllocatedBytes: raw.mallocAllocatedBytes,
    rawPhysicalFootprintBytes: raw.physicalFootprintBytes,
    rawMallocAllocatedBytes: raw.mallocAllocatedBytes,
    rawResourceReceipt: cloneJson(raw, `sample ${index} raw resource receipt`)
  }
}

function canonicalMonotonicNs(value, label) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`${label} is not a canonical monotonic nanosecond count`)
  }
  return BigInt(value)
}

function normalizeTiming(rawTiming, clock, index) {
  requireExactKeys(
    rawTiming,
    ['beforeMonotonicNs', 'afterMonotonicNs', 'beforeWallTimeMs', 'afterWallTimeMs'],
    `sample ${index} runner timing`
  )
  const anchorNs = canonicalMonotonicNs(clock.anchorMonotonicNs, 'Outcome 5 clock anchor')
  const beforeNs = canonicalMonotonicNs(
    rawTiming.beforeMonotonicNs,
    `sample ${index} beforeMonotonicNs`
  )
  const afterNs = canonicalMonotonicNs(
    rawTiming.afterMonotonicNs,
    `sample ${index} afterMonotonicNs`
  )
  for (const field of ['beforeWallTimeMs', 'afterWallTimeMs']) {
    if (!Number.isSafeInteger(rawTiming[field]) || rawTiming[field] < 0) {
      throw new Error(`sample ${index} ${field} is not a wall-clock millisecond receipt`)
    }
  }
  if (beforeNs < anchorNs || afterNs < beforeNs) {
    throw new Error(`sample ${index} runner monotonic timing is reversed`)
  }
  if (
    rawTiming.beforeWallTimeMs < clock.anchorWallTimeMs ||
    rawTiming.afterWallTimeMs < rawTiming.beforeWallTimeMs
  ) {
    throw new Error(`sample ${index} runner wall timing is reversed`)
  }
  return {
    timing: cloneJson(rawTiming, `sample ${index} runner timing`),
    actualElapsedMs: rawTiming.beforeWallTimeMs - clock.anchorWallTimeMs,
    monotonicMs: Number(beforeNs - anchorNs) / 1_000_000
  }
}

function normalizeSample(
  raw,
  planEntry,
  expectedAssetId,
  artifactRoot,
  sourceAsset,
  sourcePtsCensus,
  clock,
  rawTiming
) {
  if (!isRecord(raw)) throw new Error(`sample ${planEntry.index} receipt is missing`)
  requireExactKeys(
    raw,
    ['current', 'peak', 'resource', 'capture'],
    `sample ${planEntry.index} adapter receipt`
  )
  const current = endurance.parseAvSyncCurrentExport(raw.current)
  if (!current.ok)
    throw new Error(`sample ${planEntry.index} current avc1 receipt is invalid: ${current.reason}`)
  const peak = endurance.parseAvSyncPeakExport(raw.peak)
  if (!peak.ok)
    throw new Error(`sample ${planEntry.index} peak av1 receipt is invalid: ${peak.reason}`)
  const resource = normalizeResource(raw.resource, planEntry.index)
  const runnerTiming = normalizeTiming(rawTiming, clock, planEntry.index)
  const bound = requireCaptureBinding(
    raw.capture,
    artifactRoot,
    sourceAsset,
    expectedAssetId,
    sourcePtsCensus.authority,
    planEntry.index
  )
  requireExactAssetObservation(bound.hud, expectedAssetId, planEntry.index)
  const sample = {
    index: planEntry.index,
    plannedElapsedMs: planEntry.plannedElapsedMs,
    actualElapsedMs: runnerTiming.actualElapsedMs,
    monotonicMs: runnerTiming.monotonicMs,
    timing: runnerTiming.timing,
    decodedContentPtsSeconds: bound.hud.contentPtsSeconds,
    droppedFrames: bound.hud.diagnostics.droppedFrames,
    hud: bound.hud,
    rawAvc1: raw.current,
    rawAv1: raw.peak,
    current,
    peak,
    resource,
    capture: bound.capture
  }
  const joinedResource = {
    ...resource,
    sampleIndex: planEntry.index,
    monotonicMs: runnerTiming.monotonicMs
  }
  sample.resource = joinedResource
  return {
    sample,
    currentEntry: {
      sampleIndex: planEntry.index,
      monotonicMs: runnerTiming.monotonicMs,
      rawText: raw.current,
      receipt: current,
      timebase: current.timebase
    },
    peakEntry: {
      sampleIndex: planEntry.index,
      monotonicMs: runnerTiming.monotonicMs,
      rawText: raw.peak,
      receipt: peak,
      timebase: current.timebase
    },
    resource: joinedResource
  }
}

function acceptanceIntegrityFailures(samples, resources) {
  const failures = []
  const list = Array.isArray(samples) ? samples : []
  let previousPts = null
  for (let index = 0; index < list.length; index += 1) {
    const pts = list[index]?.decodedContentPtsSeconds
    if (!isFiniteNumber(pts) || pts < 0) {
      failures.push(`sample ${index} decoded content PTS is missing or invalid`)
    } else if (previousPts !== null && pts <= previousPts) {
      failures.push(`sample ${index} decoded content PTS did not strictly advance`)
    }
    if (isFiniteNumber(pts)) previousPts = pts
  }
  const first = list[0]
  const last = list.at(-1)
  const ptsSpan =
    first &&
    last &&
    isFiniteNumber(first.decodedContentPtsSeconds) &&
    isFiniteNumber(last.decodedContentPtsSeconds)
      ? last.decodedContentPtsSeconds - first.decodedContentPtsSeconds
      : null
  if (ptsSpan === null || ptsSpan < 570) {
    failures.push(
      `decoded content PTS span ${ptsSpan === null ? 'unknown' : ptsSpan}s is under 570s`
    )
  }
  const elapsedSpan =
    first && last && isFiniteNumber(first.actualElapsedMs) && isFiniteNumber(last.actualElapsedMs)
      ? (last.actualElapsedMs - first.actualElapsedMs) / 1000
      : null
  if (
    ptsSpan !== null &&
    elapsedSpan !== null &&
    Math.abs(ptsSpan - elapsedSpan) > NOMINAL_CADENCE_SECONDS
  ) {
    failures.push(
      `decoded content PTS span ${ptsSpan}s disagrees with elapsed span ${elapsedSpan}s by over one cadence`
    )
  }
  const readings = Array.isArray(resources?.readings) ? resources.readings : []
  const capacities = readings.map((reading) => reading?.ioSurfaceCapacity)
  if (
    capacities.length !== SAMPLE_COUNT ||
    capacities.some((capacity) => !Number.isSafeInteger(capacity) || capacity <= 0)
  ) {
    failures.push('IOSurface capacity is missing or non-positive at one or more samples')
  } else if (capacities.some((capacity) => capacity !== capacities[0])) {
    failures.push('IOSurface capacity changed during the endurance run')
  }
  if (resources?.ioSurfaceCapacity !== capacities[0]) {
    failures.push('aggregate IOSurface capacity does not equal the stable per-sample capacity')
  }
  return failures
}

function recomputeVerdict({
  samples,
  timebasePlan,
  currentSamples,
  peakSamples,
  audio,
  resources,
  clock
}) {
  const core = endurance.summarizeOutcome5({
    samples,
    timebasePlan,
    currentSamples,
    peakSamples,
    audio,
    resources
  })
  const extraFailures = acceptanceIntegrityFailures(samples, resources)
  if (clock?.source === TEST_CLOCK_SOURCE) {
    extraFailures.push('synthetic test timing cannot prove a live ten-minute endurance run')
  }
  return {
    ...core,
    status: core.failures.length === 0 && extraFailures.length === 0 ? 'blocked' : 'red',
    failures: [...core.failures, ...extraFailures]
  }
}

function validateAcceptanceEvidence(evidence) {
  if (
    !isRecord(evidence) ||
    evidence.schemaVersion !== 1 ||
    evidence.kind !== 'taskwraith-studio-av-endurance-acceptance'
  ) {
    throw new Error('Outcome 5 evidence schema identity is invalid')
  }
  requireExactKeys(
    evidence,
    [
      'schemaVersion',
      'kind',
      'expectedAssetId',
      'artifactRoot',
      'sourceAsset',
      'sourcePtsCensus',
      'clock',
      'startedAtMs',
      'plan',
      'samples',
      'currentSamples',
      'peakSamples',
      'timebasePlan',
      'resources',
      'audio',
      'verdict'
    ],
    'Outcome 5 evidence'
  )
  if (typeof evidence.expectedAssetId !== 'string' || evidence.expectedAssetId.length === 0) {
    throw new Error('Outcome 5 evidence expectedAssetId is invalid')
  }
  if (typeof evidence.artifactRoot !== 'string' || !path.isAbsolute(evidence.artifactRoot)) {
    throw new Error('Outcome 5 evidence artifactRoot is invalid')
  }
  ensureSafeRegularPathEvidenceRoot(evidence.artifactRoot)
  requireExactKeys(
    evidence.sourceAsset,
    ['path', 'sha256Base64Url', 'byteLength'],
    'Outcome 5 source asset'
  )
  const normalizedSourceAsset = normalizeSourceAsset(
    evidence.sourceAsset.path,
    evidence.artifactRoot,
    evidence.expectedAssetId
  )
  if (!exactJsonEqual(evidence.sourceAsset, normalizedSourceAsset)) {
    throw new Error('Outcome 5 source asset receipt was forged or changed')
  }
  const parsedSourcePtsCensus = requireSourcePtsCensus(
    evidence.sourcePtsCensus,
    evidence.sourceAsset
  )
  requireExactKeys(
    evidence.clock,
    ['source', 'anchorMonotonicNs', 'anchorWallTimeMs'],
    'Outcome 5 runner clock'
  )
  if (![CLOCK_SOURCE, TEST_CLOCK_SOURCE].includes(evidence.clock.source)) {
    throw new Error('Outcome 5 runner clock source is invalid')
  }
  if (
    (evidence.clock.source === TEST_CLOCK_SOURCE) !==
    (evidence.sourcePtsCensus.authority === TEST_REFERENCE_SOURCE)
  ) {
    throw new Error('Outcome 5 clock and reference authorities disagree about test-only custody')
  }
  const anchorNs = canonicalMonotonicNs(evidence.clock.anchorMonotonicNs, 'Outcome 5 clock anchor')
  if (
    !Number.isSafeInteger(evidence.clock.anchorWallTimeMs) ||
    evidence.clock.anchorWallTimeMs < 0
  ) {
    throw new Error('Outcome 5 wall-clock anchor is invalid')
  }
  if (!isFiniteNumber(evidence.startedAtMs)) {
    throw new Error('Outcome 5 evidence startedAtMs is invalid')
  }
  if (evidence.startedAtMs !== Number(anchorNs) / 1_000_000) {
    throw new Error('Outcome 5 plan anchor is not derived from the runner monotonic clock')
  }
  const expectedPlan = endurance.planSamples({ startedAtMs: evidence.startedAtMs })
  if (!Array.isArray(evidence.plan) || evidence.plan.length !== SAMPLE_COUNT) {
    throw new Error(`Outcome 5 evidence plan must contain exactly ${SAMPLE_COUNT} entries`)
  }
  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    const planned = evidence.plan[i]
    const expected = expectedPlan[i]
    requireExactKeys(planned, ['index', 'plannedElapsedMs', 'plannedAtMs'], `Outcome 5 plan ${i}`)
    if (
      planned.index !== expected.index ||
      planned.plannedElapsedMs !== expected.plannedElapsedMs ||
      planned.plannedAtMs !== expected.plannedAtMs
    ) {
      throw new Error(`Outcome 5 plan ${i} departs from the canonical 0..600s plan`)
    }
  }
  for (const field of ['samples', 'currentSamples', 'peakSamples', 'timebasePlan']) {
    if (!Array.isArray(evidence[field]) || evidence[field].length !== SAMPLE_COUNT) {
      throw new Error(`Outcome 5 evidence ${field} must contain exactly ${SAMPLE_COUNT} entries`)
    }
  }
  if (
    !isRecord(evidence.resources) ||
    !Array.isArray(evidence.resources.readings) ||
    evidence.resources.readings.length !== SAMPLE_COUNT
  ) {
    throw new Error('Outcome 5 evidence resource readings are incomplete')
  }
  requireExactKeys(
    evidence.resources,
    ['readings', 'ioSurfaceCapacity', 'droppedFrames'],
    'Outcome 5 resources'
  )
  const screenshotPaths = new Set()
  const screenshotHashes = new Set()
  const referencePaths = new Set()
  const referencePts = new Set()
  const rawOcrHashes = new Set()
  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    const sample = evidence.samples[i]
    if (
      !isRecord(sample) ||
      sample.index !== i ||
      sample.plannedElapsedMs !== expectedPlan[i].plannedElapsedMs
    ) {
      throw new Error(`Outcome 5 sample ${i} is not joined to the canonical plan`)
    }
    requireExactAssetObservation(sample.hud, evidence.expectedAssetId, i)
    if (
      sample.decodedContentPtsSeconds !== sample.hud.contentPtsSeconds ||
      sample.droppedFrames !== sample.hud.diagnostics.droppedFrames ||
      !isFiniteNumber(sample.actualElapsedMs) ||
      !isFiniteNumber(sample.monotonicMs)
    ) {
      throw new Error(`Outcome 5 sample ${i} HUD observation is not exactly joined`)
    }
    requireExactKeys(
      sample,
      [
        'index',
        'plannedElapsedMs',
        'actualElapsedMs',
        'monotonicMs',
        'timing',
        'decodedContentPtsSeconds',
        'droppedFrames',
        'hud',
        'rawAvc1',
        'rawAv1',
        'current',
        'peak',
        'resource',
        'capture'
      ],
      `Outcome 5 sample ${i}`
    )
    const reboundCapture = requireCaptureBinding(
      sample.capture,
      evidence.artifactRoot,
      evidence.sourceAsset,
      evidence.expectedAssetId,
      evidence.sourcePtsCensus.authority,
      i,
      true
    )
    if (
      !exactJsonEqual(reboundCapture.capture, sample.capture) ||
      !exactJsonEqual(reboundCapture.hud, sample.hud)
    ) {
      throw new Error(`Outcome 5 sample ${i} capture binding was forged or changed`)
    }
    const resolvedSourcePts = diagnostics.resolveExactSourcePts(
      parsedSourcePtsCensus.values,
      sample.hud.contentPtsSeconds
    )
    if (resolvedSourcePts !== sample.capture.referenceContentPtsSeconds) {
      throw new Error(`Outcome 5 sample ${i} reference PTS is not in the source census`)
    }
    const reboundTiming = normalizeTiming(sample.timing, evidence.clock, i)
    if (
      reboundTiming.actualElapsedMs !== sample.actualElapsedMs ||
      reboundTiming.monotonicMs !== sample.monotonicMs
    ) {
      throw new Error(`Outcome 5 sample ${i} timing was forged or changed`)
    }
    if (
      screenshotPaths.has(sample.capture.screenshotPath) ||
      screenshotHashes.has(sample.capture.screenshotSha256) ||
      referencePaths.has(sample.capture.referencePath) ||
      referencePts.has(sample.capture.referenceContentPtsSeconds) ||
      rawOcrHashes.has(sample.capture.rawOcrSha256)
    ) {
      throw new Error(
        `Outcome 5 sample ${i} reuses a screenshot path/hash, reference path/PTS, or raw OCR hash`
      )
    }
    screenshotPaths.add(sample.capture.screenshotPath)
    screenshotHashes.add(sample.capture.screenshotSha256)
    referencePaths.add(sample.capture.referencePath)
    referencePts.add(sample.capture.referenceContentPtsSeconds)
    rawOcrHashes.add(sample.capture.rawOcrSha256)
    const resource = evidence.resources.readings[i]
    requireExactKeys(
      resource,
      [
        'resourceDetailValue',
        'residentDecoderCount',
        'ioSurfaceCapacity',
        'liveIoSurfaceIds',
        'footprintBytes',
        'mallocInUseBytes',
        'residentBytes',
        'physicalFootprintBytes',
        'mallocAllocatedBytes',
        'rawPhysicalFootprintBytes',
        'rawMallocAllocatedBytes',
        'rawResourceReceipt',
        'sampleIndex',
        'monotonicMs'
      ],
      `Outcome 5 resource ${i}`
    )
    if (resource.sampleIndex !== i || resource.monotonicMs !== sample.monotonicMs) {
      throw new Error(`Outcome 5 resource ${i} is not joined to its sample clock`)
    }
    const renormalizedResource = normalizeResource(resource.rawResourceReceipt, i)
    const resourceForCompare = { ...resource }
    const renormalizedForCompare = { ...renormalizedResource }
    delete resourceForCompare.rawResourceReceipt
    delete renormalizedForCompare.rawResourceReceipt
    if (
      !exactJsonEqual(resourceForCompare, {
        ...renormalizedForCompare,
        sampleIndex: i,
        monotonicMs: sample.monotonicMs
      })
    ) {
      throw new Error(`Outcome 5 resource ${i} raw receipt does not match normalized values`)
    }
    if (!exactJsonEqual(sample.resource, resource)) {
      throw new Error(`Outcome 5 sample ${i} resource join was changed`)
    }
    const current = evidence.currentSamples[i]
    const peak = evidence.peakSamples[i]
    const timebase = evidence.timebasePlan[i]
    requireExactKeys(
      current,
      ['sampleIndex', 'monotonicMs', 'rawText', 'receipt', 'timebase'],
      `Outcome 5 current sample ${i}`
    )
    requireExactKeys(
      peak,
      ['sampleIndex', 'monotonicMs', 'rawText', 'receipt', 'timebase'],
      `Outcome 5 peak sample ${i}`
    )
    requireExactKeys(
      timebase,
      ['sampleIndex', 'timescale', 'frameDurationTicks'],
      `Outcome 5 timebase ${i}`
    )
    if (
      current.sampleIndex !== i ||
      peak.sampleIndex !== i ||
      current.monotonicMs !== sample.monotonicMs ||
      peak.monotonicMs !== sample.monotonicMs ||
      timebase.sampleIndex !== i ||
      current.receipt?.kind !== 'current' ||
      peak.receipt?.kind !== 'peak' ||
      current.rawText !== sample.rawAvc1 ||
      peak.rawText !== sample.rawAv1 ||
      current.timebase?.timescale !== timebase.timescale ||
      current.timebase?.frameDurationTicks !== timebase.frameDurationTicks ||
      peak.timebase?.timescale !== timebase.timescale ||
      peak.timebase?.frameDurationTicks !== timebase.frameDurationTicks
    ) {
      throw new Error(`Outcome 5 sample ${i} has a non-canonical A/V join`)
    }
    const reparsedCurrent = endurance.parseAvSyncCurrentExport(current.rawText)
    const reparsedPeak = endurance.parseAvSyncPeakExport(peak.rawText)
    if (
      !reparsedCurrent.ok ||
      !reparsedPeak.ok ||
      !exactJsonEqual(reparsedCurrent, current.receipt) ||
      !exactJsonEqual(reparsedPeak, peak.receipt)
    ) {
      throw new Error(`Outcome 5 sample ${i} raw A/V receipt does not match its parsed receipt`)
    }
  }
  if (!isRecord(evidence.audio)) throw new Error('Outcome 5 audio evidence is missing')
  requireExactKeys(
    evidence.audio,
    ['windowAudio', 'silenceWindow', 'routeHealth', 'priorRouteHealth'],
    'Outcome 5 audio evidence'
  )
  if (!isRecord(evidence.verdict) || !['red', 'blocked'].includes(evidence.verdict.status)) {
    throw new Error('Outcome 5 evidence verdict is invalid')
  }
  const recomputedVerdict = recomputeVerdict({
    samples: evidence.samples,
    timebasePlan: evidence.timebasePlan,
    currentSamples: evidence.currentSamples,
    peakSamples: evidence.peakSamples,
    audio: evidence.audio,
    resources: evidence.resources,
    clock: evidence.clock
  })
  if (!exactJsonEqual(recomputedVerdict, evidence.verdict)) {
    throw new Error('Outcome 5 verdict is not an independent recomputation of raw evidence')
  }
  return evidence
}

function normalizeClockRead(value, label) {
  requireExactKeys(value, ['monotonicNs', 'wallTimeMs'], label)
  canonicalMonotonicNs(value.monotonicNs, `${label} monotonicNs`)
  if (!Number.isSafeInteger(value.wallTimeMs) || value.wallTimeMs < 0) {
    throw new Error(`${label} wallTimeMs is invalid`)
  }
  return { monotonicNs: value.monotonicNs, wallTimeMs: value.wallTimeMs }
}

function createRunnerClock(options, adapters) {
  if (adapters.monotonicNow !== undefined) {
    throw new Error('Outcome 5 refuses adapter-controlled monotonicNow evidence')
  }
  if (adapters.testOnlyClock !== undefined) {
    if (options.testOnlyAllowSyntheticClock !== true) {
      throw new Error('Outcome 5 synthetic clock requires explicit test-only authorization')
    }
    if (!isRecord(adapters.testOnlyClock) || typeof adapters.testOnlyClock.read !== 'function') {
      throw new Error('Outcome 5 test-only clock is invalid')
    }
    return {
      source: TEST_CLOCK_SOURCE,
      read: () => normalizeClockRead(adapters.testOnlyClock.read(), 'Outcome 5 test clock')
    }
  }
  return {
    source: CLOCK_SOURCE,
    read: () => ({
      monotonicNs: process.hrtime.bigint().toString(),
      wallTimeMs: Date.now()
    })
  }
}

function monotonicMilliseconds(clockRead) {
  return Number(canonicalMonotonicNs(clockRead.monotonicNs, 'Outcome 5 clock read')) / 1_000_000
}

async function runAvEnduranceAcceptance(options = {}, adapters = {}) {
  const requestedArtifactRoot = options.artifactRoot
  const artifactRoot = path.resolve(String(requestedArtifactRoot || ''))
  const expectedAssetId = options.expectedAssetId
  if (
    typeof requestedArtifactRoot !== 'string' ||
    !path.isAbsolute(requestedArtifactRoot) ||
    artifactRoot === path.parse(artifactRoot).root
  ) {
    throw new Error('Outcome 5 acceptance requires an absolute artifact root')
  }
  if (typeof expectedAssetId !== 'string' || expectedAssetId.length < 1) {
    throw new Error('Outcome 5 acceptance requires an expected asset identity')
  }
  if (typeof options.sourceAssetPath !== 'string' || !path.isAbsolute(options.sourceAssetPath)) {
    throw new Error('Outcome 5 acceptance requires an absolute source asset path')
  }
  ensureSafeRegularPathEvidenceRoot(artifactRoot)
  const sourceAsset = normalizeSourceAsset(options.sourceAssetPath, artifactRoot, expectedAssetId)
  if (typeof adapters.sampleAt !== 'function')
    throw new Error('Outcome 5 acceptance requires sampleAt')
  const runnerClock = createRunnerClock(options, adapters)
  const referenceAuthority = createReferenceAuthority(options, adapters)
  if (
    (runnerClock.source === TEST_CLOCK_SOURCE) !==
    (referenceAuthority.source === TEST_REFERENCE_SOURCE)
  ) {
    throw new Error('Outcome 5 clock and reference authority must share production/test custody')
  }
  const sourcePtsCensus = collectSourcePtsCensus(sourceAsset, referenceAuthority)
  const waitUntil =
    adapters.waitUntil ||
    (async (plannedAtMs) => {
      while (true) {
        const delay = plannedAtMs - monotonicMilliseconds(runnerClock.read())
        if (delay <= 0) return
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 1_000)))
      }
    })
  if (typeof waitUntil !== 'function') throw new Error('Outcome 5 waitUntil adapter is invalid')
  const anchor = runnerClock.read()
  const startedAtMs = monotonicMilliseconds(anchor)
  const clock = {
    source: runnerClock.source,
    anchorMonotonicNs: anchor.monotonicNs,
    anchorWallTimeMs: anchor.wallTimeMs
  }
  const plan = endurance.planSamples({ startedAtMs })
  const samples = []
  const currentSamples = []
  const peakSamples = []
  const resources = []
  for (const planEntry of plan) {
    if (planEntry.index > 0) await waitUntil(planEntry.plannedAtMs, planEntry)
    const before = planEntry.index === 0 ? anchor : runnerClock.read()
    const raw = await adapters.sampleAt(planEntry, {
      plannedAtMs: planEntry.plannedAtMs,
      runnerClockSource: runnerClock.source
    })
    const after = runnerClock.read()
    const authorizedCapture = authorizeCaptureReference(
      raw.capture,
      artifactRoot,
      sourceAsset,
      expectedAssetId,
      sourcePtsCensus,
      referenceAuthority,
      planEntry.index
    )
    const normalized = normalizeSample(
      { ...raw, capture: authorizedCapture },
      planEntry,
      expectedAssetId,
      artifactRoot,
      sourceAsset,
      sourcePtsCensus,
      clock,
      {
        beforeMonotonicNs: before.monotonicNs,
        afterMonotonicNs: after.monotonicNs,
        beforeWallTimeMs: before.wallTimeMs,
        afterWallTimeMs: after.wallTimeMs
      }
    )
    samples.push(normalized.sample)
    currentSamples.push(normalized.currentEntry)
    peakSamples.push(normalized.peakEntry)
    resources.push(normalized.resource)
  }
  const ioSurfaceCapacity = resources[0]?.ioSurfaceCapacity || 0
  const resourceEvidence = {
    readings: resources,
    ioSurfaceCapacity,
    droppedFrames: samples.reduce((max, sample) => Math.max(max, sample.droppedFrames), 0)
  }
  const timebasePlan = currentSamples.map((entry) => ({
    sampleIndex: entry.sampleIndex,
    timescale: entry.timebase.timescale,
    frameDurationTicks: entry.timebase.frameDurationTicks
  }))
  const audio = adapters.audioEvidence || {
    windowAudio: null,
    silenceWindow: null,
    routeHealth: null,
    priorRouteHealth: null
  }
  const verdict = recomputeVerdict({
    samples,
    timebasePlan,
    currentSamples,
    peakSamples,
    audio,
    resources: resourceEvidence,
    clock
  })
  const evidence = validateAcceptanceEvidence({
    schemaVersion: 1,
    kind: 'taskwraith-studio-av-endurance-acceptance',
    expectedAssetId,
    artifactRoot,
    sourceAsset,
    sourcePtsCensus,
    clock,
    startedAtMs,
    plan,
    samples,
    currentSamples,
    peakSamples,
    timebasePlan,
    resources: resourceEvidence,
    audio,
    verdict
  })
  const writeEvidence = adapters.writeEvidence
  if (writeEvidence) await writeEvidence(artifactRoot, evidence)
  return { evidence, artifactRoot }
}

module.exports = {
  MIN_ELAPSED_SECONDS,
  NOMINAL_CADENCE_SECONDS,
  SAMPLE_COUNT,
  normalizeResource,
  normalizeSample,
  planSamples: endurance.planSamples,
  runAvEnduranceAcceptance,
  validateAcceptanceEvidence
}
