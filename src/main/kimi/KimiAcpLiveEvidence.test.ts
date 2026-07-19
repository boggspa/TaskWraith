import { describe, expect, it } from 'vitest'
import {
  hasDeniedFsRequest,
  hasDeniedToolCall,
  hasTerminalPermissionDenial,
  toolResultContainsPermissionDenial,
  type KimiLiveToolCallEvidence
} from './KimiAcpLiveEvidence'

function toolCall(overrides: Partial<KimiLiveToolCallEvidence> = {}): KimiLiveToolCallEvidence {
  return {
    id: 'tool-1',
    title: 'FetchURL',
    status: 'completed',
    rawFrames: [
      JSON.stringify({
        method: 'session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tool-1',
            status: 'completed',
            content: [{ type: 'text', text: 'Tool "FetchURL" was denied by permission rule.' }]
          }
        }
      })
    ],
    ...overrides
  }
}

describe('Kimi ACP live denial evidence', () => {
  it('accepts only a terminal tool result carrying the exact permission-denial outcome', () => {
    expect(hasTerminalPermissionDenial(toolCall())).toBe(true)
    expect(hasDeniedToolCall([toolCall()], 'FetchURL')).toBe(true)
  })

  it.each([
    ['pending call', { status: 'pending' }],
    ['generic upstream failure', { rawFrames: [JSON.stringify({ error: 'network unavailable' })] }],
    ['empty result', { rawFrames: [JSON.stringify({ status: 'failed', content: [] })] }],
    ['another tool denial', { title: 'WebSearch' }],
    ['malformed frame', { rawFrames: ['not-json'] }]
  ])('rejects %s as FetchURL denial evidence', (_label, overrides) => {
    const evidence = toolCall(overrides)
    expect(hasDeniedToolCall([evidence], 'FetchURL')).toBe(false)
  })

  it('accepts the sub-agent and policy denial message variants', () => {
    expect(
      hasTerminalPermissionDenial(
        toolCall({
          rawFrames: [
            JSON.stringify({
              method: 'session/update',
              params: {
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'tool-1',
                  status: 'completed',
                  result: { text: 'Tool "FetchURL" was denied.' }
                }
              }
            })
          ]
        })
      )
    ).toBe(true)
    expect(
      hasTerminalPermissionDenial(
        toolCall({
          status: 'failed',
          rawFrames: [
            JSON.stringify({
              method: 'session/update',
              params: {
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'tool-1',
                  status: 'failed',
                  error: {
                    message: 'Tool "FetchURL" was denied by permission policy. reason'
                  }
                }
              }
            })
          ]
        })
      )
    ).toBe(true)
  })

  it('rejects a denial phrase spoofed only in model-controlled tool input', () => {
    const spoofedInput = toolCall({
      rawFrames: [
        JSON.stringify({
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tool-1',
              title: 'FetchURL',
              rawInput: { url: 'https://example.invalid/Tool "FetchURL" was denied.' }
            }
          }
        }),
        JSON.stringify({
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tool-1',
              status: 'completed',
              content: [{ type: 'text', text: 'Request completed successfully.' }]
            }
          }
        })
      ]
    })

    expect(hasTerminalPermissionDenial(spoofedInput)).toBe(false)
    expect(toolResultContainsPermissionDenial(spoofedInput, 'FetchURL')).toBe(false)
  })

  it('binds an exact client-fs path request to its -32001 denial response', () => {
    const requests = [{ id: 41, method: 'fs/read_text_file' as const, path: '/outside/secret.txt' }]
    const errors = [
      {
        id: 41,
        code: -32001,
        message: 'Path is outside the granted workspace roots.'
      }
    ]
    expect(hasDeniedFsRequest(requests, errors, 'fs/read_text_file', '/outside/secret.txt')).toBe(
      true
    )
    expect(hasDeniedFsRequest(requests, errors, 'fs/read_text_file', '/outside/other.txt')).toBe(
      false
    )
    expect(
      hasDeniedFsRequest(
        requests,
        [{ ...errors[0], id: 42 }],
        'fs/read_text_file',
        requests[0].path
      )
    ).toBe(false)
  })

  it('requires the parent Agent result itself to carry the child denial', () => {
    const agent = toolCall({
      id: 'agent-1',
      title: 'Agent',
      rawFrames: [
        JSON.stringify({
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'agent-1',
              status: 'completed',
              content: [{ text: 'Tool "FetchURL" was denied. Child used no fallback.' }]
            }
          }
        })
      ]
    })
    expect(toolResultContainsPermissionDenial(agent, 'FetchURL')).toBe(true)
    expect(
      toolResultContainsPermissionDenial(
        {
          ...agent,
          rawFrames: [
            JSON.stringify({
              method: 'session/update',
              params: {
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'agent-1',
                  status: 'completed',
                  content: [{ text: 'child could not fetch' }]
                }
              }
            })
          ]
        },
        'FetchURL'
      )
    ).toBe(false)
  })
})
