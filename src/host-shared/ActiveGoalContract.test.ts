import { describe, expect, it } from 'vitest'

import {
  hostComputeGoalRuntimeTiming,
  hostFormatActiveGoalPromptBlock,
  hostShouldInjectActiveGoal,
  type HostActiveGoalFacts
} from './ActiveGoalContract'

function goal(overrides: Partial<HostActiveGoalFacts> = {}): HostActiveGoalFacts {
  return {
    objective: 'Ship the standalone goal lens.',
    status: 'active',
    mode: 'taskwraith_steered',
    ...overrides
  }
}

describe('ActiveGoalContract', () => {
  it('binds a run only while the goal is live and TaskWraith is steering it', () => {
    expect(hostShouldInjectActiveGoal(goal())).toBe(true)
    expect(hostShouldInjectActiveGoal(goal({ status: 'blocked' }))).toBe(true)
    expect(hostShouldInjectActiveGoal(goal({ status: 'paused' }))).toBe(false)
    expect(hostShouldInjectActiveGoal(goal({ status: 'completed' }))).toBe(false)
    expect(hostShouldInjectActiveGoal(null)).toBe(false)
    expect(hostShouldInjectActiveGoal(undefined)).toBe(false)

    // Native modes run the provider's own goal loop. Injecting a second
    // objective block would have TaskWraith and the provider steering one run.
    for (const mode of ['codex_native', 'claude_native', 'grok_native'] as const) {
      expect(hostShouldInjectActiveGoal(goal({ mode }))).toBe(false)
    }
    expect(hostShouldInjectActiveGoal(goal({ mode: 'ollama_harness' }))).toBe(true)
  })

  it('phrases the objective block with the mode label and a blocked reason', () => {
    const block = hostFormatActiveGoalPromptBlock(goal())
    expect(block).toContain('<taskwraith_active_goal>')
    expect(block).toContain('Ship the standalone goal lens.')
    expect(block).toContain('Provider mode: Guided by TaskWraith')
    expect(block).toContain('Status: active')
    expect(block.trimEnd().endsWith('</taskwraith_active_goal>')).toBe(true)

    const blocked = hostFormatActiveGoalPromptBlock(
      goal({ status: 'blocked', blockedReason: 'waiting on review' })
    )
    expect(blocked).toContain('waiting on review')

    // A blocked goal with no reason must not render a dangling separator.
    expect(hostFormatActiveGoalPromptBlock(goal({ status: 'blocked' }))).toContain(
      'Status: blocked'
    )
  })

  it('accumulates wall, active, paused and blocked time from the ledger', () => {
    const timing = hostComputeGoalRuntimeTiming(
      {
        startedAt: '2026-08-29T10:00:00.000Z',
        intervals: [
          {
            status: 'active',
            startedAt: '2026-08-29T10:00:00.000Z',
            endedAt: '2026-08-29T10:30:00.000Z'
          },
          {
            status: 'paused',
            startedAt: '2026-08-29T10:30:00.000Z',
            endedAt: '2026-08-29T10:45:00.000Z'
          },
          {
            status: 'blocked',
            startedAt: '2026-08-29T10:45:00.000Z',
            endedAt: '2026-08-29T11:00:00.000Z'
          }
        ]
      },
      '2026-08-29T11:00:00.000Z'
    )
    expect(timing.wallMs).toBe(60 * 60 * 1000)
    expect(timing.activeMs).toBe(30 * 60 * 1000)
    expect(timing.pausedMs).toBe(15 * 60 * 1000)
    expect(timing.blockedMs).toBe(15 * 60 * 1000)

    // An open interval runs to `now`, never to zero.
    const open = hostComputeGoalRuntimeTiming(
      {
        startedAt: '2026-08-29T10:00:00.000Z',
        intervals: [{ status: 'active', startedAt: '2026-08-29T10:00:00.000Z' }]
      },
      '2026-08-29T10:20:00.000Z'
    )
    expect(open.activeMs).toBe(20 * 60 * 1000)
    expect(hostComputeGoalRuntimeTiming(null).wallMs).toBe(0)
  })
})
