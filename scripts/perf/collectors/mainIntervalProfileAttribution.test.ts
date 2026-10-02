import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { calibrateMainProfile } = require('./mainProfileCalibration.cjs')
const { attributeMainIntervalProfile } = require('./mainIntervalProfileAttribution.cjs')
const digest = (s: string) => createHash('sha256').update(s).digest('hex')
function fixture() {
  const marker = (tag: string, beforeMs: number, afterMs: number) => ({
    tag,
    beforeMs,
    afterMs,
    pid: 42,
    timeOrigin: 100,
    identity: 'main:42:performance.timeOrigin:100',
    clockId: 'node.performance.now',
    windowId: 'w',
    source: tag,
    sourceSha256: digest(tag)
  })
  const frame = {
    functionName: 'commit',
    url: 'frozen-source:///src/main/store/ToolActivityDetailLedger.ts',
    lineNumber: 1,
    columnNumber: 1
  }
  const profile = {
    startTime: 1000000,
    endTime: 1117000,
    nodes: [
      { id: 3, children: [1, 2, 4], callFrame: { functionName: '(root)', url: '' } },
      { id: 1, callFrame: { functionName: 'start', url: 'taskwraith-calibration-start.js' } },
      { id: 2, callFrame: { functionName: 'end', url: 'taskwraith-calibration-end.js' } },
      { id: 4, callFrame: frame }
    ],
    samples: [1, 1, 4, 4, 4, 2, 2],
    timeDeltas: [11000, 6000, 4000, 70000, 14000, 6000, 6000]
  }
  const calibration = calibrateMainProfile(profile, [
    marker('start', 10, 18),
    marker('end', 110, 118)
  ])
  return {
    profile,
    calibration,
    window: { id: 'w', clockId: 'node.performance.now', startMs: 30, endMs: 80, durationMs: 50 },
    clock: {
      clockId: 'node.performance.now',
      provenance: 'node-performance-now',
      identity: 'main:42:performance.timeOrigin:100',
      pid: 42,
      timeOrigin: 100
    },
    sourceProvenance: {
      complete: true,
      buildCommitSha: 'a'.repeat(40),
      sourceManifestSha256: 'b'.repeat(64),
      evidence: [
        {
          nodeId: 4,
          resolvedFrame: frame,
          sourceSha256: 'c'.repeat(64),
          bundleSha256: 'd'.repeat(64),
          mapSha256: 'e'.repeat(64),
          captureManifestSha256: 'f'.repeat(64),
          buildCommitSha: 'a'.repeat(40),
          sourceManifestSha256: 'b'.repeat(64)
        }
      ]
    },
    gapSnapshot: {
      intervalMs: 5,
      thresholdMs: 25,
      startedAtMs: 30,
      endedAtMs: 80,
      observedForMs: 50,
      blockedMs: 30,
      gaps: [{ expectedAtMs: 40, observedAtMs: 70, durationMs: 30 }],
      dropped: 0,
      censored: false,
      reasons: [],
      suspensionProtection: { heldThroughout: true }
    },
    exemptions: { complete: true, entries: [] }
  }
}
describe('calibrated interval attribution', () => {
  it('rejects uncapped gap arrays before normalization and charges nonoverlap scans', () => {
    const input = fixture()
    const many = Array.from({ length: 1000 }, () => ({
      expectedAtMs: 30,
      observedAtMs: 55,
      durationMs: 25
    }))
    expect(() =>
      attributeMainIntervalProfile({
        ...input,
        gapSnapshot: { ...input.gapSnapshot, gaps: many, blockedMs: 25000 },
        limits: { maxGaps: 10 }
      })
    ).toThrow('gap overflow')
    // First valid mapped sample is wholly before this gap; the scan still costs
    // work, and all marker samples cost work even when excluded.
    expect(() => attributeMainIntervalProfile({ ...input, limits: { maxWork: 3 } })).toThrow(
      'work overflow'
    )
    expect(() =>
      attributeMainIntervalProfile({ ...input, limits: { maxWork: Number.MAX_SAFE_INTEGER + 1 } })
    ).toThrow('bound')
  })

  it('caps source-missing and marker-excluded unresolved evidence on every path', () => {
    const input = fixture()
    input.profile.nodes[3].callFrame.url = '/out/main/index.js'
    expect(() => attributeMainIntervalProfile({ ...input, limits: { maxEvidence: 1 } })).toThrow(
      'evidence overflow'
    )
    const marker = fixture()
    marker.window.startMs = 0
    marker.window.durationMs = 80
    marker.gapSnapshot.startedAtMs = 0
    marker.gapSnapshot.observedForMs = 80
    expect(() => attributeMainIntervalProfile({ ...marker, limits: { maxEvidence: 1 } })).toThrow(
      'evidence overflow'
    )
  })
  it('subtracts timestamped supported exemptions without manufacturing exact durations', () => {
    const input = fixture()
    const entries = [
      {
        windowId: 'w',
        clockId: 'node.performance.now',
        owner: 's7_detail_batch',
        reason: 'sync_dependency',
        startMs: 40,
        endMs: 70
      }
    ]
    const result = attributeMainIntervalProfile({
      ...input,
      exemptions: { complete: true, entries }
    })
    expect(result.listedOwnerMsBounds).toEqual({ lower: 0, upper: 0 })
    expect(result.attributionEligible).toBe(true)
    expect(result.exact).toBe(false)
    expect(() =>
      attributeMainIntervalProfile({
        ...input,
        exemptions: { complete: true, entries: [{ ...entries[0], clockId: 'other' }] }
      })
    ).toThrow('exemption')
  })

  it('uses measured uncertainty while qualifying fully interior actual owner evidence', () => {
    const input = fixture()
    expect(input.calibration.qualified).toBe(true)
    const result = attributeMainIntervalProfile(input)
    expect(result.exact).toBe(false)
    expect(result.attributionEligible).toBe(true)
    expect(result.listedOwnerMsBounds).toEqual({ lower: 30, upper: 30 })
    expect('listedOwnerMs' in result).toBe(false)
    expect(result.coverage.complete).toBe(true)
  })
  it('retains lower/upper clipping rather than averaging ambiguous sample edges', () => {
    const input = fixture()
    input.gapSnapshot.gaps[0] = { expectedAtMs: 40, observedAtMs: 70, durationMs: 30 }
    input.profile.timeDeltas = [11000, 6000, 33000, 41000, 14000, 6000, 6000]
    const result = attributeMainIntervalProfile(input)
    expect(
      result.intervals.some(
        (i: { clippedOverlap: { lowerMs: number; upperMs: number } }) =>
          i.clippedOverlap.lowerMs < i.clippedOverlap.upperMs
      )
    ).toBe(true)
    expect(result.exact).toBe(false)
    expect(result.censored).toBe(true)
  })
  it.each(['pid', 'origin', 'window', 'digest', 'cancel', 'source', 'truncated'] as const)(
    'refuses or censors %s',
    (kind) => {
      const input = fixture()
      if (kind === 'pid') input.clock.pid = 43
      if (kind === 'origin') input.clock.timeOrigin = 101
      if (kind === 'window') input.window.id = 'other'
      if (kind === 'digest') input.sourceProvenance.evidence[0].sourceSha256 = 'bad'
      if (kind === 'cancel') input.gapSnapshot.censored = true
      if (kind === 'source') input.profile.nodes[3].callFrame.url = '/out/main/index.js'
      if (kind === 'truncated') input.profile.timeDeltas.pop()
      if (kind === 'source') expect(attributeMainIntervalProfile(input).censored).toBe(true)
      else expect(() => attributeMainIntervalProfile(input)).toThrow('refused')
    }
  )
  it('empty gaps still require complete calibrated profile and source coverage', () => {
    const input = fixture()
    input.gapSnapshot.gaps = []
    input.gapSnapshot.blockedMs = 0
    expect(attributeMainIntervalProfile(input).ownerAbsenceProven).toBe(true)
    input.window.startMs = 0
    input.window.durationMs = 80
    input.gapSnapshot.startedAtMs = 0
    input.gapSnapshot.observedForMs = 80
    expect(attributeMainIntervalProfile(input).censored).toBe(true)
  })
})
