import { describe, expect, it } from 'vitest'
import { createSyntheticSnapshot } from './hostSnapshot'
import { diffHostSnapshots, isNonInterferenceProven } from './interferenceDiff'

function snap(partial: Parameters<typeof createSyntheticSnapshot>[0]) {
  return createSyntheticSnapshot(partial)
}

describe('interferenceDiff', () => {
  it('marks dry-run dimensions as not_measured and never proves non-interference', () => {
    const before = snap({
      capturedAtMs: 1,
      frontmostAppId: 'com.apple.Terminal',
      focusedWindowId: 'w1',
      keyboardTargetPid: 1,
      hostCursor: { x: 1, y: 2 },
      clipboardHash: 'h1',
      targetIsActive: false,
      humanInputScope: 'global_hid'
    })
    const after = { ...before, capturedAtMs: 2 }
    const dims = diffHostSnapshots({
      before,
      after,
      targetActionSucceeded: null,
      dryRun: true
    })
    expect(dims).toHaveLength(8)
    expect(dims.every((d) => d.verdict === 'not_measured' || d.verdict === 'fail')).toBe(
      true
    )
    // global_hid fails target-scoped arbitration even in dry-run
    expect(
      dims.find((d) => d.dimension === 'targetScopedHumanArbitration')?.verdict
    ).toBe('fail')
    expect(isNonInterferenceProven(dims, true)).toBe(false)
  })

  it('fails when host cursor or frontmost app changes', () => {
    const before = snap({
      capturedAtMs: 1,
      frontmostAppId: 'com.apple.Terminal',
      focusedWindowId: 'w1',
      keyboardTargetPid: 1,
      hostCursor: { x: 1, y: 2 },
      clipboardHash: 'h1',
      targetIsActive: false,
      humanInputScope: 'target_scoped',
      humanInputRecentOnTarget: false,
      humanInputRecentElsewhere: false
    })
    const after = {
      ...before,
      capturedAtMs: 2,
      frontmostAppId: 'com.taskwraith.harness.AppDriveFixture',
      hostCursor: { x: 99, y: 99 },
      targetIsActive: true
    }
    const dims = diffHostSnapshots({
      before,
      after,
      targetActionSucceeded: true,
      dryRun: false
    })
    expect(dims.find((d) => d.dimension === 'frontmostApp')?.verdict).toBe('fail')
    expect(dims.find((d) => d.dimension === 'hostCursor')?.verdict).toBe('fail')
    expect(dims.find((d) => d.dimension === 'activation')?.verdict).toBe('fail')
    expect(isNonInterferenceProven(dims, false)).toBe(false)
  })

  it('can prove non-interference only when all eight pass and not dry-run', () => {
    const before = snap({
      capturedAtMs: 1,
      frontmostAppId: 'com.apple.Terminal',
      focusedWindowId: 'w1',
      keyboardTargetPid: 1,
      hostCursor: { x: 1, y: 2 },
      clipboardHash: 'h1',
      targetIsActive: false,
      humanInputScope: 'target_scoped',
      humanInputRecentOnTarget: false,
      humanInputRecentElsewhere: true
    })
    const after = { ...before, capturedAtMs: 2 }
    const dims = diffHostSnapshots({
      before,
      after,
      targetActionSucceeded: true,
      dryRun: false
    })
    expect(dims.every((d) => d.verdict === 'pass')).toBe(true)
    expect(isNonInterferenceProven(dims, false)).toBe(true)
    expect(isNonInterferenceProven(dims, true)).toBe(false)
  })
})
