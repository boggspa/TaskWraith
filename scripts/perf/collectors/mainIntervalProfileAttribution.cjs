'use strict'
const { mapProfileIntervalBounds } = require('./mainProfileCalibration.cjs')
const { RULES, normalizeMainLoopGapSnapshot } = require('./mainGapProfileAttribution.cjs')
const fail = (reason) => {
  throw new Error('Interval attribution refused: ' + reason)
}
const union = (rows) => {
  const result = []
  for (const row of rows.sort((a, b) => a[0] - b[0])) {
    if (row[1] <= row[0]) continue
    const last = result[result.length - 1]
    if (last && row[0] <= last[1]) last[1] = Math.max(last[1], row[1])
    else result.push([...row])
  }
  return result
}
const sum = (rows) => union(rows).reduce((n, [a, b]) => n + b - a, 0)
const clip = (a, b, c, d) => [Math.max(a, c), Math.min(b, d)]
const subtract = (range, exclusions) => {
  let rows = range[1] > range[0] ? [range] : []
  for (const [a, b] of union(exclusions))
    rows = rows.flatMap(([lo, hi]) =>
      a >= hi || b <= lo
        ? [[lo, hi]]
        : [
            [lo, Math.min(hi, a)],
            [Math.max(lo, b), hi]
          ].filter(([x, y]) => y > x)
    )
  return rows
}

/** Sample CPU residency is bounded with marker envelopes, never point-anchored.
 * Required source provenance is the reviewed resolver output, with original
 * positions and artifact digests carried through each interval's evidence.
 * Unknown or boundary-ambiguous attribution is censored, not zero-filled.
 */
function attributeMainIntervalProfile({
  window,
  clock,
  calibration,
  profile,
  sourceProvenance,
  gapSnapshot,
  exemptions,
  limits = {}
}) {
  const maxSamples = limits.maxSamples ?? 2000000,
    maxEvidence = limits.maxEvidence ?? 100000,
    maxDepth = limits.maxDepth ?? 256,
    maxGaps = limits.maxGaps ?? 20000
  const maxWork = limits.maxWork ?? 10000000
  if (!Number.isSafeInteger(maxWork) || maxWork < 1) fail('work bound')
  let work = 0
  if (![maxSamples, maxEvidence, maxDepth, maxGaps].every((n) => Number.isSafeInteger(n) && n > 0))
    fail('bounds')
  const charge = (amount = 1) => {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > maxWork - work)
      fail('work overflow')
    work += amount
  }
  const appendEvidence = (rows, value) => {
    if (rows.length >= maxEvidence) fail('evidence overflow')
    rows.push(value)
  }
  if (!Array.isArray(gapSnapshot?.gaps) || gapSnapshot.gaps.length > maxGaps) fail('gap overflow')
  if (
    !window ||
    typeof window.id !== 'string' ||
    !Number.isFinite(window.startMs) ||
    !Number.isFinite(window.endMs) ||
    window.endMs <= window.startMs ||
    window.durationMs !== window.endMs - window.startMs
  )
    fail('window')
  const anchor = calibration?.anchors?.[0]
  if (
    !anchor ||
    calibration.exact !== false ||
    clock?.clockId !== 'node.performance.now' ||
    clock.provenance !== 'node-performance-now' ||
    clock.identity !== anchor.identity ||
    clock.pid !== anchor.pid ||
    clock.timeOrigin !== anchor.timeOrigin ||
    window.clockId !== clock.clockId ||
    anchor.windowId !== window.id ||
    calibration.anchors.some((a) => a.windowId !== window.id)
  )
    fail('clock/window identity')
  if (
    !sourceProvenance?.complete ||
    !Array.isArray(sourceProvenance.evidence) ||
    !/^[a-f0-9]{40}$/.test(sourceProvenance.buildCommitSha) ||
    !/^[a-f0-9]{64}$/.test(sourceProvenance.sourceManifestSha256)
  )
    fail('source provenance')
  if (
    !Array.isArray(profile?.nodes) ||
    !Array.isArray(profile.samples) ||
    !Array.isArray(profile.timeDeltas) ||
    profile.samples.length !== profile.timeDeltas.length ||
    !profile.samples.length ||
    profile.samples.length > maxSamples ||
    profile.nodes.length > 100000
  )
    fail('profile')
  if (
    !exemptions ||
    exemptions.complete !== true ||
    !Array.isArray(exemptions.entries) ||
    exemptions.entries.length > maxEvidence
  )
    fail('timestamped exemption support absent/overflow')
  const allowed = {
    d2_d3: ['s7_journal'],
    strict_run_event: ['s7_run_event'],
    sync_dependency: ['s7_journal', 's7_run_event', 's7_detail_batch', 's7c_catalogue'],
    baseline_verify: ['s7_journal'],
    in_memory_fallback: ['s6_materialize', 's6_transfer'],
    in_memory_conflict: ['s6_materialize', 's6_transfer'],
    in_memory_oversize: ['s6_materialize', 's6_transfer'],
    catalogue_pre_i5: ['s7c_catalogue']
  }
  for (const ex of exemptions.entries)
    if (
      ex.windowId !== window.id ||
      ex.clockId !== clock.clockId ||
      !allowed[ex.reason]?.includes(ex.owner) ||
      !Number.isFinite(ex.startMs) ||
      !Number.isFinite(ex.endMs) ||
      ex.startMs < window.startMs ||
      ex.endMs > window.endMs ||
      ex.endMs <= ex.startMs
    )
      fail('exemption identity/bounds')
  const gaps = normalizeMainLoopGapSnapshot(gapSnapshot, {
    windowId: window.id,
    clockId: clock.clockId,
    clockKind: 'monotonic'
  })
  if (
    gaps.startMs !== window.startMs ||
    gaps.endMs !== window.endMs ||
    gaps.durationMs !== window.durationMs
  )
    fail('gap identity/duration')
  const gapRanges = union(gaps.entries.map((g) => [g.expectedFireMs, g.observedFireMs]))
  for (const gap of gaps.entries)
    if (
      !Number.isFinite(gap.expectedFireMs) ||
      !Number.isFinite(gap.observedFireMs) ||
      gap.expectedFireMs < window.startMs ||
      gap.observedFireMs > window.endMs ||
      gap.delayMs !== gap.observedFireMs - gap.expectedFireMs ||
      gap.delayMs < 25
    )
      fail('gap bounds')
  const nodes = new Map(),
    parents = new Map(),
    provenance = new Map()
  for (const row of sourceProvenance.evidence) {
    if (
      provenance.has(row.nodeId) ||
      ![row.sourceSha256, row.bundleSha256, row.mapSha256, row.captureManifestSha256].every((d) =>
        /^[a-f0-9]{64}$/.test(d)
      ) ||
      row.buildCommitSha !== sourceProvenance.buildCommitSha ||
      row.sourceManifestSha256 !== sourceProvenance.sourceManifestSha256
    )
      fail('source digest/identity')
    provenance.set(row.nodeId, row)
  }
  for (const node of profile.nodes) {
    if (
      !Number.isSafeInteger(node.id) ||
      nodes.has(node.id) ||
      !node.callFrame ||
      typeof node.callFrame.url !== 'string'
    )
      fail('nodes')
    nodes.set(node.id, node)
  }
  for (const node of nodes.values())
    if (node.children !== undefined && !Array.isArray(node.children)) fail('children')
  for (const node of nodes.values())
    for (const child of node.children ?? []) {
      if (!nodes.has(child) || parents.has(child)) fail('tree')
      parents.set(child, node.id)
    }
  const intervals = [],
    coverageLower = [],
    coverageUpper = [],
    ownerLower = [],
    ownerUpper = [],
    unresolved = [],
    ownerTotals = {}
  const blocks = []
  let time = profile.startTime
  if (!Number.isFinite(time) || !Number.isFinite(profile.endTime)) fail('profile clock')
  for (let index = 0; index < profile.samples.length; index++) {
    charge()
    const delta = profile.timeDeltas[index],
      id = profile.samples[index]
    if (!Number.isFinite(delta) || delta <= 0 || !nodes.has(id)) fail('sample')
    const next = time + delta,
      bounds = mapProfileIntervalBounds(calibration, time, next)
    if (!bounds) {
      // Only measured marker/prefix/suffix intervals wholly outside the
      // workload may be omitted. Anything plausibly inside is censored.
      const offsets = calibration.anchors.map((a) => [a.offsetLowerMs, a.offsetUpperMs]).flat()
      const lo = time / 1000 + Math.min(...offsets),
        hi = next / 1000 + Math.max(...offsets)
      if (lo < window.endMs && hi > window.startMs)
        appendEvidence(unresolved, {
          sampleIndex: index,
          reason: 'unmapped_or_marker_interval_overlaps_workload',
          profileFromUs: time,
          profileToUs: next
        })
      time = next
      continue
    }
    time = next
    const lastBlock = blocks[blocks.length - 1]
    if (lastBlock && lastBlock.toUs === next - delta) {
      lastBlock.toUs = next
      lastBlock.to = bounds.to
    } else blocks.push({ fromUs: next - delta, toUs: next, from: bounds.from, to: bounds.to })
    const possible = clip(bounds.from.lowerMs, bounds.to.upperMs, window.startMs, window.endMs)
    const certain = clip(bounds.from.upperMs, bounds.to.lowerMs, window.startMs, window.endMs)
    if (possible[1] <= possible[0]) continue
    coverageUpper.push(possible)
    coverageLower.push(certain)
    const seen = new Set(),
      frames = [],
      sources = []
    let cursor = id
    while (cursor !== undefined) {
      if (seen.has(cursor) || seen.size >= maxDepth) fail('stack cycle/depth')
      seen.add(cursor)
      const frame = nodes.get(cursor).callFrame
      frames.push(frame)
      if (frame.url.startsWith('frozen-source:///')) {
        const p = provenance.get(cursor)
        if (!p || JSON.stringify(p.resolvedFrame) !== JSON.stringify(frame))
          fail('unbound resolved frame')
        sources.push(p)
      } else if (frame.url && !frame.url.startsWith('node:') && !frame.url.startsWith('native '))
        sources.push({ unmapped: true, url: frame.url })
      cursor = parents.get(cursor)
    }
    const owners = [
      ...new Set(
        RULES.filter(
          ([, kind, file, names]) =>
            kind === 'owner' &&
            (file !== 'RunEventLedgerWriter' ||
              frames.some((f) => /^fsync(?:Sync)?$/.test(f.functionName))) &&
            frames.some((f) => f.url.includes(file) && names.includes(f.functionName))
        ).map((r) => r[0])
      )
    ]
    const unknown = sources.some((s) => s.unmapped) || !owners.length
    const residuals = RULES.filter(
      ([, kind, file, names]) =>
        kind === 'residual' &&
        frames.some((f) => f.url.includes(file) && names.includes(f.functionName))
    ).map((rule) => rule[0])
    if (sources.some((s) => s.unmapped))
      appendEvidence(unresolved, {
        sampleIndex: index,
        reason: 'source_coverage_incomplete',
        bounds
      })
    for (let gapIndex = 0; gapIndex < gapRanges.length; gapIndex++) {
      charge()
      const upper = clip(possible[0], possible[1], ...gapRanges[gapIndex]),
        lower = clip(certain[0], certain[1], ...gapRanges[gapIndex])
      if (upper[1] <= upper[0]) continue
      charge(owners.length * Math.max(1, exemptions.entries.length))
      if (intervals.length >= maxEvidence || unresolved.length >= maxEvidence)
        fail('evidence overflow')
      const ambiguous = lower[1] <= lower[0] || lower[0] !== upper[0] || lower[1] !== upper[1]
      if (unknown || ambiguous)
        appendEvidence(unresolved, {
          sampleIndex: index,
          gapIndex,
          reason: unknown ? 'unknown_or_residual_only_stack' : 'boundary_ambiguous_sample',
          bounds
        })
      if (!unknown) {
        for (const owner of owners) {
          const exclusions = exemptions.entries
            .filter((ex) => ex.owner === owner)
            .map((ex) => [ex.startMs, ex.endMs])
          const lowerRows = subtract(lower, exclusions),
            upperRows = subtract(upper, exclusions)
          ownerUpper.push(...upperRows)
          ownerLower.push(...lowerRows)
          ownerTotals[owner] ??= { lower: [], upper: [] }
          ownerTotals[owner].lower.push(...lowerRows)
          ownerTotals[owner].upper.push(...upperRows)
        }
      }
      appendEvidence(intervals, {
        sampleIndex: index,
        nodeId: id,
        gapIndex,
        profileFromUs: next - delta,
        profileToUs: next,
        bounds,
        clippedOverlap: { lowerMs: Math.max(0, lower[1] - lower[0]), upperMs: upper[1] - upper[0] },
        owners,
        residuals,
        sourceEvidence: sources,
        exact: false
      })
    }
  }
  if (Math.abs(time - profile.endTime) > 1) fail('truncated profile')
  const coverageMs = {
    lower: sum(blocks.map((b) => clip(b.from.upperMs, b.to.lowerMs, window.startMs, window.endMs))),
    upper: sum(coverageUpper)
  }
  const complete = coverageMs.lower >= window.durationMs
  if (!complete)
    appendEvidence(unresolved, { reason: 'workload_timestamp_coverage_incomplete', coverageMs })
  const eligible = complete && !unresolved.length
  return {
    schemaVersion: 1,
    exact: false,
    window: { ...window },
    clock: { ...clock },
    calibration,
    sourceProvenance,
    exemptions,
    recordedGapEntries: gaps.entries.map((row) => ({ ...row })),
    coverage: { complete, sampledWindowMsBounds: coverageMs },
    gaps: gapRanges.map(([startMs, endMs]) => ({ startMs, endMs })),
    blockedMsBounds: { lower: sum(gapRanges), upper: sum(gapRanges) },
    listedOwnerMsBounds: { lower: sum(ownerLower), upper: sum(ownerUpper) },
    ownerTotals: Object.fromEntries(
      Object.entries(ownerTotals).map(([owner, r]) => [
        owner,
        { lower: sum(r.lower), upper: sum(r.upper) }
      ])
    ),
    intervals,
    unresolvedAttribution: unresolved,
    attributionEligible: eligible,
    censored: !eligible,
    ownerAbsenceProven: eligible && ownerUpper.length === 0,
    samplingLimitations:
      'Conservative marker-envelope CPU sample overlap only; no exact scalar or absence of unsampled work is certified.'
  }
}
module.exports = { attributeMainIntervalProfile }
