import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { EXPECTED, expectedValueSequence, verifyStudioPixelEvidence } =
  require('./studio-pixel-evidence-verifier.cjs') as {
    EXPECTED: {
      cycleTwoScreenshotSha256: string
      finalContentPtsSeconds: number
      finalPositionTicks: number
      finalScreenshotSha256: string
      fixtureSha256: string
      ticksPerSecond: number
      toleranceTicks: number
    }
    expectedValueSequence: () => number[]
    verifyStudioPixelEvidence: (
      evidence: Record<string, any>,
      driverSource: string,
      documents: Record<string, any>
    ) => Record<string, any>
  }

const DRIVER_SOURCE = `
var receipts: [ActionReceipt] = []
for (index, action) in request.actions.enumerated() {
    receipts.append(ActionReceipt(index: index))
    usleep(120_000)
}
let formatter = ISO8601DateFormatter()
`

function createFixture() {
  const values = expectedValueSequence()
  const documents: Record<string, any> = {}
  const receipts = []

  for (let offset = 0; offset < values.length; offset += 30) {
    const chunk = values.slice(offset, offset + 30)
    const requestPath = `request-${offset}.json`
    const receiptPath = `receipt-${offset}.json`
    const actions = chunk.map((playheadTicks, index) => ({
      index,
      type: 'set-playhead-ticks',
      playheadTicks,
      observedPlayheadTicks: playheadTicks - Math.min(4_820, index * 20)
    }))
    receipts.push({
      requestPath,
      receiptPath,
      actionCount: actions.length,
      actions
    })
    documents[requestPath] = {
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false,
      expectedPid: 100,
      expectedPgid: 200,
      actions: actions.map((action) => ({
        type: action.type,
        playheadTicks: action.playheadTicks,
        playheadToleranceTicks: EXPECTED.toleranceTicks
      }))
    }
    documents[receiptPath] = {
      inputDelivery: 'background-observation-only',
      pid: 100,
      pgid: 200,
      actions: actions.map((action) => ({
        ...action,
        playheadToleranceTicks: EXPECTED.toleranceTicks
      }))
    }
  }

  const evidence = {
    ok: true,
    custody: { fixture: { sha256: EXPECTED.fixtureSha256 } },
    sourceWindow: { pid: 100 },
    electron: { pgid: 200 },
    positioningAtSeventeen: [{ contentPtsSeconds: EXPECTED.finalContentPtsSeconds }],
    seventeenPoint: {
      hud: { parsed: { contentPtsSeconds: EXPECTED.finalContentPtsSeconds } },
      screenshot: { sha256: EXPECTED.finalScreenshotSha256 }
    },
    storm: {
      prescribedCondition: true,
      repeatedLaterJumpCycles: 3,
      repeatedBackwardSecondSteps: 523,
      axBackwardValueSetCount: 523,
      receipts,
      cycles: [
        {
          cycle: 0,
          stimulus: {
            delivery: 'background-ax-value-set',
            ticksPerSecond: EXPECTED.ticksPerSecond,
            cadenceMs: 120,
            valueSetCount: 240,
            displacementTicksPerSet: -EXPECTED.ticksPerSecond
          },
          laterSeek: { transportSeconds: 241 },
          backwardSeek: {
            secondSteps: 240,
            transportSeconds: 1,
            hud: { parsed: { contentPtsSeconds: 1 } },
            screenshot: { sha256: 'cycle-zero' }
          }
        },
        {
          cycle: 1,
          stimulus: {
            delivery: 'background-ax-value-set',
            ticksPerSecond: EXPECTED.ticksPerSecond,
            cadenceMs: 120,
            valueSetCount: 180,
            displacementTicksPerSet: -EXPECTED.ticksPerSecond
          },
          laterSeek: { transportSeconds: 182 },
          backwardSeek: {
            secondSteps: 180,
            transportSeconds: 2,
            hud: { parsed: { contentPtsSeconds: 2 } },
            screenshot: { sha256: 'cycle-one' }
          }
        },
        {
          cycle: 2,
          stimulus: {
            delivery: 'background-ax-value-set',
            ticksPerSecond: EXPECTED.ticksPerSecond,
            cadenceMs: 120,
            valueSetCount: 103,
            displacementTicksPerSet: -EXPECTED.ticksPerSecond
          },
          laterSeek: { transportSeconds: 121 },
          backwardSeek: {
            secondSteps: 103,
            transportSeconds: 18,
            hud: { parsed: { contentPtsSeconds: 18 } },
            screenshot: { sha256: EXPECTED.cycleTwoScreenshotSha256 }
          }
        }
      ]
    }
  }

  return { documents, evidence }
}

describe('Studio pixel evidence verifier', () => {
  it('recomputes the exact packaged 527/523 sequence and PTS invariant', () => {
    const { documents, evidence } = createFixture()
    const report = verifyStudioPixelEvidence(evidence, DRIVER_SOURCE, documents)

    expect(report).toMatchObject({
      ok: true,
      orderedValueSetCount: 527,
      backwardOneSecondValueSetCount: 523,
      displacementTicksPerBackwardSet: -500_000,
      cycleOffsetsInValueSetReceipts: [0, 241, 422, 526],
      settlementToleranceTicks: 25_000,
      finalPosition: {
        requestedTicks: 8_550_000,
        decodedContentPtsSeconds: 17.083
      },
      cadence: {
        kind: 'source-pinned-lower-bound',
        lowerBoundMillisecondsPerAction: 120,
        measuredWallClockCadence: false
      }
    })
  })

  it('fails when any ordered value is changed', () => {
    const { documents, evidence } = createFixture()
    evidence.storm.receipts[4].actions[3].playheadTicks += 1
    documents[evidence.storm.receipts[4].requestPath].actions[3].playheadTicks += 1
    documents[evidence.storm.receipts[4].receiptPath].actions[3].playheadTicks += 1

    expect(() => verifyStudioPixelEvidence(evidence, DRIVER_SOURCE, documents)).toThrow(
      'ordered 527-value sequence changed'
    )
  })

  it('fails when settlement exceeds the explicit tolerance', () => {
    const { documents, evidence } = createFixture()
    const summary = evidence.storm.receipts[0]
    summary.actions[0].observedPlayheadTicks -= EXPECTED.toleranceTicks + 1
    documents[summary.receiptPath].actions[0].observedPlayheadTicks =
      summary.actions[0].observedPlayheadTicks

    expect(() => verifyStudioPixelEvidence(evidence, DRIVER_SOURCE, documents)).toThrow(
      'storm settlement exceeded tolerance'
    )
  })

  it('fails when the final VFR decoded PTS invariant is absent', () => {
    const { documents, evidence } = createFixture()
    evidence.seventeenPoint.hud.parsed.contentPtsSeconds = 20.029

    expect(() => verifyStudioPixelEvidence(evidence, DRIVER_SOURCE, documents)).toThrow(
      'seek(17.1s) did not decode the fixture PTS 17.083s'
    )
  })

  it('fails when the source-pinned 120ms sequential lower bound is removed', () => {
    const { documents, evidence } = createFixture()

    expect(() =>
      verifyStudioPixelEvidence(
        evidence,
        DRIVER_SOURCE.replace('usleep(120_000)', 'usleep(1)'),
        documents
      )
    ).toThrow('driver 120ms action sleep is missing')
  })
})
