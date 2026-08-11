import { describe, it, expect, afterEach, vi } from 'vitest'
import { createHash } from 'crypto'
import {
  WIRE_PROMPT_EVENT_PAYLOAD_TYPE,
  configureWirePromptCapture,
  emitWirePromptCapture
} from './WirePromptEvents'

afterEach(() => configureWirePromptCapture(null))

describe('emitWirePromptCapture', () => {
  it('appends a metadata-only lifecycle payload when raw-event storage is off', () => {
    const appendForRoute = vi.fn()
    configureWirePromptCapture({ appendForRoute, storeContent: () => false })
    emitWirePromptCapture({
      appRunId: 'run-1',
      appChatId: 'chat-1',
      provider: 'grok',
      transport: 'grok-acp',
      part: 'user',
      text: 'wire text',
      transforms: ['mode-preamble']
    })
    expect(appendForRoute).toHaveBeenCalledTimes(1)
    const [provider, route, summary, payload] = appendForRoute.mock.calls[0]
    expect(provider).toBe('grok')
    expect(route).toEqual({ appRunId: 'run-1', appChatId: 'chat-1' })
    expect(summary).toContain('grok-acp')
    expect(payload.type).toBe(WIRE_PROMPT_EVENT_PAYLOAD_TYPE)
    expect(payload.sha256).toBe(createHash('sha256').update('wire text', 'utf8').digest('hex'))
    expect(payload.bytes).toBe(Buffer.byteLength('wire text'))
    expect(payload.transforms).toEqual(['mode-preamble'])
    expect(payload.content).toBeUndefined()
    expect(payload.attempt).toBe(1)
  })

  it('stores the wire text when raw-event storage is on', () => {
    const appendForRoute = vi.fn()
    configureWirePromptCapture({ appendForRoute, storeContent: () => true })
    emitWirePromptCapture({
      appRunId: 'run-1',
      provider: 'ollama',
      transport: 'ollama-api',
      part: 'system',
      text: 'system message',
      attempt: 2
    })
    const payload = appendForRoute.mock.calls[0][3]
    expect(payload.content).toBe('system message')
    expect(payload.attempt).toBe(2)
  })

  it('no-ops when unconfigured or without a run id, and never throws on appender failure', () => {
    expect(() =>
      emitWirePromptCapture({
        appRunId: 'run-1',
        provider: 'grok',
        transport: 'grok-acp',
        part: 'user',
        text: 'x'
      })
    ).not.toThrow()
    const appendForRoute = vi.fn(() => {
      throw new Error('disk full')
    })
    configureWirePromptCapture({ appendForRoute, storeContent: () => false })
    emitWirePromptCapture({
      appRunId: undefined,
      provider: 'grok',
      transport: 'grok-acp',
      part: 'user',
      text: 'x'
    })
    expect(appendForRoute).not.toHaveBeenCalled()
    expect(() =>
      emitWirePromptCapture({
        appRunId: 'run-1',
        provider: 'grok',
        transport: 'grok-acp',
        part: 'user',
        text: 'x'
      })
    ).not.toThrow()
  })
})
