import { describe, expect, it } from 'vitest'
import type { RunItemEvent } from '../../../shared/runItemEvents'
import {
  isAssistantRunItemDelta,
  legacyAssistantDeltaProjectionKey,
  legacyToolEventProjectionKey,
  legacyToolEventProjectionNameKey,
  projectRunItemToolEvents,
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
    const projections = projectRunItemToolEvents(
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
    const projection = projections[0]

    expect(projections).toHaveLength(1)
    expect(projection).toMatchObject({
      chatId: 'chat-1',
      runId: 'run-1',
      itemId: 'tool-1',
      legacySkipKey: legacyToolEventProjectionKey('run-1', 'tool-1', false),
      legacySkipKeys: [
        legacyToolEventProjectionKey('run-1', 'tool-1', false),
        legacyToolEventProjectionNameKey('run-1', 'read_file', false)
      ],
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
    const projections = projectRunItemToolEvents(
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
    const projection = projections[0]

    expect(projections).toHaveLength(1)
    expect(projection).toMatchObject({
      legacySkipKey: legacyToolEventProjectionKey('run-1', 'tool-1', true),
      legacySkipKeys: [
        legacyToolEventProjectionKey('run-1', 'tool-1', true),
        legacyToolEventProjectionNameKey('run-1', 'read_file', true)
      ],
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

  it('projects visible progress compat sidecars into paired tool use and result events', () => {
    const projections = projectRunItemToolEvents(
      event({
        kind: 'tool/progress',
        itemKind: undefined,
        channel: undefined,
        delta: undefined,
        itemId: 'progress-1',
        toolName: 'update_topic',
        data: {
          type: 'update_topic',
          title: 'Indexing',
          summary: 'Reading files',
          reasoning_trace: 'hidden'
        }
      }),
      'codex'
    )

    expect(projections).toHaveLength(2)
    expect(projections[0]).toMatchObject({
      legacySkipKeys: [
        legacyToolEventProjectionKey('run-1', 'progress-1', false),
        legacyToolEventProjectionNameKey('run-1', 'update_topic', false)
      ],
      event: {
        name: 'update_topic',
        isUse: true,
        isResult: false,
        data: {
          type: 'tool_use',
          tool_id: 'progress-1',
          tool_name: 'update_topic',
          parameters: {
            title: 'Indexing',
            kind: 'update_topic',
            summary: 'Reading files',
            type: 'update_topic'
          }
        }
      }
    })
    expect(projections[0]?.event.data.parameters).not.toHaveProperty('reasoning_trace')
    expect(projections[1]).toMatchObject({
      legacySkipKeys: [
        legacyToolEventProjectionKey('run-1', 'progress-1', true),
        legacyToolEventProjectionNameKey('run-1', 'update_topic', true)
      ],
      event: {
        name: 'update_topic',
        isUse: false,
        isResult: true,
        data: {
          type: 'tool_result',
          tool_id: 'progress-1',
          tool_name: 'update_topic',
          output: 'Reading files',
          status: 'success'
        }
      }
    })
  })

  it('keeps the single-projection wrapper for callers that only need the first tool event', () => {
    const projection = projectRunItemToolEvent(
      event({
        kind: 'tool/progress',
        itemKind: undefined,
        channel: undefined,
        delta: undefined,
        itemId: 'tool-1',
        toolCallId: 'tool-1',
        toolName: 'read_file'
      }),
      'codex'
    )

    expect(projection?.event.isUse).toBe(true)
  })
})
