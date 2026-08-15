'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { PNG } = require('pngjs')

const repoRoot = path.resolve(__dirname, '..')
const DEFAULT_EVIDENCE_PATH = path.join(
  repoRoot,
  '.local-only/taskwraith-studio/acceptance/w1acc10e/pixel-idr-fix-523-storm-full-evidence.json'
)
const DEFAULT_DRIVER_PATH = path.join(repoRoot, 'scripts/studio-acceptance-ui-driver.swift')
const DEFAULT_VISUAL_REFERENCES = Object.freeze({
  cycleTwo: path.join(
    repoRoot,
    '.local-only/taskwraith-studio/acceptance/w1acc10e/pixel-idr-verifier/reference-18_000.png'
  ),
  final: path.join(
    repoRoot,
    '.local-only/taskwraith-studio/acceptance/w1acc10e/pixel-idr-verifier/reference-17_083.png'
  )
})
const VISUAL_THRESHOLDS = Object.freeze({
  maximumMeanAbsoluteChannelResidual: 10,
  maximumP99ChannelResidual: 50,
  maximumFractionAbove40: 0.03,
  maximumFractionAbove80: 0.01
})

const EXPECTED = Object.freeze({
  evidenceSha256: '331d60817d598c4838444c7918f9bc794e3855bb7513f567815f6d8c6b5678cc',
  fixtureSha256: 'f7e39d4237fe1e408a76d213a322f60a8788eeaedac5252d95677135b08380f9',
  ticksPerSecond: 500_000,
  toleranceTicks: 25_000,
  cadenceLowerBoundMs: 120,
  finalPositionTicks: 8_550_000,
  finalContentPtsSeconds: 17.083,
  cycleTwoScreenshotSha256: 'eba053bb4e61cc6e4e19fbedd0e622972a9beddec257c4369cdef1e5ab1ce9f9',
  cycleTwoReferenceSha256: '91d88fd342bf868a377026db49c0192ebddc40be2d1d02e05be933076f487937',
  finalScreenshotSha256: '05cf5bd1fcfdf6f0b8dfeab1df9cb400fcbfbf0ddf308e6c86e139b14e28350f',
  finalReferenceSha256: '6dde433f5aa54326143927cde81ac6350aeb4cc46884f3bb402b16baf3a25bcc'
})

const CYCLES = Object.freeze([
  Object.freeze({ laterSeconds: 241, backwardSecondSteps: 240, finalSeconds: 1 }),
  Object.freeze({ laterSeconds: 182, backwardSecondSteps: 180, finalSeconds: 2 }),
  Object.freeze({ laterSeconds: 121, backwardSecondSteps: 103, finalSeconds: 18 })
])

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath))
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function pixelChannel(image, x, y, channel) {
  const boundedX = Math.max(0, Math.min(image.width - 1, x))
  const boundedY = Math.max(0, Math.min(image.height - 1, y))
  return image.data[(boundedY * image.width + boundedX) * 4 + channel]
}

function bilinearChannel(image, x, y, channel) {
  const left = Math.floor(x)
  const top = Math.floor(y)
  const xWeight = x - left
  const yWeight = y - top
  const topValue =
    (1 - xWeight) * pixelChannel(image, left, top, channel) +
    xWeight * pixelChannel(image, left + 1, top, channel)
  const bottomValue =
    (1 - xWeight) * pixelChannel(image, left, top + 1, channel) +
    xWeight * pixelChannel(image, left + 1, top + 1, channel)
  return (1 - yWeight) * topValue + yWeight * bottomValue
}

function quantile(sortedValues, fraction) {
  invariant(sortedValues.length > 0, 'pixel comparison produced no residuals')
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * fraction))]
}

function boundedCaptureExtent(capture) {
  let minimumX = capture.width
  let minimumY = capture.height
  let maximumX = -1
  let maximumY = -1
  for (let y = 0; y < capture.height; y += 1) {
    for (let x = 0; x < capture.width; x += 1) {
      if (capture.data[(y * capture.width + x) * 4 + 3] === 0) continue
      minimumX = Math.min(minimumX, x)
      minimumY = Math.min(minimumY, y)
      maximumX = Math.max(maximumX, x)
      maximumY = Math.max(maximumY, y)
    }
  }
  invariant(maximumX >= 0 && maximumY >= 0, 'WindowServer capture has no visible pixels')
  const trailingTransparentColumns = capture.width - maximumX - 1
  const trailingTransparentRows = capture.height - maximumY - 1
  const hasTrailingTransparentCanvas = trailingTransparentColumns > 1 || trailingTransparentRows > 1
  if (!hasTrailingTransparentCanvas) {
    return { x: 0, y: 0, width: capture.width, height: capture.height }
  }
  invariant(
    minimumX <= 1 && minimumY <= 1,
    'WindowServer capture transparent canvas is not top-left bounded'
  )
  return { x: 0, y: 0, width: maximumX + 1, height: maximumY + 1 }
}

function compareWindowCaptureToReference(capturePath, referencePath, windowBounds, options = {}) {
  const capture = PNG.sync.read(fs.readFileSync(capturePath))
  const reference = PNG.sync.read(fs.readFileSync(referencePath))
  const captureExtent = boundedCaptureExtent(capture)
  const windowWidth = Number(windowBounds?.width)
  const windowHeight = Number(windowBounds?.height)
  invariant(
    Number.isInteger(windowWidth) &&
      Number.isInteger(windowHeight) &&
      windowWidth > 0 &&
      windowHeight > 0,
    'visual checkpoint window bounds are invalid'
  )
  invariant(
    reference.width > 0 &&
      reference.height > 0 &&
      Math.abs(reference.width / reference.height - 16 / 9) < 0.001,
    'visual reference is not a 16:9 frame'
  )

  const logicalVideoWidth = windowWidth
  const logicalVideoHeight = Math.round((logicalVideoWidth * reference.height) / reference.width)
  const logicalTitleBarHeight = windowHeight - logicalVideoHeight
  invariant(
    logicalTitleBarHeight >= 20 && logicalTitleBarHeight <= 40,
    'WindowServer capture geometry is outside the bounded Companion shape'
  )

  const scaleCandidates = [1, 2, 3, 4]
    .map((backingScale) => {
      const scaledWindowWidth = windowWidth * backingScale
      const scaledWindowHeight = windowHeight * backingScale
      const horizontalShadowPixels = captureExtent.width - scaledWindowWidth
      const verticalShadowPixels = captureExtent.height - scaledWindowHeight
      const shadowless = verticalShadowPixels === 0
      const boundedWindowShadow =
        verticalShadowPixels >= 16 * backingScale &&
        (verticalShadowPixels - 16 * backingScale) % (2 * backingScale) === 0
      const valid =
        horizontalShadowPixels >= 0 &&
        horizontalShadowPixels % (2 * backingScale) === 0 &&
        verticalShadowPixels >= 0 &&
        (shadowless || boundedWindowShadow)
      return {
        backingScale,
        horizontalShadowPixels,
        verticalShadowPixels,
        valid,
        shadowScore: horizontalShadowPixels + verticalShadowPixels
      }
    })
    .filter((candidate) => candidate.valid)
    .sort(
      (left, right) =>
        left.shadowScore - right.shadowScore || right.backingScale - left.backingScale
    )
  invariant(
    scaleCandidates.length > 0,
    'WindowServer capture geometry is outside the bounded Companion shape'
  )

  const geometry = scaleCandidates[0]
  const backingScale = geometry.backingScale
  const videoWidth = logicalVideoWidth * backingScale
  const videoHeight = logicalVideoHeight * backingScale
  const titleBarHeight = logicalTitleBarHeight * backingScale
  const horizontalShadowPixels = geometry.horizontalShadowPixels
  const verticalShadowPixels = geometry.verticalShadowPixels
  const captureX = captureExtent.x + horizontalShadowPixels / 2
  const topShadowPixels =
    verticalShadowPixels === 0 ? 0 : (verticalShadowPixels - 16 * backingScale) / 2
  const captureY = captureExtent.y + topShadowPixels + titleBarHeight
  const logicalHudOverlayHeight = options.hudOverlayHeight ?? 92
  const hudOverlayHeight = logicalHudOverlayHeight * backingScale
  const comparisonHeight = videoHeight - hudOverlayHeight
  invariant(
    Number.isInteger(logicalHudOverlayHeight) &&
      logicalHudOverlayHeight >= 0 &&
      comparisonHeight > 0 &&
      captureX + videoWidth <= captureExtent.x + captureExtent.width &&
      captureY + videoHeight <= captureExtent.y + captureExtent.height,
    'bounded video comparison region is invalid'
  )

  const materialPixelCount = videoWidth * comparisonHeight
  const channelFits = []
  for (let channel = 0; channel < 3; channel += 1) {
    let referenceSum = 0
    let captureSum = 0
    let referenceSquaredSum = 0
    let crossProductSum = 0
    for (let y = 0; y < comparisonHeight; y += 1) {
      const referenceY = ((y + 0.5) * reference.height) / videoHeight - 0.5
      for (let x = 0; x < videoWidth; x += 1) {
        const referenceX = ((x + 0.5) * reference.width) / videoWidth - 0.5
        const referenceValue = bilinearChannel(reference, referenceX, referenceY, channel)
        const captureValue = pixelChannel(capture, captureX + x, captureY + y, channel)
        referenceSum += referenceValue
        captureSum += captureValue
        referenceSquaredSum += referenceValue * referenceValue
        crossProductSum += referenceValue * captureValue
      }
    }
    const denominator = referenceSquaredSum - (referenceSum * referenceSum) / materialPixelCount
    invariant(Math.abs(denominator) > 0.001, 'visual reference channel has no variance')
    const scale = (crossProductSum - (referenceSum * captureSum) / materialPixelCount) / denominator
    const offset = captureSum / materialPixelCount - (scale * referenceSum) / materialPixelCount
    channelFits.push({ scale, offset })
  }

  const residuals = []
  let residualSum = 0
  let pixelsAbove40 = 0
  let pixelsAbove80 = 0
  for (let y = 0; y < comparisonHeight; y += 1) {
    const referenceY = ((y + 0.5) * reference.height) / videoHeight - 0.5
    for (let x = 0; x < videoWidth; x += 1) {
      const referenceX = ((x + 0.5) * reference.width) / videoWidth - 0.5
      let maximumPixelResidual = 0
      for (let channel = 0; channel < 3; channel += 1) {
        const referenceValue = bilinearChannel(reference, referenceX, referenceY, channel)
        const predictedCaptureValue =
          channelFits[channel].scale * referenceValue + channelFits[channel].offset
        const residual = Math.abs(
          pixelChannel(capture, captureX + x, captureY + y, channel) - predictedCaptureValue
        )
        residuals.push(residual)
        residualSum += residual
        maximumPixelResidual = Math.max(maximumPixelResidual, residual)
      }
      if (maximumPixelResidual > 40) pixelsAbove40 += 1
      if (maximumPixelResidual > 80) pixelsAbove80 += 1
    }
  }
  residuals.sort((left, right) => left - right)
  const metrics = {
    materialPixelCount,
    meanAbsoluteChannelResidual: residualSum / residuals.length,
    p95ChannelResidual: quantile(residuals, 0.95),
    p99ChannelResidual: quantile(residuals, 0.99),
    maximumChannelResidual: residuals.at(-1),
    fractionAbove40: pixelsAbove40 / materialPixelCount,
    fractionAbove80: pixelsAbove80 / materialPixelCount
  }
  const thresholds = options.thresholds || VISUAL_THRESHOLDS
  const clean =
    metrics.meanAbsoluteChannelResidual <= thresholds.maximumMeanAbsoluteChannelResidual &&
    metrics.p99ChannelResidual <= thresholds.maximumP99ChannelResidual &&
    metrics.fractionAbove40 <= thresholds.maximumFractionAbove40 &&
    metrics.fractionAbove80 <= thresholds.maximumFractionAbove80

  return {
    clean,
    capture: {
      path: capturePath,
      width: capture.width,
      height: capture.height,
      sha256: sha256File(capturePath)
    },
    reference: {
      path: referencePath,
      width: reference.width,
      height: reference.height,
      sha256: sha256File(referencePath)
    },
    registration: {
      backingScale,
      captureExtent,
      captureX,
      captureY,
      videoWidth,
      videoHeight,
      titleBarHeight,
      logicalVideoWidth,
      logicalVideoHeight,
      logicalTitleBarHeight,
      logicalHudOverlayHeight,
      hudOverlayHeight,
      horizontalShadowPixels,
      verticalShadowPixels,
      comparisonHeight
    },
    colorFit: channelFits,
    metrics,
    thresholds
  }
}

function expectedValueSequence() {
  const values = []
  for (const cycle of CYCLES) {
    const laterTicks = cycle.laterSeconds * EXPECTED.ticksPerSecond
    values.push(laterTicks)
    for (let index = 1; index <= cycle.backwardSecondSteps; index += 1) {
      values.push(laterTicks - index * EXPECTED.ticksPerSecond)
    }
  }
  values.push(EXPECTED.finalPositionTicks)
  return values
}

function verifyDriverCadenceSource(driverSource) {
  const loop = 'for (index, action) in request.actions.enumerated() {'
  const loopOffset = driverSource.indexOf(loop)
  const sleepOffset = driverSource.indexOf('usleep(120_000)', loopOffset)
  const receiptOffset = driverSource.indexOf('let formatter = ISO8601DateFormatter()', loopOffset)

  invariant(loopOffset >= 0, 'driver action loop is missing')
  invariant(sleepOffset > loopOffset, 'driver 120ms action sleep is missing')
  invariant(
    receiptOffset > sleepOffset,
    'driver cadence sleep is not inside the sequential action loop'
  )

  return {
    kind: 'source-pinned-lower-bound',
    sequentialActionLoop: true,
    lowerBoundMillisecondsPerAction: EXPECTED.cadenceLowerBoundMs,
    measuredWallClockCadence: false
  }
}

function verifyRawReceiptPair(summary, request, receipt, expectedPid, expectedPgid) {
  invariant(
    request.inputDelivery === 'background-observation-only' &&
      request.allowForegroundInput === false,
    'storm request is not background-observation-only'
  )
  invariant(
    receipt.inputDelivery === 'background-observation-only',
    'storm receipt input mode changed'
  )
  invariant(
    request.expectedPid === expectedPid &&
      receipt.pid === expectedPid &&
      request.expectedPgid === expectedPgid &&
      receipt.pgid === expectedPgid,
    'storm PID/PGID identity changed'
  )
  invariant(
    request.actions.length === summary.actions.length &&
      receipt.actions.length === summary.actions.length &&
      summary.actionCount === summary.actions.length,
    'storm request/receipt action counts diverged'
  )

  for (let index = 0; index < summary.actions.length; index += 1) {
    const embedded = summary.actions[index]
    const requested = request.actions[index]
    const observed = receipt.actions[index]
    invariant(
      embedded.type === 'set-playhead-ticks' &&
        requested.type === 'set-playhead-ticks' &&
        observed.type === 'set-playhead-ticks',
      'storm contains a non-playhead action'
    )
    invariant(
      requested.playheadTicks === embedded.playheadTicks &&
        observed.playheadTicks === embedded.playheadTicks &&
        observed.observedPlayheadTicks === embedded.observedPlayheadTicks,
      'embedded storm action does not match its raw request/receipt'
    )
    invariant(
      requested.playheadToleranceTicks === EXPECTED.toleranceTicks &&
        observed.playheadToleranceTicks === EXPECTED.toleranceTicks,
      'storm action tolerance changed'
    )
  }
}

function verifyStudioPixelEvidence(evidence, driverSource, documents) {
  invariant(evidence?.ok === true, 'pixel evidence is not successful')
  invariant(
    evidence.custody?.fixture?.sha256 === EXPECTED.fixtureSha256,
    'pixel evidence fixture identity changed'
  )
  invariant(evidence.storm?.prescribedCondition === true, 'storm condition is not prescribed')
  invariant(
    evidence.storm?.repeatedLaterJumpCycles === CYCLES.length,
    'storm later-jump count changed'
  )
  invariant(
    evidence.storm?.repeatedBackwardSecondSteps === 523 &&
      evidence.storm?.axBackwardValueSetCount === 523,
    'storm backward action count changed'
  )
  invariant(
    Array.isArray(evidence.storm?.cycles) && evidence.storm.cycles.length === CYCLES.length,
    'storm cycle count changed'
  )

  for (let index = 0; index < CYCLES.length; index += 1) {
    const expected = CYCLES[index]
    const actual = evidence.storm.cycles[index]
    invariant(actual.cycle === index, 'storm cycle ordering changed')
    invariant(
      actual.stimulus?.delivery === 'background-ax-value-set' &&
        actual.stimulus?.ticksPerSecond === EXPECTED.ticksPerSecond &&
        actual.stimulus?.cadenceMs === EXPECTED.cadenceLowerBoundMs &&
        actual.stimulus?.valueSetCount === expected.backwardSecondSteps &&
        actual.stimulus?.displacementTicksPerSet === -EXPECTED.ticksPerSecond,
      'storm cycle stimulus changed'
    )
    invariant(
      actual.laterSeek?.transportSeconds === expected.laterSeconds &&
        actual.backwardSeek?.secondSteps === expected.backwardSecondSteps &&
        actual.backwardSeek?.transportSeconds === expected.finalSeconds,
      'storm cycle endpoints changed'
    )
  }

  const expectedPid = evidence.sourceWindow?.pid
  const expectedPgid = evidence.electron?.pgid
  invariant(Number.isSafeInteger(expectedPid) && expectedPid > 0, 'Companion PID is invalid')
  invariant(Number.isSafeInteger(expectedPgid) && expectedPgid > 0, 'Companion PGID is invalid')

  const summaries = evidence.storm.receipts
  invariant(Array.isArray(summaries) && summaries.length > 0, 'storm receipts are missing')
  invariant(documents && typeof documents === 'object', 'raw receipt documents are missing')

  for (const summary of summaries) {
    const request = documents[summary.requestPath]
    const receipt = documents[summary.receiptPath]
    invariant(request, 'raw request is missing: ' + String(summary.requestPath))
    invariant(receipt, 'raw receipt is missing: ' + String(summary.receiptPath))
    verifyRawReceiptPair(summary, request, receipt, expectedPid, expectedPgid)
  }

  const actions = summaries.flatMap((summary) => summary.actions)
  const actualValues = actions.map((action) => action.playheadTicks)
  const expectedValues = expectedValueSequence()
  invariant(actualValues.length === 527, 'storm/final value-set count is not 527')
  invariant(exactJson(actualValues, expectedValues), 'ordered 527-value sequence changed')

  const cycleOffsets = [0, 241, 422, 526]
  const expectedOffsetValues = [
    241 * EXPECTED.ticksPerSecond,
    182 * EXPECTED.ticksPerSecond,
    121 * EXPECTED.ticksPerSecond,
    EXPECTED.finalPositionTicks
  ]
  invariant(
    exactJson(
      cycleOffsets.map((offset) => actualValues[offset]),
      expectedOffsetValues
    ),
    'storm cycle offsets changed'
  )

  const observedDeltas = actions.map((action) => {
    invariant(
      Number.isSafeInteger(action.playheadTicks) &&
        Number.isSafeInteger(action.observedPlayheadTicks),
      'storm receipt contains a non-integer playhead value'
    )
    const delta = Math.abs(action.observedPlayheadTicks - action.playheadTicks)
    invariant(delta <= EXPECTED.toleranceTicks, 'storm settlement exceeded tolerance')
    return delta
  })

  const finalAction = actions.at(-1)
  invariant(
    finalAction.playheadTicks === EXPECTED.finalPositionTicks,
    'final 17.1s positioning request changed'
  )
  invariant(
    evidence.positioningAtSeventeen?.[0]?.contentPtsSeconds === EXPECTED.finalContentPtsSeconds &&
      evidence.seventeenPoint?.hud?.parsed?.contentPtsSeconds === EXPECTED.finalContentPtsSeconds,
    'seek(17.1s) did not decode the fixture PTS 17.083s'
  )

  const cycleTwo = evidence.storm.cycles[2]?.backwardSeek
  invariant(
    cycleTwo?.transportSeconds === 18 &&
      cycleTwo?.hud?.parsed?.contentPtsSeconds === 18 &&
      cycleTwo?.screenshot?.sha256 === EXPECTED.cycleTwoScreenshotSha256,
    'transport-18.000 visual checkpoint changed'
  )
  invariant(
    evidence.seventeenPoint?.screenshot?.sha256 === EXPECTED.finalScreenshotSha256,
    'decoded-17.083 visual checkpoint changed'
  )

  return {
    ok: true,
    kind: 'taskwraith-studio-pixel-evidence-verification',
    fixtureSha256: EXPECTED.fixtureSha256,
    orderedValueSetCount: actualValues.length,
    backwardOneSecondValueSetCount: 523,
    displacementTicksPerBackwardSet: -EXPECTED.ticksPerSecond,
    cycleOffsetsInValueSetReceipts: cycleOffsets,
    cycleOffsetValues: expectedOffsetValues,
    settlementToleranceTicks: EXPECTED.toleranceTicks,
    maximumObservedSettlementDeltaTicks: Math.max(...observedDeltas),
    finalPosition: {
      requestedTicks: finalAction.playheadTicks,
      observedTicks: finalAction.observedPlayheadTicks,
      decodedContentPtsSeconds: evidence.seventeenPoint.hud.parsed.contentPtsSeconds
    },
    cadence: verifyDriverCadenceSource(driverSource),
    visualPoints: [
      {
        label: 'post-storm-transport-18.000',
        transportSeconds: 18,
        decodedContentPtsSeconds: 18,
        screenshotSha256: cycleTwo.screenshot.sha256
      },
      {
        label: 'post-storm-decoded-17.083',
        transportSeconds: 17.2,
        decodedContentPtsSeconds: EXPECTED.finalContentPtsSeconds,
        screenshotSha256: evidence.seventeenPoint.screenshot.sha256
      }
    ]
  }
}

function loadReferencedDocuments(evidence) {
  const documents = {}
  for (const summary of evidence.storm.receipts) {
    for (const documentPath of [summary.requestPath, summary.receiptPath]) {
      documents[documentPath] = JSON.parse(fs.readFileSync(documentPath, 'utf8'))
    }
  }
  return documents
}

function verifyStudioPixelEvidenceFiles(options = {}) {
  const evidencePath = options.evidencePath || DEFAULT_EVIDENCE_PATH
  const driverPath = options.driverPath || DEFAULT_DRIVER_PATH
  const visualReferences = options.visualReferences || DEFAULT_VISUAL_REFERENCES
  const evidenceBytes = fs.readFileSync(evidencePath)
  const evidenceSha256 = sha256Bytes(evidenceBytes)
  invariant(
    evidenceSha256 === (options.expectedEvidenceSha256 || EXPECTED.evidenceSha256),
    'preserved full evidence hash changed: ' + evidenceSha256
  )
  const evidence = JSON.parse(evidenceBytes.toString('utf8'))
  const driverSource = fs.readFileSync(driverPath, 'utf8')
  const aggregate = verifyStudioPixelEvidence(
    evidence,
    driverSource,
    loadReferencedDocuments(evidence)
  )

  const compareCheckpoint = (
    label,
    screenshot,
    expectedScreenshotSha256,
    referencePath,
    expectedReferenceSha256
  ) => {
    invariant(screenshot?.path && screenshot?.receiptPath, label + ' capture paths are missing')
    invariant(
      sha256File(screenshot.path) === expectedScreenshotSha256,
      label + ' capture bytes changed'
    )
    invariant(
      sha256File(referencePath) === expectedReferenceSha256,
      label + ' fresh reference bytes changed'
    )
    const receipt = JSON.parse(fs.readFileSync(screenshot.receiptPath, 'utf8'))
    invariant(
      receipt.ok === true &&
        receipt.outputPath === screenshot.path &&
        receipt.sha256 === expectedScreenshotSha256 &&
        receipt.windowBounds,
      label + ' WindowServer receipt is invalid'
    )
    const comparison = compareWindowCaptureToReference(
      screenshot.path,
      referencePath,
      receipt.windowBounds
    )
    invariant(
      comparison.clean,
      label + ' material pixel comparison failed: ' + JSON.stringify(comparison.metrics)
    )
    return {
      label,
      captureReceiptPath: screenshot.receiptPath,
      capturePath: path.relative(repoRoot, screenshot.path),
      referencePath: path.relative(repoRoot, referencePath),
      ...comparison
    }
  }

  const visualComparisons = [
    compareCheckpoint(
      'post-storm-transport-18.000',
      evidence.storm.cycles[2].backwardSeek.screenshot,
      EXPECTED.cycleTwoScreenshotSha256,
      visualReferences.cycleTwo,
      EXPECTED.cycleTwoReferenceSha256
    ),
    compareCheckpoint(
      'post-storm-decoded-17.083',
      evidence.seventeenPoint.screenshot,
      EXPECTED.finalScreenshotSha256,
      visualReferences.final,
      EXPECTED.finalReferenceSha256
    )
  ]

  return {
    ...aggregate,
    evidencePath: path.relative(repoRoot, evidencePath),
    evidenceSha256,
    driverPath: path.relative(repoRoot, driverPath),
    driverSha256: sha256File(driverPath),
    visualComparisonCount: visualComparisons.length,
    visualComparisons
  }
}

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(verifyStudioPixelEvidenceFiles(), null, 2) + '\n')
  } catch (error) {
    console.error(
      '[studio-pixel-evidence-verifier] FAIL — ' +
        (error instanceof Error ? error.message : String(error))
    )
    process.exitCode = 1
  }
}

module.exports = {
  CYCLES,
  DEFAULT_VISUAL_REFERENCES,
  EXPECTED,
  VISUAL_THRESHOLDS,
  compareWindowCaptureToReference,
  expectedValueSequence,
  verifyDriverCadenceSource,
  verifyStudioPixelEvidence,
  verifyStudioPixelEvidenceFiles
}
