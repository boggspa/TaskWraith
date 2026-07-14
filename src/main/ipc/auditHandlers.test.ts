import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAuditHandlers, type AuditHandlerDeps } from './auditHandlers'
import type { AuditRunRecord } from '../store/types'
import type { AuditOrchestrator } from '../audit/AuditOrchestrator'

const ipcHandlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    }
  }
}))

function auditRun(overrides: Partial<AuditRunRecord> = {}): AuditRunRecord {
  return {
    schemaVersion: 1,
    id: 'audit-1',
    mode: 'quick',
    chatId: 'chat-1',
    workspacePath: '/repo',
    status: 'completed',
    phases: [],
    dimensions: [],
    participants: [],
    findings: [],
    verdicts: [],
    gates: [],
    budget: { maxAgents: 1, spentAgents: 1, spentTokens: 0, truncated: false },
    createdAt: 't0',
    updatedAt: 't1',
    ...overrides
  }
}

function auditHandlerDeps(overrides: Partial<AuditHandlerDeps> = {}): AuditHandlerDeps {
  return {
    getAuditOrchestrator: () => null,
    getAuditRun: () => null,
    getAuditRuns: () => [],
    resolveSenderAuditScope: () => ({ kind: 'main' }),
    workspacePathsEqual: (left, right) => left === right,
    beginAuditRun: () => true,
    endAuditRun: () => {},
    markAuditRunCancelled: () => {},
    clearAuditRunCancelled: () => {},
    ...overrides
  }
}

describe('registerAuditHandlers', () => {
  beforeEach(() => {
    ipcHandlers.clear()
  })

  it('validates preferredProvider before reserving the in-flight audit slot', async () => {
    let inFlight = false
    let beginCalls = 0
    let endCalls = 0
    const run = vi.fn(async () => auditRun())

    registerAuditHandlers({
      getAuditOrchestrator: () => ({ run }) as unknown as AuditOrchestrator,
      getAuditRun: () => null,
      getAuditRuns: () => [],
      resolveSenderAuditScope: () => ({ kind: 'main' }),
      workspacePathsEqual: (left, right) => left === right,
      beginAuditRun: () => {
        beginCalls += 1
        if (inFlight) return false
        inFlight = true
        return true
      },
      endAuditRun: () => {
        endCalls += 1
        inFlight = false
      },
      markAuditRunCancelled: () => {},
      clearAuditRunCancelled: () => {}
    })

    const start = ipcHandlers.get('audit-run:start')
    expect(start).toBeDefined()

    await expect(
      start?.({}, { chatId: 'chat-1', workspacePath: '/repo', preferredProvider: 'bogus' })
    ).rejects.toThrow()

    expect(beginCalls).toBe(0)
    expect(endCalls).toBe(0)
    expect(run).not.toHaveBeenCalled()

    await expect(
      start?.({}, { chatId: 'chat-1', workspacePath: '/repo', preferredProvider: 'claude' })
    ).resolves.toMatchObject({ id: 'audit-1', status: 'completed' })

    expect(beginCalls).toBe(1)
    expect(endCalls).toBe(1)
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', preferredProvider: 'claude' })
    )
  })

  it('validates the workspace path before reserving the in-flight audit slot', async () => {
    let beginCalls = 0
    let endCalls = 0
    const run = vi.fn(async () => auditRun())

    registerAuditHandlers({
      getAuditOrchestrator: () => ({ run }) as unknown as AuditOrchestrator,
      getAuditRun: () => null,
      getAuditRuns: () => [],
      resolveSenderAuditScope: () => ({ kind: 'main' }),
      workspacePathsEqual: (left, right) => left === right,
      validateWorkspacePath: () => {
        throw new Error('Workspace must be selected through TaskWraith.')
      },
      beginAuditRun: () => {
        beginCalls += 1
        return true
      },
      endAuditRun: () => {
        endCalls += 1
      },
      markAuditRunCancelled: () => {},
      clearAuditRunCancelled: () => {}
    })

    const start = ipcHandlers.get('audit-run:start')
    await expect(
      start?.({}, { chatId: 'chat-1', workspacePath: '/missing', preferredProvider: 'claude' })
    ).rejects.toThrow('Workspace must be selected through TaskWraith.')

    expect(beginCalls).toBe(0)
    expect(endCalls).toBe(0)
    expect(run).not.toHaveBeenCalled()
  })

  it('passes the canonical validated workspace path to the orchestrator', async () => {
    const run = vi.fn(async () => auditRun({ workspacePath: '/repo-canonical' }))

    registerAuditHandlers({
      getAuditOrchestrator: () => ({ run }) as unknown as AuditOrchestrator,
      getAuditRun: () => null,
      getAuditRuns: () => [],
      resolveSenderAuditScope: () => ({ kind: 'main' }),
      workspacePathsEqual: (left, right) => left === right,
      validateWorkspacePath: () => '/repo-canonical',
      beginAuditRun: () => true,
      endAuditRun: () => {},
      markAuditRunCancelled: () => {},
      clearAuditRunCancelled: () => {}
    })

    const start = ipcHandlers.get('audit-run:start')
    await expect(
      start?.({}, { chatId: 'chat-1', workspacePath: '/repo', preferredProvider: 'claude' })
    ).resolves.toMatchObject({ workspacePath: '/repo-canonical' })

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: '/repo-canonical' }))
  })

  it('allows a chat popout to start an audit only for its exact owner chat and workspace', async () => {
    const run = vi.fn(async (input: { chatId: string; workspaceId?: string; workspacePath: string }) =>
      auditRun({
        chatId: input.chatId,
        workspaceId: input.workspaceId,
        workspacePath: input.workspacePath
      })
    )

    registerAuditHandlers(
      auditHandlerDeps({
        getAuditOrchestrator: () => ({ run }) as unknown as AuditOrchestrator,
        resolveSenderAuditScope: () => ({
          kind: 'chat',
          chatId: 'chat-test-1',
          workspaceId: 'workspace-test-1',
          workspacePath: '/Test 1'
        }),
        validateWorkspacePath: () => '/Test 1'
      })
    )

    const start = ipcHandlers.get('audit-run:start')
    await expect(
      start?.({}, { chatId: 'chat-test-1', workspacePath: '/Test 1 alias' })
    ).resolves.toMatchObject({
      chatId: 'chat-test-1',
      workspaceId: 'workspace-test-1',
      workspacePath: '/Test 1'
    })
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-test-1',
        workspaceId: 'workspace-test-1',
        workspacePath: '/Test 1'
      })
    )
  })

  it('denies a Test 1 chat popout from starting a Test 3 audit before reserving a slot', async () => {
    const getAuditOrchestrator = vi.fn(() => ({ run: vi.fn() }) as unknown as AuditOrchestrator)
    const beginAuditRun = vi.fn(() => true)

    registerAuditHandlers(
      auditHandlerDeps({
        getAuditOrchestrator,
        resolveSenderAuditScope: () => ({
          kind: 'chat',
          chatId: 'chat-test-1',
          workspaceId: 'workspace-test-1',
          workspacePath: '/Test 1'
        }),
        validateWorkspacePath: (workspacePath) => workspacePath,
        beginAuditRun
      })
    )

    const start = ipcHandlers.get('audit-run:start')
    await expect(
      start?.(
        {},
        {
          chatId: 'chat-test-3',
          workspaceId: 'workspace-test-3',
          workspacePath: '/Test 3'
        }
      )
    ).rejects.toThrow('Audit run is unavailable to this renderer.')
    expect(getAuditOrchestrator).not.toHaveBeenCalled()
    expect(beginAuditRun).not.toHaveBeenCalled()
  })

  it('allows a chat popout to read and cancel its own persisted audit', async () => {
    const ownAudit = auditRun({
      chatId: 'chat-test-1',
      workspaceId: 'workspace-test-1',
      workspacePath: '/Test 1'
    })
    const getAuditRun = vi.fn(() => ownAudit)
    const markAuditRunCancelled = vi.fn()

    registerAuditHandlers(
      auditHandlerDeps({
        getAuditRun,
        resolveSenderAuditScope: () => ({
          kind: 'chat',
          chatId: 'chat-test-1',
          workspaceId: 'workspace-test-1',
          workspacePath: '/Test 1'
        }),
        markAuditRunCancelled
      })
    )

    await expect(ipcHandlers.get('get-audit-run')?.({}, ownAudit.id)).resolves.toEqual(ownAudit)
    await expect(ipcHandlers.get('audit-run:cancel')?.({}, ownAudit.id)).resolves.toEqual({
      ok: true
    })
    expect(getAuditRun).toHaveBeenCalledTimes(2)
    expect(markAuditRunCancelled).toHaveBeenCalledWith(ownAudit.id)
  })

  it('denies a Test 1 chat popout from reading or cancelling a Test 3 audit', async () => {
    const foreignAudit = auditRun({
      id: 'audit-test-3',
      chatId: 'chat-test-3',
      workspaceId: 'workspace-test-3',
      workspacePath: '/Test 3'
    })
    const markAuditRunCancelled = vi.fn()

    registerAuditHandlers(
      auditHandlerDeps({
        getAuditRun: () => foreignAudit,
        resolveSenderAuditScope: () => ({
          kind: 'chat',
          chatId: 'chat-test-1',
          workspaceId: 'workspace-test-1',
          workspacePath: '/Test 1'
        }),
        markAuditRunCancelled
      })
    )

    await expect(
      ipcHandlers.get('get-audit-run')?.({}, foreignAudit.id)
    ).rejects.toThrow('Audit run is unavailable to this renderer.')
    await expect(
      ipcHandlers.get('audit-run:cancel')?.({}, foreignAudit.id)
    ).rejects.toThrow('Audit run is unavailable to this renderer.')
    expect(markAuditRunCancelled).not.toHaveBeenCalled()
  })

  it('forces chat-popout audit lists to the owner workspace and filters to the owner chat', async () => {
    const ownAudit = auditRun({
      id: 'audit-own',
      chatId: 'chat-test-1',
      workspaceId: 'workspace-test-1',
      workspacePath: '/Test 1'
    })
    const sameWorkspaceOtherChat = auditRun({
      id: 'audit-other-chat',
      chatId: 'chat-test-1b',
      workspaceId: 'workspace-test-1',
      workspacePath: '/Test 1'
    })
    const sameChatOtherWorkspace = auditRun({
      id: 'audit-test-3',
      chatId: 'chat-test-1',
      workspaceId: 'workspace-test-3',
      workspacePath: '/Test 3'
    })
    const getAuditRuns = vi.fn(() => [ownAudit, sameWorkspaceOtherChat, sameChatOtherWorkspace])

    registerAuditHandlers(
      auditHandlerDeps({
        getAuditRuns,
        resolveSenderAuditScope: () => ({
          kind: 'chat',
          chatId: 'chat-test-1',
          workspaceId: 'workspace-test-1',
          workspacePath: '/Test 1'
        })
      })
    )

    await expect(ipcHandlers.get('get-audit-runs')?.({}, undefined)).resolves.toEqual([ownAudit])
    expect(getAuditRuns).toHaveBeenCalledWith('workspace-test-1')

    await expect(
      ipcHandlers.get('get-audit-runs')?.({}, 'workspace-test-3')
    ).rejects.toThrow('Audit run is unavailable to this renderer.')
    expect(getAuditRuns).toHaveBeenCalledTimes(1)
  })

  it('fails closed for non-chat secondary renderers on every audit channel', async () => {
    const resolveSenderAuditScope = vi.fn(() => {
      throw new Error('Only an owning chat renderer can access audits.')
    })

    registerAuditHandlers(auditHandlerDeps({ resolveSenderAuditScope }))

    await expect(
      ipcHandlers.get('audit-run:start')?.({}, { chatId: 'chat-1', workspacePath: '/repo' })
    ).rejects.toThrow('Only an owning chat renderer can access audits.')
    await expect(ipcHandlers.get('get-audit-run')?.({}, 'audit-1')).rejects.toThrow(
      'Only an owning chat renderer can access audits.'
    )
    await expect(ipcHandlers.get('get-audit-runs')?.({}, undefined)).rejects.toThrow(
      'Only an owning chat renderer can access audits.'
    )
    await expect(ipcHandlers.get('audit-run:cancel')?.({}, 'audit-1')).rejects.toThrow(
      'Only an owning chat renderer can access audits.'
    )
    expect(resolveSenderAuditScope).toHaveBeenCalledTimes(4)
  })

  it('keeps the main renderer audit read and cancellation surface unrestricted', async () => {
    const records = [auditRun({ id: 'audit-test-3', workspaceId: 'workspace-test-3' })]
    const getAuditRuns = vi.fn(() => records)
    const markAuditRunCancelled = vi.fn()

    registerAuditHandlers(
      auditHandlerDeps({
        getAuditRun: () => null,
        getAuditRuns,
        markAuditRunCancelled
      })
    )

    await expect(ipcHandlers.get('get-audit-run')?.({}, 'missing')).resolves.toBeNull()
    await expect(
      ipcHandlers.get('get-audit-runs')?.({}, 'workspace-test-3')
    ).resolves.toEqual(records)
    await expect(ipcHandlers.get('audit-run:cancel')?.({}, 'unknown')).resolves.toEqual({ ok: true })
    expect(getAuditRuns).toHaveBeenCalledWith('workspace-test-3')
    expect(markAuditRunCancelled).toHaveBeenCalledWith('unknown')
  })
})
