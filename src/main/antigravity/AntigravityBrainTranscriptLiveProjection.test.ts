import { describe, expect, it } from 'vitest'
import {
  AgyBrainTranscriptMonitor,
  AgyBrainTranscriptProjector,
  type AgyBrainTranscriptCompatEvent
} from './AntigravityBrainTranscriptLiveProjection'

function step(stepIndex: number, type: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    step_index: stepIndex,
    source: 'MODEL',
    type,
    status: 'DONE',
    created_at: '2026-08-15T19:30:00Z',
    ...overrides
  })
}

describe('AgyBrainTranscriptProjector', () => {
  it('projects planner thinking without duplicating assistant content', () => {
    const projector = new AgyBrainTranscriptProjector('agy-run-1')
    const events = projector.consume([
      step(1, 'PLANNER_RESPONSE', {
        thinking: '**Inspecting**\n\nI should read the relevant file first.',
        content: 'This is the final assistant report.',
        tool_calls: [{ name: 'view_file' }]
      })
    ])

    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        tool_id: 'antigravity-thinking-agy-run-1',
        tool_name: 'antigravity_thinking',
        parameters: { title: 'AntiGravity thinking', kind: 'reasoning' }
      }),
      expect.objectContaining({
        type: 'tool_result',
        tool_id: 'antigravity-thinking-agy-run-1',
        output: '**Inspecting**\n\nI should read the relevant file first.'
      })
    ])
    expect(JSON.stringify(events)).not.toContain('final assistant report')
  })

  it('opens a chronological thinking segment after an intervening tool step', () => {
    const projector = new AgyBrainTranscriptProjector('agy-run-2')
    projector.consume([step(1, 'PLANNER_RESPONSE', { thinking: 'First thought' })])

    const events = projector.consume([
      step(1, 'PLANNER_RESPONSE', { thinking: 'First thought' }),
      step(2, 'VIEW_FILE', { content: 'File Path: `/repo/a.ts`\nTotal Lines: 3' }),
      step(3, 'PLANNER_RESPONSE', { thinking: 'Second thought' })
    ])

    expect(events.map((event) => event.type)).toEqual([
      'tool_use',
      'tool_result',
      'tool_use',
      'tool_result'
    ])
    expect(events[2]).toMatchObject({
      tool_id: 'antigravity-thinking-agy-run-2-seg2',
      tool_name: 'antigravity_thinking'
    })
    expect(events[3]).toMatchObject({ output: 'Second thought' })
  })

  it('deduplicates identical planner retries even across chronology breaks', () => {
    const projector = new AgyBrainTranscriptProjector('agy-run-3')
    projector.consume([step(1, 'PLANNER_RESPONSE', { thinking: 'Choose the right tool.' })])

    const events = projector.consume([
      step(2, 'RUN_COMMAND', { content: 'git status' }),
      step(3, 'PLANNER_RESPONSE', { thinking: 'Choose the right tool.' })
    ])

    expect(events).toEqual([])
  })

  it('coalesces timestamp-varying invalid-tool errors and warns once', () => {
    const projector = new AgyBrainTranscriptProjector('agy-run-4')
    let lastEvents: ReturnType<typeof projector.consume> = []
    for (let index = 1; index <= 6; index += 1) {
      lastEvents = projector.consume([
        step(index, 'ERROR_MESSAGE', {
          content:
            `Created At: 2026-08-15T20:30:0${index}+01:00\n` +
            `Completed At: 2026-08-15T20:30:0${index}+01:00\n` +
            'Error invalid tool call: invalid_args'
        })
      ])
      if (index === 1) {
        expect(lastEvents.map((event) => event.type)).toEqual(['tool_use', 'tool_result'])
      }
      if (index === 5) {
        expect(lastEvents.map((event) => event.type)).toEqual(['tool_result', 'provider_warning'])
      }
    }

    expect(lastEvents).toHaveLength(1)
    expect(lastEvents[0]).toMatchObject({
      type: 'tool_result',
      tool_id: 'antigravity-thinking-agy-run-4-tool-retries',
      status: 'error',
      output: expect.stringContaining('6 repeated occurrences')
    })
    expect(JSON.stringify(lastEvents)).not.toContain('Created At:')
  })

  it('suppresses pre-existing steps in a resumed conversation baseline', () => {
    const projector = new AgyBrainTranscriptProjector('agy-run-5')
    const prior = step(20, 'PLANNER_RESPONSE', { thinking: 'Old turn reasoning' })
    projector.markBaseline([prior])

    const events = projector.consume([
      prior,
      step(21, 'PLANNER_RESPONSE', { thinking: 'Current turn reasoning' })
    ])

    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ output: 'Current turn reasoning' })
    expect(JSON.stringify(events)).not.toContain('Old turn reasoning')
  })
})

describe('AgyBrainTranscriptMonitor', () => {
  it('baselines a resumed transcript before projecting appended records', async () => {
    const oldLine = step(4, 'PLANNER_RESPONSE', { thinking: 'Old reasoning' })
    const newLine = step(5, 'PLANNER_RESPONSE', { thinking: 'New reasoning' })
    let raw = oldLine
    const emitted: AgyBrainTranscriptCompatEvent[] = []
    const monitor = new AgyBrainTranscriptMonitor({
      appRunId: 'resumed-run',
      workspace: '/repo',
      providerSessionId: 'agy-project-v1:11111111-1111-4111-8111-111111111111',
      emit: (event) => emitted.push(event),
      deps: {
        readFile: async () => raw,
        stat: async () => ({ size: raw.length, mtimeMs: raw.length })
      }
    })

    await monitor.prime()
    raw = `${oldLine}\n${newLine}`
    await monitor.pollNow()

    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toMatchObject({ output: 'New reasoning' })
    expect(JSON.stringify(emitted)).not.toContain('Old reasoning')
  })

  it('waits for a fresh project receipt and then projects its complete first turn', async () => {
    let receipt = '22222222-2222-4222-8222-222222222222'
    const raw = step(1, 'PLANNER_RESPONSE', { thinking: 'Fresh project reasoning' })
    const emitted: AgyBrainTranscriptCompatEvent[] = []
    const monitor = new AgyBrainTranscriptMonitor({
      appRunId: 'fresh-run',
      workspace: '/repo',
      providerSessionId: null,
      receiptBeforeFreshProject: receipt,
      emit: (event) => emitted.push(event),
      deps: {
        readReceipt: async () => receipt,
        readFile: async () => raw,
        stat: async () => ({ size: raw.length, mtimeMs: raw.length })
      }
    })

    await monitor.prime()
    await monitor.pollNow()
    expect(emitted).toEqual([])

    receipt = '33333333-3333-4333-8333-333333333333'
    await monitor.pollNow()
    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toMatchObject({ output: 'Fresh project reasoning' })
  })

  it('forces one final transcript read while stopping even when stat evidence is unchanged', async () => {
    const oldLine = step(8, 'PLANNER_RESPONSE', { thinking: 'Already projected turn' })
    const finalLine = step(9, 'PLANNER_RESPONSE', { thinking: 'Final planner trace' })
    let raw = oldLine
    const emitted: AgyBrainTranscriptCompatEvent[] = []
    const monitor = new AgyBrainTranscriptMonitor({
      appRunId: 'terminal-drain-run',
      workspace: '/repo',
      providerSessionId: 'agy-project-v1:44444444-4444-4444-8444-444444444444',
      emit: (event) => emitted.push(event),
      deps: {
        readFile: async () => raw,
        // Model a coarse/unchanged filesystem timestamp. The terminal drain
        // must not depend on another stat transition to observe the final row.
        stat: async () => ({ size: 100, mtimeMs: 1 })
      }
    })

    await monitor.prime()
    raw = `${oldLine}\n${finalLine}`
    await monitor.pollNow()
    expect(emitted).toEqual([])

    await monitor.stopAndDrain()
    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toMatchObject({ output: 'Final planner trace' })
  })
})
