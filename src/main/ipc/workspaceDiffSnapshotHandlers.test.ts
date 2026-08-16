import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  captureWorkspaceSnapshot,
  getCommitFilePreview,
  getGitRevisionDiff,
  getWorkspaceDiff
} from '../DiffService'
import { registerWorkspaceDiffSnapshotHandlers } from './workspaceDiffSnapshotHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

vi.mock('../DiffService', () => ({
  getWorkspaceDiff: vi.fn(),
  getCommitFilePreview: vi.fn(),
  getGitRevisionDiff: vi.fn(),
  captureWorkspaceSnapshot: vi.fn()
}))

const mockedHandle = vi.mocked(ipcMain.handle)
const mockedGetWorkspaceDiff = vi.mocked(getWorkspaceDiff)
const mockedGetCommitFilePreview = vi.mocked(getCommitFilePreview)
const mockedGetGitRevisionDiff = vi.mocked(getGitRevisionDiff)
const mockedCaptureWorkspaceSnapshot = vi.mocked(captureWorkspaceSnapshot)

beforeEach(() => {
  mockedHandle.mockReset()
  mockedGetWorkspaceDiff.mockReset()
  mockedGetCommitFilePreview.mockReset()
  mockedGetGitRevisionDiff.mockReset()
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
    const assertSenderScope = vi.fn()

    registerWorkspaceDiffSnapshotHandlers({ requireRegisteredWorkspace, assertSenderScope })

    await expect(handlerFor('get-diff')({} as any, '/repo')).resolves.toBe(diff)
    expect(requireRegisteredWorkspace).toHaveBeenCalledWith('/repo')
    expect(assertSenderScope).toHaveBeenCalledWith(
      expect.anything(),
      { capability: 'workspace-diff', workspacePath: '/repo/real' }
    )
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
    const resolveWorkspaceDiffPath = vi.fn(() => '/repo/real')
    const assertSenderScope = vi.fn()

    registerWorkspaceDiffSnapshotHandlers({
      requireRegisteredWorkspace,
      resolveWorkspaceDiffPath,
      assertSenderScope
    })

    await expect(handlerFor('capture-snapshot')({} as any, '/repo')).resolves.toBe(snapshot)
    expect(resolveWorkspaceDiffPath).toHaveBeenCalledWith('/repo')
    expect(requireRegisteredWorkspace).not.toHaveBeenCalled()
    expect(assertSenderScope).toHaveBeenCalledWith(
      expect.anything(),
      { capability: 'workspace-diff', workspacePath: '/repo/real' }
    )
    expect(mockedCaptureWorkspaceSnapshot).toHaveBeenCalledWith('/repo/real')
  })

  it('loads historical commit files through the same read-scoped workspace boundary', async () => {
    const preview = {
      ok: true as const,
      files: [{ path: 'src/app.ts', additions: 4, deletions: 1 }],
      totalFiles: 1
    }
    mockedGetCommitFilePreview.mockResolvedValue(preview)
    const requireRegisteredWorkspace = vi.fn(() => '/repo/real')
    const assertSenderScope = vi.fn()

    registerWorkspaceDiffSnapshotHandlers({ requireRegisteredWorkspace, assertSenderScope })

    const input = { workspacePath: '/repo', chatId: 'chat-1', commitHash: 'abc1234' }
    await expect(handlerFor('get-diff')({} as any, input)).resolves.toBe(preview)
    expect(assertSenderScope).toHaveBeenCalledWith(expect.anything(), {
      capability: 'workspace-diff',
      chatId: 'chat-1',
      workspacePath: '/repo/real'
    })
    expect(mockedGetCommitFilePreview).toHaveBeenCalledWith('/repo/real', 'abc1234')
    expect(mockedGetWorkspaceDiff).not.toHaveBeenCalled()
  })

  it('loads a historical revision diff through the same read-scoped workspace boundary', async () => {
    const diff = { type: 'changes', summaries: [{ path: 'src/app.ts' }] }
    mockedGetGitRevisionDiff.mockResolvedValue(diff as any)
    const requireRegisteredWorkspace = vi.fn(() => '/repo/real')
    const assertSenderScope = vi.fn()

    registerWorkspaceDiffSnapshotHandlers({ requireRegisteredWorkspace, assertSenderScope })

    const revision = { kind: 'commit' as const, commitHash: 'abc1234' }
    const input = { workspacePath: '/repo', chatId: 'chat-1', revision }
    await expect(handlerFor('get-diff')({} as any, input)).resolves.toBe(diff)
    expect(assertSenderScope).toHaveBeenCalledWith(expect.anything(), {
      capability: 'workspace-diff',
      chatId: 'chat-1',
      workspacePath: '/repo/real'
    })
    expect(mockedGetGitRevisionDiff).toHaveBeenCalledWith('/repo/real', revision)
    expect(mockedGetWorkspaceDiff).not.toHaveBeenCalled()
  })

  it('resolves a chat-scoped external repository before loading its diff', async () => {
    const diff = { type: 'changes', text: 'external changes' }
    mockedGetWorkspaceDiff.mockResolvedValue(diff)
    const requireRegisteredWorkspace = vi.fn()
    const resolveWorkspaceDiffPath = vi.fn(() => '/external/repo/real')
    const assertSenderScope = vi.fn()

    registerWorkspaceDiffSnapshotHandlers({
      requireRegisteredWorkspace,
      resolveWorkspaceDiffPath,
      assertSenderScope
    })

    const input = { repoPath: '/external/repo', chatId: 'chat-1' }
    await expect(handlerFor('get-diff')({} as any, input)).resolves.toBe(diff)
    expect(resolveWorkspaceDiffPath).toHaveBeenCalledWith(input)
    expect(requireRegisteredWorkspace).not.toHaveBeenCalled()
    expect(assertSenderScope).toHaveBeenCalledWith(
      expect.anything(),
      {
        capability: 'workspace-diff',
        chatId: 'chat-1',
        workspacePath: '/external/repo/real'
      }
    )
    expect(mockedGetWorkspaceDiff).toHaveBeenCalledWith('/external/repo/real')
  })
})
