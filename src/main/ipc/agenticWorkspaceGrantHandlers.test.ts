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
  const settings = { bridgeDaemonEnabled: false } as AppSettings
  return {
    settings,
    permissionService: {
      upsertWorkspaceGrant: vi.fn(),
      removeWorkspaceGrant: vi.fn()
    },
    getSettings: vi.fn(() => settings),
    assertProviderId: vi.fn((provider: ProviderId) => provider),
    requireNonEmptyString: vi.fn((value: string) => value),
    assertAgenticServiceId: vi.fn((service: AgenticServiceId) => service)
  }
}

describe('registerAgenticWorkspaceGrantHandlers', () => {
  it('registers and executes the upsert grant handler', () => {
    const deps = createDeps()
    registerAgenticWorkspaceGrantHandlers(deps)

    expect(
      handlerFor('upsert-agentic-workspace-grant')({}, 'codex', '/tmp/workspace', 'fileChanges')
    ).toBe(deps.settings)

    expect(deps.assertProviderId).toHaveBeenCalledWith('codex')
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('/tmp/workspace', 'Workspace path')
    expect(deps.assertAgenticServiceId).toHaveBeenCalledWith('fileChanges')
    expect(deps.permissionService.upsertWorkspaceGrant).toHaveBeenCalledWith(
      'codex',
      '/tmp/workspace',
      'fileChanges'
    )
    expect(deps.getSettings).toHaveBeenCalledTimes(1)
  })

  it('registers and executes the remove grant handler', () => {
    const deps = createDeps()
    registerAgenticWorkspaceGrantHandlers(deps)
    expect(
      handlerFor('remove-agentic-workspace-grant')({}, 'claude', '/tmp/workspace-2', 'shellCommands')
    ).toBe(deps.settings)

    expect(deps.assertProviderId).toHaveBeenCalledWith('claude')
    expect(deps.requireNonEmptyString).toHaveBeenCalledWith('/tmp/workspace-2', 'Workspace path')
    expect(deps.assertAgenticServiceId).toHaveBeenCalledWith('shellCommands')
    expect(deps.permissionService.removeWorkspaceGrant).toHaveBeenCalledWith(
      'claude',
      '/tmp/workspace-2',
      'shellCommands'
    )
    expect(deps.getSettings).toHaveBeenCalledTimes(1)
  })
})
