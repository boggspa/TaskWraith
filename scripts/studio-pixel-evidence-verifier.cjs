'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')
const DEFAULT_EVIDENCE_PATH = path.join(
  repoRoot,
  '.local-only/taskwraith-studio/acceptance/w1acc10e/pixel-idr-fix-523-storm-full-evidence.json'
)
const DEFAULT_DRIVER_PATH = path.join(repoRoot, 'scripts/studio-acceptance-ui-driver.swift')

const EXPECTED = Object.freeze({
  evidenceSha256: '331d60817d598c4838444c7918f9bc794e3855bb7513f567815f6d8c6b5678cc',
  fixtureSha256: 'f7e39d4237fe1e408a76d213a322f60a8788eeaedac5252d95677135b08380f9',
  ticksPerSecond: 500_000,
  toleranceTicks: 25_000,
  cadenceLowerBoundMs: 120,
  finalPositionTicks: 8_550_000,
  finalContentPtsSeconds: 17.083,
  cycleTwoScreenshotSha256: 'eba053bb4e61cc6e4e19fbedd0e622972a9beddec257c4369cdef1e5ab1ce9f9',
  finalScreenshotSha256: '05cf5bd1fcfdf6f0b8dfeab1df9cb400fcbfbf0ddf308e6c86e139b14e28350f'
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
  const evidenceBytes = fs.readFileSync(evidencePath)
  const evidenceSha256 = sha256Bytes(evidenceBytes)
  invariant(
    evidenceSha256 === (options.expectedEvidenceSha256 || EXPECTED.evidenceSha256),
    'preserved full evidence hash changed: ' + evidenceSha256
  )
  const evidence = JSON.parse(evidenceBytes.toString('utf8'))
  const driverSource = fs.readFileSync(driverPath, 'utf8')
  return {
    ...verifyStudioPixelEvidence(evidence, driverSource, loadReferencedDocuments(evidence)),
    evidencePath: path.relative(repoRoot, evidencePath),
    evidenceSha256,
    driverPath: path.relative(repoRoot, driverPath),
    driverSha256: sha256File(driverPath)
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
  EXPECTED,
  expectedValueSequence,
  verifyDriverCadenceSource,
  verifyStudioPixelEvidence,
  verifyStudioPixelEvidenceFiles
}
