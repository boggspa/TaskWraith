import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { getWorkspaceActivitySnapshot } from '../WorkspaceActivityService'
import { registerWorkspaceActivityHandlers } from './workspaceActivityHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

vi.mock('../WorkspaceActivityService', () => ({
  getWorkspaceActivitySnapshot: vi.fn()
}))

const mockedHandle = vi.mocked(ipcMain.handle)
const mockedGetWorkspaceActivitySnapshot = vi.mocked(getWorkspaceActivitySnapshot)

beforeEach(() => {
  mockedHandle.mockReset()
  mockedGetWorkspaceActivitySnapshot.mockReset()
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

describe('registerWorkspaceActivityHandlers', () => {
  it('validates the workspace path before loading the activity snapshot', async () => {
    const snapshot = { workspacePath: '/repo/real', days: [] }
    mockedGetWorkspaceActivitySnapshot.mockResolvedValue(snapshot as any)
    const requireRegisteredWorkspace = vi.fn(() => '/repo/real')

    registerWorkspaceActivityHandlers({ requireRegisteredWorkspace })

    await expect(handlerFor('get-workspace-activity')({} as any, '/repo', 30)).resolves.toBe(
      snapshot
    )
    expect(requireRegisteredWorkspace).toHaveBeenCalledWith('/repo')
    expect(mockedGetWorkspaceActivitySnapshot).toHaveBeenCalledWith('/repo/real', 30)
  })
})
