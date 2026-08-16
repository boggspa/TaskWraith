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

function taskWraithUserInput(stepIndex = 0): string {
  return step(stepIndex, 'USER_INPUT', {
    source: 'USER_EXPLICIT',
    content:
      '<USER_REQUEST>\nTaskWraith gateway MCP profile is active for this provider session.\nInspect the workspace.\n</USER_REQUEST>'
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

  it('requires a unique fresh TaskWraith brain and corroborating changed receipt', async () => {
    let receipt = '22222222-2222-4222-8222-222222222222'
    const freshId = '33333333-3333-4333-8333-333333333333'
    let conversationIds: string[] = []
    const raw = [
      taskWraithUserInput(),
      step(1, 'PLANNER_RESPONSE', {
        thinking: 'Fresh project reasoning',
        tool_calls: [{ name: 'view_file', args: { AbsolutePath: '"/repo/src/main.ts"' } }]
      })
    ].join('\n')
    const emitted: AgyBrainTranscriptCompatEvent[] = []
    const monitor = new AgyBrainTranscriptMonitor({
      appRunId: 'fresh-run',
      workspace: '/repo',
      providerSessionId: null,
      receiptBeforeFreshProject: receipt,
      emit: (event) => emitted.push(event),
      deps: {
        readReceipt: async () => receipt,
        listBrainConversationIds: async () => conversationIds,
        readFile: async () => raw,
        stat: async () => ({ size: raw.length, mtimeMs: raw.length })
      }
    })

    await monitor.prime()
    await monitor.pollNow()
    expect(emitted).toEqual([])

    conversationIds = [freshId]
    receipt = freshId
    await monitor.pollNow()
    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toMatchObject({ output: 'Fresh project reasoning' })
  })

  it('attaches a fresh TaskWraith brain before its workspace receipt is published', async () => {
    const priorId = '55555555-5555-4555-8555-555555555555'
    const freshId = '66666666-6666-4666-8666-666666666666'
    let conversationIds = [priorId]
    const raw = [
      taskWraithUserInput(),
      step(1, 'PLANNER_RESPONSE', {
        thinking: 'Inspecting the focused implementation.',
        tool_calls: [
          {
            name: 'run_command',
            args: { Cwd: '"/repo"', CommandLine: '"git status --porcelain"' }
          }
        ]
      })
    ].join('\n')
    const emitted: AgyBrainTranscriptCompatEvent[] = []
    const monitor = new AgyBrainTranscriptMonitor({
      appRunId: 'fresh-discovery-run',
      workspace: '/repo',
      providerSessionId: null,
      receiptBeforeFreshProject: priorId,
      emit: (event) => emitted.push(event),
      deps: {
        readReceipt: async () => priorId,
        listBrainConversationIds: async () => conversationIds,
        readFile: async (path) => (path.includes(freshId) ? raw : ''),
        stat: async () => ({ size: raw.length, mtimeMs: raw.length })
      }
    })

    await monitor.prime()
    conversationIds = [priorId, freshId]
    await monitor.pollNow()

    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toMatchObject({ output: 'Inspecting the focused implementation.' })
  })

  it('fails closed when more than one new TaskWraith brain matches the workspace', async () => {
    const priorId = '77777777-7777-4777-8777-777777777777'
    const firstId = '88888888-8888-4888-8888-888888888888'
    const secondId = '99999999-9999-4999-8999-999999999999'
    let conversationIds = [priorId]
    let receipt = priorId
    const transcript = (thinking: string) =>
      [
        taskWraithUserInput(),
        step(1, 'PLANNER_RESPONSE', {
          thinking,
          tool_calls: [{ name: 'view_file', args: { AbsolutePath: '"/repo/src/main.ts"' } }]
        })
      ].join('\n')
    const rawById = new Map([
      [firstId, transcript('First matching run')],
      [secondId, transcript('Second matching run')]
    ])
    const emitted: AgyBrainTranscriptCompatEvent[] = []
    const monitor = new AgyBrainTranscriptMonitor({
      appRunId: 'ambiguous-fresh-run',
      workspace: '/repo',
      providerSessionId: null,
      receiptBeforeFreshProject: priorId,
      emit: (event) => emitted.push(event),
      deps: {
        readReceipt: async () => receipt,
        listBrainConversationIds: async () => conversationIds,
        readFile: async (path) =>
          [...rawById.entries()].find(([id]) => path.includes(id))?.[1] || '',
        stat: async () => ({ size: 200, mtimeMs: 2 })
      }
    })

    await monitor.prime()
    conversationIds = [priorId, firstId, secondId]
    await monitor.pollNow()
    expect(emitted).toEqual([])

    receipt = secondId
    await monitor.pollNow()
    expect(emitted).toEqual([])
    expect(await monitor.stopAndDrain()).toBeNull()
  })

  it('does not trust a changed receipt that points to a pre-launch conversation', async () => {
    const priorId = '12121212-1212-4212-8212-121212121212'
    const foreignId = '34343434-3434-4434-8434-343434343434'
    let receipt = priorId
    const foreignRaw = [
      taskWraithUserInput(),
      step(1, 'PLANNER_RESPONSE', {
        thinking: 'Foreign pre-existing turn',
        tool_calls: [{ name: 'view_file', args: { AbsolutePath: '"/repo/src/main.ts"' } }]
      }),
      step(2, 'PLANNER_RESPONSE', {
        content: 'Foreign final response.',
        tool_calls: null
      })
    ].join('\n')
    const emitted: AgyBrainTranscriptCompatEvent[] = []
    const monitor = new AgyBrainTranscriptMonitor({
      appRunId: 'pre-existing-receipt-run',
      workspace: '/repo',
      providerSessionId: null,
      receiptBeforeFreshProject: priorId,
      emit: (event) => emitted.push(event),
      deps: {
        readReceipt: async () => receipt,
        listBrainConversationIds: async () => [priorId, foreignId],
        readFile: async (path) => (path.includes(foreignId) ? foreignRaw : ''),
        stat: async () => ({ size: foreignRaw.length, mtimeMs: foreignRaw.length })
      }
    })

    await monitor.prime()
    receipt = foreignId
    await monitor.pollNow()

    expect(emitted).toEqual([])
    expect(await monitor.stopAndDrain()).toBeNull()
  })

  it('ignores a new brain without TaskWraith and workspace provenance', async () => {
    const priorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const foreignId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    let conversationIds = [priorId]
    const foreignRaw = [
      step(0, 'USER_INPUT', { source: 'USER_EXPLICIT', content: 'Unrelated agy session' }),
      step(1, 'PLANNER_RESPONSE', {
        thinking: 'Private unrelated reasoning',
        tool_calls: [{ name: 'run_command', args: { Cwd: '"/elsewhere"' } }]
      })
    ].join('\n')
    const emitted: AgyBrainTranscriptCompatEvent[] = []
    const monitor = new AgyBrainTranscriptMonitor({
      appRunId: 'foreign-fresh-run',
      workspace: '/repo',
      providerSessionId: null,
      receiptBeforeFreshProject: priorId,
      emit: (event) => emitted.push(event),
      deps: {
        readReceipt: async () => priorId,
        listBrainConversationIds: async () => conversationIds,
        readFile: async () => foreignRaw,
        stat: async () => ({ size: foreignRaw.length, mtimeMs: foreignRaw.length })
      }
    })

    await monitor.prime()
    conversationIds = [priorId, foreignId]
    await monitor.pollNow()

    expect(emitted).toEqual([])
  })

  it('forces one final transcript read while stopping even when stat evidence is unchanged', async () => {
    const oldLine = step(8, 'PLANNER_RESPONSE', { thinking: 'Already projected turn' })
    const finalLine = step(9, 'PLANNER_RESPONSE', {
      thinking: 'Final planner trace',
      content: 'Exact final answer.',
      tool_calls: null
    })
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

    const [completedFinalResponse, repeatedDrain] = await Promise.all([
      monitor.stopAndDrain(),
      monitor.stopAndDrain()
    ])
    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toMatchObject({ output: 'Final planner trace' })
    expect(completedFinalResponse).toEqual({
      stepIndex: 9,
      createdAt: '2026-08-15T19:30:00Z',
      content: 'Exact final answer.'
    })
    expect(repeatedDrain).toEqual(completedFinalResponse)
  })

  it('never returns a prior-turn final from a resumed transcript baseline', async () => {
    const priorFinal = step(14, 'PLANNER_RESPONSE', {
      content: 'Prior turn final.',
      tool_calls: null
    })
    const monitor = new AgyBrainTranscriptMonitor({
      appRunId: 'resumed-final-baseline-run',
      workspace: '/repo',
      providerSessionId: 'agy-project-v1:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      emit: () => undefined,
      deps: {
        readFile: async () => priorFinal,
        stat: async () => ({ size: priorFinal.length, mtimeMs: priorFinal.length })
      }
    })

    await monitor.prime()
    expect(await monitor.stopAndDrain()).toBeNull()
  })

  it('fails closed when a resumed pre-turn transcript baseline cannot be read', async () => {
    const priorFinal = step(22, 'PLANNER_RESPONSE', {
      content: 'Prior turn final after a transient read failure.',
      tool_calls: null
    })
    let readAttempts = 0
    const emitted: AgyBrainTranscriptCompatEvent[] = []
    const monitor = new AgyBrainTranscriptMonitor({
      appRunId: 'resumed-baseline-read-failure-run',
      workspace: '/repo',
      providerSessionId: 'agy-project-v1:56565656-5656-4656-8656-565656565656',
      emit: (event) => emitted.push(event),
      deps: {
        readFile: async () => {
          readAttempts += 1
          if (readAttempts === 1) throw new Error('transient read failure')
          return priorFinal
        },
        stat: async () => ({ size: priorFinal.length, mtimeMs: priorFinal.length })
      }
    })

    await monitor.prime()
    expect(await monitor.stopAndDrain()).toBeNull()
    expect(emitted).toEqual([])
    expect(readAttempts).toBe(1)
  })

  it('warns when a final native response remains stuck before process exit', async () => {
    const oldLine = step(10, 'PLANNER_RESPONSE', { thinking: 'Earlier planning' })
    const finalContent = 'This final report must not be projected as assistant content.'
    const finalLine = step(11, 'PLANNER_RESPONSE', {
      thinking: '',
      content: finalContent,
      tool_calls: null
    })
    let raw = oldLine
    let now = 1_000
    const emitted: AgyBrainTranscriptCompatEvent[] = []
    const monitor = new AgyBrainTranscriptMonitor({
      appRunId: 'stuck-native-exit-run',
      workspace: '/repo',
      providerSessionId: 'agy-project-v1:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      emit: (event) => emitted.push(event),
      deps: {
        readFile: async () => raw,
        stat: async () => ({ size: raw.length, mtimeMs: raw.length }),
        finalResponseExitGraceMs: 30_000,
        now: () => now
      }
    })

    await monitor.prime()
    raw = `${oldLine}\n${finalLine}`
    await monitor.pollNow()
    expect(emitted).toEqual([])

    now = 31_000
    await monitor.pollNow()
    expect(emitted).toEqual([
      expect.objectContaining({
        type: 'provider_warning',
        title: 'AntiGravity final response is awaiting native exit'
      })
    ])
    expect(JSON.stringify(emitted)).not.toContain(finalContent)
    expect(await monitor.stopAndDrain()).toEqual({
      stepIndex: 11,
      createdAt: '2026-08-15T19:30:00Z',
      content: finalContent
    })
  })
})
