import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { getCachedWorkspaceActivitySnapshot } from '../WorkspaceActivityBackground'
import { registerWorkspaceActivityHandlers } from './workspaceActivityHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

vi.mock('../WorkspaceActivityBackground', () => ({
  getCachedWorkspaceActivitySnapshot: vi.fn()
}))

const mockedHandle = vi.mocked(ipcMain.handle)
const mockedGetCachedWorkspaceActivitySnapshot = vi.mocked(getCachedWorkspaceActivitySnapshot)

beforeEach(() => {
  mockedHandle.mockReset()
  mockedGetCachedWorkspaceActivitySnapshot.mockReset()
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
    mockedGetCachedWorkspaceActivitySnapshot.mockReturnValue(snapshot as any)
    const requireRegisteredWorkspace = vi.fn(() => '/repo/real')
    const assertSenderScope = vi.fn()

    registerWorkspaceActivityHandlers({ requireRegisteredWorkspace, assertSenderScope })

    await expect(handlerFor('get-workspace-activity')({} as any, '/repo', 30)).resolves.toBe(
      snapshot
    )
    expect(requireRegisteredWorkspace).toHaveBeenCalledWith('/repo')
    expect(assertSenderScope).toHaveBeenCalledWith(expect.anything(), '/repo')
    expect(mockedGetCachedWorkspaceActivitySnapshot).toHaveBeenCalledWith('/repo/real', 30)
  })

  it('rejects another renderer workspace before loading activity', async () => {
    const assertSenderScope = vi.fn(() => {
      throw new Error('wrong workspace owner')
    })
    registerWorkspaceActivityHandlers({
      requireRegisteredWorkspace: vi.fn(() => '/repo/real'),
      assertSenderScope
    })

    await expect(handlerFor('get-workspace-activity')({} as any, '/repo', 30)).rejects.toThrow(
      'wrong workspace owner'
    )
    expect(mockedGetCachedWorkspaceActivitySnapshot).not.toHaveBeenCalled()
  })
})
