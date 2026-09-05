import { describe, expect, it, vi } from 'vitest'
import {
  generateMuseIntroduction,
  museStatsWithIntroduction,
  type MuseIntroductionInput
} from './MuseIntroduction'
import type { MuseRunOutcome } from './MuseRun'
import { museMeterSnapshotToProviderStats, unavailableMuseMeterSnapshot } from './MuseUsage'

function outcome(overrides: Partial<MuseRunOutcome> = {}): MuseRunOutcome {
  const meter = unavailableMuseMeterSnapshot('intro-session')
  return {
    status: 'success',
    sessionId: 'intro-session',
    exitCode: 0,
    assistantText: 'I will read both files and verify their totals.',
    events: [],
    meter,
    providerStats: museMeterSnapshotToProviderStats(meter),
    warnings: [],
    argv: [],
    effort: 'minimal',
    writeCapable: false,
    skillPinHash: '',
    leasePath: '',
    ...overrides
  }
}

function input() {
  return {
    binaryPath: '/bin/muse',
    workspacePath: '/workspace',
    prompt: 'Verify the two totals.',
    runId: 'work-run',
    temporaryRoot: '/tmp',
    model: 'muse-spark-1.3',
    spawn: vi.fn()
  }
}

describe('Muse-authored introductions', () => {
  it('uses the selected Muse model in a distinct acknowledgment phase and returns its words verbatim', async () => {
    const run = vi.fn<NonNullable<MuseIntroductionInput['run']>>(async () => outcome())
    const result = await generateMuseIntroduction({ ...input(), run })
    expect(result.text).toBe('I will read both files and verify their totals.')
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'muse-spark-1.3',
        runId: 'work-run-introduction',
        introductionOnly: true,
        prompt: expect.stringContaining('Do not use tools, inspect files, carry out the task')
      })
    )
    expect(run.mock.calls[0][0].prompt).toContain('Verify the two totals.')
  })

  it('does not convert a failed intro, a tool execution, or cancellation into a fake opening', async () => {
    expect(
      await generateMuseIntroduction({ ...input(), run: async () => outcome({ status: 'failed' }) })
    ).toMatchObject({ text: null, warning: expect.any(String) })
    expect(
      await generateMuseIntroduction({
        ...input(),
        run: async (request) => {
          request.onEvent?.({ type: 'tool_use', payloadType: 'runtime.session', raw: {} })
          return outcome()
        }
      })
    ).toMatchObject({ text: null })
    const run = vi.fn()
    expect(await generateMuseIntroduction({ ...input(), run, shouldCancel: () => true })).toEqual({
      text: null
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('leaves native slash commands alone and provides a bounded cancellation predicate', async () => {
    const run = vi.fn<NonNullable<MuseIntroductionInput['run']>>(async (request) => {
      expect(request.shouldCancel?.()).toBe(true)
      return outcome({ status: 'cancelled', assistantText: '' })
    })
    expect(await generateMuseIntroduction({ ...input(), prompt: '/compact', run })).toEqual({
      text: null
    })
    expect(run).not.toHaveBeenCalled()
    await generateMuseIntroduction({ ...input(), run, timeoutMs: -1 })
    expect(run).toHaveBeenCalledOnce()
  })

  it('includes usage from both phases once, without claiming missing counts are reported', () => {
    const stats = {
      ...outcome().providerStats,
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      reasoning_tokens: 5,
      _taskwraith_token_count_confidence: 'reported' as const
    }
    expect(museStatsWithIntroduction(stats, stats)).toMatchObject({
      input_tokens: 200,
      output_tokens: 40,
      total_tokens: 240,
      reasoning_tokens: 10,
      _taskwraith_token_count_confidence: 'reported'
    })
    expect(
      museStatsWithIntroduction(stats, outcome().providerStats)._taskwraith_token_count_confidence
    ).toBe('unavailable')
  })
})
