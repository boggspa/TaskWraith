import { describe, expect, it, vi } from 'vitest'
import { AuditService, type ApprovalRouteContext, type AuditServiceDeps } from './AuditService'
import type { ApprovalLedgerRequestInput } from '../store/types'
import type { RunManager } from '../RunManager'

const fixedNow = new Date('2026-05-16T03:00:00.000Z')

function makeDeps(overrides: Partial<AuditServiceDeps> = {}): {
  deps: AuditServiceDeps
  records: ApprovalLedgerRequestInput[]
  errors: Array<{ message: string; error: unknown }>
} {
  const records: ApprovalLedgerRequestInput[] = []
  const errors: Array<{ message: string; error: unknown }> = []
  const context: ApprovalRouteContext = {
    session: {
      providerSessionId: 'provider-session-1',
      providerRunId: 'provider-run-1',
      workspacePath: '/session-workspace'
    },
    runId: 'run-1',
    chatId: 'chat-1',
    workspaceId: 'workspace-1',
    workspacePath: '/context-workspace'
  }
  const deps: AuditServiceDeps = {
    runManager: { get: vi.fn() } as unknown as RunManager<unknown>,
    resolveApprovalResponse: vi.fn(),
    recordApprovalLedgerDecision: vi.fn((input: ApprovalLedgerRequestInput) => {
      records.push(input)
    }),
    approvalRouteContext: vi.fn(() => context),
    now: vi.fn(() => fixedNow),
    idSuffix: vi.fn(() => 'fixedsuffix'),
    logError: vi.fn((message: string, error: unknown) => {
      errors.push({ message, error })
    }),
    ...overrides
  }
  return { deps, records, errors }
}

describe('AuditService', () => {
  it('resolves approval ledger responses with user defaults', () => {
    const { deps } = makeDeps()
    const service = new AuditService(deps)
    service.resolveApprovalLedgerResponse('approval-1', 'accept')
    expect(deps.resolveApprovalResponse).toHaveBeenCalledWith('approval-1', 'accept', 'user', {})
  })

  it('resolves approval ledger responses with system metadata', () => {
    const { deps } = makeDeps()
    const service = new AuditService(deps)
    const metadata = { reason: 'timeout' }
    service.resolveApprovalLedgerResponse('approval-1', 'decline', 'system', metadata)
    expect(deps.resolveApprovalResponse).toHaveBeenCalledWith(
      'approval-1',
      'decline',
      'system',
      metadata
    )
  })

  it('threads an optional intent note through extraMetadata (Order-4)', () => {
    const { deps } = makeDeps()
    const service = new AuditService(deps)
    service.resolveApprovalLedgerResponse('approval-1', 'accept', 'user', {
      intentNote: 'reviewed the diff, safe'
    })
    expect(deps.resolveApprovalResponse).toHaveBeenCalledWith('approval-1', 'accept', 'user', {
      intentNote: 'reviewed the diff, safe'
    })
  })

  it('does not throw when ledger response resolution fails', () => {
    const error = new Error('ledger unavailable')
    const { deps, errors } = makeDeps({
      resolveApprovalResponse: vi.fn(() => {
        throw error
      })
    })
    const service = new AuditService(deps)
    expect(() => service.resolveApprovalLedgerResponse('approval-1', 'accept')).not.toThrow()
    expect(errors).toEqual([{ message: 'Failed to resolve approval ledger request', error }])
  })

  it('records automatic allow decisions with request-scoped expiration', () => {
    const { deps, records } = makeDeps()
    const service = new AuditService(deps)
    service.recordAutomaticApprovalDecision(
      'codex',
      { appRunId: 'run-1', appChatId: 'chat-1' },
      'shellCommands',
      undefined,
      {
        method: 'shell/run',
        title: 'Run shell command',
        body: 'ls',
        preview: { command: 'ls' }
      },
      'autoAllow',
      'policy',
      'request',
      { policy: 'allow' }
    )
    expect(deps.approvalRouteContext).toHaveBeenCalledWith('codex', {
      appRunId: 'run-1',
      appChatId: 'chat-1'
    })
    expect(records[0]).toMatchObject({
      approvalId: 'autoAllow-shellCommands-1778900400000-fixedsuffix',
      provider: 'codex',
      service: 'shellCommands',
      method: 'shell/run',
      title: 'Run shell command',
      body: 'ls',
      preview: { command: 'ls' },
      actions: [],
      status: 'approved',
      requestedAt: fixedNow.toISOString(),
      respondedAt: fixedNow.toISOString(),
      decision: 'autoAllow',
      decisionSource: 'policy',
      grantedScope: 'request',
      expiration: {
        mode: 'none',
        description: 'Allowed automatically by the current TaskWraith policy for this request.'
      },
      runId: 'run-1',
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
      workspacePath: '/context-workspace',
      providerSessionId: 'provider-session-1',
      providerRunId: 'provider-run-1',
      metadata: { policy: 'allow' }
    })
  })

  it('records automatic deny decisions with on-decision expiration', () => {
    const { records } = makeDeps()
    const service = new AuditService(
      makeDeps({ recordApprovalLedgerDecision: (input) => records.push(input) }).deps
    )
    service.recordAutomaticApprovalDecision(
      'gemini',
      { appRunId: 'run-1' },
      'mcpTools',
      '/workspace',
      {
        method: 'mcp/call',
        title: 'Call MCP tool',
        body: 'Blocked'
      },
      'autoDeny',
      'policy',
      'request'
    )
    expect(records[0]).toMatchObject({
      status: 'denied',
      decision: 'autoDeny',
      workspacePath: '/workspace',
      expiration: {
        mode: 'on_decision',
        description: 'Denied automatically by the current TaskWraith policy.',
        expiresAt: fixedNow.toISOString(),
        expiredAt: fixedNow.toISOString(),
        expiredReason: 'policy_denied'
      }
    })
  })

  it('records Boss auto approvals as request-scoped ledger decisions with participant metadata', () => {
    const { records } = makeDeps()
    const service = new AuditService(
      makeDeps({ recordApprovalLedgerDecision: (input) => records.push(input) }).deps
    )
    service.recordAutomaticApprovalDecision(
      'codex',
      { appRunId: 'run-1', appChatId: 'chat-1' },
      'fileChanges',
      '/workspace',
      { method: 'write_file', title: 'Edit file', body: 'Update implementation' },
      'autoAllow',
      'bossman_auto',
      'request',
      {
        bossmanParticipantId: 'claude-boss',
        targetParticipantId: 'codex-worker',
        approvalId: 'pending-approval-1',
        actionClass: 'fileChanges',
        rationale: 'Protecting the current work session.'
      }
    )
    expect(records[0]).toMatchObject({
      decision: 'autoAllow',
      decisionSource: 'bossman_auto',
      grantedScope: 'request',
      expiration: {
        mode: 'none',
        description: 'Allowed automatically by the current TaskWraith policy for this request.'
      },
      metadata: {
        bossmanParticipantId: 'claude-boss',
        targetParticipantId: 'codex-worker',
        approvalId: 'pending-approval-1',
        actionClass: 'fileChanges',
        rationale: 'Protecting the current work session.'
      }
    })
  })

  it('uses workspace and session expiration descriptions for broader grants', () => {
    const { records } = makeDeps()
    const service = new AuditService(
      makeDeps({ recordApprovalLedgerDecision: (input) => records.push(input) }).deps
    )
    service.recordAutomaticApprovalDecision(
      'codex',
      null,
      'fileChanges',
      undefined,
      { method: 'edit', title: 'Edit file', body: 'Allowed' },
      'autoAllow',
      'workspace_grant',
      'workspace'
    )
    service.recordAutomaticApprovalDecision(
      'codex',
      null,
      'fileChanges',
      undefined,
      { method: 'edit', title: 'Edit file', body: 'Allowed' },
      'autoAllow',
      'session_grant',
      'session'
    )
    expect(records[0].expiration).toEqual({
      mode: 'workspace_revocation',
      description: 'Workspace approval remains active until the workspace grant is revoked.'
    })
    expect(records[1].expiration).toEqual({
      mode: 'session_end',
      description: 'Session approval expires when the active provider runtime session ends.'
    })
  })

  it('does not throw when route context or decision recording fails', () => {
    const routeError = new Error('route failed')
    const { deps, errors } = makeDeps({
      approvalRouteContext: vi.fn(() => {
        throw routeError
      })
    })
    const service = new AuditService(deps)
    expect(() =>
      service.recordAutomaticApprovalDecision(
        'kimi',
        null,
        'shellCommands',
        undefined,
        { method: 'shell/run', title: 'Run shell', body: 'ls' },
        'autoAllow',
        'policy',
        'request'
      )
    ).not.toThrow()
    expect(errors).toEqual([
      {
        message: 'Failed to record automatic approval ledger decision',
        error: routeError
      }
    ])
  })
})
