import fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/* eslint-disable @typescript-eslint/no-require-imports */
const { PNG } = require('pngjs') as {
  PNG: new (options: { width: number; height: number }) => {
    width: number
    height: number
    data: Buffer
  }
}
const {
  JOURNEY_PHASES,
  assertObservationOnlyRequest,
  buildObservationRequest,
  captureNative,
  classifyTrackedDirt,
  createSyntheticRedReference,
  custodyMatches,
  evaluatePureRedCapture,
  matchHudAssetIdentity,
  parseCli,
  resolveArtifactRoot,
  validateClearedState,
  validateInvalidReplacement,
  validateReplayState,
  validateTransportMutationBracket,
  writeFailureArtifacts,
  validateTerminalReceipt
} = require('./studio-lut-acceptance-runner.cjs') as {
  JOURNEY_PHASES: readonly string[]
  assertObservationOnlyRequest: (request: Record<string, any>) => Record<string, any>
  buildObservationRequest: (name: string) => Record<string, any>
  captureNative: (
    plan: Record<string, any>,
    target: Record<string, any>,
    name: string,
    adapters?: Record<string, any>
  ) => Promise<Record<string, any>>
  classifyTrackedDirt: (
    trackedStatus: string,
    digestPath?: (relativePath: string) => string | null
  ) => {
    studioPathsClean: boolean
    studioTrackedDirt: Record<string, any>[]
    foreignTrackedDirt: Record<string, any>[]
    wholeTrackedTreeClean: boolean
  }
  createSyntheticRedReference: (options: {
    destination: string
    width: number
    height: number
  }) => Record<string, any>
  custodyMatches: (actual: Record<string, any>, expected: Record<string, any>) => boolean
  evaluatePureRedCapture: (options: {
    capturePath: string
    referencePath: string
    windowBounds: { width: number; height: number }
    hudOverlayHeight?: number
  }) => Record<string, any>
  matchHudAssetIdentity: (
    hud: { observations: Array<{ text: string }> },
    assetId: string
  ) => {
    matched: boolean
    expected: string
    observedCandidate: string | null
    observationIndex: number | null
    comparedLength: number
    distance: number
    threshold: number
  }
  parseCli: (argv: string[]) => Record<string, any>
  resolveArtifactRoot: (candidate: string, acceptanceRoot?: string) => string
  validateClearedState: (
    state: Record<string, any>,
    operation: Record<string, any>,
    dom: Record<string, any>
  ) => Record<string, any>
  validateInvalidReplacement: (options: {
    activeState: Record<string, any>
    stateAfterInvalid: Record<string, any>
    journalBefore: unknown[]
    journalAfter: unknown[]
    rejectedDom: Record<string, any>
  }) => Record<string, any>
  validateReplayState: (
    state: Record<string, any>,
    dom: Record<string, any>,
    expectedEffectId: string
  ) => Record<string, any>
  validateTransportMutationBracket: (
    beforeReceipt: Record<string, any>,
    afterReceipt: Record<string, any>,
    name?: string
  ) => Record<string, any>
  writeFailureArtifacts: (
    artifactRoot: string,
    error: Error,
    transportMutationBracket?: Record<string, any> | null,
    custody?: Record<string, any> | null
  ) => Promise<void>
  validateTerminalReceipt: (terminal: Record<string, any>) => Record<string, any>
}

const temporaryDirectories: string[] = []

const custodyTestExpected = Object.freeze({
  companionSha256: 'companion',
  sourceDigest: 'source',
  sourceCount: 68,
  outDigest: 'out',
  outCount: 105,
  fixtureSha256: 'fixture',
  validCubeSha256: 'valid-cube',
  invalidCubeSha256: 'invalid-cube'
})

function matchingCustody(dirt: Record<string, any>): Record<string, any> {
  return {
    ...dirt,
    productAncestorPresent: true,
    companionSha256: custodyTestExpected.companionSha256,
    sourceDigest: custodyTestExpected.sourceDigest,
    sourceCount: custodyTestExpected.sourceCount,
    outDigest: custodyTestExpected.outDigest,
    outCount: custodyTestExpected.outCount,
    fixtureSha256: custodyTestExpected.fixtureSha256,
    validCubeSha256: custodyTestExpected.validCubeSha256,
    invalidCubeSha256: custodyTestExpected.invalidCubeSha256,
    supportMatches: true
  }
}

const validTransportMutationText =
  'tm1 kind=lifecycleAttach route=review preSrc=audio postSrc=audio ' +
  'host=4.125000 prevHost=- preAnchorT=2000000 preAnchorH=4.000000 ' +
  'prePos=2062500 preDur=300000000 prePlay=1 preRate=1.000 ' +
  'postAnchorT=2062500 postAnchorH=4.125000 postPos=2062500 postDur=300000000 ' +
  'postPlay=1 postRate=1.000 crossedDomain=0 clamped=0'

function transportMutationReceipt(
  directory: string,
  suffix: string,
  accessibilityValue = validTransportMutationText
): Record<string, any> {
  return {
    inputDelivery: 'background-observation-only',
    allowForegroundInput: false,
    requestPath: path.join(directory, `request-${suffix}.json`),
    rawReceiptPath: path.join(directory, `raw-${suffix}.json.stdout`),
    rawStdoutSha256: 'a'.repeat(64),
    rawStdoutByteLength: Buffer.byteLength(accessibilityValue),
    receiptPath: path.join(directory, `receipt-${suffix}.json`),
    actions: [
      {
        index: 0,
        type: 'read-transport-mutation',
        accessibilityLabel: 'Transport mutation detail',
        accessibilityRole: 'AXStaticText',
        accessibilityMatchCount: 1,
        accessibilityValue
      }
    ]
  }
}

function studioUiDriverEvidence(
  directory: string,
  suffix: string,
  failureStage: string | null
): Record<string, any> {
  return {
    requestPath: path.join(directory, `request-${suffix}.json`),
    rawReceiptPath: path.join(directory, `raw-${suffix}.json.stdout`),
    rawStdoutSha256: 'b'.repeat(64),
    rawStdoutByteLength: 128,
    validatedReceiptPath:
      failureStage === null ? path.join(directory, `receipt-${suffix}.json`) : null,
    failureStage
  }
}

function studioUiDriverFailure(
  directory: string,
  suffix: string,
  failureStage: string
): Error & { studioUiDriverEvidence: Record<string, any> } {
  const failure = new Error(`${suffix} failed at ${failureStage}`) as Error & {
    studioUiDriverEvidence: Record<string, any>
  }
  failure.studioUiDriverEvidence = studioUiDriverEvidence(directory, suffix, failureStage)
  return failure
}

function screenshotReceipt(
  directory: string,
  suffix: string,
  screenshotPath: string
): Record<string, any> {
  return {
    inputDelivery: 'background-observation-only',
    allowForegroundInput: false,
    ...studioUiDriverEvidence(directory, suffix, null),
    receiptPath: path.join(directory, `receipt-${suffix}.json`),
    actions: [
      {
        index: 0,
        type: 'screenshot',
        screenshotPath,
        byteLength: fs.statSync(screenshotPath).size
      }
    ]
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'studio-lut-runner-'))
  temporaryDirectories.push(directory)
  return directory
}

function writeDefaultOverlayCapture(destination: string): void {
  const width = 320
  const height = 210
  const titleBarHeight = 30
  const videoHeight = 180
  const timelineTop = videoHeight - (84 + 34)
  const hudTop = videoHeight - 92
  const image = new PNG({ width, height })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      const videoY = y - titleBarHeight
      if (y < titleBarHeight) {
        image.data[offset] = 48
        image.data[offset + 1] = 48
        image.data[offset + 2] = 48
      } else if (videoY >= timelineTop && videoY < hudTop) {
        image.data[offset] = 0
        image.data[offset + 1] = 255
        image.data[offset + 2] = 0
      } else {
        image.data[offset] = 255
        image.data[offset + 1] = 0
        image.data[offset + 2] = 0
      }
      image.data[offset + 3] = 255
    }
  }
  fs.writeFileSync(destination, PNG.sync.write(image))
}

function writeCapture(
  destination: string,
  mode: 'pure-red' | 'ungraded' | 'uniform-gray' | 'partial-red'
): void {
  const width = 160
  const height = 120
  const titleBarHeight = 30
  const image = new PNG({ width, height })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      if (y < titleBarHeight) {
        image.data[offset] = 48
        image.data[offset + 1] = 48
        image.data[offset + 2] = 48
      } else if (mode === 'pure-red') {
        image.data[offset] = 255
        image.data[offset + 1] = 0
        image.data[offset + 2] = 0
      } else if (mode === 'uniform-gray') {
        image.data[offset] = 129
        image.data[offset + 1] = 128
        image.data[offset + 2] = 129
      } else if (mode === 'partial-red') {
        const redDominant = x < width * 0.95
        image.data[offset] = redDominant ? 255 : 129
        image.data[offset + 1] = redDominant ? 0 : 128
        image.data[offset + 2] = redDominant ? 0 : 129
      } else {
        image.data[offset] = (x * 3 + y) % 256
        image.data[offset + 1] = (x + y * 5) % 256
        image.data[offset + 2] = (x * 7 + y * 2) % 256
      }
      image.data[offset + 3] = 255
    }
  }
  fs.writeFileSync(destination, PNG.sync.write(image))
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fsPromises.rm(directory, { recursive: true, force: true }))
  )
})

describe('studio LUT acceptance runner contract', () => {
  it('passes matching pins with foreign tracked dirt and seals its hashes into evidence', async () => {
    const dirt = classifyTrackedDirt(
      ' M src/main/collaboration/ExternalSeatResolution.ts\0 M src/main/index.ts\0',
      (relativePath) => (relativePath.endsWith('index.ts') ? 'a' : 'b').repeat(64)
    )
    const custody = matchingCustody(dirt)

    expect(dirt).toMatchObject({
      wholeTrackedTreeClean: false,
      studioPathsClean: true,
      studioTrackedDirt: [],
      foreignTrackedDirt: [
        {
          status: ' M',
          path: 'src/main/collaboration/ExternalSeatResolution.ts',
          worktreeSha256: 'b'.repeat(64)
        },
        {
          status: ' M',
          path: 'src/main/index.ts',
          worktreeSha256: 'a'.repeat(64)
        }
      ]
    })
    expect(custodyMatches(custody, custodyTestExpected)).toBe(true)

    const directory = await temporaryDirectory()
    await writeFailureArtifacts(directory, new Error('bounded failure'), null, custody)
    const evidence = JSON.parse(
      await fsPromises.readFile(path.join(directory, 'evidence.json'), 'utf8')
    )
    expect(evidence.custody).toMatchObject({
      studioPathsClean: true,
      foreignTrackedDirt: dirt.foreignTrackedDirt
    })
  })

  it.each([
    'scripts/studio-lut-acceptance-runner.cjs',
    'scripts/studio-acceptance-harness.cjs',
    'scripts/studio-acceptance-ui-driver.swift',
    'scripts/studio-acceptance-watchdog.cjs',
    'scripts/studio-acceptance-window-probe.swift',
    'scripts/studio-pixel-evidence-verifier.cjs'
  ])('rejects tracked dirt in protected Studio script %s', (relativePath) => {
    const trackedStatus = ` M ${relativePath}\0`
    const dirt = classifyTrackedDirt(trackedStatus, () => 'c'.repeat(64))

    expect(dirt.studioPathsClean).toBe(false)
    expect(dirt.studioTrackedDirt).toHaveLength(1)
    expect(dirt.foreignTrackedDirt).toEqual([])
    expect(custodyMatches(matchingCustody(dirt), custodyTestExpected)).toBe(false)
  })

  it('rejects tracked dirt in a Studio Swift product source', () => {
    const trackedStatus =
      ' M swift/TaskWraithBridge/Sources/TaskWraithStudioCore/StudioPlaybackClock.swift\0'
    const dirt = classifyTrackedDirt(trackedStatus, () => 'c'.repeat(64))

    expect(dirt.studioPathsClean).toBe(false)
    expect(dirt.studioTrackedDirt).toHaveLength(1)
    expect(dirt.foreignTrackedDirt).toEqual([])
    expect(custodyMatches(matchingCustody(dirt), custodyTestExpected)).toBe(false)
  })

  it('still rejects an out digest mismatch when foreign tracked dirt is allowed', () => {
    const dirt = classifyTrackedDirt(' M src/main/index.ts\0', () => 'd'.repeat(64))
    const custody = {
      ...matchingCustody(dirt),
      outDigest: 'rebuilt-out'
    }

    expect(dirt.studioPathsClean).toBe(true)
    expect(custodyMatches(custody, custodyTestExpected)).toBe(false)
  })

  it('keeps the exact two-phase load/reject then replay/clear order', () => {
    expect(JOURNEY_PHASES).toEqual([
      'phase-1-neutral-load-invalid-retention',
      'phase-2-restart-replay-clear'
    ])
  })

  it('builds screenshot-only background observation requests', () => {
    const request = buildObservationRequest('neutral-stable-02')

    expect(assertObservationOnlyRequest(request)).toBe(request)
    expect(request).toEqual({
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false,
      actions: [{ type: 'screenshot', name: 'neutral-stable-02' }]
    })
  })

  it('accepts only identical, strict tm1 receipts around a native screenshot', async () => {
    const directory = await temporaryDirectory()
    const before = transportMutationReceipt(directory, 'before')
    const after = transportMutationReceipt(directory, 'after')
    const bracket = validateTransportMutationBracket(before, after, 'neutral-stable-02')

    expect(bracket).toMatchObject({
      ok: true,
      name: 'neutral-stable-02',
      stage: 'complete',
      failure: null,
      before: {
        requestPath: before.requestPath,
        rawReceiptPath: before.rawReceiptPath,
        rawStdoutSha256: before.rawStdoutSha256,
        rawStdoutByteLength: before.rawStdoutByteLength,
        receiptPath: before.receiptPath,
        rawValue: validTransportMutationText,
        parsedValue: { kind: 'lifecycleAttach', route: 'review' }
      },
      after: {
        requestPath: after.requestPath,
        rawReceiptPath: after.rawReceiptPath,
        rawStdoutSha256: after.rawStdoutSha256,
        rawStdoutByteLength: after.rawStdoutByteLength,
        receiptPath: after.receiptPath,
        rawValue: validTransportMutationText,
        parsedValue: { kind: 'lifecycleAttach', route: 'review' }
      }
    })

    expect(() =>
      validateTransportMutationBracket(
        before,
        transportMutationReceipt(
          directory,
          'changed',
          validTransportMutationText.replace('route=review', 'route=source')
        ),
        'changed'
      )
    ).toThrow(/changed during native screenshot/)
    expect(() =>
      validateTransportMutationBracket(
        before,
        transportMutationReceipt(
          directory,
          'malformed',
          validTransportMutationText.replace('clamped=0', 'clamped=1')
        ),
        'malformed'
      )
    ).toThrow(/tm1/)
    expect(() =>
      validateTransportMutationBracket(before, { ...after, actions: [] }, 'missing')
    ).toThrow(/transport-mutation receipt/)
  })

  it('seals the latest raw and parsed tm1 bracket into terminal failure evidence', async () => {
    const directory = await temporaryDirectory()
    const bracket = validateTransportMutationBracket(
      transportMutationReceipt(directory, 'before'),
      transportMutationReceipt(directory, 'after'),
      'failure-sample'
    )
    await writeFailureArtifacts(directory, new Error('capture failed'), bracket)

    const evidence = JSON.parse(
      await fsPromises.readFile(path.join(directory, 'evidence.json'), 'utf8')
    )
    expect(evidence).toMatchObject({
      ok: false,
      error: 'capture failed',
      latestTransportMutationBracket: {
        ok: true,
        name: 'failure-sample',
        stage: 'complete',
        failure: null,
        before: {
          requestPath: path.join(directory, 'request-before.json'),
          rawReceiptPath: path.join(directory, 'raw-before.json.stdout'),
          rawStdoutSha256: 'a'.repeat(64),
          rawStdoutByteLength: Buffer.byteLength(validTransportMutationText),
          receiptPath: path.join(directory, 'receipt-before.json'),
          rawValue: validTransportMutationText,
          parsedValue: { kind: 'lifecycleAttach', route: 'review' }
        },
        after: {
          requestPath: path.join(directory, 'request-after.json'),
          rawReceiptPath: path.join(directory, 'raw-after.json.stdout'),
          rawStdoutSha256: 'a'.repeat(64),
          rawStdoutByteLength: Buffer.byteLength(validTransportMutationText),
          receiptPath: path.join(directory, 'receipt-after.json'),
          rawValue: validTransportMutationText,
          parsedValue: { kind: 'lifecycleAttach', route: 'review' }
        }
      }
    })
  })

  it.each([
    { label: 'native exec', suffix: 'native-exec', failureStage: 'native-exec' },
    { label: 'invalid JSON', suffix: 'invalid-json', failureStage: 'json-parse' },
    { label: 'missing action', suffix: 'missing-action', failureStage: 'receipt-schema' },
    { label: 'malformed tm1', suffix: 'malformed-tm1', failureStage: 'tm1-validation' }
  ])(
    'seals the current before-read attempt for $label failure',
    async ({ suffix, failureStage }) => {
      const directory = await temporaryDirectory()
      const name = `first-${suffix}`
      const driverFailure = studioUiDriverFailure(directory, suffix, failureStage)

      await expect(
        captureNative({}, {}, name, {
          runStudioUiDriver: vi.fn(async () => {
            throw driverFailure
          })
        })
      ).rejects.toBe(driverFailure)
      await writeFailureArtifacts(directory, driverFailure)

      const evidence = JSON.parse(
        await fsPromises.readFile(path.join(directory, 'evidence.json'), 'utf8')
      )
      expect(evidence.latestTransportMutationBracket).toEqual({
        ok: false,
        name,
        stage: 'before-read',
        before: null,
        after: null,
        failure: studioUiDriverEvidence(directory, suffix, failureStage)
      })
      expect(evidence.latestTransportMutationBracket.failure).not.toHaveProperty('stdout')
    }
  )

  it('seals raw receipt paths when first-read tm1 normalization fails', async () => {
    const directory = await temporaryDirectory()
    const name = 'first-normalization'
    const malformed = transportMutationReceipt(
      directory,
      'first-normalization',
      validTransportMutationText.replace('clamped=0', 'clamped=1')
    )

    let failure: Error | null = null
    try {
      await captureNative({}, {}, name, {
        runStudioUiDriver: vi.fn(async () => malformed)
      })
    } catch (error) {
      failure = error as Error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(failure?.message).toMatch(/tm1/)
    await writeFailureArtifacts(directory, failure as Error)

    const evidence = JSON.parse(
      await fsPromises.readFile(path.join(directory, 'evidence.json'), 'utf8')
    )
    expect(evidence.latestTransportMutationBracket).toMatchObject({
      ok: false,
      name,
      stage: 'before-normalization',
      before: null,
      after: null,
      failure: {
        requestPath: malformed.requestPath,
        rawReceiptPath: malformed.rawReceiptPath,
        rawStdoutSha256: malformed.rawStdoutSha256,
        rawStdoutByteLength: malformed.rawStdoutByteLength,
        validatedReceiptPath: malformed.receiptPath,
        failureStage: 'before-normalization'
      }
    })
  })

  it('seals the valid before receipt and current after-read failure', async () => {
    const directory = await temporaryDirectory()
    const name = 'after-malformed-tm1'
    const screenshotPath = path.join(directory, `${name}.png`)
    writeCapture(screenshotPath, 'ungraded')
    const before = transportMutationReceipt(directory, 'before-valid')
    const afterFailure = studioUiDriverFailure(directory, 'after-malformed', 'tm1-validation')
    let call = 0
    const runStudioUiDriver = vi.fn(async () => {
      call += 1
      if (call === 1) return before
      if (call === 2) return screenshotReceipt(directory, 'screenshot-valid', screenshotPath)
      throw afterFailure
    })

    await expect(captureNative({}, {}, name, { runStudioUiDriver })).rejects.toBe(afterFailure)
    await writeFailureArtifacts(directory, afterFailure)

    const evidence = JSON.parse(
      await fsPromises.readFile(path.join(directory, 'evidence.json'), 'utf8')
    )
    expect(evidence.latestTransportMutationBracket).toMatchObject({
      ok: false,
      name,
      stage: 'after-read',
      before: {
        requestPath: before.requestPath,
        rawReceiptPath: before.rawReceiptPath,
        receiptPath: before.receiptPath,
        rawValue: validTransportMutationText
      },
      after: null,
      failure: studioUiDriverEvidence(directory, 'after-malformed', 'tm1-validation')
    })
    expect(runStudioUiDriver).toHaveBeenCalledTimes(3)
  })

  it('seals both current valid receipts when tm1 changes across the screenshot', async () => {
    const directory = await temporaryDirectory()
    const name = 'changed-valid-tm1'
    const screenshotPath = path.join(directory, `${name}.png`)
    writeCapture(screenshotPath, 'ungraded')
    const before = transportMutationReceipt(directory, 'before-review')
    const after = transportMutationReceipt(
      directory,
      'after-source',
      validTransportMutationText.replace('route=review', 'route=source')
    )
    let call = 0
    const runStudioUiDriver = vi.fn(async () => {
      call += 1
      if (call === 1) return before
      if (call === 2) return screenshotReceipt(directory, 'screenshot-valid', screenshotPath)
      return after
    })

    let failure: Error | null = null
    try {
      await captureNative({}, {}, name, { runStudioUiDriver })
    } catch (error) {
      failure = error as Error
    }
    expect(failure?.message).toMatch(/changed during native screenshot/)
    await writeFailureArtifacts(directory, failure as Error)

    const evidence = JSON.parse(
      await fsPromises.readFile(path.join(directory, 'evidence.json'), 'utf8')
    )
    expect(evidence.latestTransportMutationBracket).toMatchObject({
      ok: false,
      name,
      stage: 'comparison',
      before: {
        requestPath: before.requestPath,
        rawReceiptPath: before.rawReceiptPath,
        rawValue: validTransportMutationText
      },
      after: {
        requestPath: after.requestPath,
        rawReceiptPath: after.rawReceiptPath,
        rawValue: validTransportMutationText.replace('route=review', 'route=source')
      },
      failure: null
    })
    expect(runStudioUiDriver).toHaveBeenCalledTimes(3)
  })

  it('brackets the one native screenshot choke point in exact order', async () => {
    const source = await fsPromises.readFile(
      path.resolve(__dirname, 'studio-lut-acceptance-runner.cjs'),
      'utf8'
    )
    const start = source.indexOf('async function captureNative(')
    const end = source.indexOf('async function captureGuarded(', start)
    const captureSource = source.slice(start, end)
    const before = captureSource.indexOf('beforeMutationReceipt = await readTransportMutation')
    const screenshot = captureSource.indexOf(
      'receipt = await runStudioUiDriver(plan, target, request.actions)'
    )
    const after = captureSource.indexOf('afterMutationReceipt = await readTransportMutation')
    const validation = captureSource.indexOf('validateTransportMutationBracket(')

    expect(start).toBeGreaterThan(0)
    expect(before).toBeGreaterThan(0)
    expect(screenshot).toBeGreaterThan(before)
    expect(after).toBeGreaterThan(screenshot)
    expect(validation).toBeGreaterThan(after)
    const beforeStage = captureSource.indexOf("stage: 'before-read'")
    const afterStage = captureSource.indexOf("stage: 'after-read'")
    expect(beforeStage).toBeGreaterThan(0)
    expect(beforeStage).toBeLessThan(before)
    expect(afterStage).toBeGreaterThan(screenshot)
    expect(afterStage).toBeLessThan(after)
    expect(captureSource).toContain("studioUiDriverEvidenceDescriptor(error, 'before-read')")
    expect(captureSource).toContain("studioUiDriverEvidenceDescriptor(error, 'after-read')")
    expect(captureSource).toContain('latestTransportMutationBracket = {')
    expect(captureSource).toContain('transportMutationBracket')
  })

  it.each([
    {
      inputDelivery: 'foreground-global-explicit',
      allowForegroundInput: true,
      actions: [{ type: 'screenshot', name: 'bad-mode' }]
    },
    {
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false,
      actions: [{ type: 'key', key: 'g' }]
    },
    {
      inputDelivery: 'background-observation-only',
      allowForegroundInput: false,
      actions: [{ type: 'click', x: 1, y: 1 }]
    }
  ])('rejects foreground or interactive native-driver requests', (request) => {
    expect(() => assertObservationOnlyRequest(request)).toThrow(
      /background-observation-only screenshot/
    )
  })

  it('bounds explicit artifact roots to one fresh acceptance child', async () => {
    const directory = await temporaryDirectory()
    const acceptanceRoot = path.join(directory, 'acceptance')
    await fsPromises.mkdir(acceptanceRoot)
    const candidate = path.join(acceptanceRoot, 'lut-proof-a')

    expect(resolveArtifactRoot(candidate, acceptanceRoot)).toBe(candidate)
    expect(() => resolveArtifactRoot(acceptanceRoot, acceptanceRoot)).toThrow(/proper child/)
    expect(() => resolveArtifactRoot(path.join(directory, 'outside'), acceptanceRoot)).toThrow(
      /inside the Studio acceptance root/
    )
    await fsPromises.mkdir(candidate)
    expect(() => resolveArtifactRoot(candidate, acceptanceRoot)).toThrow(/must not already exist/)
  })

  it('requires an explicit artifact root for a live launch', () => {
    expect(parseCli(['--artifact-root', '/tmp/example'])).toEqual({
      artifactRoot: '/tmp/example',
      launch: false,
      preflightOnly: false
    })
    expect(parseCli(['--artifact-root', '/tmp/example', '--launch'])).toEqual({
      artifactRoot: '/tmp/example',
      launch: true,
      preflightOnly: false
    })
    expect(() => parseCli(['--launch'])).toThrow(/--artifact-root is required/)
    expect(() => parseCli(['--artifact-root', '/tmp/example', '--unknown'])).toThrow(
      /unknown argument/
    )
  })

  it('matches an exact normalized full SHA-256 asset identity', () => {
    const assetId = 'rdQM2RCZQARUViCxHpzBJ9TQEqbdFfDhCHxs5UNMZTU'
    const result = matchHudAssetIdentity(
      { observations: [{ text: `HUD asset: ${assetId}` }] },
      assetId
    )

    expect(result).toMatchObject({
      matched: true,
      expected: assetId.toLowerCase(),
      observedCandidate: assetId.toLowerCase(),
      observationIndex: 0,
      comparedLength: 43,
      distance: 0,
      threshold: 12
    })
  })

  it('accepts the deterministic w2lut0816h full-ID OCR observation at distance 12', () => {
    const assetId = 'rdQM2RCZQARUViCxHpzBJ9TQEqbdFfDhCHxs5UNMZTU'
    const result = matchHudAssetIdentity(
      {
        observations: [
          { text: 'PLAY' },
          {
            text: 'rdQMZRCZARUVICXH02B39TQEabdFf0hCHXSSUNNZ 2 -80 i5aDk 833,3 drão held 3 shoun 1976 cache 24 tex 1334 play 2'
          }
        ]
      },
      assetId
    )

    expect(result).toMatchObject({
      matched: true,
      observedCandidate: 'rdqmzrczaruvicxh02b39tqeabdff0hchxssunnz2-8',
      observationIndex: 1,
      comparedLength: 43,
      distance: 12,
      threshold: 12
    })
  })

  it.each([
    ['short first', true, 1],
    ['short last', false, 0]
  ])(
    'does not let a near-complete short prefix shadow the sealed full observation: %s',
    (_name, shortFirst, expectedObservationIndex) => {
      const assetId = 'rdQM2RCZQARUViCxHpzBJ9TQEqbdFfDhCHxs5UNMZTU'
      const sealedObservation = {
        text: 'rdQMZRCZARUVICXH02B39TQEabdFf0hCHXSSUNNZ 2 -80 i5aDk 833,3 drão held 3 shoun 1976 cache 24 tex 1334 play 2'
      }
      const shortObservation = { text: assetId.slice(0, 40) }
      const observations = shortFirst
        ? [shortObservation, sealedObservation]
        : [sealedObservation, shortObservation]
      const result = matchHudAssetIdentity({ observations }, assetId)

      expect(result).toMatchObject({
        matched: true,
        observedCandidate: 'rdqmzrczaruvicxh02b39tqeabdff0hchxssunnz2-8',
        observationIndex: expectedObservationIndex,
        comparedLength: 43,
        distance: 12,
        threshold: 12
      })
    }
  )

  it('rejects a full ID with the same first 24 characters and a wrong tail', () => {
    const assetId = 'rdQM2RCZQARUViCxHpzBJ9TQEqbdFfDhCHxs5UNMZTU'
    const wrongTail = `${assetId.slice(0, 24)}${'A'.repeat(19)}`
    const result = matchHudAssetIdentity({ observations: [{ text: wrongTail }] }, assetId)

    expect(result.matched).toBe(false)
    expect(result.comparedLength).toBe(43)
    expect(result.distance).toBeGreaterThan(12)
  })

  it('rejects the first candidate beyond the full-ID edit-distance boundary', () => {
    const assetId = 'rdQM2RCZQARUViCxHpzBJ9TQEqbdFfDhCHxs5UNMZTU'
    const thirteenEdits = Array.from(assetId, (character, index) =>
      index < 13 ? (character.toLowerCase() === 'a' ? 'B' : 'A') : character
    ).join('')
    const result = matchHudAssetIdentity({ observations: [{ text: thirteenEdits }] }, assetId)

    expect(result).toMatchObject({
      matched: false,
      comparedLength: 43,
      distance: 13,
      threshold: 12
    })
  })

  it.each([
    ['short fragment', 'rdQM2RCZQARUViCxHpzBJ9TQEqbdF'],
    ['no-media HUD', 'No media | PAUSE | 00:00:00:00']
  ])('rejects %s observations as full asset identities', (_name, text) => {
    const assetId = 'rdQM2RCZQARUViCxHpzBJ9TQEqbdFfDhCHxs5UNMZTU'
    const result = matchHudAssetIdentity({ observations: [{ text }] }, assetId)

    expect(result.matched).toBe(false)
    expect(result.comparedLength).toBeLessThan(43)
  })

  it('never concatenates separate OCR observations into one asset identity', () => {
    const assetId = 'rdQM2RCZQARUViCxHpzBJ9TQEqbdFfDhCHxs5UNMZTU'
    const result = matchHudAssetIdentity(
      {
        observations: [{ text: assetId.slice(0, 24) }, { text: assetId.slice(24) }]
      },
      assetId
    )

    expect(result.matched).toBe(false)
    expect(result.comparedLength).toBeLessThan(43)
  })

  it('uses the verifier overlay default for LUT material-color gates', async () => {
    const directory = await temporaryDirectory()
    const capturePath = path.join(directory, 'capture.png')
    const referencePath = path.join(directory, 'synthetic-red.png')
    writeDefaultOverlayCapture(capturePath)
    createSyntheticRedReference({
      destination: referencePath,
      width: 320,
      height: 180
    })

    const result = evaluatePureRedCapture({
      capturePath,
      referencePath,
      windowBounds: { width: 320, height: 210 }
    })

    expect(result.clean).toBe(true)
    expect(result.comparator.registration).toMatchObject({
      logicalHudOverlayHeight: 118,
      comparisonHeight: 62,
      videoHeight: 180
    })
    expect(result.absolute.redDominantFraction).toBe(1)
  })

  it('accepts a pure-red material plane through the real comparator and absolute gate', async () => {
    const directory = await temporaryDirectory()
    const capturePath = path.join(directory, 'capture.png')
    const referencePath = path.join(directory, 'synthetic-red.png')
    writeCapture(capturePath, 'pure-red')
    createSyntheticRedReference({
      destination: referencePath,
      width: 160,
      height: 90
    })

    const result = evaluatePureRedCapture({
      capturePath,
      referencePath,
      windowBounds: { width: 160, height: 120 },
      hudOverlayHeight: 0
    })

    expect(result.clean).toBe(true)
    expect(result.comparator.clean).toBe(true)
    expect(result.absolute.clean).toBe(true)
    expect(result.absolute.redDominantFraction).toBe(1)
    expect(result.absolute.meanRed).toBe(255)
    expect(result.absolute.meanGreen).toBe(0)
    expect(result.absolute.meanBlue).toBe(0)
  })

  it('rejects an ungraded material plane even when presented against the red reference', async () => {
    const directory = await temporaryDirectory()
    const capturePath = path.join(directory, 'capture.png')
    const referencePath = path.join(directory, 'synthetic-red.png')
    writeCapture(capturePath, 'ungraded')
    createSyntheticRedReference({
      destination: referencePath,
      width: 160,
      height: 90
    })

    const result = evaluatePureRedCapture({
      capturePath,
      referencePath,
      windowBounds: { width: 160, height: 120 },
      hudOverlayHeight: 0
    })

    expect(result.clean).toBe(false)
    expect(result.absolute.clean).toBe(false)
    expect(result.absolute.redDominantFraction).toBeLessThan(0.97)
  })

  it('uses the absolute gate to reject a uniform gray affine false-fit', async () => {
    const directory = await temporaryDirectory()
    const capturePath = path.join(directory, 'capture.png')
    const referencePath = path.join(directory, 'synthetic-red.png')
    writeCapture(capturePath, 'uniform-gray')
    createSyntheticRedReference({
      destination: referencePath,
      width: 160,
      height: 90
    })

    const result = evaluatePureRedCapture({
      capturePath,
      referencePath,
      windowBounds: { width: 160, height: 120 },
      hudOverlayHeight: 0
    })

    expect(result.comparator.clean).toBe(true)
    expect(result.absolute.clean).toBe(false)
    expect(result.clean).toBe(false)
    expect(result.absolute.meanRed).toBe(129)
    expect(result.absolute.meanGreen).toBe(128)
    expect(result.absolute.meanBlue).toBe(129)
  })

  it('rejects a partially red material plane below the 97 percent threshold', async () => {
    const directory = await temporaryDirectory()
    const capturePath = path.join(directory, 'capture.png')
    const referencePath = path.join(directory, 'synthetic-red.png')
    writeCapture(capturePath, 'partial-red')
    createSyntheticRedReference({
      destination: referencePath,
      width: 160,
      height: 90
    })

    const result = evaluatePureRedCapture({
      capturePath,
      referencePath,
      windowBounds: { width: 160, height: 120 },
      hudOverlayHeight: 0
    })

    expect(result.absolute.redDominantFraction).toBeCloseTo(0.95, 5)
    expect(result.absolute.clean).toBe(false)
    expect(result.clean).toBe(false)
  })

  it('proves an invalid replacement retained the exact active state and journal', () => {
    const activeState = {
      active: true,
      displayName: 'Acceptance-Red.cube',
      effectId: 'effect-1'
    }
    const journal = [{ revision: 1, op: { type: 'set_effect_preview' } }]

    expect(
      validateInvalidReplacement({
        activeState,
        stateAfterInvalid: { ...activeState },
        journalBefore: journal,
        journalAfter: structuredClone(journal),
        rejectedDom: {
          active: 'true',
          label: 'LUT: Acceptance-Red.cube',
          error: 'That .cube file has a malformed entry.'
        }
      })
    ).toMatchObject({ ok: true, journalUnchanged: true })

    expect(() =>
      validateInvalidReplacement({
        activeState,
        stateAfterInvalid: { ...activeState, effectId: 'effect-2' },
        journalBefore: journal,
        journalAfter: journal,
        rejectedDom: { active: 'true', error: 'malformed' }
      })
    ).toThrow(/changed active state/)
  })

  it('requires exact replay and durable clear state', () => {
    expect(
      validateReplayState(
        { active: true, displayName: 'Acceptance-Red.cube', effectId: 'effect-1' },
        { active: 'true', label: 'LUT: Acceptance-Red.cube' },
        'effect-1'
      )
    ).toMatchObject({ ok: true })

    expect(
      validateClearedState(
        { active: false, displayName: null, effectId: null },
        { op: { type: 'set_effect_preview', effectPreview: null } },
        { active: 'false', label: 'LUT: None' }
      )
    ).toMatchObject({ ok: true })

    expect(() =>
      validateClearedState(
        { active: false, displayName: null, effectId: null },
        { op: { type: 'set_effect_preview', effectPreview: { effectId: 'effect-1' } } },
        { active: 'false', label: 'LUT: None' }
      )
    ).toThrow(/durable JSON null/)
  })

  it('rejects replay state that does not preserve the exact effect identity', () => {
    expect(() =>
      validateReplayState(
        { active: true, displayName: 'Acceptance-Red.cube', effectId: 'wrong-effect' },
        { active: 'true', label: 'LUT: Acceptance-Red.cube' },
        'effect-1'
      )
    ).toThrow(/restart replay state mismatch/)
  })

  it('requires exact watchdog teardown with no detached groups or survivors', () => {
    const terminal = {
      groupExitVerified: true,
      detachedGroupExitVerified: true,
      survivors: [],
      detachedProcessGroups: [],
      protectedInstalledGroups: []
    }
    expect(validateTerminalReceipt(terminal)).toBe(terminal)

    expect(() => validateTerminalReceipt({ ...terminal, survivors: [{ pid: 10 }] })).toThrow(
      /terminal receipt is not clean/
    )
  })
})
