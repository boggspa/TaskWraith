import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerWorkspaceChangeLedgerHandlers } from './workspaceChangeLedgerHandlers'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => mockedHandle.mockReset())

function handlerFor(channel: string): (event: unknown, ...args: any[]) => any {
  const handler = mockedHandle.mock.calls.find(([name]) => name === channel)?.[1]
  expect(handler).toBeTypeOf('function')
  return handler as (event: unknown, ...args: any[]) => any
}

function createDeps() {
  const runDiff = {
    runId: 'run-1',
    preSnapshot: { capturedAt: 'before', isGitRepo: false },
    postSnapshot: { capturedAt: 'after', isGitRepo: false },
    createdFiles: [],
    modifiedFiles: [],
    deletedFiles: [],
    preExistingFiles: []
  }
  return {
    assertSenderCanReadWorkspaceChangeLedger: vi.fn(),
    assertSenderRunChangeScope: vi.fn(),
    getWorkspaceChangeSets: vi.fn(() => [{ id: 'change-1' }] as any),
    computeRunDiff: vi.fn(() => runDiff as any),
    recordWorkspaceRunChange: vi.fn(() => ({ id: 'change-1' }) as any),
    requireRegisteredWorkspace: vi.fn((workspacePath: string) => workspacePath),
    findRegisteredWorkspace: vi.fn(() => ({ id: 'ws-1', path: '/Test 1' }) as any),
    assertProviderId: vi.fn((provider) => provider as any),
    assertRunChangeContext: vi.fn()
  }
}

describe('registerWorkspaceChangeLedgerHandlers', () => {
  it('denies a secondary renderer before reading the global change ledger', async () => {
    const deps = createDeps()
    deps.assertSenderCanReadWorkspaceChangeLedger.mockImplementation(() => {
      throw new Error('Only the main renderer can manage workspace authority.')
    })
    registerWorkspaceChangeLedgerHandlers(deps)

    await expect(
      handlerFor('get-workspace-change-sets')({ sender: { id: 44 } }, {})
    ).rejects.toThrow('Only the main renderer')
    expect(deps.getWorkspaceChangeSets).not.toHaveBeenCalled()
  })

  it('denies a secondary renderer before computing or persisting another workspace diff', async () => {
    const deps = createDeps()
    deps.assertSenderRunChangeScope.mockImplementation(() => {
      throw new Error('Renderer workspace ownership does not match this request.')
    })
    deps.findRegisteredWorkspace.mockReturnValue({ id: 'ws-3', path: '/Test 3' } as any)
    registerWorkspaceChangeLedgerHandlers(deps)

    await expect(
      handlerFor('compute-run-diff')(
        { sender: { id: 44 } },
        'run-test-3',
        { capturedAt: 'before', isGitRepo: false, workspacePath: '/Test 3' },
        { capturedAt: 'after', isGitRepo: false, workspacePath: '/Test 3' },
        { chatId: 'test-3-chat', workspaceId: 'ws-3', workspacePath: '/Test 3' }
      )
    ).rejects.toThrow('Renderer workspace ownership')
    expect(deps.computeRunDiff).not.toHaveBeenCalled()
    expect(deps.recordWorkspaceRunChange).not.toHaveBeenCalled()
  })

  it('allows an owning chat renderer to persist only its validated run diff', async () => {
    const deps = createDeps()
    registerWorkspaceChangeLedgerHandlers(deps)
    const event = { sender: { id: 44 } }
    const pre = { capturedAt: 'before', isGitRepo: false, workspacePath: '/Test 1' }
    const post = { capturedAt: 'after', isGitRepo: false, workspacePath: '/Test 1' }

    await handlerFor('compute-run-diff')(event, 'run-1', pre, post, {
      chatId: 'chat-1',
      workspaceId: 'ws-1',
      workspacePath: '/Test 1',
      provider: 'codex'
    })

    expect(deps.assertSenderRunChangeScope).toHaveBeenCalledWith(event, {
      chatId: 'chat-1',
      workspacePath: '/Test 1'
    })
    expect(deps.assertRunChangeContext).toHaveBeenCalled()
    expect(deps.recordWorkspaceRunChange).toHaveBeenCalled()
  })

  it('binds a main-renderer change record to validated run and workspace context', async () => {
    const deps = createDeps()
    registerWorkspaceChangeLedgerHandlers(deps)
    const pre = { capturedAt: 'before', isGitRepo: false, workspacePath: '/Test 1' }
    const post = { capturedAt: 'after', isGitRepo: false, workspacePath: '/Test 1' }

    await expect(
      handlerFor('compute-run-diff')(
        { sender: { id: 1 } },
        'run-1',
        pre,
        post,
        {
          chatId: 'chat-1',
          workspaceId: 'ws-1',
          workspacePath: '/Test 1',
          provider: 'codex'
        }
      )
    ).resolves.toMatchObject({ runId: 'run-1', changeSetId: 'change-1' })
    expect(deps.assertRunChangeContext).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        workspacePath: '/Test 1',
        effectiveWorkspacePath: '/Test 1',
        changeContext: expect.objectContaining({ chatId: 'chat-1' })
      })
    )
    expect(deps.recordWorkspaceRunChange).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        chatId: 'chat-1',
        workspaceId: 'ws-1',
        workspacePath: '/Test 1',
        provider: 'codex'
      })
    )
  })
})
