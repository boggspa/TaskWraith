import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  deleteOfficeDocument,
  readExternalOfficeDocument,
  readOfficeDocument,
  writeExternalOfficeDocument,
  writeOfficeDocument
} from '../services/OfficeDocumentService'
import {
  OFFICE_EXTERNAL_GRANT_REQUIRED,
  registerOfficeDocumentHandlers,
  type OfficeDocumentHandlerDeps
} from './officeDocumentHandlers'
import type { ChatRecord, ExternalPathGrant, WorkspaceRecord } from '../store/types'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../services/OfficeDocumentService', () => ({
  readOfficeDocument: vi.fn(),
  writeOfficeDocument: vi.fn(),
  deleteOfficeDocument: vi.fn(),
  readExternalOfficeDocument: vi.fn(),
  writeExternalOfficeDocument: vi.fn()
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
    getChatForExternalGrants: vi.fn(() => ({ appChatId: 'chat-1' }) as unknown as ChatRecord),
    executableExternalPathGrantsForChat: vi.fn(() => [] as ExternalPathGrant[]),
    externalGrantAllowsPath: vi.fn(() => false),
    canonicalExternalGrantPath: vi.fn((value: string) => value),
    ...overrides
  }
}

/** Grant covering `path` with `access`, shaped like the signed records. */
function grantFor(path: string, access: 'read' | 'write'): ExternalPathGrant {
  return { id: `grant-${access}`, path, kind: 'file', access } as unknown as ExternalPathGrant
}

/** Dep set whose grants behave like the real containment check. */
function grantedDeps(grants: ExternalPathGrant[]): Partial<OfficeDocumentHandlerDeps> {
  return {
    executableExternalPathGrantsForChat: vi.fn(() => grants),
    externalGrantAllowsPath: vi.fn(
      (grant: ExternalPathGrant, targetPath: string, access: 'read' | 'write') =>
        grant.path === targetPath && (access === 'read' || grant.access === 'write')
    )
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
      'office:read-external-document',
      'office:write-external-document',
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

  describe('external documents', () => {
    const EXTERNAL = '/Users/me/Documents/brief.docx'

    it('reads a granted path and reports the strongest access', async () => {
      const deps = makeDeps(grantedDeps([grantFor(EXTERNAL, 'write')]))
      registerOfficeDocumentHandlers(deps)
      vi.mocked(readExternalOfficeDocument).mockResolvedValue({ path: EXTERNAL } as never)

      const result = await handlerFor('office:read-external-document')(fakeEvent, {
        chatId: 'chat-1',
        path: EXTERNAL
      })

      expect(vi.mocked(readExternalOfficeDocument)).toHaveBeenCalledWith(EXTERNAL)
      expect(deps.assertSenderScope).toHaveBeenCalledWith(fakeEvent, {
        capability: 'workspace-file',
        workspacePath: '/Users/me/Documents',
        operation: 'read'
      })
      expect(result).toMatchObject({ externalAccess: 'write' })
    })

    it('reports read-only access for read grants and refuses the write', async () => {
      const deps = makeDeps(grantedDeps([grantFor(EXTERNAL, 'read')]))
      registerOfficeDocumentHandlers(deps)
      vi.mocked(readExternalOfficeDocument).mockResolvedValue({ path: EXTERNAL } as never)

      const read = await handlerFor('office:read-external-document')(fakeEvent, {
        chatId: 'chat-1',
        path: EXTERNAL
      })
      expect(read).toMatchObject({ externalAccess: 'read' })

      await expect(
        handlerFor('office:write-external-document')(fakeEvent, {
          chatId: 'chat-1',
          path: EXTERNAL,
          model: { kind: 'word', blocks: [] },
          baseEtag: null
        })
      ).rejects.toThrow(OFFICE_EXTERNAL_GRANT_REQUIRED)
      expect(vi.mocked(writeExternalOfficeDocument)).not.toHaveBeenCalled()
    })

    it('refuses uncovered paths with the grant-required marker', async () => {
      const deps = makeDeps(grantedDeps([grantFor('/Users/me/Documents/other.docx', 'write')]))
      registerOfficeDocumentHandlers(deps)
      await expect(
        handlerFor('office:read-external-document')(fakeEvent, {
          chatId: 'chat-1',
          path: EXTERNAL
        })
      ).rejects.toThrow(OFFICE_EXTERNAL_GRANT_REQUIRED)
      expect(vi.mocked(readExternalOfficeDocument)).not.toHaveBeenCalled()
    })

    it('re-derives grants on the write itself so a mid-edit revoke wins', async () => {
      let grants = [grantFor(EXTERNAL, 'write')]
      const deps = makeDeps({
        ...grantedDeps([]),
        executableExternalPathGrantsForChat: vi.fn(() => grants),
        externalGrantAllowsPath: vi.fn(
          (grant: ExternalPathGrant, targetPath: string, access: 'read' | 'write') =>
            grant.path === targetPath && (access === 'read' || grant.access === 'write')
        )
      })
      registerOfficeDocumentHandlers(deps)
      vi.mocked(writeExternalOfficeDocument).mockResolvedValue({ path: EXTERNAL } as never)

      await handlerFor('office:write-external-document')(fakeEvent, {
        chatId: 'chat-1',
        path: EXTERNAL,
        model: { kind: 'word', blocks: [] },
        baseEtag: 'sha256:x'
      })
      expect(vi.mocked(writeExternalOfficeDocument)).toHaveBeenCalledWith({
        absolutePath: EXTERNAL,
        model: { kind: 'word', blocks: [] },
        baseEtag: 'sha256:x'
      })

      // Revoked while the user was editing.
      grants = []
      await expect(
        handlerFor('office:write-external-document')(fakeEvent, {
          chatId: 'chat-1',
          path: EXTERNAL,
          model: { kind: 'word', blocks: [] },
          baseEtag: 'sha256:x'
        })
      ).rejects.toThrow(OFFICE_EXTERNAL_GRANT_REQUIRED)
      expect(vi.mocked(writeExternalOfficeDocument)).toHaveBeenCalledTimes(1)
    })

    it('rejects malformed payloads, unsafe chat ids and relative paths', async () => {
      const deps = makeDeps(grantedDeps([grantFor(EXTERNAL, 'write')]))
      registerOfficeDocumentHandlers(deps)
      const read = handlerFor('office:read-external-document')

      await expect(read(fakeEvent, null)).rejects.toThrow(/Malformed external office payload/)
      await expect(read(fakeEvent, { chatId: 'chat-1', path: 'relative.docx' })).rejects.toThrow(
        /must be absolute/
      )
      await expect(read(fakeEvent, { chatId: '../escape', path: EXTERNAL })).rejects.toThrow()
      expect(vi.mocked(readExternalOfficeDocument)).not.toHaveBeenCalled()
    })

    it('resolves the path canonically before checking grants', async () => {
      const canonical = '/private/tmp/brief.docx'
      const deps = makeDeps({
        ...grantedDeps([grantFor(canonical, 'write')]),
        canonicalExternalGrantPath: vi.fn(() => canonical)
      })
      registerOfficeDocumentHandlers(deps)
      vi.mocked(readExternalOfficeDocument).mockResolvedValue({ path: canonical } as never)

      await handlerFor('office:read-external-document')(fakeEvent, {
        chatId: 'chat-1',
        path: '/tmp/brief.docx'
      })
      expect(deps.canonicalExternalGrantPath).toHaveBeenCalledWith('/tmp/brief.docx')
      expect(vi.mocked(readExternalOfficeDocument)).toHaveBeenCalledWith(canonical)
    })
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
