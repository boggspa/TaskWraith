import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const {
  attributeMainGapProfile,
  normalizeMainLoopGapSnapshot
} = require('./mainGapProfileAttribution.cjs')

function fixture() {
  return {
    window: {
      id: 'beside-1',
      clockId: 'main-monotonic-1',
      startMs: 100,
      endMs: 200,
      durationMs: 100
    },
    anchor: {
      windowId: 'beside-1',
      clockId: 'main-monotonic-1',
      profileUs: 1000000,
      monotonicMs: 100
    },
    gaps: {
      windowId: 'beside-1',
      clockId: 'main-monotonic-1',
      startMs: 100,
      endMs: 200,
      durationMs: 100,
      overflow: false,
      complete: true,
      powerSaveBlockerActive: true,
      entries: [{ expectedFireMs: 120, observedFireMs: 180, delayMs: 60 }]
    },
    profile: {
      startTime: 1000000,
      endTime: 1100000,
      nodes: [
        { id: 1, callFrame: { functionName: '(root)', url: '' }, children: [2] },
        {
          id: 2,
          callFrame: { functionName: 'append', url: '/src/main/store/RunEventLedgerWriter.ts' },
          children: [3]
        },
        {
          id: 3,
          callFrame: { functionName: 'append', url: '/src/main/store/RunEventLedgerWriter.ts' },
          children: [4]
        },
        {
          id: 4,
          callFrame: {
            functionName: 'deriveChatRecordMutation',
            url: '/src/main/store/ChatRecordMutation.ts'
          },
          children: [5]
        },
        { id: 5, callFrame: { functionName: 'fsyncSync', url: 'node:fs' } }
      ],
      samples: [1, 5, 1],
      timeDeltas: [20000, 60000, 20000]
    },
    exemptions: [] as Array<{
      windowId: string
      clockId: string
      owner: string
      reason: string
      startMs: number
      endMs: number
    }>
  }
}

describe('timestamped X2 CPU/gap attribution', () => {
  it('maps the actual detail batch source and refuses bundled owner absence', () => {
    const input = fixture()
    input.profile.nodes[1].callFrame = {
      functionName: 'commit',
      url: 'file:///repo/src/main/store/ToolActivityDetailLedger.ts'
    }
    input.profile.nodes[2].callFrame = { functionName: '(anonymous)', url: '' }
    const mapped = attributeMainGapProfile(input)
    expect(mapped.totals.s7_detail_batch.sampledMs).toBe(60)
    expect(mapped.nonExemptOwnerGaps).toEqual([0])
    expect(mapped.attributionEligible).toBe(true)
    for (const node of input.profile.nodes)
      if (node.callFrame.url.startsWith('file:') || node.callFrame.url.startsWith('/src/'))
        node.callFrame.url = 'file:///build/out/main/index.js'
    const bundled = attributeMainGapProfile(input)
    expect(bundled.ownerAbsenceProven).toBe(false)
    expect(bundled.attributionEligible).toBe(false)
    expect(bundled.censored).toBe(true)
    expect(bundled.unresolvedAttribution[0].reason).toBe('bundled_source_mapping_unavailable')
  })

  it('censors unknown and residual-only stacks; empty gaps still require full profile coverage', () => {
    const input = fixture()
    input.profile.nodes[1].callFrame.url = '/unknown'
    input.profile.nodes[2].callFrame.url = '/unknown'
    const residual = attributeMainGapProfile(input)
    expect(residual.nonExemptOwnerGaps).toEqual([])
    expect(residual.ownerAbsenceProven).toBe(false)
    expect(residual.unresolvedAttribution[0].reason).toContain('residual_only')
    input.gaps.entries = []
    const empty = attributeMainGapProfile(input)
    expect(empty.coverage.complete).toBe(true)
    expect(empty.ownerAbsenceProven).toBe(true)
    input.profile.timeDeltas.pop()
    expect(() => attributeMainGapProfile(input)).toThrow('truncated')
  })
  it('accepts native recorder evidence only with explicit monotonic window provenance', () => {
    const snapshot = {
      intervalMs: 5,
      thresholdMs: 25,
      startedAtMs: 100,
      endedAtMs: 200,
      observedForMs: 100,
      blockedMs: 60,
      dropped: 0,
      censored: false,
      reasons: [],
      suspensionProtection: { heldThroughout: true },
      gaps: [{ expectedAtMs: 120, observedAtMs: 180, durationMs: 60 }]
    }
    const identity = { windowId: 'beside-1', clockId: 'main-monotonic-1', clockKind: 'monotonic' }
    expect(
      attributeMainGapProfile({
        ...fixture(),
        gaps: normalizeMainLoopGapSnapshot(snapshot, identity)
      }).blockedMs
    ).toBe(60)
    expect(() =>
      normalizeMainLoopGapSnapshot(snapshot, { ...identity, clockKind: 'wall' })
    ).toThrow('monotonic')
    expect(() => normalizeMainLoopGapSnapshot({ ...snapshot, dropped: 1 }, identity)).toThrow(
      'incomplete'
    )
  })

  it('bounds comparison work and refuses mismatched exemption ownership', () => {
    expect(() => attributeMainGapProfile({ ...fixture(), limits: { maxWork: 1 } })).toThrow(
      'overflow'
    )
    const input = fixture()
    input.exemptions.push({
      windowId: 'beside-1',
      clockId: 'main-monotonic-1',
      owner: 's7_run_event',
      reason: 'd2_d3',
      startMs: 120,
      endMs: 180
    })
    expect(() => attributeMainGapProfile(input)).toThrow('mismatch')
  })
  it('joins actual samples to expected-fire gaps and deduplicates recursive owner frames', () => {
    const result = attributeMainGapProfile(fixture())
    expect(result.nonExemptOwnerMs).toBe(60)
    expect(result.totals.s7_run_event.sampledMs).toBe(60)
    expect(result.totals.mutation_derivation.sampledMs).toBe(60)
    expect(result.listedOwnerMs).toBe(60)
    expect(result.nonExemptOwnerGaps).toEqual([0])
    expect(result.evidence[0]).toMatchObject({
      sampleIndex: 1,
      nodeId: 5,
      startMs: 120,
      endMs: 180
    })
    expect(result.coverage.sampledWindowMs).toBe(100)
  })

  it('splits real exemption intervals and retains counted residuals', () => {
    const input = fixture()
    input.exemptions.push({
      windowId: 'beside-1',
      clockId: 'main-monotonic-1',
      owner: 's7_run_event',
      reason: 'strict_run_event',
      startMs: 130,
      endMs: 160
    })
    const result = attributeMainGapProfile(input)
    expect(result.totals.s7_run_event).toMatchObject({ exemptMs: 30, nonExemptMs: 30 })
    expect(result.nonExemptOwnerMs).toBe(30)
    expect(result.totals.mutation_derivation.nonExemptMs).toBe(60)
    expect(
      result.evidence.some((row: { exemptionReasons: string[] }) =>
        row.exemptionReasons.includes('strict_run_event')
      )
    ).toBe(true)
  })

  it('counts nested distinct owners separately but unions their elapsed sample overlap', () => {
    const input = fixture()
    input.profile.nodes[1].callFrame = {
      functionName: 'publish',
      url: '/src/host-runtime/HostThreadRecordTransfer.ts'
    }
    const result = attributeMainGapProfile(input)
    expect(result.totals.s6_transfer.sampledMs).toBe(60)
    expect(result.totals.s7_run_event.sampledMs).toBe(60)
    expect(result.listedOwnerMs).toBe(60)
    expect(result.nonExemptOwnerMs).toBe(60)
  })

  it('derives fully exempt gaps from sampled timestamps rather than caller certification', () => {
    const input = fixture()
    input.exemptions.push({
      windowId: 'beside-1',
      clockId: 'main-monotonic-1',
      owner: 's7_run_event',
      reason: 'strict_run_event',
      startMs: 120,
      endMs: 180
    })
    const result = attributeMainGapProfile(input)
    expect(result.nonExemptOwnerGaps).toEqual([])
    expect(
      result.evidence.filter((row: { owner: string }) => row.owner === 's7_run_event')
    ).toHaveLength(1)
    expect(result.totals.s7_run_event.exemptMs).toBe(60)
  })

  it('merges overlapping gap and owner intervals without counting elapsed time twice', () => {
    const input = fixture()
    input.gaps.entries.push({ expectedFireMs: 150, observedFireMs: 190, delayMs: 40 })
    const result = attributeMainGapProfile(input)
    expect(result.blockedMs).toBe(70)
    expect(result.nonExemptOwnerMs).toBe(60)
    expect(result.gaps).toHaveLength(1)
  })

  it('does not classify generic frame names as proof and reports unattributed sampling', () => {
    const input = fixture()
    input.profile.nodes[1].callFrame.url = '/unknown'
    input.profile.nodes[2].callFrame.url = '/unknown'
    const result = attributeMainGapProfile(input)
    expect(result.nonExemptOwnerGaps).toEqual([])
    expect(result.totals.mutation_derivation.sampledMs).toBe(60)
    expect(result.sampling.limitation).toContain('cannot be proven absent')
  })

  it.each([
    'anchor',
    'duration',
    'truncated',
    'delta',
    'coverage',
    'overflow',
    'cycle',
    'unknown_sample',
    'gap_clock'
  ])('refuses %s rather than manufacturing zero attribution', (kind) => {
    const input = fixture()
    if (kind === 'anchor') input.anchor.clockId = 'other'
    if (kind === 'duration') input.window.durationMs = 99
    if (kind === 'truncated') input.profile.timeDeltas.pop()
    if (kind === 'delta') input.profile.timeDeltas[1] = -1
    if (kind === 'coverage') input.profile.endTime += 1000
    if (kind === 'overflow') input.gaps.overflow = true
    if (kind === 'cycle') input.profile.nodes[3].children = [1]
    if (kind === 'unknown_sample') input.profile.samples[1] = 99
    if (kind === 'gap_clock') input.gaps.clockId = 'other'
    expect(() => attributeMainGapProfile(input)).toThrow('refused')
  })

  it('refuses output evidence overflow and residual exemption fabrication', () => {
    expect(() => attributeMainGapProfile({ ...fixture(), limits: { maxEvidence: 1 } })).toThrow(
      'overflow'
    )
    const input = fixture()
    input.exemptions.push({
      windowId: 'beside-1',
      clockId: 'main-monotonic-1',
      owner: 'mutation_derivation',
      reason: 'baseline_verify',
      startMs: 120,
      endMs: 180
    })
    expect(() => attributeMainGapProfile(input)).toThrow('exemption')
  })
})
