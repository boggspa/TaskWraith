import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerAgenticWorkspaceGrantHandlers } from './agenticWorkspaceGrantHandlers'
import type { AppSettings, AgenticServiceId, ProviderId } from '../store/types'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createDeps() {
  const settings = {
    bridgeDaemonEnabled: false,
    compactDensity: true,
    claudeApiKey: 'secret-claude',
    codexUsageCredential: {
      accountId: 'account-1',
      encryptedAccessToken: 'secret-codex'
    }
  } as unknown as AppSettings
  return {
    settings,
    permissionService: {
      upsertWorkspaceGrant: vi.fn(),
      removeWorkspaceGrant: vi.fn()
    },
    getSettings: vi.fn(() => settings),
    assertProviderId: vi.fn((provider: ProviderId) => provider),
    assertLiveProviderId: vi.fn((provider: ProviderId) => provider),
    requireNonEmptyString: vi.fn((value: string) => value),
    assertAgenticServiceId: vi.fn((service: AgenticServiceId) => service),
    assertSenderCanManageAgenticWorkspaceGrants: vi.fn(
      (_event: unknown, workspacePath: string) => workspacePath
    )
  }
}

describe('registerAgenticWorkspaceGrantHandlers', () => {
  it('registers and executes the upsert grant handler', () => {
    const deps = createDeps()
    const event = { sender: { id: 1 } }
    registerAgenticWorkspaceGrantHandlers(deps)

    const result = handlerFor('upsert-agentic-workspace-grant')(
      event,
      'codex',
      '/tmp/workspace',
      'fileChanges'
    ) as AppSettings

    expect(result).toMatchObject({
      bridgeDaemonEnabled: false,
      compactDensity: true,
      codexUsageCredential: { accountId: 'account-1' }
    })
    expect(result).not.toHaveProperty('claudeApiKey')
    expect(result.codexUsageCredential).not.toHaveProperty('encryptedAccessToken')

    expect(deps.assertLiveProviderId).toHaveBeenCalledWith('codex')
    expect(deps.assertProviderId).not.toHaveBeenCalled()
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('/tmp/workspace', 'Workspace path')
    expect(deps.assertAgenticServiceId).toHaveBeenCalledWith('fileChanges')
    expect(deps.assertSenderCanManageAgenticWorkspaceGrants).toHaveBeenCalledWith(
      event,
      '/tmp/workspace'
    )
    expect(deps.permissionService.upsertWorkspaceGrant).toHaveBeenCalledWith(
      'codex',
      '/tmp/workspace',
      'fileChanges'
    )
    expect(deps.getSettings).toHaveBeenCalledTimes(1)
  })

  it('registers and executes the remove grant handler', () => {
    const deps = createDeps()
    const event = { sender: { id: 1 } }
    registerAgenticWorkspaceGrantHandlers(deps)
    const result = handlerFor('remove-agentic-workspace-grant')(
      event,
      'claude',
      '/tmp/workspace-2',
      'shellCommands'
    ) as AppSettings

    expect(result).toMatchObject({
      bridgeDaemonEnabled: false,
      compactDensity: true,
      codexUsageCredential: { accountId: 'account-1' }
    })
    expect(result).not.toHaveProperty('claudeApiKey')
    expect(result.codexUsageCredential).not.toHaveProperty('encryptedAccessToken')

    expect(deps.assertProviderId).toHaveBeenCalledWith('claude')
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('/tmp/workspace-2', 'Workspace path')
    expect(deps.assertAgenticServiceId).toHaveBeenCalledWith('shellCommands')
    expect(deps.assertSenderCanManageAgenticWorkspaceGrants).toHaveBeenCalledWith(
      event,
      '/tmp/workspace-2'
    )
    expect(deps.permissionService.removeWorkspaceGrant).toHaveBeenCalledWith(
      'claude',
      '/tmp/workspace-2',
      'shellCommands'
    )
    expect(deps.getSettings).toHaveBeenCalledTimes(1)
  })

  it('allows removing an agents-scoped workspace grant without provider assertion', () => {
    const deps = createDeps()
    const event = { sender: { id: 1 } }
    registerAgenticWorkspaceGrantHandlers(deps)
    const result = handlerFor('remove-agentic-workspace-grant')(
      event,
      'agents',
      '/tmp/workspace-2',
      'shellCommands'
    ) as AppSettings

    expect(deps.assertProviderId).not.toHaveBeenCalled()
    expect(deps.permissionService.removeWorkspaceGrant).toHaveBeenCalledWith(
      'agents',
      '/tmp/workspace-2',
      'shellCommands'
    )
    expect(result).toMatchObject({ bridgeDaemonEnabled: false })
  })

  it('grants Cursor workspace Tool Grants with full provider parity', () => {
    // Cursor's B-mode TaskWraith MCP broker routes tool calls through the
    // central approval gate, where resolvePermission honors workspace grants —
    // so grant upserts must work for Cursor exactly like every other provider.
    const deps = createDeps()
    const event = { sender: { id: 1 } }
    registerAgenticWorkspaceGrantHandlers(deps)

    expect(() =>
      handlerFor('upsert-agentic-workspace-grant')(event, 'cursor', '/tmp/workspace', 'fileChanges')
    ).not.toThrow()
    expect(deps.assertLiveProviderId).toHaveBeenCalledWith('cursor')
    expect(deps.permissionService.upsertWorkspaceGrant).toHaveBeenCalledWith(
      'cursor',
      '/tmp/workspace',
      'fileChanges'
    )

    expect(() =>
      handlerFor('remove-agentic-workspace-grant')(event, 'cursor', '/tmp/workspace', 'fileChanges')
    ).not.toThrow()
    expect(deps.assertProviderId).toHaveBeenCalledWith('cursor')
    expect(deps.permissionService.removeWorkspaceGrant).toHaveBeenCalledWith(
      'cursor',
      '/tmp/workspace',
      'fileChanges'
    )
  })

  it('rejects an upsert from a hostile secondary renderer before permission mutation', () => {
    const secondaryEvent = { sender: { id: 42 } }
    const deps = createDeps()
    deps.assertSenderCanManageAgenticWorkspaceGrants.mockImplementation((event) => {
      if (event === secondaryEvent) throw new Error('Renderer cannot manage agentic grants.')
      return '/tmp/workspace'
    })
    registerAgenticWorkspaceGrantHandlers(deps)

    expect(() =>
      handlerFor('upsert-agentic-workspace-grant')(
        secondaryEvent,
        'codex',
        '/tmp/workspace',
        'fileChanges'
      )
    ).toThrow('Renderer cannot manage agentic grants.')

    expect(deps.assertSenderCanManageAgenticWorkspaceGrants).toHaveBeenCalledWith(
      secondaryEvent,
      '/tmp/workspace'
    )
    expect(deps.permissionService.upsertWorkspaceGrant).not.toHaveBeenCalled()
    expect(deps.permissionService.removeWorkspaceGrant).not.toHaveBeenCalled()
    expect(deps.getSettings).not.toHaveBeenCalled()
  })

  it('rejects a removal from a hostile secondary renderer before permission mutation', () => {
    const secondaryEvent = { sender: { id: 43 } }
    const deps = createDeps()
    deps.assertSenderCanManageAgenticWorkspaceGrants.mockImplementation((event) => {
      if (event === secondaryEvent) throw new Error('Renderer cannot manage agentic grants.')
      return '/tmp/workspace-2'
    })
    registerAgenticWorkspaceGrantHandlers(deps)

    expect(() =>
      handlerFor('remove-agentic-workspace-grant')(
        secondaryEvent,
        'claude',
        '/tmp/workspace-2',
        'shellCommands'
      )
    ).toThrow('Renderer cannot manage agentic grants.')

    expect(deps.assertSenderCanManageAgenticWorkspaceGrants).toHaveBeenCalledWith(
      secondaryEvent,
      '/tmp/workspace-2'
    )
    expect(deps.permissionService.upsertWorkspaceGrant).not.toHaveBeenCalled()
    expect(deps.permissionService.removeWorkspaceGrant).not.toHaveBeenCalled()
    expect(deps.getSettings).not.toHaveBeenCalled()
  })
})
