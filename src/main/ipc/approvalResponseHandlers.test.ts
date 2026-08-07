import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import type { ChatRecord, ExternalPathGrant } from '../store/types'
import {
  registerApprovalResponseHandlers,
  type ApprovalResponseHandlerDeps
} from './approvalResponseHandlers'

/**
 * M3-3d SECURITY wrapper net for the relocated respond-agent-approval endpoint.
 * The deliverable is the PERSIST-BEFORE-RESOLVE fence: for a grant action, the
 * signed grant must be issued + durably persisted (saveChat) + broadcast BEFORE
 * `resolve` fires — and `resolve` must ALWAYS fire (partial-failure safety), even
 * when persistence throws. A reorder that let resolve fire before persist is a
 * partial-failure safety hole, not a behaviour change, so it gets an explicit
 * ordering assertion (d1) + a persist-failure-tolerance assertion (d5).
 *
 * The 5 injected deps log to a shared `order` array so the sequence can be
 * asserted directly. `fs` is direct-imported by the module → vi.mock it to
 * control the file/dir/throw probe. `../store/ExternalPathGrants` is mocked for a
 * hermetic transform. `randomBytes` runs real (its output — the grant id — is
 * irrelevant to ordering/persist assertions).
 */

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    promises: {
      ...actual.promises,
      stat: vi.fn(async () => ({ isDirectory: () => false }))
    }
  }
})

vi.mock('../store/ExternalPathGrants', () => ({
  canonicalizeExternalPathGrantMetadata: vi.fn((_metadata, nextGrants) => ({
    externalPathGrants: nextGrants
  })),
  collectExternalPathGrantsFromMetadata: vi.fn(() => [] as ExternalPathGrant[])
}))

const mockedHandle = vi.mocked(ipcMain.handle)
const mockedStat = vi.mocked(fs.stat)

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

type Detection =
  | {
      path?: string
      appChatId?: string
      provider: string
      access: 'read' | 'write'
      workspaceScope?: 'global' | 'workspace'
      workspaceId?: string | null
      workspacePath?: string | null
    }
  | undefined

function createChat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    id: 'chat-1',
    appChatId: 'chat-1',
    chatKind: 'single',
    provider: 'codex',
    scope: 'workspace',
    workspaceId: 'ws-1',
    workspacePath: '/ws-1',
    providerMetadata: {},
    updatedAt: 1,
    ...overrides
  } as unknown as ChatRecord
}

function createDeps(order: string[]) {
  let detection: Detection = {
    path: '/tmp/target',
    appChatId: 'chat-1',
    provider: 'codex',
    access: 'read',
    workspaceScope: 'workspace',
    workspaceId: 'ws-1',
    workspacePath: '/ws-1'
  }
  let chat: ChatRecord | null = createChat()
  const deps = {
    assertSenderCanRespond: vi.fn(),
    approvalService: {
      getPendingExternalPathDetection: vi.fn(() => {
        order.push('getPendingExternalPathDetection')
        return detection
      }),
      resolve: vi.fn((requestId: string, action: string, options?: unknown) => {
        order.push('resolve')
        return { resolved: true, requestId, action, options }
      })
    },
    issueExternalPathGrant: vi.fn((grant: Omit<ExternalPathGrant, 'issuedBy' | 'signature'>) => {
      order.push('issueExternalPathGrant')
      return { ...grant, issuedBy: 'main', signature: 'sig' } as ExternalPathGrant
    }),
    getChat: vi.fn(() => {
      order.push('getChat')
      return chat
    }),
    saveChat: vi.fn(() => {
      order.push('saveChat')
    }),
    broadcastChatUpdated: vi.fn(() => {
      order.push('broadcastChatUpdated')
    })
  } as unknown as ApprovalResponseHandlerDeps

  return {
    deps,
    setDetection(next: Detection) {
      detection = next
    },
    setChat(next: ChatRecord | null) {
      chat = next
    }
  }
}

beforeEach(() => {
  mockedHandle.mockReset()
  mockedStat.mockReset()
  mockedStat.mockResolvedValue({ isDirectory: () => false } as never)
})

describe('registerApprovalResponseHandlers', () => {
  it('registers the respond-agent-approval channel', () => {
    registerApprovalResponseHandlers(createDeps([]).deps)
    expect(handlerFor('respond-agent-approval')).toBeTypeOf('function')
  })

  it('rejects a renderer that does not own the pending approval before resolving it', async () => {
    const order: string[] = []
    const { deps } = createDeps(order)
    vi.mocked(deps.assertSenderCanRespond).mockImplementation(() => {
      throw new Error('approval belongs to another chat')
    })
    registerApprovalResponseHandlers(deps)

    await expect(
      handlerFor('respond-agent-approval')({} as never, 'req-cross-chat', 'accept')
    ).rejects.toThrow('approval belongs to another chat')
    expect(deps.approvalService.resolve).not.toHaveBeenCalled()
    expect(deps.issueExternalPathGrant).not.toHaveBeenCalled()
  })

  // (d1) THE deliverable: persist-before-resolve ordering. A grant action issues +
  // persists + broadcasts the grant, THEN resolves — resolve strictly LAST.
  it('(d1) persists the grant before resolving — resolve fires last, after saveChat + broadcast', async () => {
    const order: string[] = []
    const { deps } = createDeps(order)
    registerApprovalResponseHandlers(deps)

    const result = await handlerFor('respond-agent-approval')({}, 'req-1', 'grantExternalPathRead')

    expect(order).toEqual([
      'getPendingExternalPathDetection',
      'getChat',
      'issueExternalPathGrant',
      'getChat',
      'saveChat',
      'broadcastChatUpdated',
      'resolve'
    ])
    // resolve is strictly last (the safety-critical invariant).
    expect(order[order.length - 1]).toBe('resolve')
    // grant issued read-access, thisThread, for the detected chat/path.
    expect(vi.mocked(deps.issueExternalPathGrant)).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex',
        chatId: 'chat-1',
        path: '/tmp/target',
        access: 'read',
        duration: 'thisThread'
      })
    )
    expect(vi.mocked(deps.approvalService.resolve)).toHaveBeenCalledWith(
      'req-1',
      'grantExternalPathRead',
      undefined
    )
    expect(result).toEqual(expect.objectContaining({ resolved: true }))
  })

  // (d2) grantExternalPathEdit → write access + directory kind from the stat probe.
  it('(d2) grant-edit issues write access and directory kind from the stat probe', async () => {
    const order: string[] = []
    const { deps } = createDeps(order)
    mockedStat.mockResolvedValue({ isDirectory: () => true } as never)
    registerApprovalResponseHandlers(deps)

    await handlerFor('respond-agent-approval')({}, 'req-2', 'grantExternalPathEdit')

    expect(vi.mocked(deps.issueExternalPathGrant)).toHaveBeenCalledWith(
      expect.objectContaining({ access: 'write', kind: 'directory' })
    )
    expect(order[order.length - 1]).toBe('resolve')
  })

  it('(d2b) persists a read grant but rejects a currently pending write', async () => {
    const order: string[] = []
    const { deps, setDetection } = createDeps(order)
    setDetection({
      path: '/tmp/target',
      appChatId: 'chat-1',
      provider: 'codex',
      access: 'write',
      workspaceScope: 'workspace',
      workspaceId: 'ws-1',
      workspacePath: '/ws-1'
    })
    registerApprovalResponseHandlers(deps)

    await handlerFor('respond-agent-approval')({}, 'req-2b', 'grantExternalPathRead')

    expect(vi.mocked(deps.issueExternalPathGrant)).toHaveBeenCalledWith(
      expect.objectContaining({ access: 'read' })
    )
    expect(vi.mocked(deps.approvalService.resolve)).toHaveBeenCalledWith(
      'req-2b',
      'declineExternalPath',
      undefined
    )
    expect(order[order.length - 1]).toBe('resolve')
  })

  it('fails closed when the chat primary rebinds while the approval modal is open', async () => {
    // Mirror pick-and-persist: consent described ws-1; Accept must not remint onto ws-2.
    const order: string[] = []
    const { deps, setChat } = createDeps(order)
    setChat(
      createChat({
        workspaceId: 'ws-2',
        workspacePath: '/ws-2'
      })
    )
    registerApprovalResponseHandlers(deps)

    await handlerFor('respond-agent-approval')({}, 'req-rebind', 'grantExternalPathEdit')

    expect(vi.mocked(deps.issueExternalPathGrant)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.saveChat)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.approvalService.resolve)).toHaveBeenCalledWith(
      'req-rebind',
      'declineExternalPath',
      undefined
    )
    expect(order[order.length - 1]).toBe('resolve')
  })

  it('fails closed on path-only primary drift (same workspace id)', async () => {
    const order: string[] = []
    const { deps, setChat } = createDeps(order)
    setChat(
      createChat({
        workspaceId: 'ws-1',
        workspacePath: '/ws-1b'
      })
    )
    registerApprovalResponseHandlers(deps)

    await handlerFor('respond-agent-approval')({}, 'req-path-only', 'grantExternalPathEdit')

    expect(vi.mocked(deps.issueExternalPathGrant)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.saveChat)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.approvalService.resolve)).toHaveBeenCalledWith(
      'req-path-only',
      'declineExternalPath',
      undefined
    )
  })

  it('fails closed when the pending detection has no stamped workspace binding', async () => {
    const order: string[] = []
    const { deps, setDetection } = createDeps(order)
    setDetection({
      path: '/tmp/target',
      appChatId: 'chat-1',
      provider: 'codex',
      access: 'read'
    })
    registerApprovalResponseHandlers(deps)

    await handlerFor('respond-agent-approval')({}, 'req-legacy-stamp', 'grantExternalPathRead')

    expect(vi.mocked(deps.issueExternalPathGrant)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.saveChat)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.approvalService.resolve)).toHaveBeenCalledWith(
      'req-legacy-stamp',
      'declineExternalPath',
      undefined
    )
  })

  it('fails closed when the chat was deleted before Accept', async () => {
    const order: string[] = []
    const { deps, setChat } = createDeps(order)
    setChat(null)
    registerApprovalResponseHandlers(deps)

    await handlerFor('respond-agent-approval')({}, 'req-deleted', 'grantExternalPathEdit')

    expect(vi.mocked(deps.issueExternalPathGrant)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.saveChat)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.approvalService.resolve)).toHaveBeenCalledWith(
      'req-deleted',
      'declineExternalPath',
      undefined
    )
  })

  it('fails closed when the chat flips between workspace and global scope', async () => {
    const order: string[] = []
    const { deps, setChat } = createDeps(order)
    setChat(createChat({ scope: 'global', workspaceId: undefined, workspacePath: undefined }))
    registerApprovalResponseHandlers(deps)

    await handlerFor('respond-agent-approval')({}, 'req-scope-flip', 'grantExternalPathEdit')

    expect(vi.mocked(deps.issueExternalPathGrant)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.approvalService.resolve)).toHaveBeenCalledWith(
      'req-scope-flip',
      'declineExternalPath',
      undefined
    )
  })

  it('declines when the chat rebinds after mint but before durable persist', async () => {
    const order: string[] = []
    const { deps } = createDeps(order)
    let getChatCalls = 0
    vi.mocked(deps.getChat).mockImplementation(() => {
      order.push('getChat')
      getChatCalls += 1
      if (getChatCalls === 1) return createChat()
      return createChat({ workspaceId: 'ws-2', workspacePath: '/ws-2' })
    })
    registerApprovalResponseHandlers(deps)

    await handlerFor('respond-agent-approval')({}, 'req-post-mint', 'grantExternalPathEdit')

    expect(vi.mocked(deps.issueExternalPathGrant)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(deps.saveChat)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.approvalService.resolve)).toHaveBeenCalledWith(
      'req-post-mint',
      'declineExternalPath',
      undefined
    )
  })

  // (d3) stat throws → grantKind falls back to 'file'; persist + resolve still run.
  it('(d3) falls back to file kind when the stat probe throws, still persists + resolves', async () => {
    const order: string[] = []
    const { deps } = createDeps(order)
    mockedStat.mockRejectedValue(new Error('stat boom'))
    registerApprovalResponseHandlers(deps)

    await handlerFor('respond-agent-approval')({}, 'req-3', 'grantExternalPathRead')

    expect(vi.mocked(deps.issueExternalPathGrant)).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'file' })
    )
    expect(order).toContain('saveChat')
    expect(order[order.length - 1]).toBe('resolve')
  })

  // (d4) no pending detection → skip the grant path entirely, resolve only.
  it('(d4) resolves without issuing a grant when there is no pending detection', async () => {
    const order: string[] = []
    const { deps, setDetection } = createDeps(order)
    setDetection(undefined)
    registerApprovalResponseHandlers(deps)

    await handlerFor('respond-agent-approval')({}, 'req-4', 'grantExternalPathRead')

    expect(order).toEqual(['getPendingExternalPathDetection', 'resolve'])
    expect(vi.mocked(deps.issueExternalPathGrant)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.saveChat)).not.toHaveBeenCalled()
  })

  // (d5) partial-failure safety: persistence throws → resolve STILL fires. The
  // grant path is best-effort; a resolve that DIDN'T fire would wedge the approval.
  it('(d5) still resolves when persistence throws (partial-failure safety)', async () => {
    const order: string[] = []
    const { deps } = createDeps(order)
    vi.mocked(deps.saveChat).mockImplementation(() => {
      order.push('saveChat')
      throw new Error('persist boom')
    })
    registerApprovalResponseHandlers(deps)

    const result = await handlerFor('respond-agent-approval')({}, 'req-5', 'grantExternalPathEdit')

    // broadcast never happened (save threw), but resolve STILL fired, last.
    expect(order).not.toContain('broadcastChatUpdated')
    expect(order[order.length - 1]).toBe('resolve')
    expect(vi.mocked(deps.approvalService.resolve)).toHaveBeenCalledWith(
      'req-5',
      'grantExternalPathEdit',
      undefined
    )
    expect(result).toEqual(expect.objectContaining({ resolved: true }))
  })

  // (d6) a non-grant action never touches the grant path — resolve only, and the
  // pending-detection peek is never even consulted.
  it('(d6) non-grant actions resolve directly without touching the grant path', async () => {
    const order: string[] = []
    const { deps } = createDeps(order)
    registerApprovalResponseHandlers(deps)

    await handlerFor('respond-agent-approval')({}, 'req-6', 'accept')

    expect(order).toEqual(['resolve'])
    expect(vi.mocked(deps.approvalService.getPendingExternalPathDetection)).not.toHaveBeenCalled()
    expect(vi.mocked(deps.issueExternalPathGrant)).not.toHaveBeenCalled()
  })

  // (d7) intentNote rides through to resolve as extraMetadata; a blank note is
  // dropped entirely (never persisted as an empty note).
  it('(d7) threads a trimmed intentNote into resolveOptions and drops a blank one', async () => {
    const order: string[] = []
    const { deps } = createDeps(order)
    registerApprovalResponseHandlers(deps)

    await handlerFor('respond-agent-approval')({}, 'req-7', 'decline', '  keep this  ')
    expect(vi.mocked(deps.approvalService.resolve)).toHaveBeenLastCalledWith('req-7', 'decline', {
      extraMetadata: { intentNote: 'keep this' }
    })

    await handlerFor('respond-agent-approval')({}, 'req-7b', 'decline', '   ')
    expect(vi.mocked(deps.approvalService.resolve)).toHaveBeenLastCalledWith(
      'req-7b',
      'decline',
      undefined
    )
  })

  // (d8) detection present but missing appChatId → skip grant (can't persist to a
  // chat), resolve only.
  it('(d8) skips the grant when the detection has no appChatId', async () => {
    const order: string[] = []
    const { deps, setDetection } = createDeps(order)
    setDetection({
      path: '/tmp/target',
      appChatId: undefined,
      provider: 'codex',
      access: 'read'
    })
    registerApprovalResponseHandlers(deps)

    await handlerFor('respond-agent-approval')({}, 'req-8', 'grantExternalPathRead')

    expect(order).toEqual(['getPendingExternalPathDetection', 'resolve'])
    expect(vi.mocked(deps.issueExternalPathGrant)).not.toHaveBeenCalled()
  })
})
