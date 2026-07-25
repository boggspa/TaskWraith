import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  deleteOfficeDocument,
  readOfficeDocument,
  writeOfficeDocument
} from '../services/OfficeDocumentService'
import {
  registerOfficeDocumentHandlers,
  type OfficeDocumentHandlerDeps
} from './officeDocumentHandlers'
import type { WorkspaceRecord } from '../store/types'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../services/OfficeDocumentService', () => ({
  readOfficeDocument: vi.fn(),
  writeOfficeDocument: vi.fn(),
  deleteOfficeDocument: vi.fn()
}))

type RegisteredHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>

const mockedHandle = vi.mocked(ipcMain.handle)
const mockedRead = vi.mocked(readOfficeDocument)
const mockedWrite = vi.mocked(writeOfficeDocument)

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function makeDeps(overrides: Partial<OfficeDocumentHandlerDeps> = {}): OfficeDocumentHandlerDeps {
  return {
    requireRegisteredWorkspace: vi.fn((workspacePath: string) => `/registered${workspacePath}`),
    assertSenderScope: vi.fn(),
    findRegisteredWorkspace: vi.fn(
      () => ({ id: 'ws-1', path: '/registered/ws' }) as unknown as WorkspaceRecord
    ),
    recordWorkspaceEditorChange: vi.fn(),
    scheduleRemoteGitSnapshotRefresh: vi.fn(),
    ...overrides
  }
}

const fakeEvent = {} as IpcMainInvokeEvent

describe('registerOfficeDocumentHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers all office channels', () => {
    registerOfficeDocumentHandlers(makeDeps())
    const channels = mockedHandle.mock.calls.map(([channel]) => channel)
    expect(channels).toEqual([
      'office:read-document',
      'office:write-document',
      'office:delete-document'
    ])
  })

  it('normalizes the workspace, asserts read scope, then reads', async () => {
    const deps = makeDeps()
    registerOfficeDocumentHandlers(deps)
    const readResult = { path: 'a.docx' }
    mockedRead.mockResolvedValue(readResult as never)

    const result = await handlerFor('office:read-document')(fakeEvent, '/ws', 'a.docx')

    expect(deps.requireRegisteredWorkspace).toHaveBeenCalledWith('/ws')
    expect(deps.assertSenderScope).toHaveBeenCalledWith(fakeEvent, {
      capability: 'workspace-file',
      workspacePath: '/registered/ws',
      operation: 'read'
    })
    expect(mockedRead).toHaveBeenCalledWith('/registered/ws', 'a.docx')
    expect(result).toBe(readResult)
  })

  it('asserts write scope, forwards the model and refreshes the git snapshot', async () => {
    const deps = makeDeps()
    registerOfficeDocumentHandlers(deps)
    const writeResult = { path: 'a.docx', etag: 'sha256:x' }
    mockedWrite.mockResolvedValue(writeResult as never)
    const model = { kind: 'word', blocks: [] }

    const result = await handlerFor('office:write-document')(
      fakeEvent,
      '/ws',
      'a.docx',
      model,
      'sha256:prev'
    )

    expect(deps.assertSenderScope).toHaveBeenCalledWith(fakeEvent, {
      capability: 'workspace-file',
      workspacePath: '/registered/ws',
      operation: 'write'
    })
    expect(mockedWrite).toHaveBeenCalledWith({
      workspacePath: '/registered/ws',
      workspaceId: 'ws-1',
      filePath: 'a.docx',
      model,
      baseEtag: 'sha256:prev',
      recordChange: deps.recordWorkspaceEditorChange
    })
    expect(deps.scheduleRemoteGitSnapshotRefresh).toHaveBeenCalledWith('ws-1', {
      delayMs: 50,
      force: true
    })
    expect(result).toBe(writeResult)
  })

  it('asserts write scope for deletes and refreshes the git snapshot', async () => {
    const deps = makeDeps()
    registerOfficeDocumentHandlers(deps)
    const deleteResult = { path: 'a.docx' }
    vi.mocked(deleteOfficeDocument).mockResolvedValue(deleteResult as never)

    const result = await handlerFor('office:delete-document')(
      fakeEvent,
      '/ws',
      'a.docx',
      'sha256:prev'
    )

    expect(deps.assertSenderScope).toHaveBeenCalledWith(fakeEvent, {
      capability: 'workspace-file',
      workspacePath: '/registered/ws',
      operation: 'write'
    })
    expect(vi.mocked(deleteOfficeDocument)).toHaveBeenCalledWith({
      workspacePath: '/registered/ws',
      workspaceId: 'ws-1',
      filePath: 'a.docx',
      baseEtag: 'sha256:prev',
      recordChange: deps.recordWorkspaceEditorChange
    })
    expect(deps.scheduleRemoteGitSnapshotRefresh).toHaveBeenCalledWith('ws-1', {
      delayMs: 50,
      force: true
    })
    expect(result).toBe(deleteResult)
  })

  it('propagates scope failures without touching the service', async () => {
    const deps = makeDeps({
      assertSenderScope: vi.fn(() => {
        throw new Error('scope denied')
      })
    })
    registerOfficeDocumentHandlers(deps)
    await expect(handlerFor('office:read-document')(fakeEvent, '/ws', 'a.docx')).rejects.toThrow(
      'scope denied'
    )
    expect(mockedRead).not.toHaveBeenCalled()
  })
})
