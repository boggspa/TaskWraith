import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/* eslint-disable @typescript-eslint/no-require-imports */
const {
  normalizeResource,
  planSamples,
  prepareAvEnduranceSourceEvidence,
  runAvEnduranceAcceptance,
  validateAcceptanceEvidence
} = require('./studio-av-endurance-acceptance-runner.cjs') as {
  normalizeResource: (raw: Record<string, any>, index: number) => Record<string, any>
  planSamples: (options?: Record<string, any>) => Array<Record<string, any>>
  prepareAvEnduranceSourceEvidence: (
    options: Record<string, any>,
    adapters: Record<string, any>
  ) => Record<string, any>
  runAvEnduranceAcceptance: (
    options: Record<string, any>,
    adapters: Record<string, any>
  ) => Promise<Record<string, any>>
  validateAcceptanceEvidence: (evidence: Record<string, any>) => Record<string, any>
}
const { buildReferenceExtractCommand } = require('./studio-bounded-diagnostics-runner.cjs') as {
  buildReferenceExtractCommand: (options: Record<string, any>) => string[]
}
const { hudAssetIdentityToken } = require('./studio-acceptance-session.cjs') as {
  hudAssetIdentityToken: (assetId: string) => string
}
const { PNG } = require('pngjs') as { PNG: any }

const sourceAssetBytes = Buffer.from('TaskWraith Outcome 5 deterministic source identity\n')
const assetId = createHash('sha256').update(sourceAssetBytes).digest('base64url')
const currentText =
  'avc1 ts=30000 fd=1000 pf=0 ap=0 err=0 errms=0.000 win=30000 winms=0.030 drawn=1 expl=not_explained'
const peakText = 'av1 pf=0 ap=0 err=0 errms=0.000 win=30000 winms=0.030 drawn=1 expl=not_explained'
const resourceText = 'res1 dec=1 cap=3 surf=1 ids=0000002A'

const windowBounds = { x: 0, y: 0, width: 320, height: 180 }
const sourceHostFrame = { x: 1, y: 1, width: 318, height: 178 }
const hudOverlayHeight = 20

function sha256Bytes(value: Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256Text(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function timecodeForFrame(frameIndex: number) {
  const hours = Math.floor(frameIndex / (30 * 3_600))
  const minutes = Math.floor((frameIndex % (30 * 3_600)) / (30 * 60))
  const seconds = Math.floor((frameIndex % (30 * 60)) / 30)
  const frame = frameIndex % 30
  return [hours, minutes, seconds, frame].map((value) => String(value).padStart(2, '0')).join(':')
}

function createArtifactFixtures(root: string) {
  mkdirSync(root, { recursive: true })
  const sourceAssetPath = path.join(root, 'source.bin')
  writeFileSync(sourceAssetPath, sourceAssetBytes)
  return Array.from({ length: 21 }, (_, index) => {
    const reference = new PNG({ width: 320, height: 180 })
    for (let y = 0; y < reference.height; y += 1) {
      for (let x = 0; x < reference.width; x += 1) {
        const offset = (y * reference.width + x) * 4
        reference.data[offset] = 30 + Math.floor(x / 32) + index * 3
        reference.data[offset + 1] = 60 + Math.floor(y / 30) + index * 2
        reference.data[offset + 2] = 90 + Math.floor((x + y) / 64) + index
        reference.data[offset + 3] = 255
      }
    }
    const referenceBytes = PNG.sync.write(reference)
    const referencePath = path.join(
      root,
      `av-endurance-reference-${String(index).padStart(2, '0')}.png`
    )
    writeFileSync(referencePath, referenceBytes)
    const capture = PNG.sync.read(referenceBytes)
    // The changing rows sit wholly inside the declared HUD exclusion, making
    // each real screenshot byte-distinct while the decoded-video comparison
    // remains clean.
    for (let y = 170; y < 180; y += 1) {
      for (let x = 0; x < capture.width; x += 1) {
        const offset = (y * capture.width + x) * 4
        capture.data[offset] = (index * 11 + x) % 256
        capture.data[offset + 1] = (index * 17 + y) % 256
      }
    }
    const screenshotBytes = PNG.sync.write(capture)
    const screenshotPath = path.join(root, `sample-${String(index).padStart(2, '0')}.png`)
    writeFileSync(screenshotPath, screenshotBytes)
    const referenceFrameIndex = index === 20 ? 17_999 : index * 900
    const rawOcrText = JSON.stringify([
      { text: timecodeForFrame(referenceFrameIndex) },
      { text: 'PLAY' },
      {
        text: `drop 0 held 0 shown ${100 + index} cache ${50 + index} tex 3`
      },
      { text: 'play 1 rss 400.0 MB' },
      { text: hudAssetIdentityToken(assetId) }
    ])
    return {
      screenshotPath,
      screenshotSha256: sha256Bytes(screenshotBytes),
      windowBounds,
      sourceHostFrame,
      hudOverlayHeight,
      rawOcrText,
      rawOcrSha256: sha256Text(rawOcrText)
    }
  })
}

function freshRoot(label: string) {
  return mkdtempSync(path.join(os.tmpdir(), `taskwraith-av-${label}-`))
}

function acceptanceOptions(root: string) {
  return {
    artifactRoot: root,
    expectedAssetId: assetId,
    sourceAssetPath: path.join(root, 'source.bin'),
    testOnlyAllowSyntheticClock: true
  }
}

function captureWithState(capture: Record<string, any>, state: 'PLAY' | 'PAUSE') {
  const observations = JSON.parse(capture.rawOcrText)
  const stateObservation = observations.find((observation: Record<string, any>) =>
    ['PLAY', 'PAUSE'].includes(observation.text)
  )
  stateObservation.text = state
  const rawOcrText = JSON.stringify(observations)
  return { ...capture, rawOcrText, rawOcrSha256: sha256Text(rawOcrText) }
}

function audioProbe(overrides: Record<string, any> = {}) {
  const durationSeconds = overrides.durationSeconds ?? 600
  const frameCount = overrides.frameCount ?? durationSeconds * 48_000
  return {
    durationSeconds,
    elapsedSeconds: durationSeconds,
    sampleBufferCount: 10,
    frameCount,
    sampleValueCount: overrides.sampleValueCount ?? frameCount * 2,
    sampleRate: 48_000,
    channelCount: 2,
    rms: 0.2,
    peak: 0.5,
    nonSilentFraction: 1,
    defaultOutputDevice: {
      id: 42,
      name: 'Output',
      uid: 'output',
      nominalSampleRate: 48_000
    },
    ...overrides
  }
}

function routeHealth() {
  return {
    id: 42,
    name: 'Output',
    uid: 'output',
    nominalSampleRate: 48_000,
    alive: true,
    running: true,
    hasOutputStream: true,
    outputStreamCount: 1,
    outputChannelCount: 2,
    muteSupported: true,
    muted: false,
    volumeSupported: true,
    volume: 0.75
  }
}

function rawSample(planEntry: Record<string, any>, overrides: Record<string, any> = {}) {
  return {
    current: currentText,
    peak: peakText,
    resource: {
      resourceDetailValue: resourceText,
      physicalFootprintBytes: 400_000_000 + (planEntry.index % 2),
      mallocAllocatedBytes: 100_000_000 + (planEntry.index % 2),
      residentBytes: 500_000_000 + (planEntry.index % 2),
      droppedFrames: 0
    },
    ...overrides
  }
}

function truthfulAdapters(
  root: string,
  overrides: (entry: Record<string, any>) => Record<string, any> = () => ({})
) {
  const fixtures = createArtifactFixtures(root)
  const censusText =
    Array.from({ length: 18_000 }, (_, index) => (index / 30).toFixed(6)).join('\n') + '\n'
  let elapsedMs = 0
  const wallAnchorMs = 1_800_000_000_000
  return {
    testOnlyClock: {
      read: () => ({
        monotonicNs: (BigInt(elapsedMs) * 1_000_000n).toString(),
        wallTimeMs: wallAnchorMs + elapsedMs
      })
    },
    testOnlyReferenceAuthority: {
      census: (_sourceAsset: Record<string, any>, command: Record<string, any>) => ({
        command: [command.executable, ...command.args],
        exitCode: 0,
        stdout: censusText,
        stderr: ''
      }),
      generate: (
        _sourceAsset: Record<string, any>,
        _exactSourcePtsSeconds: number,
        _referencePath: string,
        command: Record<string, any>
      ) => ({
        command: [command.executable, ...command.args],
        exitCode: 0,
        stdout: '',
        stderr: ''
      })
    },
    waitUntil: async (_plannedAtMs: number, entry: Record<string, any>) => {
      elapsedMs = entry.plannedElapsedMs
    },
    sampleAt: async (entry: Record<string, any>) => {
      const override = overrides(entry)
      return rawSample(entry, { ...override, capture: override.capture ?? fixtures[entry.index] })
    },
    audioEvidence: {
      windowAudio: audioProbe(),
      silenceWindow: audioProbe({
        durationSeconds: 2,
        elapsedSeconds: 2,
        rms: 0.0001,
        peak: 0.002,
        nonSilentFraction: 0
      }),
      routeHealth: routeHealth(),
      priorRouteHealth: routeHealth()
    },
    writeEvidence: async () => {}
  }
}

describe('Studio AV endurance acceptance orchestration', () => {
  it('creates exactly 21 samples spanning the declared 0..600s plan', () => {
    const plan = planSamples({ startedAtMs: 10_000 })
    expect(plan).toHaveLength(21)
    expect(plan[0]).toMatchObject({ index: 0, plannedElapsedMs: 0, plannedAtMs: 10_000 })
    expect(plan.at(-1)).toMatchObject({
      index: 20,
      plannedElapsedMs: 600_000,
      plannedAtMs: 610_000
    })
  })

  it('binds owner-supplied VFR media to its measured dynamic source census', async () => {
    const root = freshRoot('dynamic-vfr-census')
    const adapters = truthfulAdapters(root)
    const requiredSamplePts = [...Array.from({ length: 20 }, (_, index) => index * 30), 599.966667]
    const vfrValues = [...requiredSamplePts, 0.4, 1.125, 61.9, 302.333, 488.75].sort(
      (left, right) => left - right
    )
    const rawCensus = `${vfrValues.map((value) => value.toFixed(6)).join('\n')}\n`
    adapters.testOnlyReferenceAuthority.census = (
      _sourceAsset: Record<string, any>,
      command: Record<string, any>
    ) => ({
      command: [command.executable, ...command.args],
      exitCode: 0,
      stdout: rawCensus,
      stderr: ''
    })
    const result = await runAvEnduranceAcceptance(acceptanceOptions(root), adapters)
    expect(result.evidence.sourcePtsCensus.count).toBe(vfrValues.length)
    expect(result.evidence.sourcePtsCensus.values).toEqual(vfrValues)
  })

  it('prepares the trusted source census before playback and reuses it without re-probing', async () => {
    const root = freshRoot('prepared-source')
    const adapters = truthfulAdapters(root)
    const census: any = adapters.testOnlyReferenceAuthority.census
    let censusCalls = 0
    adapters.testOnlyReferenceAuthority.census = (...args: any[]) => {
      censusCalls += 1
      return census(...args)
    }
    const options = acceptanceOptions(root)
    const preparedSourceEvidence = prepareAvEnduranceSourceEvidence(options, adapters)
    expect(censusCalls).toBe(1)
    expect(Object.isFrozen(preparedSourceEvidence)).toBe(true)
    expect(Object.isFrozen(preparedSourceEvidence.sourceAsset)).toBe(true)
    expect(Object.isFrozen(preparedSourceEvidence.sourcePtsCensus)).toBe(true)
    expect(Object.isFrozen(preparedSourceEvidence.sourcePtsCensus.values)).toBe(true)
    expect(preparedSourceEvidence).not.toHaveProperty('referenceAuthority')
    expect(() => {
      preparedSourceEvidence.sourcePtsCensus.values[0] = 999
    }).toThrow()
    adapters.testOnlyReferenceAuthority.generate = () => {
      throw new Error('mutated external authority must not be observed after preparation')
    }
    await expect(
      runAvEnduranceAcceptance(options, {
        ...adapters,
        preparedSourceEvidence: { ...preparedSourceEvidence }
      })
    ).rejects.toThrow(/prepared source evidence.*forged/i)
    const result = await runAvEnduranceAcceptance(options, {
      ...adapters,
      preparedSourceEvidence
    })
    expect(censusCalls).toBe(1)
    expect(result.evidence.sourcePtsCensus.count).toBe(18_000)
  })

  it('keeps the physical-audibility blocker and refuses synthetic timing as live proof', async () => {
    const root = freshRoot('truthful')
    const result = await runAvEnduranceAcceptance(acceptanceOptions(root), truthfulAdapters(root))
    expect(result.evidence.verdict.status).toBe('red')
    expect(result.evidence.verdict.failures).toEqual([
      'synthetic test timing cannot prove a live ten-minute endurance run'
    ])
    expect(result.evidence.verdict.blockers.join(' ')).toMatch(
      /physical audibility.*cannot reach Green/i
    )
    expect(result.evidence.samples).toHaveLength(21)
    expect(result.evidence.currentSamples).toHaveLength(21)
    expect(result.evidence.peakSamples).toHaveLength(21)
    expect(result.evidence.resources.readings[0]).toMatchObject({
      footprintBytes: 400_000_000,
      mallocInUseBytes: 100_000_000,
      rawPhysicalFootprintBytes: 400_000_000,
      rawMallocAllocatedBytes: 100_000_000,
      rawResourceReceipt: {
        resourceDetailValue: resourceText,
        physicalFootprintBytes: 400_000_000,
        mallocAllocatedBytes: 100_000_000,
        residentBytes: 500_000_000,
        droppedFrames: 0
      }
    })
  })

  it('rejects av1 masquerading as current and missing decoded PTS/resources', async () => {
    const currentRoot = freshRoot('current')
    await expect(
      runAvEnduranceAcceptance(
        acceptanceOptions(currentRoot),
        truthfulAdapters(currentRoot, () => ({ current: peakText }))
      )
    ).rejects.toThrow(/current avc1/i)
    const ptsRoot = freshRoot('pts')
    const ptsFixtures = createArtifactFixtures(ptsRoot)
    const missingPtsText = JSON.stringify([{ text: 'PLAY' }])
    await expect(
      runAvEnduranceAcceptance(
        acceptanceOptions(ptsRoot),
        truthfulAdapters(ptsRoot, (entry) => ({
          capture: {
            ...ptsFixtures[entry.index],
            rawOcrText: missingPtsText,
            rawOcrSha256: sha256Text(missingPtsText)
          }
        }))
      )
    ).rejects.toThrow(/raw OCR.*playable HUD/i)
    const resourceRoot = freshRoot('resource')
    await expect(
      runAvEnduranceAcceptance(
        acceptanceOptions(resourceRoot),
        truthfulAdapters(resourceRoot, () => ({ resource: null }))
      )
    ).rejects.toThrow(/resource receipt/i)
  })

  it('rejects bunching through the canonical sample-sequence verdict', async () => {
    const root = freshRoot('bunched')
    const adapters = truthfulAdapters(root)
    adapters.waitUntil = async () => {}
    const result = await runAvEnduranceAcceptance(acceptanceOptions(root), adapters)
    expect(result.evidence.verdict.status).toBe('red')
    expect(result.evidence.verdict.failures.join(' ')).toMatch(
      /EARLY|under-duration|did not advance/i
    )
  })

  it('rejects forged evidence schema and preserves canonical resource normalization', () => {
    expect(
      normalizeResource(
        {
          resourceDetailValue: resourceText,
          physicalFootprintBytes: 4,
          mallocAllocatedBytes: 5,
          residentBytes: 6
        },
        0
      )
    ).toMatchObject({
      footprintBytes: 4,
      mallocInUseBytes: 5,
      physicalFootprintBytes: 4,
      mallocAllocatedBytes: 5,
      rawPhysicalFootprintBytes: 4,
      rawMallocAllocatedBytes: 5
    })
    expect(() => validateAcceptanceEvidence({ schemaVersion: 2 })).toThrow(/schema identity/i)
  })

  it('rejects missing exact asset identity, malformed resources, and forged evidence keys', async () => {
    const identityRoot = freshRoot('identity')
    const identityFixtures = createArtifactFixtures(identityRoot)
    const missingIdentityText = JSON.stringify([
      { text: '00:00:00:00' },
      { text: 'PLAY' },
      { text: 'drop 0 held 0 shown 1 cache 1 tex 1' },
      { text: 'play 1 rss 400.0 MB' }
    ])
    await expect(
      runAvEnduranceAcceptance(
        acceptanceOptions(identityRoot),
        truthfulAdapters(identityRoot, (entry) => ({
          capture: {
            ...identityFixtures[entry.index],
            rawOcrText: missingIdentityText,
            rawOcrSha256: sha256Text(missingIdentityText)
          }
        }))
      )
    ).rejects.toThrow(/asset-identity-mismatch|playable HUD/i)
    expect(() =>
      normalizeResource(
        {
          resourceDetailValue: 'res1 dec=1 cap=1 surf=1 ids=0000002A',
          physicalFootprintBytes: -1,
          mallocAllocatedBytes: 5,
          residentBytes: 6
        },
        0
      )
    ).toThrow(/physicalFootprintBytes/i)
    expect(() =>
      normalizeResource(
        {
          resourceDetailValue: 'res1 dec=1 cap=1 surf=1 ids=!',
          physicalFootprintBytes: 4,
          mallocAllocatedBytes: 5,
          residentBytes: 6
        },
        0
      )
    ).toThrow(/resource receipt/i)
    const root = freshRoot('schema')
    const result = await runAvEnduranceAcceptance(acceptanceOptions(root), truthfulAdapters(root))
    expect(() =>
      validateAcceptanceEvidence(JSON.parse(JSON.stringify(result.evidence)))
    ).not.toThrow()
    expect(() => validateAcceptanceEvidence({ ...result.evidence, forged: true })).toThrow(
      /schema key set/i
    )
    expect(() =>
      validateAcceptanceEvidence({ ...result.evidence, plan: result.evidence.plan.slice(0, 20) })
    ).toThrow(/plan must contain/i)
    await expect(
      runAvEnduranceAcceptance(
        {
          ...acceptanceOptions(freshRoot('relative-options')),
          artifactRoot: 'relative-artifact'
        },
        truthfulAdapters(freshRoot('relative'))
      )
    ).rejects.toThrow(/absolute artifact root/i)
  })

  it('schedules each adapter sample at its canonical monotonic plan instant and writes it', async () => {
    const waits: number[] = []
    const samples: number[] = []
    let written: Record<string, any> | null = null
    const root = freshRoot('scheduled')
    const adapters = truthfulAdapters(root)
    const fixtures = createArtifactFixtures(root)
    const advanceClock = adapters.waitUntil
    adapters.waitUntil = async (plannedAtMs: number, entry: Record<string, any>) => {
      waits.push(plannedAtMs)
      expect(entry.plannedAtMs).toBe(plannedAtMs)
      await advanceClock(plannedAtMs, entry)
    }
    adapters.sampleAt = async (entry: Record<string, any>) => {
      samples.push(entry.index)
      return rawSample(entry, { capture: fixtures[entry.index] })
    }
    adapters.writeEvidence = async (_root: string, evidence: Record<string, any>) => {
      written = evidence
    }
    const result = await runAvEnduranceAcceptance(acceptanceOptions(root), adapters)
    expect(waits).toEqual(
      result.evidence.plan.slice(1).map((entry: Record<string, any>) => entry.plannedAtMs)
    )
    expect(samples).toEqual(Array.from({ length: 21 }, (_, index) => index))
    expect(written).toBe(result.evidence)
  })

  it('owns the evidence clocks and rejects adapter-supplied timing', async () => {
    const legacyRoot = freshRoot('legacy-clock')
    const legacyAdapters = truthfulAdapters(legacyRoot) as Record<string, any>
    legacyAdapters.monotonicNow = () => 0
    await expect(
      runAvEnduranceAcceptance(acceptanceOptions(legacyRoot), legacyAdapters)
    ).rejects.toThrow(/refuses adapter-controlled monotonicNow/i)

    const rawRoot = freshRoot('raw-clock')
    const rawAdapters = truthfulAdapters(rawRoot)
    const sampleAt = rawAdapters.sampleAt
    rawAdapters.sampleAt = async (entry: Record<string, any>) => ({
      ...(await sampleAt(entry)),
      actualElapsedMs: entry.plannedElapsedMs,
      monotonicMs: entry.plannedElapsedMs
    })
    await expect(runAvEnduranceAcceptance(acceptanceOptions(rawRoot), rawAdapters)).rejects.toThrow(
      /adapter receipt.*schema key set/i
    )

    const referenceRoot = freshRoot('raw-reference')
    const referenceAdapters = truthfulAdapters(referenceRoot)
    const rawReferenceSample = referenceAdapters.sampleAt
    referenceAdapters.sampleAt = async (entry: Record<string, any>) => {
      const raw = await rawReferenceSample(entry)
      return {
        ...raw,
        capture: { ...raw.capture, referencePath: path.join(referenceRoot, 'forged.png') }
      }
    }
    await expect(
      runAvEnduranceAcceptance(acceptanceOptions(referenceRoot), referenceAdapters)
    ).rejects.toThrow(/raw capture.*schema key set/i)
  })

  it('independently rejects forged PTS, artifact hash/path, pixel, and audio evidence', async () => {
    const root = freshRoot('forged')
    const result = await runAvEnduranceAcceptance(acceptanceOptions(root), truthfulAdapters(root))
    const forgedPts = JSON.parse(JSON.stringify(result.evidence))
    forgedPts.samples[1].decodedContentPtsSeconds = forgedPts.samples[0].decodedContentPtsSeconds
    forgedPts.samples[1].hud.contentPtsSeconds = forgedPts.samples[0].hud.contentPtsSeconds
    expect(() => validateAcceptanceEvidence(forgedPts)).toThrow(/binding|verdict|PTS|joined/i)

    const forgedHash = JSON.parse(JSON.stringify(result.evidence))
    forgedHash.samples[0].capture.screenshotSha256 = '0'.repeat(64)
    expect(() => validateAcceptanceEvidence(forgedHash)).toThrow(/screenshot bytes/i)

    const forgedPath = JSON.parse(JSON.stringify(result.evidence))
    forgedPath.samples[0].capture.screenshotPath = path.join(os.tmpdir(), 'outside-evidence.png')
    expect(() => validateAcceptanceEvidence(forgedPath)).toThrow(/outside artifactRoot/i)

    const forgedPixels = JSON.parse(JSON.stringify(result.evidence))
    forgedPixels.samples[0].capture.pixelComparison.clean = false
    expect(() => validateAcceptanceEvidence(forgedPixels)).toThrow(/pixel comparison/i)

    const forgedOcr = JSON.parse(JSON.stringify(result.evidence))
    const observations = JSON.parse(forgedOcr.samples[0].capture.rawOcrText)
    observations[0].text = '00:00:01:00'
    forgedOcr.samples[0].capture.rawOcrText = JSON.stringify(observations)
    forgedOcr.samples[0].capture.rawOcrSha256 = sha256Text(forgedOcr.samples[0].capture.rawOcrText)
    expect(() => validateAcceptanceEvidence(forgedOcr)).toThrow(/reference PTS|binding/i)

    const forgedReferencePts = JSON.parse(JSON.stringify(result.evidence))
    forgedReferencePts.samples[0].capture.referenceContentPtsSeconds = 1
    forgedReferencePts.samples[0].capture.referenceCommand = buildReferenceExtractCommand({
      assetPath: forgedReferencePts.sourceAsset.path,
      exactSourcePtsSeconds: 1,
      referencePath: forgedReferencePts.samples[0].capture.referencePath
    })
    expect(() => validateAcceptanceEvidence(forgedReferencePts)).toThrow(
      /reference (?:PTS|execution)/i
    )

    const forgedTiming = JSON.parse(JSON.stringify(result.evidence))
    forgedTiming.samples[1].timing.beforeMonotonicNs = '1'
    expect(() => validateAcceptanceEvidence(forgedTiming)).toThrow(/timing|monotonic/i)

    const forgedAudio = JSON.parse(JSON.stringify(result.evidence))
    forgedAudio.audio.windowAudio.rms = 0
    expect(() => validateAcceptanceEvidence(forgedAudio)).toThrow(/verdict/i)

    const forgedResource = JSON.parse(JSON.stringify(result.evidence))
    forgedResource.resources.readings[0].rawResourceReceipt.physicalFootprintBytes += 1
    expect(() => validateAcceptanceEvidence(forgedResource)).toThrow(/raw receipt/i)

    const oversizedCapture = JSON.parse(JSON.stringify(result.evidence))
    const oversizedPath = path.join(root, 'oversized.png')
    writeFileSync(oversizedPath, Buffer.alloc(0))
    truncateSync(oversizedPath, 64 * 1024 * 1024 + 1)
    oversizedCapture.samples[0].capture.screenshotPath = oversizedPath
    expect(() => validateAcceptanceEvidence(oversizedCapture)).toThrow(/bounded byte length/i)

    writeFileSync(result.evidence.sourceAsset.path, Buffer.from('changed source bytes'))
    expect(() => validateAcceptanceEvidence(result.evidence)).toThrow(/source asset bytes/i)
  })

  it('marks a changing positive IOSurface capacity red instead of taking a maximum', async () => {
    const root = freshRoot('capacity')
    const result = await runAvEnduranceAcceptance(
      acceptanceOptions(root),
      truthfulAdapters(root, (entry) =>
        entry.index === 1
          ? {
              resource: {
                resourceDetailValue: 'res1 dec=1 cap=4 surf=1 ids=0000002A',
                physicalFootprintBytes: 400_000_001,
                mallocAllocatedBytes: 100_000_001,
                residentBytes: 500_000_001,
                droppedFrames: 0
              }
            }
          : {}
      )
    )
    expect(result.evidence.resources.ioSurfaceCapacity).toBe(3)
    expect(result.evidence.verdict.status).toBe('red')
    expect(result.evidence.verdict.failures.join(' ')).toMatch(/capacity changed/i)
  })

  it('accepts only the final canonical sample as a truthful end-of-media PAUSE', async () => {
    const terminalRoot = freshRoot('terminal-pause')
    const terminalFixtures = createArtifactFixtures(terminalRoot)
    const terminal = await runAvEnduranceAcceptance(
      acceptanceOptions(terminalRoot),
      truthfulAdapters(terminalRoot, (entry) =>
        entry.index === 20
          ? { capture: captureWithState(terminalFixtures[entry.index], 'PAUSE') }
          : {}
      )
    )
    expect(terminal.evidence.samples[20].hud.state).toBe('PAUSE')

    const prematureRoot = freshRoot('premature-terminal-pause')
    const prematureFixtures = createArtifactFixtures(prematureRoot)
    const prematureCapture = captureWithState(prematureFixtures[20], 'PAUSE')
    const prematureObservations = JSON.parse(prematureCapture.rawOcrText)
    prematureObservations[0].text = '00:09:40:00'
    prematureCapture.rawOcrText = JSON.stringify(prematureObservations)
    prematureCapture.rawOcrSha256 = sha256Text(prematureCapture.rawOcrText)
    await expect(
      runAvEnduranceAcceptance(
        acceptanceOptions(prematureRoot),
        truthfulAdapters(prematureRoot, (entry) =>
          entry.index === 20 ? { capture: prematureCapture } : {}
        )
      )
    ).rejects.toThrow(/terminal PAUSE.*final decoded source frame/i)

    const earlyRoot = freshRoot('early-pause')
    const earlyFixtures = createArtifactFixtures(earlyRoot)
    await expect(
      runAvEnduranceAcceptance(
        acceptanceOptions(earlyRoot),
        truthfulAdapters(earlyRoot, (entry) =>
          entry.index === 19
            ? { capture: captureWithState(earlyFixtures[entry.index], 'PAUSE') }
            : {}
        )
      )
    ).rejects.toThrow(/playable HUD|transport-not-playing/i)
  })

  it('rejects a missing current or peak receipt during normalization', async () => {
    const currentRoot = freshRoot('missing-current')
    await expect(
      runAvEnduranceAcceptance(
        acceptanceOptions(currentRoot),
        truthfulAdapters(currentRoot, () => ({ current: 'av1 x' }))
      )
    ).rejects.toThrow(/current avc1/i)
    const peakRoot = freshRoot('missing-peak')
    await expect(
      runAvEnduranceAcceptance(
        acceptanceOptions(peakRoot),
        truthfulAdapters(peakRoot, () => ({ peak: 'avc1 x' }))
      )
    ).rejects.toThrow(/peak av1/i)
  })
})
