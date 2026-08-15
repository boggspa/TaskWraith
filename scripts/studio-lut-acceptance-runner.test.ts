import fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

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
  createSyntheticRedReference,
  evaluatePureRedCapture,
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
  createSyntheticRedReference: (options: {
    destination: string
    width: number
    height: number
  }) => Record<string, any>
  evaluatePureRedCapture: (options: {
    capturePath: string
    referencePath: string
    windowBounds: { width: number; height: number }
    hudOverlayHeight?: number
  }) => Record<string, any>
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
    transportMutationBracket?: Record<string, any>
  ) => Promise<void>
  validateTerminalReceipt: (terminal: Record<string, any>) => Record<string, any>
}

const temporaryDirectories: string[] = []

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

async function temporaryDirectory(): Promise<string> {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'studio-lut-runner-'))
  temporaryDirectories.push(directory)
  return directory
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
      before: {
        requestPath: before.requestPath,
        receiptPath: before.receiptPath,
        rawValue: validTransportMutationText,
        parsedValue: { kind: 'lifecycleAttach', route: 'review' }
      },
      after: {
        requestPath: after.requestPath,
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
        before: {
          requestPath: path.join(directory, 'request-before.json'),
          receiptPath: path.join(directory, 'receipt-before.json'),
          rawValue: validTransportMutationText,
          parsedValue: { kind: 'lifecycleAttach', route: 'review' }
        },
        after: {
          requestPath: path.join(directory, 'request-after.json'),
          receiptPath: path.join(directory, 'receipt-after.json'),
          rawValue: validTransportMutationText,
          parsedValue: { kind: 'lifecycleAttach', route: 'review' }
        }
      }
    })
  })

  it('brackets the one native screenshot choke point in exact order', async () => {
    const source = await fsPromises.readFile(
      path.resolve(__dirname, 'studio-lut-acceptance-runner.cjs'),
      'utf8'
    )
    const start = source.indexOf('async function captureNative(')
    const end = source.indexOf('async function captureGuarded(', start)
    const captureSource = source.slice(start, end)
    const before = captureSource.indexOf(
      'const beforeMutationReceipt = await readTransportMutation'
    )
    const screenshot = captureSource.indexOf(
      'const receipt = await harness.runStudioUiDriver(plan, target, request.actions)'
    )
    const after = captureSource.indexOf('const afterMutationReceipt = await readTransportMutation')
    const validation = captureSource.indexOf('validateTransportMutationBracket(')

    expect(start).toBeGreaterThan(0)
    expect(before).toBeGreaterThan(0)
    expect(screenshot).toBeGreaterThan(before)
    expect(after).toBeGreaterThan(screenshot)
    expect(validation).toBeGreaterThan(after)
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
