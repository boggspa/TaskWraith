import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const {
  calibrateMainProfile,
  captureProfileMarker,
  mapProfileTimeBounds,
  mapProfileIntervalBounds
} = require('./mainProfileCalibration.cjs')

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
    sourceSha256: createHash('sha256').update(tag).digest('hex')
  })
  const markers = [marker('start', 10, 18), marker('end', 110, 118)]
  const profile = {
    startTime: 1000000,
    endTime: 1200000,
    nodes: [
      { id: 3, children: [1, 2], callFrame: { functionName: '(root)', url: '' } },
      ...['start', 'end'].map((tag, i) => ({
        id: i + 1,
        callFrame: { functionName: tag, url: `taskwraith-calibration-${tag}.js` }
      }))
    ],
    samples: [1, 1, 2, 2],
    timeDeltas: [11000, 6000, 94000, 6000]
  }
  return { profile, markers }
}
describe('measured profile calibration', () => {
  it('refuses hostile options and calibration shapes without throwing', () => {
    const f = fixture()
    expect(calibrateMainProfile(f.profile, f.markers, null).qualified).toBe(false)
    const valid = calibrateMainProfile(f.profile, f.markers)
    for (const value of [
      null,
      { qualified: true },
      { ...valid, anchors: [null, null] },
      { ...valid, markers: [null, null] },
      { ...valid, markerExclusions: [null, null] },
      { ...valid, offsetBoundsMs: { lower: NaN, upper: Infinity } },
      { ...valid, anchors: valid.anchors.map((a: object) => ({ ...a, identity: 'foreign' })) }
    ]) {
      expect(mapProfileTimeBounds(value, 1050000)).toBeNull()
      expect(mapProfileIntervalBounds(value, 1050000, 1060000)).toBeNull()
    }
  })
  it('refuses malformed tree rows and unknown nonmarker samples without throwing', () => {
    const f = fixture()
    for (const profile of [
      { ...f.profile, nodes: [null] },
      { ...f.profile, samples: [1, 99, 2, 2] },
      { ...f.profile, nodes: [...f.profile.nodes, f.profile.nodes[0]] },
      {
        ...f.profile,
        nodes: [{ ...f.profile.nodes[0], children: [1, 99] }, ...f.profile.nodes.slice(1)]
      },
      { ...f.profile, startTime: f.profile.endTime },
      { ...f.profile, nodes: f.profile.nodes.map((node) => ({ ...node, children: [node.id] })) }
    ])
      expect(calibrateMainProfile(profile, f.markers).qualified).toBe(false)
  })
  it('excludes marker brackets and ambiguous boundaries from mappings', () => {
    const f = fixture(),
      result = calibrateMainProfile(f.profile, f.markers)
    expect(result.markerExclusions).toHaveLength(2)
    for (const range of result.markerExclusions) {
      expect(mapProfileTimeBounds(result, range.profileLowerUs)).toBeNull()
      expect(mapProfileTimeBounds(result, range.profileUpperUs)).toBeNull()
    }
    expect(mapProfileTimeBounds(result, result.anchors[0].profileLastUs)).toBeNull()
    expect(mapProfileTimeBounds(result, result.anchors[1].profileFirstUs)).toBeNull()
  })
  it('retains uncertainty and refuses extrapolation instead of inventing exact anchors', () => {
    const f = fixture(),
      result = calibrateMainProfile(f.profile, f.markers)
    expect(result.qualified).toBe(true)
    expect(result.exact).toBe(false)
    expect(result.offsetBoundsMs.uncertaintyMs).toBe(2)
    expect(mapProfileTimeBounds(result, 1050000)).toEqual({
      lowerMs: 49,
      upperMs: 51,
      exact: false,
      source: 'start-end-marker-envelope'
    })
    expect(mapProfileTimeBounds(result, 1000000)).toBeNull()
  })
  it('refuses missing, delayed, mismatched and tampered marker evidence', () => {
    const f = fixture()
    expect(calibrateMainProfile({}, f.markers).qualified).toBe(false)
    expect(calibrateMainProfile(f.profile, []).qualified).toBe(false)
    for (const changes of [
      { identity: 'foreign' },
      { beforeMs: NaN },
      { afterMs: 200 },
      { source: 'tampered' },
      { tag: 'not_sampled' }
    ]) {
      const markers = [f.markers[0], { ...f.markers[1], ...changes }]
      expect(calibrateMainProfile(f.profile, markers).qualified).toBe(false)
    }
    expect(
      calibrateMainProfile({ ...f.profile, timeDeltas: [NaN, 1, 1, 1] }, f.markers).qualified
    ).toBe(false)
  })
  it('bounds unsupported and stalled live evaluation', async () => {
    await expect(
      captureProfileMarker({ post: async () => ({ exceptionDetails: {} }) }, { windowId: 'w' })
    ).rejects.toThrow('unsupported')
    await expect(
      captureProfileMarker({ post: () => new Promise(() => {}) }, { windowId: 'w', timeoutMs: 1 })
    ).rejects.toMatchObject({ code: 'CAPTURE_TIMEOUT' })
  })
})
