import { describe, expect, it } from 'vitest'
import {
  isMutatingTaskWraithMcpTool,
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
