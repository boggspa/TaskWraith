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
      clearWorkspaces: vi.fn(),
      selectWorkspace: vi.fn(async () => workspace('selected'))
    },
    probeExternalPath: vi.fn(async () => ({ branch: 'main' })),
    broadcastWorkspaceUpdate: vi.fn(),
    broadcastWorkspaceList: vi.fn(),
    resolveSenderWorkspaceReadScope: vi.fn(() => ({ kind: 'all' as const })),
    assertSenderCanManageWorkspaces: vi.fn(),
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
    expect(deps.assertSenderCanManageWorkspaces).not.toHaveBeenCalled()
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

  it('returns only the Test1 owner workspace and never probes Test3 for a secondary renderer', async () => {
    const test1 = workspace('test-1')
    const test3 = workspace('test-3')
    const refreshedTest1 = workspace('test-1', { branch: 'feature' })
    const deps = createDeps({
      workspaceService: {
        ...createDeps().workspaceService,
        getWorkspaces: vi
          .fn()
          .mockReturnValueOnce([test1, test3])
          .mockReturnValueOnce([refreshedTest1, test3])
      },
      probeExternalPath: vi.fn(async () => ({ branch: 'feature' })),
      resolveSenderWorkspaceReadScope: vi.fn(() => ({
        kind: 'workspace' as const,
        workspaceId: 'test-1'
      }))
    })
    registerWorkspaceHandlers(deps)

    await expect(handlerFor('get-workspaces')({ sender: { id: 41 } })).resolves.toEqual([
      refreshedTest1
    ])
    expect(deps.probeExternalPath).toHaveBeenCalledTimes(1)
    expect(deps.probeExternalPath).toHaveBeenCalledWith(test1.path)
    expect(deps.probeExternalPath).not.toHaveBeenCalledWith(test3.path)
    expect(deps.workspaceService.addOrUpdateWorkspace).toHaveBeenCalledTimes(1)
  })

  it('denies a secondary renderer without an owned workspace before enumeration', async () => {
    const deps = createDeps({
      resolveSenderWorkspaceReadScope: vi.fn(() => {
        throw new Error('Renderer has no workspace ownership for this request.')
      })
    })
    registerWorkspaceHandlers(deps)

    await expect(handlerFor('get-workspaces')({ sender: { id: 52 } })).rejects.toThrow(
      'Renderer has no workspace ownership for this request.'
    )
    expect(deps.workspaceService.getWorkspaces).not.toHaveBeenCalled()
    expect(deps.probeExternalPath).not.toHaveBeenCalled()
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

  it('rejects workspace mutations from an unauthorized secondary renderer', async () => {
    const secondaryEvent = { sender: { id: 42 } }
    const deps = createDeps({
      assertSenderCanManageWorkspaces: vi.fn((event) => {
        if ((event as typeof secondaryEvent).sender.id === secondaryEvent.sender.id) {
          throw new Error('Renderer cannot manage workspaces.')
        }
      })
    })
    registerWorkspaceHandlers(deps)

    await expect(
      handlerFor('add-or-update-workspace')(secondaryEvent, '/repo/new', { pinned: true })
    ).rejects.toThrow('Renderer cannot manage workspaces.')
    expect(() => handlerFor('remove-workspace')(secondaryEvent, 'workspace-1')).toThrow(
      'Renderer cannot manage workspaces.'
    )
    expect(() => handlerFor('clear-workspaces')(secondaryEvent)).toThrow(
      'Renderer cannot manage workspaces.'
    )
    await expect(handlerFor('select-workspace')(secondaryEvent)).rejects.toThrow(
      'Renderer cannot manage workspaces.'
    )

    expect(deps.assertSenderCanManageWorkspaces).toHaveBeenCalledTimes(4)
    expect(deps.probeExternalPath).not.toHaveBeenCalled()
    expect(deps.workspaceService.addOrUpdateWorkspace).not.toHaveBeenCalled()
    expect(deps.workspaceService.removeWorkspace).not.toHaveBeenCalled()
    expect(deps.workspaceService.clearWorkspaces).not.toHaveBeenCalled()
    expect(deps.workspaceService.selectWorkspace).not.toHaveBeenCalled()
    expect(deps.broadcastWorkspaceUpdate).not.toHaveBeenCalled()
    expect(deps.broadcastWorkspaceList).not.toHaveBeenCalled()
  })

  it('delegates workspace selection to the workspace service', async () => {
    const deps = createDeps()
    registerWorkspaceHandlers(deps)

    await expect(handlerFor('select-workspace')({} as any)).resolves.toEqual(
      workspace('selected')
    )
    expect(deps.workspaceService.selectWorkspace).toHaveBeenCalledTimes(1)
  })
})
