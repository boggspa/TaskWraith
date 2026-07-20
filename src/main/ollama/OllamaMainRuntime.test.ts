import { resolve } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { RunManager } from '../RunManager'
import type { AppSettings } from '../store/types'
import { createOllamaMainRuntime, type OllamaMainRuntimeDependencies } from './OllamaMainRuntime'

function dependencies(
  overrides: Partial<OllamaMainRuntimeDependencies> = {}
): OllamaMainRuntimeDependencies {
  const settings = {
    agenticServices: { mcpTools: 'ask' },
    ollamaModelPreflightAt: {}
  } as AppSettings
  return {
    store: {
      getSettings: () => settings,
      updateSettings: vi.fn(),
      getChat: () => null,
      saveChat: vi.fn(),
      getRunQueueJob: () => null
    },
    canonicalPath: resolve,
    canonicalExternalGrantPath: resolve,
    isPathInsideRoot: (root, candidate) => Boolean(root && candidate.startsWith(root)),
    getAgentToolContext: () => null,
    resolveGrantAwarePath: (_context, _provider, path) => path,
    resolveGrantAwarePathAuthority: () => {
      throw new Error('unexpected grant-aware read')
    },
    externalPathGrantForTarget: () => undefined,
    workspaceToolExecutors: {
      executeFindFiles: vi.fn(),
      executeWorkspaceSearch: vi.fn(),
      executeWorkspaceSymbols: vi.fn(),
      executeGitStatus: vi.fn(),
      executeGitDiff: vi.fn()
    },
    executeMcpTool: vi.fn(async () => ({ text: '{"ok":true}' })),
    registerRunSession: vi.fn(() => ({})),
    appendDurableRunEventForRoute: vi.fn(),
    sendAgentCompatLine: vi.fn(),
    sendAgentCompatError: vi.fn(),
    sendAgentCompatExit: vi.fn(),
    runManager: new RunManager(),
    emitProviderCapabilityWarnings: vi.fn(),
    runProvider: vi.fn(async () => {}),
    ...overrides
  }
}

describe('createOllamaMainRuntime', () => {
  it('delegates mutation tools to the shared MCP approval path with exact run identity', async () => {
    const deps = dependencies()
    const runtime = createOllamaMainRuntime(deps)

    const result = await runtime.executeLocalTool({
      toolName: 'write_file',
      arguments: { path: 'notes.md', content: 'hello', intent: 'save notes' },
      workspacePath: '/repo',
      appRunId: 'run-1',
      appChatId: 'chat-1'
    })

    expect(result).toMatchObject({ ok: true, output: '{"ok":true}' })
    expect(deps.executeMcpTool).toHaveBeenCalledWith(
      'write_file',
      { path: 'notes.md', content: 'hello', intent: 'save notes' },
      { appRunId: 'run-1', appChatId: 'chat-1' },
      'ollama'
    )
  })

  it('keeps capability gateway calls on the same routed MCP seam', async () => {
    const deps = dependencies()
    const runtime = createOllamaMainRuntime(deps)

    await runtime.executeLocalTool({
      toolName: 'capability_search',
      arguments: { query: 'inspect symbols' },
      workspacePath: '/repo',
      appRunId: 'run-gateway',
      appChatId: 'chat-gateway'
    })

    expect(deps.executeMcpTool).toHaveBeenCalledWith(
      'capability_search',
      { query: 'inspect symbols' },
      { appRunId: 'run-gateway', appChatId: 'chat-gateway' },
      'ollama'
    )
  })

  it('formats workspace search results without bypassing the scoped executor', async () => {
    const executeWorkspaceSearch = vi.fn(async () => ({
      matches: [
        { path: 'src/a.ts', line: 4, text: 'needle' },
        { path: 'src/b.ts', line: 9, text: 'needle again' }
      ],
      count: 3,
      truncated: true,
      exitCode: 0
    }))
    const deps = dependencies({
      workspaceToolExecutors: {
        ...dependencies().workspaceToolExecutors,
        executeWorkspaceSearch
      }
    })
    const runtime = createOllamaMainRuntime(deps)

    // Resolve once so Windows absolute form (e.g. D:\repo) matches production
    // canonicalPath(resolve) rather than a POSIX-only literal.
    const workspacePath = resolve('/repo')
    const result = await runtime.executeLocalTool({
      toolName: 'workspace_search',
      arguments: { query: 'needle' },
      workspacePath
    })

    expect(result).toMatchObject({ ok: true })
    expect(result.output).toBe(
      'src/a.ts:4: needle\nsrc/b.ts:9: needle again\n[search truncated at 3 results]'
    )
    expect(executeWorkspaceSearch).toHaveBeenCalledWith(
      { query: 'needle' },
      expect.objectContaining({ workspacePath }),
      workspacePath
    )
  })

  it('fails unknown tools closed with a typed structured error', async () => {
    const runtime = createOllamaMainRuntime(dependencies())
    const result = await runtime.executeLocalTool({
      toolName: 'not_a_tool' as never,
      arguments: {},
      workspacePath: '/repo'
    })

    expect(result).toMatchObject({
      ok: false,
      structuredContent: {
        ok: false,
        tool: 'not_a_tool'
      }
    })
    expect(result.output).toContain('not a recognized TaskWraith tool')
  })

  it('persists model preflight timestamps and emits only actionable warnings', () => {
    const deps = dependencies()
    const runtime = createOllamaMainRuntime(deps)
    runtime.markModelPreflightComplete(' model-a ')
    runtime.emitModelPreflight(
      {} as Electron.WebContents,
      {
        family: 'unknown',
        guidance: 'check model support',
        checks: [{ id: 'installed', ok: true, detail: 'installed' }],
        warnings: [
          { id: 'info', severity: 'info', title: 'Info', message: 'no action' },
          { id: 'warn', severity: 'warning', title: 'Warning', message: 'take action' }
        ]
      },
      { appRunId: 'run-1', appChatId: 'chat-1' }
    )

    expect(deps.store.updateSettings).toHaveBeenCalledWith({
      ollamaModelPreflightAt: { 'model-a': expect.any(Number) }
    })
    expect(deps.appendDurableRunEventForRoute).toHaveBeenCalledTimes(2)
    expect(deps.sendAgentCompatLine).toHaveBeenCalledOnce()
    expect(deps.sendAgentCompatLine).toHaveBeenCalledWith(
      expect.anything(),
      'ollama',
      expect.objectContaining({ severity: 'warning', title: 'Warning' }),
      { appRunId: 'run-1', appChatId: 'chat-1' }
    )
  })

  it('registers exact run state before invoking the provider transport', async () => {
    const registerRunSession = vi.fn(() => ({}))
    const runProvider = vi.fn<OllamaMainRuntimeDependencies['runProvider']>(async () => {})
    const deps = dependencies({ registerRunSession, runProvider })
    const runtime = createOllamaMainRuntime(deps)
    const sender = {} as Electron.WebContents

    await runtime.runProviderAdapter({ sender } as Electron.IpcMainInvokeEvent, {
      provider: 'ollama',
      scope: 'workspace',
      workspace: '/repo',
      prompt: 'hello',
      appRunId: 'run-1',
      appChatId: 'chat-1',
      approvalMode: 'plan',
      sessionTrust: false
    })

    expect(registerRunSession).toHaveBeenCalledWith(
      'ollama',
      sender,
      { appRunId: 'run-1', appChatId: 'chat-1' },
      '/repo',
      expect.objectContaining({
        provider: 'ollama',
        appRunId: 'run-1',
        appChatId: 'chat-1',
        approvalMode: 'plan',
        sessionTrust: false
      })
    )
    expect(runProvider).toHaveBeenCalledOnce()
    expect(runProvider.mock.calls[0]?.[3]).toEqual({
      appRunId: 'run-1',
      appChatId: 'chat-1'
    })
  })

  it('does not start transport when run-session registration is refused', async () => {
    const runProvider = vi.fn(async () => {})
    const runtime = createOllamaMainRuntime(
      dependencies({ registerRunSession: () => undefined, runProvider })
    )

    await runtime.runProviderAdapter(
      { sender: {} as Electron.WebContents } as Electron.IpcMainInvokeEvent,
      {
        provider: 'ollama',
        scope: 'workspace',
        workspace: '/repo',
        prompt: 'hello',
        appRunId: 'run-refused',
        appChatId: 'chat-1'
      }
    )

    expect(runProvider).not.toHaveBeenCalled()
  })
})
