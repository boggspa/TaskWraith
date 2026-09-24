import { describe, expect, it } from 'vitest'

import {
  CODEX_THREAD_MCP_ROUTE_CONFIG_KEY,
  CODEX_THREAD_UNSUBSCRIBE_METHOD,
  buildCodexThreadMcpRouteEnv,
  isCodexThreadUnsubscribeResult
} from './CodexThreadMcpRouteEnv'

describe('Codex per-thread MCP route env', () => {
  it('stamps the exact run route and optional chat/workspace context', () => {
    expect(
      buildCodexThreadMcpRouteEnv({
        mcpBridgeEnabled: true,
        appRunId: 'run-1',
        appChatId: 'chat-1',
        workspacePath: '/workspace'
      })
    ).toEqual({
      TASKWRAITH_PARENT_PROVIDER: 'codex',
      TASKWRAITH_RUN_ID: 'run-1',
      TASKWRAITH_CHAT_ID: 'chat-1',
      TASKWRAITH_WORKSPACE_PATH: '/workspace'
    })
  })

  it('omits absent optional fields and trims route values', () => {
    expect(
      buildCodexThreadMcpRouteEnv({
        mcpBridgeEnabled: true,
        appRunId: ' run-1 ',
        appChatId: '   ',
        workspacePath: ''
      })
    ).toEqual({ TASKWRAITH_PARENT_PROVIDER: 'codex', TASKWRAITH_RUN_ID: 'run-1' })
  })

  it('stamps nothing when the bridge is unavailable or the exact run id is absent', () => {
    expect(
      buildCodexThreadMcpRouteEnv({
        mcpBridgeEnabled: false,
        appRunId: 'run-1',
        appChatId: 'chat-1',
        workspacePath: '/workspace'
      })
    ).toBeNull()
    expect(
      buildCodexThreadMcpRouteEnv({
        mcpBridgeEnabled: true,
        appRunId: ' ',
        appChatId: 'chat-1',
        workspacePath: '/workspace'
      })
    ).toBeNull()
  })

  it('names the live TaskWraith bridge config key', () => {
    expect(CODEX_THREAD_MCP_ROUTE_CONFIG_KEY).toBe('mcp_servers.TaskWraith.env')
    expect(CODEX_THREAD_UNSUBSCRIBE_METHOD).toBe('thread/unsubscribe')
  })

  it('accepts only the app-server unsubscribe acknowledgement statuses', () => {
    expect(isCodexThreadUnsubscribeResult({ status: 'unsubscribed' })).toBe(true)
    expect(isCodexThreadUnsubscribeResult({ status: 'notSubscribed' })).toBe(true)
    expect(isCodexThreadUnsubscribeResult({ status: 'notLoaded' })).toBe(true)
    expect(isCodexThreadUnsubscribeResult({ status: 'unknown' })).toBe(false)
    expect(isCodexThreadUnsubscribeResult(null)).toBe(false)
  })
})
