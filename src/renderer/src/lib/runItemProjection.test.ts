import { describe, expect, it } from 'vitest'
import type { RunItemEvent } from '../../../shared/runItemEvents'
import {
  isAssistantRunItemDelta,
  legacyAssistantDeltaProjectionKey,
  legacyToolEventProjectionKey,
  projectRunItemToolEvent,
  projectRunItemAssistantDelta
} from './runItemProjection'

const event = (overrides: Partial<RunItemEvent> & Record<string, unknown>): RunItemEvent =>
  ({
    protocolVersion: 1,
    kind: 'item/delta',
    chatId: 'chat-1',
    runId: 'run-1',
    provider: 'codex',
    itemId: 'item-1',
    itemKind: 'assistant_message',
    channel: 'assistant',
    delta: 'hello',
    sequence: 3,
    createdAt: '2026-06-29T00:00:00.000Z',
    ...overrides
  }) as RunItemEvent

describe('runItemProjection', () => {
  it('projects assistant item deltas into the existing assistant delta shape', () => {
    const projection = projectRunItemAssistantDelta(event({ cumulative: true }), {
      providerModel: 'qwen3:4b-instruct',
      providerModelLabel: 'Qwen 3 (4B Param)'
    })

    expect(projection).toEqual({
      chatId: 'chat-1',
      runId: 'run-1',
      itemId: 'item-1',
      sequence: 3,
      input: {
        incoming: 'hello',
        runId: 'run-1',
        cumulative: true,
        itemId: 'item-1',
        providerModelMetadata: {
          providerModel: 'qwen3:4b-instruct',
          providerModelLabel: 'Qwen 3 (4B Param)'
        }
      }
    })
  })

  it('ignores non-assistant and empty deltas', () => {
    expect(projectRunItemAssistantDelta(event({ channel: 'stdout' }))).toBeNull()
    expect(projectRunItemAssistantDelta(event({ delta: '' }))).toBeNull()
  })

  it('narrows assistant run item deltas', () => {
    expect(isAssistantRunItemDelta(event({}))).toBe(true)
    expect(isAssistantRunItemDelta(event({ kind: 'tool/progress' }))).toBe(false)
  })

  it('builds stable skip keys for projected legacy compat deltas', () => {
    expect(legacyAssistantDeltaProjectionKey('run-1', 'item-1', 'hello')).toBe(
      'run-1\u0000item-1\u0000hello'
    )
  })

  it('projects tool progress sidecars into tool use events', () => {
    const projection = projectRunItemToolEvent(
      event({
        kind: 'tool/progress',
        itemKind: undefined,
        channel: undefined,
        delta: undefined,
        itemId: 'tool-1',
        toolCallId: 'tool-1',
        toolName: 'read_file',
        status: 'running',
        data: { file_path: 'README.md' }
      }),
      'codex'
    )

    expect(projection).toMatchObject({
      chatId: 'chat-1',
      runId: 'run-1',
      itemId: 'tool-1',
      legacySkipKey: legacyToolEventProjectionKey('run-1', 'tool-1', false),
      event: {
        type: 'tool_event',
        name: 'read_file',
        isUse: true,
        isResult: false,
        data: {
          type: 'tool_use',
          tool_id: 'tool-1',
          tool_name: 'read_file',
          provider: 'codex'
        }
      }
    })
  })

  it('projects tool output sidecars into tool result events', () => {
    const projection = projectRunItemToolEvent(
      event({
        kind: 'tool/outputDelta',
        itemKind: undefined,
        channel: undefined,
        delta: 'done',
        itemId: 'tool-1',
        toolCallId: 'tool-1',
        toolName: 'read_file',
        status: 'success',
        output: 'done'
      }),
      'codex'
    )

    expect(projection).toMatchObject({
      legacySkipKey: legacyToolEventProjectionKey('run-1', 'tool-1', true),
      event: {
        type: 'tool_event',
        name: 'read_file',
        isUse: false,
        isResult: true,
        data: {
          type: 'tool_result',
          tool_id: 'tool-1',
          output: 'done',
          provider: 'codex'
        }
      }
    })
  })

  it('leaves visible progress compat events on the legacy path', () => {
    expect(
      projectRunItemToolEvent(
        event({
          kind: 'tool/progress',
          itemKind: undefined,
          channel: undefined,
          delta: undefined,
          itemId: 'progress-1',
          toolName: 'update_topic',
          data: { type: 'update_topic', title: 'Indexing', summary: 'Reading files' }
        }),
        'codex'
      )
    ).toBeNull()
  })
})
