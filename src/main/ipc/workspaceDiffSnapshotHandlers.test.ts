import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { captureWorkspaceSnapshot, getWorkspaceDiff } from '../DiffService'
import { registerWorkspaceDiffSnapshotHandlers } from './workspaceDiffSnapshotHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

vi.mock('../DiffService', () => ({
  getWorkspaceDiff: vi.fn(),
  captureWorkspaceSnapshot: vi.fn()
}))

const mockedHandle = vi.mocked(ipcMain.handle)
const mockedGetWorkspaceDiff = vi.mocked(getWorkspaceDiff)
const mockedCaptureWorkspaceSnapshot = vi.mocked(captureWorkspaceSnapshot)

beforeEach(() => {
  mockedHandle.mockReset()
  mockedGetWorkspaceDiff.mockReset()
  mockedCaptureWorkspaceSnapshot.mockReset()
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

describe('registerWorkspaceDiffSnapshotHandlers', () => {
  it('validates the workspace path before loading workspace diff', async () => {
    const diff = { type: 'no_changes', text: 'No changes were made.' }
    mockedGetWorkspaceDiff.mockResolvedValue(diff)
    const requireRegisteredWorkspace = vi.fn(() => '/repo/real')

    registerWorkspaceDiffSnapshotHandlers({ requireRegisteredWorkspace })

    await expect(handlerFor('get-diff')({} as any, '/repo')).resolves.toBe(diff)
    expect(requireRegisteredWorkspace).toHaveBeenCalledWith('/repo')
    expect(mockedGetWorkspaceDiff).toHaveBeenCalledWith('/repo/real')
  })

  it('validates the workspace path before capturing snapshots', async () => {
    const snapshot = {
      runId: 'run-1',
      capturedAt: '2026-06-27T16:00:00.000Z',
      isGitRepo: true,
      files: []
    }
    mockedCaptureWorkspaceSnapshot.mockResolvedValue(snapshot as any)
    const requireRegisteredWorkspace = vi.fn(() => '/repo/real')

    registerWorkspaceDiffSnapshotHandlers({ requireRegisteredWorkspace })

    await expect(handlerFor('capture-snapshot')({} as any, '/repo')).resolves.toBe(snapshot)
    expect(requireRegisteredWorkspace).toHaveBeenCalledWith('/repo')
    expect(mockedCaptureWorkspaceSnapshot).toHaveBeenCalledWith('/repo/real')
  })
})
