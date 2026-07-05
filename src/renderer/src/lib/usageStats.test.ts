import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from './GeminiAdapter'
import { isProviderExecutionToolEvent } from './usageStats'

describe('usageStats', () => {
  it('does not count provider thinking traces as execution tool events', () => {
    const event: NormalizedEvent = {
      type: 'tool_event',
      name: 'cursor_thinking',
      data: {
        type: 'tool_result',
        tool_name: 'cursor_thinking',
        output: 'Thinking through the task.'
      },
      timestamp: '2026-07-05T19:00:00.000Z',
      isUse: false,
      isResult: true
    }

    expect(isProviderExecutionToolEvent(event)).toBe(false)
  })

  it('still counts normal tool events as execution tool events', () => {
    const event: NormalizedEvent = {
      type: 'tool_event',
      name: 'read_file',
      data: {
        type: 'tool_use',
        tool_name: 'read_file',
        parameters: { path: 'README.md' }
      },
      timestamp: '2026-07-05T19:00:00.000Z',
      isUse: true,
      isResult: false
    }

    expect(isProviderExecutionToolEvent(event)).toBe(true)
  })
})
