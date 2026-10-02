'use strict'

const { randomBytes, createHash } = require('node:crypto')
const { awaitWithTimeout } = require('../boundedAwait.cjs')

/** A unique source function gives CPU samples an observable marker. Reads
 * bracket its execution in the measured process, not the runner. */
async function captureProfileMarker(session, options) {
  const tag = `tw_calibration_${randomBytes(12).toString('hex')}`
  const durationMs = options.durationMs ?? 8
  if (!Number.isFinite(durationMs) || durationMs < 2 || durationMs > 50)
    throw new Error('invalid marker duration')
  const source = `(function(){
    const { performance } = require('node:perf_hooks');
    const beforeMs = performance.now();
    (function ${tag}(){ while (performance.now() - beforeMs < ${durationMs}) {} })();
    const afterMs = performance.now();
    return { tag: ${JSON.stringify(tag)}, beforeMs, afterMs, pid: process.pid,
      clockId: 'node.performance.now', timeOrigin: performance.timeOrigin,
      identity: 'main:' + process.pid + ':performance.timeOrigin:' + performance.timeOrigin };
  })()\n//# sourceURL=taskwraith-calibration-${tag}.js`
  const result = await awaitWithTimeout(
    session.post('Runtime.evaluate', {
      expression: source,
      returnByValue: true
    }),
    options.timeoutMs ?? 1000,
    'profile calibration marker'
  )
  if (result?.exceptionDetails || !result?.result?.value)
    throw new Error('marker evaluation unsupported')
  return {
    ...result.result.value,
    source,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    windowId: options.windowId
  }
}

/** Bounds, not an assertion that V8 and Node clocks share an epoch. Any
 * observed marker sample occurred somewhere inside its measured bracket. */
function calibrateMainProfile(profile, markers, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    return { qualified: false, reasons: ['invalid_calibration_options'], exact: false }
  const reasons = []
  const refuse = (reason) => {
    reasons.push(reason)
  }
  const anchors = []
  if (
    !profile ||
    !Array.isArray(profile.nodes) ||
    !Array.isArray(profile.samples) ||
    !Array.isArray(profile.timeDeltas) ||
    profile.samples.length !== profile.timeDeltas.length ||
    !Number.isFinite(profile.startTime) ||
    !Number.isFinite(profile.endTime) ||
    profile.startTime < 0 ||
    profile.endTime <= profile.startTime ||
    profile.nodes.length === 0 ||
    profile.nodes.some(
      (node) =>
        !node ||
        !Number.isSafeInteger(node.id) ||
        node.id < 1 ||
        !node.callFrame ||
        typeof node.callFrame !== 'object' ||
        typeof node.callFrame.functionName !== 'string' ||
        typeof node.callFrame.url !== 'string' ||
        (node.children !== undefined && !Array.isArray(node.children))
    )
  ) {
    return {
      qualified: false,
      reasons: ['malformed_profile'],
      anchors,
      markers,
      offsetBoundsMs: null
    }
  }
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const invalid = (reason) => ({
    qualified: false,
    reasons: [reason],
    anchors,
    markers,
    offsetBoundsMs: null,
    markerExclusions: [],
    exact: false
  })
  if (nodes.size !== profile.nodes.length) return invalid('duplicate_profile_node')
  const parents = new Map()
  for (const node of profile.nodes)
    for (const child of node.children ?? []) {
      if (!nodes.has(child) || parents.has(child)) return invalid('invalid_profile_child')
      parents.set(child, node.id)
    }
  if (profile.nodes.filter((node) => !parents.has(node.id)).length !== 1)
    return invalid('invalid_profile_root')
  for (const node of profile.nodes) {
    const seen = new Set()
    let id = node.id
    while (id !== undefined) {
      if (seen.has(id)) return invalid('cyclic_profile_tree')
      seen.add(id)
      id = parents.get(id)
    }
  }
  if (profile.samples.some((id) => !Number.isSafeInteger(id) || !nodes.has(id)))
    return invalid('unknown_profile_sample')
  let cursor = profile.startTime
  const samples = []
  for (let i = 0; i < profile.samples.length; i++) {
    const delta = profile.timeDeltas[i]
    if (!Number.isFinite(delta) || delta < 0) {
      refuse('invalid_profile_delta')
      break
    }
    cursor += delta
    if (cursor > profile.endTime) refuse('profile_sample_outside_bounds')
    samples.push({ node: nodes.get(profile.samples[i]), profileUs: cursor })
  }
  if (!Array.isArray(markers) || markers.length !== 2) refuse('start_end_markers_required')
  else
    for (const marker of markers) {
      if (
        !marker ||
        !Number.isSafeInteger(marker.pid) ||
        marker.pid < 1 ||
        marker.clockId !== 'node.performance.now' ||
        !Number.isFinite(marker.timeOrigin) ||
        marker.identity !== `main:${marker.pid}:performance.timeOrigin:${marker.timeOrigin}` ||
        ![marker.beforeMs, marker.afterMs].every((value) => Number.isFinite(value) && value >= 0) ||
        marker.afterMs <= marker.beforeMs ||
        typeof marker.source !== 'string' ||
        marker.sourceSha256 !== createHash('sha256').update(marker.source).digest('hex')
      ) {
        refuse('invalid_marker_provenance')
        continue
      }
      const hits = samples.filter((sample) => {
        let node = sample.node
        const seen = new Set()
        while (node && !seen.has(node.id)) {
          seen.add(node.id)
          if (
            node.callFrame?.functionName === marker.tag &&
            node.callFrame.url === `taskwraith-calibration-${marker.tag}.js`
          )
            return true
          node = nodes.get(parents.get(node.id))
        }
        return false
      })
      if (!hits.length) {
        refuse('marker_missing_from_profile')
        continue
      }
      const firstUs = hits[0].profileUs,
        lastUs = hits[hits.length - 1].profileUs
      const lowerMs = marker.beforeMs - firstUs / 1000
      const upperMs = marker.afterMs - lastUs / 1000
      anchors.push({
        windowId: marker.windowId,
        clockId: marker.clockId,
        identity: marker.identity,
        pid: marker.pid,
        timeOrigin: marker.timeOrigin,
        profileFirstUs: firstUs,
        profileLastUs: lastUs,
        monotonicBeforeMs: marker.beforeMs,
        monotonicAfterMs: marker.afterMs,
        offsetLowerMs: lowerMs,
        offsetUpperMs: upperMs,
        uncertaintyMs: upperMs - lowerMs,
        sampleCount: hits.length,
        sourceSha256: marker.sourceSha256
      })
    }
  let offsetBoundsMs = null
  let driftBoundsMs = null
  const markerExclusions = []
  if (anchors.length === 2) {
    const [start, end] = anchors
    const envelopeLower = Math.min(start.offsetLowerMs, end.offsetLowerMs)
    const envelopeUpper = Math.max(start.offsetUpperMs, end.offsetUpperMs)
    for (const anchor of anchors)
      markerExclusions.push({
        profileLowerUs: (anchor.monotonicBeforeMs - envelopeUpper) * 1000,
        profileUpperUs: (anchor.monotonicAfterMs - envelopeLower) * 1000,
        monotonicBeforeMs: anchor.monotonicBeforeMs,
        monotonicAfterMs: anchor.monotonicAfterMs,
        sourceSha256: anchor.sourceSha256,
        boundaryInclusive: true
      })
    driftBoundsMs = {
      lower: end.offsetLowerMs - start.offsetUpperMs,
      upper: end.offsetUpperMs - start.offsetLowerMs
    }
    if (start.identity !== end.identity || start.windowId !== end.windowId)
      refuse('marker_identity_mismatch')
    if (
      end.monotonicBeforeMs <= start.monotonicAfterMs ||
      end.profileFirstUs <= start.profileLastUs
    )
      refuse('marker_order_invalid')
    const lower = Math.max(start.offsetLowerMs, end.offsetLowerMs)
    const upper = Math.min(start.offsetUpperMs, end.offsetUpperMs)
    if (lower > upper) refuse('clock_drift_or_disjoint_offsets')
    else offsetBoundsMs = { lower, upper, uncertaintyMs: upper - lower }
    const maximum = options.maximumUncertaintyMs ?? 2
    if (
      !Number.isFinite(maximum) ||
      maximum <= 0 ||
      anchors.some((anchor) => anchor.uncertaintyMs < 0 || anchor.uncertaintyMs > maximum)
    )
      refuse('marker_uncertainty_exceeded')
  } else refuse('anchors_unavailable')
  return {
    schemaVersion: 1,
    qualified: reasons.length === 0,
    reasons,
    anchors,
    markers,
    offsetBoundsMs,
    driftBoundsMs,
    markerExclusions,
    mappingKind: 'measured-interval',
    exact: false
  }
}

/** No exact point is manufactured: consumers must reject boundary-ambiguous
 * overlap, and may not extrapolate beyond the measured calibration markers. */
function mapProfileTimeBounds(calibration, profileUs) {
  if (!validMappingCalibration(calibration)) return null
  if (
    !calibration?.qualified ||
    !Number.isFinite(profileUs) ||
    profileUs <= calibration.anchors[0].profileLastUs ||
    profileUs >= calibration.anchors[1].profileFirstUs ||
    !Array.isArray(calibration.markerExclusions) ||
    calibration.markerExclusions.some(
      (range) => profileUs >= range.profileLowerUs && profileUs <= range.profileUpperUs
    )
  )
    return null
  // Envelope retains both endpoint uncertainties rather than assuming that
  // an unmeasured interior offset equals their intersection.
  const lower = Math.min(...calibration.anchors.map((anchor) => anchor.offsetLowerMs))
  const upper = Math.max(...calibration.anchors.map((anchor) => anchor.offsetUpperMs))
  return {
    lowerMs: profileUs / 1000 + lower,
    upperMs: profileUs / 1000 + upper,
    exact: false,
    source: 'start-end-marker-envelope'
  }
}

function mapProfileIntervalBounds(calibration, fromUs, toUs) {
  if (!validMappingCalibration(calibration)) return null
  if (
    !Number.isFinite(fromUs) ||
    !Number.isFinite(toUs) ||
    toUs <= fromUs ||
    calibration?.markerExclusions?.some(
      (range) => fromUs <= range.profileUpperUs && toUs >= range.profileLowerUs
    )
  )
    return null
  const from = mapProfileTimeBounds(calibration, fromUs)
  const to = mapProfileTimeBounds(calibration, toUs)
  return from && to ? { from, to, exact: false } : null
}

function validMappingCalibration(value) {
  if (
    !value ||
    value.qualified !== true ||
    value.exact !== false ||
    value.mappingKind !== 'measured-interval' ||
    !Array.isArray(value.reasons) ||
    value.reasons.length ||
    !Array.isArray(value.anchors) ||
    value.anchors.length !== 2 ||
    !Array.isArray(value.markers) ||
    value.markers.length !== 2 ||
    !Array.isArray(value.markerExclusions) ||
    value.markerExclusions.length !== 2 ||
    !value.offsetBoundsMs ||
    ![
      value.offsetBoundsMs.lower,
      value.offsetBoundsMs.upper,
      value.offsetBoundsMs.uncertaintyMs
    ].every(Number.isFinite) ||
    value.offsetBoundsMs.lower > value.offsetBoundsMs.upper
  )
    return false
  const finite = (names) => (row) => row && names.every((name) => Number.isFinite(row[name]))
  if (
    !value.anchors.every(
      finite([
        'profileFirstUs',
        'profileLastUs',
        'monotonicBeforeMs',
        'monotonicAfterMs',
        'offsetLowerMs',
        'offsetUpperMs',
        'pid',
        'timeOrigin'
      ])
    ) ||
    !value.markerExclusions.every(
      finite(['profileLowerUs', 'profileUpperUs', 'monotonicBeforeMs', 'monotonicAfterMs'])
    )
  )
    return false
  for (let i = 0; i < 2; i++) {
    const a = value.anchors[i],
      marker = value.markers[i],
      range = value.markerExclusions[i]
    if (
      !marker ||
      a.clockId !== 'node.performance.now' ||
      a.identity !== `main:${a.pid}:performance.timeOrigin:${a.timeOrigin}` ||
      a.pid !== marker.pid ||
      a.timeOrigin !== marker.timeOrigin ||
      a.identity !== marker.identity ||
      a.clockId !== marker.clockId ||
      typeof marker.source !== 'string' ||
      a.sourceSha256 !== marker.sourceSha256 ||
      marker.sourceSha256 !== createHash('sha256').update(marker.source).digest('hex') ||
      a.monotonicBeforeMs !== marker.beforeMs ||
      a.monotonicAfterMs !== marker.afterMs ||
      a.profileFirstUs > a.profileLastUs ||
      a.offsetLowerMs > a.offsetUpperMs ||
      range.profileLowerUs > range.profileUpperUs ||
      range.boundaryInclusive !== true ||
      range.sourceSha256 !== a.sourceSha256 ||
      a.offsetLowerMs !== a.monotonicBeforeMs - a.profileFirstUs / 1000 ||
      a.offsetUpperMs !== a.monotonicAfterMs - a.profileLastUs / 1000 ||
      range.monotonicBeforeMs !== a.monotonicBeforeMs ||
      range.monotonicAfterMs !== a.monotonicAfterMs ||
      range.profileLowerUs !==
        (a.monotonicBeforeMs - Math.max(...value.anchors.map((row) => row.offsetUpperMs))) * 1000 ||
      range.profileUpperUs !==
        (a.monotonicAfterMs - Math.min(...value.anchors.map((row) => row.offsetLowerMs))) * 1000
    )
      return false
  }
  if (
    value.offsetBoundsMs.lower !== Math.max(...value.anchors.map((row) => row.offsetLowerMs)) ||
    value.offsetBoundsMs.upper !== Math.min(...value.anchors.map((row) => row.offsetUpperMs)) ||
    value.offsetBoundsMs.uncertaintyMs !== value.offsetBoundsMs.upper - value.offsetBoundsMs.lower
  )
    return false
  return (
    value.anchors[0].identity === value.anchors[1].identity &&
    value.anchors[0].windowId === value.anchors[1].windowId &&
    value.anchors[0].profileLastUs < value.anchors[1].profileFirstUs
  )
}

module.exports = {
  captureProfileMarker,
  calibrateMainProfile,
  mapProfileTimeBounds,
  mapProfileIntervalBounds
}
