import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerWorkspaceHandlers } from './workspaceHandlers'
import type { WorkspaceRecord } from '../store/types'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

function workspace(id: string, overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id,
    path: `/repo/${id}`,
    displayName: id,
    lastOpenedAt: 1,
    createdAt: 1,
    pinned: false,
    ...overrides
  }
}

function createDeps(overrides: Partial<Parameters<typeof registerWorkspaceHandlers>[0]> = {}) {
  return {
    workspaceService: {
      getWorkspaces: vi.fn(() => [workspace('workspace-1', { branch: 'main' })]),
      addOrUpdateWorkspace: vi.fn((path: string, partial?: Partial<WorkspaceRecord>) =>
        workspace('updated', { path, ...partial })
      ),
      removeWorkspace: vi.fn(),
      clearWorkspaces: vi.fn()
    },
    probeExternalPath: vi.fn(async () => ({ branch: 'main' })),
    broadcastWorkspaceUpdate: vi.fn(),
    broadcastWorkspaceList: vi.fn(),
    ...overrides
  }
}

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

describe('registerWorkspaceHandlers', () => {
  it('returns workspaces without probing when branch metadata is already present', async () => {
    const deps = createDeps()
    registerWorkspaceHandlers(deps)

    await expect(handlerFor('get-workspaces')({} as any)).resolves.toEqual([
      workspace('workspace-1', { branch: 'main' })
    ])
    expect(deps.probeExternalPath).not.toHaveBeenCalled()
    expect(deps.workspaceService.addOrUpdateWorkspace).not.toHaveBeenCalled()
  })

  it('backfills missing branch metadata on get-workspaces', async () => {
    const stale = workspace('stale')
    const refreshed = workspace('stale', { branch: 'feature' })
    const deps = createDeps({
      workspaceService: {
        ...createDeps().workspaceService,
        getWorkspaces: vi.fn().mockReturnValueOnce([stale]).mockReturnValueOnce([refreshed])
      },
      probeExternalPath: vi.fn(async () => ({ branch: 'feature' }))
    })
    registerWorkspaceHandlers(deps)

    await expect(handlerFor('get-workspaces')({} as any)).resolves.toEqual([refreshed])
    expect(deps.probeExternalPath).toHaveBeenCalledWith('/repo/stale')
    expect(deps.workspaceService.addOrUpdateWorkspace).toHaveBeenCalledWith('/repo/stale', {
      branch: 'feature'
    })
  })

  it('keeps the caller partial when branch probing fails during add-or-update', async () => {
    const deps = createDeps({
      probeExternalPath: vi.fn(async () => {
        throw new Error('probe failed')
      })
    })
    registerWorkspaceHandlers(deps)

    await expect(
      handlerFor('add-or-update-workspace')({} as any, '/repo/new', { pinned: true })
    ).resolves.toEqual(workspace('updated', { path: '/repo/new', pinned: true }))
    expect(deps.workspaceService.addOrUpdateWorkspace).toHaveBeenCalledWith('/repo/new', {
      pinned: true
    })
    expect(deps.broadcastWorkspaceUpdate).toHaveBeenCalledWith('updated')
  })

  it('uses probed branch metadata during add-or-update when the caller omits branch', async () => {
    const deps = createDeps({
      probeExternalPath: vi.fn(async () => ({ branch: 'feature' }))
    })
    registerWorkspaceHandlers(deps)

    await expect(
      handlerFor('add-or-update-workspace')({} as any, '/repo/new', { pinned: true })
    ).resolves.toEqual(workspace('updated', { path: '/repo/new', pinned: true, branch: 'feature' }))
    expect(deps.workspaceService.addOrUpdateWorkspace).toHaveBeenCalledWith('/repo/new', {
      pinned: true,
      branch: 'feature'
    })
    expect(deps.broadcastWorkspaceUpdate).toHaveBeenCalledWith('updated')
  })

  it('broadcasts workspace list updates for remove and clear', () => {
    const deps = createDeps()
    registerWorkspaceHandlers(deps)

    handlerFor('remove-workspace')({} as any, 'workspace-1')
    expect(deps.workspaceService.removeWorkspace).toHaveBeenCalledWith('workspace-1')
    expect(deps.broadcastWorkspaceList).toHaveBeenCalledTimes(1)

    handlerFor('clear-workspaces')({} as any)
    expect(deps.workspaceService.clearWorkspaces).toHaveBeenCalled()
    expect(deps.broadcastWorkspaceList).toHaveBeenCalledTimes(2)
  })
})
