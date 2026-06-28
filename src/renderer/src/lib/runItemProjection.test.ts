import { describe, expect, it } from 'vitest'
import type { RunItemEvent } from '../../../shared/runItemEvents'
import {
  isAssistantRunItemDelta,
  legacyAssistantDeltaProjectionKey,
  projectRunItemAssistantDelta
} from './runItemProjection'

const event = (overrides: Partial<RunItemEvent>): RunItemEvent =>
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
})
