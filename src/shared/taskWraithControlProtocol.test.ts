import { describe, expect, it } from 'vitest'
import {
  TASKWRAITH_CONTROL_CLIENT_NAME,
  TASKWRAITH_CONTROL_PROTOCOL_VERSION,
  decodeTaskWraithControlClientMessage
} from './taskWraithControlProtocol'

describe('TaskWraith local-control protocol decoder', () => {
  it('accepts the versioned hello and bounded request surface', () => {
    expect(
      decodeTaskWraithControlClientMessage({
        type: 'hello',
        protocolVersion: TASKWRAITH_CONTROL_PROTOCOL_VERSION,
        client: TASKWRAITH_CONTROL_CLIENT_NAME,
        clientVersion: '0.1.0',
        token: 'secret',
        capabilities: ['snapshot']
      }).ok
    ).toBe(true)
    expect(
      decodeTaskWraithControlClientMessage({
        type: 'request',
        id: 'request-1',
        method: 'thread.select',
        params: { threadId: 'thread-1', limit: 80 }
      }).ok
    ).toBe(true)
  })

  it('rejects unknown methods, oversized prompts, and unbounded transcript limits', () => {
    expect(
      decodeTaskWraithControlClientMessage({
        type: 'request',
        id: 'request-1',
        method: 'provider.delete',
        params: {}
      })
    ).toMatchObject({ ok: false, error: 'unknown request method' })
    expect(
      decodeTaskWraithControlClientMessage({
        type: 'request',
        id: 'request-2',
        method: 'composer.send',
        params: { threadId: 'thread-1', text: 'x'.repeat(12_001) }
      })
    ).toMatchObject({ ok: false, error: 'composer text is required' })
    expect(
      decodeTaskWraithControlClientMessage({
        type: 'request',
        id: 'request-3',
        method: 'thread.select',
        params: { threadId: 'thread-1', limit: 201 }
      })
    ).toMatchObject({
      ok: false,
      error: 'limit must be an integer from 1 to 200'
    })
  })
  it('accepts a bounded thread.find and rejects unbounded or unknown filters', () => {
    expect(
      decodeTaskWraithControlClientMessage({
        type: 'request',
        id: 'find-1',
        method: 'thread.find',
        params: {
          query: 'persistence',
          workspacePath: '/repo/packages/app',
          status: ['working', 'needs-input'],
          includeArchived: false,
          limit: 5
        }
      }).ok
    ).toBe(true)
    expect(
      decodeTaskWraithControlClientMessage({ type: 'request', id: 'find-2', method: 'thread.find' })
        .ok
    ).toBe(true)
    expect(
      decodeTaskWraithControlClientMessage({
        type: 'request',
        id: 'find-3',
        method: 'thread.find',
        params: { limit: 101 }
      })
    ).toMatchObject({ ok: false, error: 'limit must be an integer from 1 to 100' })
    expect(
      decodeTaskWraithControlClientMessage({
        type: 'request',
        id: 'find-4',
        method: 'thread.find',
        params: { status: ['working', 'exploded'] }
      })
    ).toMatchObject({ ok: false, error: 'status must list known thread statuses' })
    expect(
      decodeTaskWraithControlClientMessage({
        type: 'request',
        id: 'find-5',
        method: 'thread.find',
        params: { query: 'x'.repeat(201) }
      })
    ).toMatchObject({ ok: false, error: 'query must be a bounded string' })
  })
})
