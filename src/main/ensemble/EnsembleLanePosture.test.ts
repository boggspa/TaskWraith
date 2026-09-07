import { describe, expect, it } from 'vitest'
import {
  LANE_INTENT_BOUNDARY_READ_CLAMPED,
  LANE_INTENT_BOUNDARY_TIER_PRESERVED,
  formatLaneIntentBoundary,
  resolveEffectiveLanePosture
} from './EnsembleLanePosture'

describe('formatLaneIntentBoundary', () => {
  it('names the runtime clamp when a read lane also lost its write permissions', () => {
    expect(
      formatLaneIntentBoundary({ presetId: 'read_only', readOnly: true, laneIntent: 'read' })
    ).toBe(LANE_INTENT_BOUNDARY_READ_CLAMPED)
  })

  it('keeps the tier-preserving wording when a read lane retains its configured tier', () => {
    expect(
      formatLaneIntentBoundary({ presetId: 'workspace_write', readOnly: false, laneIntent: 'read' })
    ).toBe(LANE_INTENT_BOUNDARY_TIER_PRESERVED)
  })

  it('pins the exact sentences moved out of EnsembleOrchestrator', () => {
    // These two strings were lifted verbatim from the orchestrator's inline
    // `readerIntentBoundary`. A reword here silently changes what every reader
    // lane is told, so the text is asserted rather than described.
    expect(LANE_INTENT_BOUNDARY_READ_CLAMPED).toBe(
      'TaskWraith lane intent: inspection, recon, or review only. Do not modify workspace files or external state. This auxiliary lane is runtime read-clamped.'
    )
    expect(LANE_INTENT_BOUNDARY_TIER_PRESERVED).toBe(
      'TaskWraith lane intent: inspection, recon, or review only. Do not modify workspace files or external state. Your configured permission tier remains active so allowed inspection tools stay non-blocking; that authority does not broaden this reader assignment.'
    )
  })

  it('says nothing for a write lane, a none lane, or a seat with no lane at all', () => {
    expect(
      formatLaneIntentBoundary({
        presetId: 'workspace_write',
        readOnly: false,
        laneIntent: 'write'
      })
    ).toBeUndefined()
    // A write lane that was runtime-clamped to read_only but whose intent was
    // NOT narrowed is still a writer assignment; only the intent gates this.
    expect(
      formatLaneIntentBoundary({ presetId: 'read_only', readOnly: true, laneIntent: 'write' })
    ).toBeUndefined()
    expect(
      formatLaneIntentBoundary({ presetId: 'read_only', readOnly: true, laneIntent: 'none' })
    ).toBeUndefined()
    expect(formatLaneIntentBoundary({ presetId: 'read_only', readOnly: true })).toBeUndefined()
    expect(formatLaneIntentBoundary(undefined)).toBeUndefined()
  })
})

describe('resolveEffectiveLanePosture', () => {
  it('carries the resolved preset and readOnly through with the live lane intent', () => {
    expect(resolveEffectiveLanePosture({ presetId: 'read_only', readOnly: true }, 'read')).toEqual({
      presetId: 'read_only',
      readOnly: true,
      laneIntent: 'read'
    })
  })

  it('omits laneIntent for a serial seat that holds no lane', () => {
    const posture = resolveEffectiveLanePosture({ presetId: 'workspace_write', readOnly: false })
    expect(posture).toEqual({ presetId: 'workspace_write', readOnly: false })
    expect(posture).not.toHaveProperty('laneIntent')
    expect(formatLaneIntentBoundary(posture)).toBeUndefined()
  })

  it('reports the clamped preset, not the seat preset, when the runtime narrowed the run', () => {
    // The orchestrator passes the permissions it actually resolved. A
    // locked_writers lane clamped to read_only must surface read_only here even
    // though its seat is still configured workspace_write.
    const posture = resolveEffectiveLanePosture({ presetId: 'read_only', readOnly: true }, 'read')
    expect(posture.presetId).toBe('read_only')
    expect(formatLaneIntentBoundary(posture)).toBe(LANE_INTENT_BOUNDARY_READ_CLAMPED)
  })
})
