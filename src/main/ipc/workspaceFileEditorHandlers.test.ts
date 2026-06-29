import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  deleteWorkspaceFile
} from '../services/WorkspaceFileEditorService'
import { registerWorkspaceFileEditorHandlers } from './workspaceFileEditorHandlers'
import type { WorkspaceRecord } from '../store/types'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

vi.mock('../services/WorkspaceFileEditorService', () => ({
  listWorkspaceFiles: vi.fn(),
  readWorkspaceFile: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  deleteWorkspaceFile: vi.fn()
}))

const mockedHandle = vi.mocked(ipcMain.handle)
const mockedListWorkspaceFiles = vi.mocked(listWorkspaceFiles)
const mockedReadWorkspaceFile = vi.mocked(readWorkspaceFile)
const mockedWriteWorkspaceFile = vi.mocked(writeWorkspaceFile)
const mockedDeleteWorkspaceFile = vi.mocked(deleteWorkspaceFile)

beforeEach(() => {
  mockedHandle.mockReset()
  mockedListWorkspaceFiles.mockReset()
  mockedReadWorkspaceFile.mockReset()
  mockedWriteWorkspaceFile.mockReset()
  mockedDeleteWorkspaceFile.mockReset()
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

function createDeps(
  overrides: Partial<Parameters<typeof registerWorkspaceFileEditorHandlers>[0]> = {}
) {
  return {
    requireRegisteredWorkspace: vi.fn(() => '/repo/real'),
    findRegisteredWorkspace: vi.fn(() => workspace('workspace-1')),
    recordWorkspaceEditorChange: vi.fn(),
    scheduleRemoteGitSnapshotRefresh: vi.fn(),
    ...overrides
  }
}

describe('registerWorkspaceFileEditorHandlers', () => {
  it('lists workspace files through the validated workspace path', async () => {
    const deps = createDeps()
    const entry = {
      path: 'src/App.tsx',
      name: 'App.tsx',
      isDirectory: false,
      depth: 1
    }
    mockedListWorkspaceFiles.mockResolvedValue({ entries: [entry], truncated: false })
    registerWorkspaceFileEditorHandlers(deps)

    await expect(handlerFor('list-workspace-files')({} as any, '/repo')).resolves.toEqual([entry])
    expect(deps.requireRegisteredWorkspace).toHaveBeenCalledWith('/repo')
    expect(mockedListWorkspaceFiles).toHaveBeenCalledWith('/repo/real')
  })

  it('lists editor files with sanitized directory/search options', async () => {
    const deps = createDeps()
    const result = { entries: [], truncated: false }
    mockedListWorkspaceFiles.mockResolvedValue(result)
    registerWorkspaceFileEditorHandlers(deps)

    await expect(
      handlerFor('list-workspace-files-for-editor')({} as any, '/repo', {
        path: 'src',
        query: 'App',
        limit: 25
      })
    ).resolves.toBe(result)
    expect(mockedListWorkspaceFiles).toHaveBeenCalledWith('/repo/real', {
      path: 'src',
      query: 'App',
      limit: 25
    })
  })

  it('reads workspace files through the validated workspace path', async () => {
    const deps = createDeps()
    const result = {
      path: 'README.md',
      content: 'hello',
      sizeBytes: 5
    }
    mockedReadWorkspaceFile.mockResolvedValue(result)
    registerWorkspaceFileEditorHandlers(deps)

    await expect(handlerFor('read-workspace-file')({} as any, '/repo', 'README.md')).resolves.toBe(
      result
    )
    expect(mockedReadWorkspaceFile).toHaveBeenCalledWith('/repo/real', 'README.md')
  })

  it('writes workspace files with change recording and remote git refresh scheduling', async () => {
    const deps = createDeps()
    const result = {
      path: 'README.md',
      content: 'updated',
      sizeBytes: 7
    }
    mockedWriteWorkspaceFile.mockResolvedValue(result)
    registerWorkspaceFileEditorHandlers(deps)

    await expect(
      handlerFor('write-workspace-file')({} as any, '/repo', 'README.md', 'updated', 'etag-1')
    ).resolves.toBe(result)
    expect(mockedWriteWorkspaceFile).toHaveBeenCalledWith({
      workspacePath: '/repo/real',
      filePath: 'README.md',
      content: 'updated',
      baseEtag: 'etag-1',
      origin: 'file-editor',
      recordChange: deps.recordWorkspaceEditorChange
    })
    expect(deps.findRegisteredWorkspace).toHaveBeenCalledWith('/repo/real')
    expect(deps.scheduleRemoteGitSnapshotRefresh).toHaveBeenCalledWith('workspace-1', {
      delayMs: 50,
      force: true
    })
  })

  it('deletes workspace files with change recording and remote git refresh scheduling', async () => {
    const deps = createDeps()
    const result = {
      path: 'README.md'
    }
    mockedDeleteWorkspaceFile.mockResolvedValue(result)
    registerWorkspaceFileEditorHandlers(deps)

    await expect(
      handlerFor('delete-workspace-file')({} as any, '/repo', 'README.md', 'etag-1')
    ).resolves.toBe(result)
    expect(mockedDeleteWorkspaceFile).toHaveBeenCalledWith({
      workspacePath: '/repo/real',
      filePath: 'README.md',
      baseEtag: 'etag-1',
      origin: 'file-editor',
      recordChange: deps.recordWorkspaceEditorChange
    })
    expect(deps.findRegisteredWorkspace).toHaveBeenCalledWith('/repo/real')
    expect(deps.scheduleRemoteGitSnapshotRefresh).toHaveBeenCalledWith('workspace-1', {
      delayMs: 50,
      force: true
    })
  })
})
