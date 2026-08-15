import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  EXPECTED,
  compareWindowCaptureToReference,
  expectedValueSequence,
  verifyStudioPixelEvidence
} = require('./studio-pixel-evidence-verifier.cjs') as {
  EXPECTED: {
    cycleTwoScreenshotSha256: string
    finalContentPtsSeconds: number
    finalPositionTicks: number
    finalScreenshotSha256: string
    fixtureSha256: string
    ticksPerSecond: number
    toleranceTicks: number
  }
  compareWindowCaptureToReference: (
    capturePath: string,
    referencePath: string,
    windowBounds: { width: number; height: number },
    options?: { hudOverlayHeight?: number }
  ) => Record<string, any>
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

function syntheticPixelChannel(image: PNG, x: number, y: number, channel: number): number {
  const boundedX = Math.max(0, Math.min(image.width - 1, x))
  const boundedY = Math.max(0, Math.min(image.height - 1, y))
  return image.data[(boundedY * image.width + boundedX) * 4 + channel]
}

function syntheticBilinearChannel(image: PNG, x: number, y: number, channel: number): number {
  const left = Math.floor(x)
  const top = Math.floor(y)
  const xWeight = x - left
  const yWeight = y - top
  const topValue =
    (1 - xWeight) * syntheticPixelChannel(image, left, top, channel) +
    xWeight * syntheticPixelChannel(image, left + 1, top, channel)
  const bottomValue =
    (1 - xWeight) * syntheticPixelChannel(image, left, top + 1, channel) +
    xWeight * syntheticPixelChannel(image, left + 1, top + 1, channel)
  return (1 - yWeight) * topValue + yWeight * bottomValue
}

function createVisualFixture(corrupt: boolean, backingScale = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-pixel-verifier-'))
  const referencePath = join(directory, 'reference.png')
  const capturePath = join(directory, 'capture.png')
  const reference = new PNG({ width: 64, height: 36 })
  const bars = [
    [255, 0, 0],
    [0, 255, 0],
    [255, 255, 0],
    [0, 0, 255],
    [255, 0, 255],
    [0, 255, 255]
  ]
  for (let y = 0; y < reference.height; y += 1) {
    for (let x = 0; x < reference.width; x += 1) {
      const pixel = (y * reference.width + x) * 4
      const color = bars[Math.min(5, Math.floor((x * 6) / reference.width))]
      for (let channel = 0; channel < 3; channel += 1) {
        reference.data[pixel + channel] = color[channel]
      }
      if (Math.abs(y - (5 + x * 0.35)) < 1.5) {
        reference.data[pixel] = (x * 7) % 256
        reference.data[pixel + 1] = (255 - x * 5) % 256
        reference.data[pixel + 2] = (x * 11) % 256
      }
      reference.data[pixel + 3] = 255
    }
  }

  const windowBounds = { width: 96, height: 86 }
  const videoWidth = 96 * backingScale
  const videoHeight = 54 * backingScale
  const captureX = 34 * backingScale
  const captureY = 58 * backingScale
  const capture = new PNG({ width: 164 * backingScale, height: 154 * backingScale })
  for (let pixel = 0; pixel < capture.width * capture.height; pixel += 1) {
    capture.data[pixel * 4 + 3] = 255
  }
  const transforms = [
    { scale: 0.97, offset: 7 },
    { scale: 0.84, offset: 11 },
    { scale: 0.824, offset: 39 }
  ]
  for (let y = 0; y < videoHeight; y += 1) {
    for (let x = 0; x < videoWidth; x += 1) {
      const pixel = ((captureY + y) * capture.width + captureX + x) * 4
      for (let channel = 0; channel < 3; channel += 1) {
        const referenceValue = syntheticBilinearChannel(
          reference,
          ((x + 0.5) * reference.width) / videoWidth - 0.5,
          ((y + 0.5) * reference.height) / videoHeight - 0.5,
          channel
        )
        let value = Math.round(
          transforms[channel].scale * referenceValue + transforms[channel].offset
        )
        if (
          corrupt &&
          x >= 20 * backingScale &&
          x < 80 * backingScale &&
          y >= 10 * backingScale &&
          y < 35 * backingScale
        ) {
          value = 255 - value
        }
        capture.data[pixel + channel] = Math.max(0, Math.min(255, value))
      }
      capture.data[pixel + 3] = 255
    }
  }

  writeFileSync(referencePath, PNG.sync.write(reference))
  writeFileSync(capturePath, PNG.sync.write(capture))
  return {
    capturePath,
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
    referencePath,
    windowBounds
  }
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

  it('accepts a clean registered video region despite bounded color conversion', () => {
    const fixture = createVisualFixture(false)
    try {
      const comparison = compareWindowCaptureToReference(
        fixture.capturePath,
        fixture.referencePath,
        fixture.windowBounds,
        { hudOverlayHeight: 9 }
      )

      expect(comparison).toMatchObject({
        clean: true,
        registration: {
          captureX: 34,
          captureY: 58,
          comparisonHeight: 45,
          videoHeight: 54,
          videoWidth: 96
        },
        metrics: { materialPixelCount: 4_320 }
      })
    } finally {
      fixture.cleanup()
    }
  })

  it('accepts a clean 2x Retina capture using logical signed window bounds', () => {
    const fixture = createVisualFixture(false, 2)
    try {
      const comparison = compareWindowCaptureToReference(
        fixture.capturePath,
        fixture.referencePath,
        fixture.windowBounds,
        { hudOverlayHeight: 9 }
      )

      expect(comparison).toMatchObject({
        clean: true,
        registration: {
          backingScale: 2,
          captureX: 68,
          captureY: 116,
          comparisonHeight: 90,
          hudOverlayHeight: 18,
          videoHeight: 108,
          videoWidth: 192
        },
        metrics: { materialPixelCount: 17_280 }
      })
    } finally {
      fixture.cleanup()
    }
  })

  it('accepts a 1x window inside a transparent Retina-sized PNG canvas', () => {
    const fixture = createVisualFixture(false)
    try {
      const original = PNG.sync.read(readFileSync(fixture.capturePath))
      const padded = new PNG({ width: original.width * 2, height: original.height * 2 })
      for (let y = 0; y < original.height; y += 1) {
        for (let x = 0; x < original.width; x += 1) {
          const sourcePixel = (y * original.width + x) * 4
          const targetPixel = (y * padded.width + x) * 4
          original.data.copy(padded.data, targetPixel, sourcePixel, sourcePixel + 4)
        }
      }
      writeFileSync(fixture.capturePath, PNG.sync.write(padded))

      const comparison = compareWindowCaptureToReference(
        fixture.capturePath,
        fixture.referencePath,
        fixture.windowBounds,
        { hudOverlayHeight: 9 }
      )

      expect(comparison).toMatchObject({
        clean: true,
        registration: {
          backingScale: 1,
          captureExtent: { x: 0, y: 0, width: 164, height: 154 },
          captureX: 34,
          captureY: 58,
          comparisonHeight: 45,
          videoHeight: 54,
          videoWidth: 96
        },
        metrics: { materialPixelCount: 4_320 }
      })
    } finally {
      fixture.cleanup()
    }
  })

  it('keeps a one-pixel transparent WindowServer fringe inside the capture extent', () => {
    const fixture = createVisualFixture(false)
    try {
      const capture = PNG.sync.read(readFileSync(fixture.capturePath))
      for (let y = 0; y < capture.height; y += 1) {
        capture.data[(y * capture.width + capture.width - 1) * 4 + 3] = 0
      }
      writeFileSync(fixture.capturePath, PNG.sync.write(capture))

      const comparison = compareWindowCaptureToReference(
        fixture.capturePath,
        fixture.referencePath,
        fixture.windowBounds,
        { hudOverlayHeight: 9 }
      )

      expect(comparison).toMatchObject({
        clean: true,
        registration: {
          backingScale: 1,
          captureExtent: { x: 0, y: 0, width: 164, height: 154 },
          captureX: 34,
          captureY: 58
        },
        metrics: { materialPixelCount: 4_320 }
      })
    } finally {
      fixture.cleanup()
    }
  })

  it('rejects structured trail residue inside the registered video region', () => {
    const fixture = createVisualFixture(true)
    try {
      const comparison = compareWindowCaptureToReference(
        fixture.capturePath,
        fixture.referencePath,
        fixture.windowBounds,
        { hudOverlayHeight: 9 }
      )

      expect(comparison.clean).toBe(false)
      expect(comparison.metrics.fractionAbove40).toBeGreaterThan(0.03)
      expect(comparison.metrics.fractionAbove80).toBeGreaterThan(0.01)
    } finally {
      fixture.cleanup()
    }
  })
})
