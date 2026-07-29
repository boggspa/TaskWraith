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
    expect(isMutatingTaskWraithMcpTool('capability_search')).toBe(false)
    expect(
      isMutatingTaskWraithMcpTool('capability_invoke', {
        name: 'write_file',
        arguments: { path: 'x', content: 'body' }
      })
    ).toBe(true)
    expect(
      isMutatingTaskWraithMcpTool('capability_invoke', {
        name: 'read_file',
        arguments: { path: 'x' }
      })
    ).toBe(false)
    expect(isMutatingTaskWraithMcpTool('unknown_future_tool')).toBe(true)
  })

  it('blocks unrouted mutating tools but keeps read tools eligible for fallback', () => {
    expect(validateMutatingMcpRoute('read_file', null)).toEqual({ ok: true })
    expect(validateMutatingMcpRoute('write_file', null)).toMatchObject({ ok: false })
    expect(validateMutatingMcpRoute('write_file', { appRunId: 'run-1' })).toEqual({ ok: true })
    expect(validateMutatingMcpRoute('ensemble_fanout', { appChatId: 'chat-1' })).toEqual({
      ok: true
    })
    expect(
      validateMutatingMcpRoute('capability_invoke', null, {
        name: 'write_file',
        arguments: { path: 'x', content: 'body' }
      })
    ).toMatchObject({ ok: false })
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
        toolName: 'capability_invoke',
        toolArgs: {
          name: 'write_file',
          arguments: { path: 'x', content: 'body' }
        },
        caller: { callerWorkspacePath: '/repo-a' },
        contextWorkspacePath: '/repo-b'
      })
    ).toMatchObject({ ok: false })
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

  it('forces a human on every appearance WRITE, so no grant can silence a restyle', () => {
    // Not a third-party channel — this one mutates the window the human reads
    // later approvals in. Appearance writes ride the generic `mcpTools` service,
    // so without this ONE session grant on any unrelated MCP tool would let an
    // agent restyle silently and repeatedly. The user's rule for the capability
    // was "never auto-allow, never elevate"; forcePrompt is what spells it.
    expect(mcpToolAlwaysPrompts('theme_tokens_set')).toBe(true)
    expect(
      mcpToolAlwaysPrompts('capability_invoke', undefined, {
        name: 'theme_tokens_set',
        arguments: { tokens: {} }
      })
    ).toBe(true)
  })

  it('leaves reads — including the appearance read — on the normal grant path', () => {
    expect(mcpToolAlwaysPrompts('write_file')).toBe(false)
    expect(mcpToolAlwaysPrompts('read_file')).toBe(false)
    // Reading the current tokens reveals nothing the window is not already
    // showing the user, so it must NOT inherit the write's every-call prompt.
    expect(mcpToolAlwaysPrompts('theme_tokens_get')).toBe(false)
    // Global chats have no workspace to have granted anything, so they prompt.
    expect(mcpToolAlwaysPrompts('read_file', 'global')).toBe(true)
  })
})
