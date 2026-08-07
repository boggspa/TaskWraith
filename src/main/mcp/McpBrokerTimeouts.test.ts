import { describe, expect, it } from 'vitest'
import {
  MCP_BROKER_ASK_USER_QUESTION_TIMEOUT_MS,
  MCP_BROKER_LONG_POLL_TIMEOUT_MS,
  MCP_BROKER_REQUEST_TIMEOUT_MS,
  mcpBrokerRequestTimeoutMsFor
} from './McpBrokerTimeouts'

describe('mcpBrokerRequestTimeoutMsFor', () => {
  it('grants the long-poll budget to ensemble_await tool calls', () => {
    expect(
      mcpBrokerRequestTimeoutMsFor({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'ensemble_await', arguments: { timeoutSeconds: 600 } }
      })
    ).toBe(MCP_BROKER_LONG_POLL_TIMEOUT_MS)
  })

  it('grants the ask-user budget so brokered seats can wait the full card TTL', () => {
    expect(
      mcpBrokerRequestTimeoutMsFor({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'ask_user_question', arguments: { question: 'Continue?' } }
      })
    ).toBe(MCP_BROKER_ASK_USER_QUESTION_TIMEOUT_MS)
  })

  it('keeps the standard budget for other tools, methods, and unparseable requests', () => {
    expect(
      mcpBrokerRequestTimeoutMsFor({
        method: 'tools/call',
        params: { name: 'ensemble_lane_result' }
      })
    ).toBe(MCP_BROKER_REQUEST_TIMEOUT_MS)
    expect(mcpBrokerRequestTimeoutMsFor({ method: 'tools/list' })).toBe(
      MCP_BROKER_REQUEST_TIMEOUT_MS
    )
    // A hostile/malformed shape must fail toward the CONSERVATIVE budget.
    expect(mcpBrokerRequestTimeoutMsFor({ method: 'tools/call', params: { name: 42 } })).toBe(
      MCP_BROKER_REQUEST_TIMEOUT_MS
    )
    expect(mcpBrokerRequestTimeoutMsFor('tools/call ensemble_await')).toBe(
      MCP_BROKER_REQUEST_TIMEOUT_MS
    )
    expect(mcpBrokerRequestTimeoutMsFor(null)).toBe(MCP_BROKER_REQUEST_TIMEOUT_MS)
  })

  it('long-poll grace stays ahead of the await clamp ceiling', () => {
    // 600s ensemble_await ceiling + 30s grace — the broker kill must remain a
    // liveness backstop, never the effective cap.
    expect(MCP_BROKER_LONG_POLL_TIMEOUT_MS).toBe(630_000)
    expect(MCP_BROKER_LONG_POLL_TIMEOUT_MS).toBeGreaterThan(600_000)
  })

  it('ask-user broker grace stays ahead of the 12-minute card TTL', () => {
    expect(MCP_BROKER_ASK_USER_QUESTION_TIMEOUT_MS).toBe(750_000)
    expect(MCP_BROKER_ASK_USER_QUESTION_TIMEOUT_MS).toBeGreaterThan(12 * 60 * 1000)
  })
})
