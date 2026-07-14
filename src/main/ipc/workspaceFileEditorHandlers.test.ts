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
    assertSenderScope: vi.fn(),
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
    expect(deps.assertSenderScope).toHaveBeenCalledWith(
      {},
      {
        capability: 'workspace-file',
        workspacePath: '/repo/real',
        operation: 'read'
      }
    )
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
        includeDirectories: false,
        limit: 25
      })
    ).resolves.toBe(result)
    expect(deps.assertSenderScope).toHaveBeenCalledWith(
      {},
      {
        capability: 'workspace-file',
        workspacePath: '/repo/real',
        operation: 'read'
      }
    )
    expect(mockedListWorkspaceFiles).toHaveBeenCalledWith('/repo/real', {
      path: 'src',
      query: 'App',
      includeDirectories: false,
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
    expect(deps.assertSenderScope).toHaveBeenCalledWith(
      {},
      {
        capability: 'workspace-file',
        workspacePath: '/repo/real',
        operation: 'read'
      }
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
    expect(deps.assertSenderScope).toHaveBeenCalledWith(
      {},
      {
        capability: 'workspace-file',
        workspacePath: '/repo/real',
        operation: 'write'
      }
    )
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
    expect(deps.assertSenderScope).toHaveBeenCalledWith(
      {},
      {
        capability: 'workspace-file',
        workspacePath: '/repo/real',
        operation: 'write'
      }
    )
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

  it.each([
    ['list-workspace-files', []],
    ['list-workspace-files-for-editor', [{}]],
    ['read-workspace-file', ['README.md']],
    ['write-workspace-file', ['README.md', 'updated', 'etag-1']],
    ['delete-workspace-file', ['README.md', 'etag-1']]
  ] as const)(
    'rejects a Test 1 popout attempting %s against Test 2 before filesystem access',
    async (channel, args) => {
      const test1Popout = { sender: { id: 101 } }
      const deps = createDeps({
        requireRegisteredWorkspace: vi.fn((requestedPath: string) => requestedPath),
        assertSenderScope: vi.fn((event, input) => {
          if (event.sender.id === 101 && input.workspacePath === '/repo/Test2') {
            throw new Error('Renderer workspace ownership does not match this request.')
          }
        })
      })
      registerWorkspaceFileEditorHandlers(deps)

      await expect(
        handlerFor(channel)(test1Popout, '/repo/Test2', ...args)
      ).rejects.toThrow('Renderer workspace ownership does not match this request.')

      expect(deps.assertSenderScope).toHaveBeenCalledWith(test1Popout, {
        capability: 'workspace-file',
        workspacePath: '/repo/Test2',
        operation:
          channel === 'write-workspace-file' || channel === 'delete-workspace-file'
            ? 'write'
            : 'read'
      })
      expect(mockedListWorkspaceFiles).not.toHaveBeenCalled()
      expect(mockedReadWorkspaceFile).not.toHaveBeenCalled()
      expect(mockedWriteWorkspaceFile).not.toHaveBeenCalled()
      expect(mockedDeleteWorkspaceFile).not.toHaveBeenCalled()
      expect(deps.recordWorkspaceEditorChange).not.toHaveBeenCalled()
      expect(deps.findRegisteredWorkspace).not.toHaveBeenCalled()
      expect(deps.scheduleRemoteGitSnapshotRefresh).not.toHaveBeenCalled()
    }
  )
})
