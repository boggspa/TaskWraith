'use strict'

// Frame rules are intentionally path-qualified: generic fsync/append/commit
// names alone cannot prove an owner or an exemption. Unrecognized work remains
// visible as unattributed sampled time, never certified as absent.
const RULES = [
  ['s6_materialize', 'owner', 'HostChatCompatibilityPersistence', ['materialize']],
  [
    's6_transfer',
    'owner',
    'HostThreadRecordTransfer',
    [
      'publish',
      'publishHostThreadRecordTransfer',
      'publishHostThreadRecordTransferOffLoop',
      'canCloneRecord',
      'postMessage'
    ]
  ],
  ['s7_run_event', 'owner', 'RunEventLedgerWriter', ['append']],
  [
    's7_journal',
    'owner',
    'IncrementalChatJournal',
    ['appendLine', 'appendLineDeferred', 'checkpoint', 'replay', 'parseJournal']
  ],
  ['s7_detail_checkpoint', 'owner', 'store/index', ['persistDetailCheckpoint']],
  ['s7_detail_batch', 'owner', 'ToolActivityDetailLedger', ['commit']],
  ['s7c_catalogue', 'owner', 'ThreadCatalogue', ['beginPublication', 'settleBurst']],
  ['mutation_derivation', 'residual', 'ChatRecordMutation', ['deriveChatRecordMutation']],
  [
    'conflict_recovery',
    'residual',
    'store/index',
    ['recoverConflict', 'recoverHostPersistConflict']
  ],
  [
    'conflict_reanchor',
    'residual',
    'IncrementalChatPersistence',
    ['replaceAuthoritative', 'replaceAuthoritativeCheckpoint']
  ],
  ['shadow_reparse', 'residual', 'store/index', ['readChatRecordCached']]
]

function fail(message) {
  throw new Error('X2 attribution refused: ' + message)
}
function number(value, name) {
  if (!Number.isFinite(value)) fail(name)
  return value
}
function union(intervals) {
  const result = []
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    if (end <= start) continue
    const last = result[result.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else result.push([start, end])
  }
  return result
}
function duration(intervals) {
  return union(intervals).reduce((sum, [a, b]) => sum + b - a, 0)
}

/** Adapter for MainLoopGapRecorder snapshots. Identity is supplied by the
 * labelled-window runner; monotonic clock provenance must be recorded there.
 * The recorder's default Date.now is not eligible for this conversion.
 */
function normalizeMainLoopGapSnapshot(snapshot, identity) {
  if (!snapshot || identity?.clockKind !== 'monotonic' || !identity.windowId || !identity.clockId)
    fail('missing monotonic recorder provenance')
  if (
    snapshot.intervalMs !== 5 ||
    snapshot.thresholdMs !== 25 ||
    snapshot.dropped !== 0 ||
    snapshot.censored !== false ||
    !Array.isArray(snapshot.reasons) ||
    snapshot.reasons.length ||
    snapshot.suspensionProtection?.heldThroughout !== true ||
    !Array.isArray(snapshot.gaps)
  )
    fail('incomplete native gap snapshot')
  const recordedBlocked = snapshot.gaps.reduce((sum, row) => sum + row.durationMs, 0)
  if (!Number.isFinite(snapshot.blockedMs) || snapshot.blockedMs !== recordedBlocked)
    fail('truncated native gap evidence')
  return {
    windowId: identity.windowId,
    clockId: identity.clockId,
    startMs: snapshot.startedAtMs,
    endMs: snapshot.endedAtMs,
    durationMs: snapshot.observedForMs,
    overflow: false,
    complete: true,
    powerSaveBlockerActive: true,
    entries: snapshot.gaps.map((row) => ({
      expectedFireMs: row.expectedAtMs,
      observedFireMs: row.observedAtMs,
      delayMs: row.durationMs
    }))
  }
}

/** Schema v1. All timestamps use explicit clockId and milliseconds, except
 * inspector profile timestamps/deltas, which are microseconds. Anchor is a
 * measured simultaneous {profileUs, monotonicMs}; never infer it from wall time.
 * Exemptions require timestamped main instrumentation, not stack guesses.
 */
function attributeMainGapProfile(input) {
  const { window, gaps, profile, anchor, exemptions = [], limits = {} } = input ?? {}
  const maxNodes = limits.maxNodes ?? 100000,
    maxSamples = limits.maxSamples ?? 2000000
  const maxGaps = limits.maxGaps ?? 20000,
    maxEvidence = limits.maxEvidence ?? 100000,
    maxDepth = limits.maxDepth ?? 256
  for (const bound of [maxNodes, maxSamples, maxGaps, maxEvidence, maxDepth])
    if (!Number.isSafeInteger(bound) || bound < 1) fail('invalid bounds')
  if (!window || !gaps || !profile || !anchor) fail('missing inputs')
  if (
    typeof window.id !== 'string' ||
    !window.id ||
    typeof window.clockId !== 'string' ||
    !window.clockId
  )
    fail('window identity')
  const start = number(window.startMs, 'window start'),
    end = number(window.endMs, 'window end')
  if (end <= start || window.durationMs !== end - start) fail('window duration')
  if (
    gaps.windowId !== window.id ||
    gaps.clockId !== window.clockId ||
    gaps.startMs !== start ||
    gaps.endMs !== end ||
    gaps.durationMs !== window.durationMs
  )
    fail('gap window identity/duration')
  if (gaps.overflow !== false || gaps.complete !== true || gaps.powerSaveBlockerActive !== true)
    fail('gap coverage/overflow/power assertion')
  if (anchor.clockId !== window.clockId || anchor.windowId !== window.id) fail('anchor identity')
  number(anchor.profileUs, 'profile anchor')
  number(anchor.monotonicMs, 'monotonic anchor')
  if (
    !Array.isArray(profile.nodes) ||
    !Array.isArray(profile.samples) ||
    !Array.isArray(profile.timeDeltas) ||
    !Array.isArray(gaps.entries)
  )
    fail('missing arrays')
  if (
    profile.nodes.length > maxNodes ||
    profile.samples.length > maxSamples ||
    gaps.entries.length > maxGaps ||
    exemptions.length > maxEvidence
  )
    fail('input overflow')
  if (!profile.samples.length || profile.samples.length !== profile.timeDeltas.length)
    fail('missing/truncated samples')
  const pstart = number(profile.startTime, 'profile start'),
    pend = number(profile.endTime, 'profile end')
  const convert = (us) => anchor.monotonicMs + (us - anchor.profileUs) / 1000
  if (pend <= pstart || convert(pstart) > start || convert(pend) < end)
    fail('profile does not cover window')
  const nodes = new Map(),
    parents = new Map()
  for (const node of profile.nodes) {
    if (
      !Number.isSafeInteger(node.id) ||
      nodes.has(node.id) ||
      !node.callFrame ||
      typeof node.callFrame.functionName !== 'string' ||
      typeof node.callFrame.url !== 'string'
    )
      fail('malformed node')
    nodes.set(node.id, node)
  }
  for (const node of profile.nodes) {
    if (node.children !== undefined && !Array.isArray(node.children)) fail('malformed children')
    for (const child of node.children ?? []) {
      if (!nodes.has(child) || parents.has(child)) fail('malformed tree')
      parents.set(child, node.id)
    }
  }
  const stacks = new Map()
  if ([...nodes.keys()].filter((id) => !parents.has(id)).length !== 1)
    fail('disconnected profile tree')
  for (const node of nodes.values()) {
    const seen = new Set(),
      frames = []
    let id = node.id
    while (id !== undefined) {
      if (seen.has(id)) fail('cyclic tree')
      if (seen.size >= maxDepth) fail('stack overflow')
      seen.add(id)
      frames.push(nodes.get(id).callFrame)
      id = parents.get(id)
    }
    stacks.set(node.id, frames)
  }
  const gapIntervals = []
  for (const entry of gaps.entries) {
    const a = number(entry.expectedFireMs, 'gap expected'),
      b = number(entry.observedFireMs, 'gap observed')
    if (a < start || b > end || b - a < 25 || entry.delayMs !== b - a) fail('malformed gap')
    gapIntervals.push([a, b])
  }
  const mergedGaps = union(gapIntervals)
  const allowed = new Set([
    'd2_d3',
    'strict_run_event',
    'sync_dependency',
    'baseline_verify',
    'in_memory_fallback',
    'in_memory_conflict',
    'in_memory_oversize',
    'catalogue_pre_i5'
  ])
  const exemptionOwners = {
    d2_d3: ['s7_journal'],
    strict_run_event: ['s7_run_event'],
    sync_dependency: ['s7_journal', 's7_run_event', 's7_detail_batch', 's7c_catalogue'],
    baseline_verify: ['s7_journal'],
    in_memory_fallback: ['s6_materialize', 's6_transfer'],
    in_memory_conflict: ['s6_materialize', 's6_transfer'],
    in_memory_oversize: ['s6_materialize', 's6_transfer'],
    catalogue_pre_i5: ['s7c_catalogue']
  }
  for (const exemption of exemptions) {
    if (
      exemption.windowId !== window.id ||
      exemption.clockId !== window.clockId ||
      !allowed.has(exemption.reason) ||
      !RULES.some((rule) => rule[0] === exemption.owner && rule[1] === 'owner')
    )
      fail('invalid exemption')
    if (!exemptionOwners[exemption.reason].includes(exemption.owner))
      fail('exemption owner mismatch')
    if (
      number(exemption.startMs, 'exemption start') < start ||
      number(exemption.endMs, 'exemption end') > end ||
      exemption.endMs <= exemption.startMs
    )
      fail('exemption interval')
  }
  const unresolved = [],
    totals = {},
    evidence = [],
    nonExempt = [],
    listed = [],
    covered = []
  let time = pstart,
    maxSampleMs = 0,
    firstGap = 0,
    work = 0
  const maxWork = limits.maxWork ?? 10000000
  if (!Number.isSafeInteger(maxWork) || maxWork < 1) fail('invalid work bound')
  for (let index = 0; index < profile.samples.length; index++) {
    const delta = profile.timeDeltas[index],
      sample = profile.samples[index]
    if (!Number.isFinite(delta) || delta <= 0 || !stacks.has(sample)) fail('malformed sample')
    const next = time + delta
    if (next > pend + 1) fail('sample beyond profile')
    const a = Math.max(start, convert(time)),
      b = Math.min(end, convert(next))
    time = next
    if (b <= a) continue
    covered.push([a, b])
    maxSampleMs = Math.max(maxSampleMs, b - a)
    const frames = stacks.get(sample),
      matches = new Map()
    const fsyncFrame = frames.some((frame) => /^fsync(?:Sync)?$/.test(frame.functionName))
    for (const [owner, kind, file, names] of RULES)
      if (
        frames.some(
          (frame) =>
            frame.url.replaceAll('\\', '/').includes(file) && names.includes(frame.functionName)
        )
      ) {
        if (owner === 's7_run_event' && !fsyncFrame) continue
        if (
          owner === 's7_journal' &&
          frames.some((frame) =>
            ['appendLine', 'appendLineDeferred'].includes(frame.functionName)
          ) &&
          !fsyncFrame
        )
          continue
        matches.set(owner, kind)
      }
    while (firstGap < mergedGaps.length && mergedGaps[firstGap][1] <= a) firstGap++
    for (
      let gapIndex = firstGap;
      gapIndex < mergedGaps.length && mergedGaps[gapIndex][0] < b;
      gapIndex++
    ) {
      work += 1 + matches.size + exemptions.length * Math.max(1, matches.size) * 3
      if (work > maxWork) fail('attribution work overflow')
      const lo = Math.max(a, mergedGaps[gapIndex][0]),
        hi = Math.min(b, mergedGaps[gapIndex][1])
      if (hi <= lo) continue
      const bundled = frames.some((frame) =>
        /(?:^|\/)out\/main\//.test(frame.url.replaceAll('\\', '/'))
      )
      const ownerMatched = [...matches.values()].some((kind) => kind === 'owner')
      if (bundled || !ownerMatched) {
        if (unresolved.length >= maxEvidence) fail('unresolved evidence overflow')
        unresolved.push({
          gapIndex,
          sampleIndex: index,
          nodeId: sample,
          startMs: lo,
          endMs: hi,
          reason: bundled
            ? 'bundled_source_mapping_unavailable'
            : matches.size
              ? 'residual_only_owner_absence_unproven'
              : 'unattributed_owner_absence_unproven',
          frameSources: frames.map((frame) => ({
            functionName: frame.functionName,
            url: frame.url
          }))
        })
      }
      if (!matches.size) {
        totals.unattributedMs = (totals.unattributedMs ?? 0) + hi - lo
        continue
      }
      for (const [owner, kind] of matches) {
        const cuts = [lo, hi]
        for (const ex of exemptions)
          if (ex.owner === owner && ex.startMs < hi && ex.endMs > lo)
            cuts.push(Math.max(lo, ex.startMs), Math.min(hi, ex.endMs))
        cuts.sort((x, y) => x - y)
        for (let part = 1; part < cuts.length; part++) {
          const from = cuts[part - 1],
            to = cuts[part]
          if (to <= from) continue
          const reasons = [
            ...new Set(
              exemptions
                .filter((ex) => ex.owner === owner && ex.startMs <= from && ex.endMs >= to)
                .map((ex) => ex.reason)
            )
          ]
          const exempt = reasons.length > 0
          totals[owner] ??= { kind, sampledMs: 0, exemptMs: 0, nonExemptMs: 0 }
          totals[owner].sampledMs += to - from
          totals[owner][exempt ? 'exemptMs' : 'nonExemptMs'] += to - from
          if (kind === 'owner') {
            listed.push([from, to])
            if (!exempt) nonExempt.push([from, to])
          }
          if (evidence.length >= maxEvidence) fail('evidence overflow')
          evidence.push({
            gapIndex,
            sampleIndex: index,
            nodeId: sample,
            owner,
            kind,
            startMs: from,
            endMs: to,
            exemptionReasons: reasons
          })
        }
      }
    }
  }
  if (Math.abs(time - pend) > 1 || duration(covered) !== end - start)
    fail('truncated profile/sample coverage')
  const nonExemptOwnerGaps = [
    ...new Set(
      evidence
        .filter((row) => row.kind === 'owner' && !row.exemptionReasons.length)
        .map((row) => row.gapIndex)
    )
  ]
  return {
    schemaVersion: 1,
    window: { ...window },
    coverage: {
      profileStartMs: convert(pstart),
      profileEndMs: convert(pend),
      sampledWindowMs: duration(covered),
      complete: true
    },
    gaps: mergedGaps.map(([expectedFireMs, observedFireMs]) => ({
      expectedFireMs,
      observedFireMs,
      delayMs: observedFireMs - expectedFireMs
    })),
    recordedGapEntries: gaps.entries.map((row) => ({ ...row })),
    blockedMs: duration(mergedGaps),
    listedOwnerMs: duration(listed),
    nonExemptOwnerMs: duration(nonExempt),
    nonExemptOwnerGaps,
    ownerAbsenceProven: unresolved.length === 0 && nonExemptOwnerGaps.length === 0,
    attributionEligible: unresolved.length === 0,
    censored: unresolved.length > 0,
    unresolvedAttribution: unresolved,
    totals,
    evidence,
    sampling: {
      maxSampleMs,
      limitation:
        'Sample intervals attribute estimated CPU residency; unsampled frames and sub-sample work cannot be proven absent. No wall-time fsync attribution inferred.'
    }
  }
}

module.exports = { attributeMainGapProfile, normalizeMainLoopGapSnapshot, RULES }
