import { describe, expect, it } from 'vitest'
import {
  isMutatingTaskWraithMcpTool,
  mcpToolAlwaysPrompts,
  pathsShareWorkspaceLineage,
  validateMcpCallerWorkspace,
  validateMutatingMcpRoute
} from './McpRouteGuards'

describe('MCP route guards', () => {
  it('treats workspace writes and app-state mutations as mutating', () => {
    expect(isMutatingTaskWraithMcpTool('write_file')).toBe(true)
    expect(isMutatingTaskWraithMcpTool('ensemble_fanout')).toBe(true)
    expect(isMutatingTaskWraithMcpTool('read_file')).toBe(false)
  })

  it('blocks unrouted mutating tools but keeps read tools eligible for fallback', () => {
    expect(validateMutatingMcpRoute('read_file', null)).toEqual({ ok: true })
    expect(validateMutatingMcpRoute('write_file', null)).toMatchObject({ ok: false })
    expect(validateMutatingMcpRoute('write_file', { appRunId: 'run-1' })).toEqual({ ok: true })
    expect(validateMutatingMcpRoute('ensemble_fanout', { appChatId: 'chat-1' })).toEqual({
      ok: true
    })
  })

  it('matches caller workspace lineage in either direction', () => {
    expect(pathsShareWorkspaceLineage('/repo/subdir', '/repo')).toBe(true)
    expect(pathsShareWorkspaceLineage('/repo', '/repo/subdir')).toBe(true)
    expect(pathsShareWorkspaceLineage('/other', '/repo')).toBe(false)
  })

  it('blocks mutating bridge calls when caller workspace differs from resolved run workspace', () => {
    expect(
      validateMcpCallerWorkspace({
        toolName: 'write_file',
        caller: { callerWorkspacePath: '/repo-a' },
        contextWorkspacePath: '/repo-b'
      })
    ).toMatchObject({ ok: false })
    expect(
      validateMcpCallerWorkspace({
        toolName: 'write_file',
        caller: { callerCwd: '/repo-a/subdir' },
        contextWorkspacePath: '/repo-a'
      })
    ).toEqual({ ok: true })
    expect(
      validateMcpCallerWorkspace({
        toolName: 'read_file',
        caller: { callerWorkspacePath: '/repo-a' },
        contextWorkspacePath: '/repo-b'
      })
    ).toEqual({ ok: true })
  })
})

describe('mcpToolAlwaysPrompts', () => {
  it('forces a human on every third-party channel, standing grants included', () => {
    for (const toolName of [
      'image_generate',
      'canvas_eval',
      // Reads are the INGRESS half of the same channel: a mailbox read puts a
      // stranger's words into the model's context.
      'outlook_list_messages',
      'outlook_search_messages',
      'outlook_get_message',
      'outlook_list_events',
      'outlook_create_draft',
      'outlook_create_event'
    ]) {
      expect(mcpToolAlwaysPrompts(toolName)).toBe(true)
    }
  })

  it('leaves ordinary workspace tools to the normal grant path', () => {
    expect(mcpToolAlwaysPrompts('write_file')).toBe(false)
    expect(mcpToolAlwaysPrompts('read_file')).toBe(false)
    // Global chats have no workspace to have granted anything, so they prompt.
    expect(mcpToolAlwaysPrompts('read_file', 'global')).toBe(true)
  })
})
