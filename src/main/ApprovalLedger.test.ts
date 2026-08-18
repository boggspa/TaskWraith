import { describe, expect, it } from 'vitest'
import {
  MAX_APPROVAL_LEDGER_HISTORY,
  PENDING_APPROVAL_TTL_MS,
  backfillApprovalLedgerTitles,
  capApprovalLedgerRecords,
  createApprovalLedgerRecord,
  expireScopedApprovalLedgerRecords,
  filterApprovalLedgerRecords,
  recoverExpiredApprovalLedgerRecords,
  resolveApprovalLedgerRecord
} from './ApprovalLedger'
import type { AgentApprovalAction } from './store/types'

describe('ApprovalLedger', () => {
  const baseRequest = {
    approvalId: 'approval-1',
    provider: 'codex' as const,
    service: 'shellCommands' as const,
    method: 'item/permissions/requestApproval',
    title: 'Approve shell command',
    body: 'Run swift build',
    actions: [
      'accept',
      'acceptForSession',
      'acceptForWorkspace',
      'decline'
    ] as AgentApprovalAction[],
    runId: 'run-1',
    chatId: 'chat-1',
    workspaceId: 'workspace-1',
    workspacePath: '/workspace'
  }

  it('creates pending records with a 24 hour timeout', () => {
    const requestedAt = '2026-05-07T00:00:00.000Z'
    const record = createApprovalLedgerRecord(baseRequest, requestedAt)

    expect(record.schemaVersion).toBe(1)
    expect(record.approvalId).toBe('approval-1')
    expect(record.status).toBe('pending')
    expect(record.expiration.mode).toBe('pending_timeout')
    expect(new Date(record.expiration.expiresAt || '').getTime()).toBe(
      new Date(requestedAt).getTime() + PENDING_APPROVAL_TTL_MS
    )
  })

  it('caps history to the newest MAX while always keeping live records', () => {
    const make = (approvalId: string, requestedAt: string) =>
      createApprovalLedgerRecord({ ...baseRequest, approvalId }, requestedAt)

    // Live records — must survive even though they are the OLDEST here.
    const pending = make('pending-1', '2020-01-01T00:00:00.000Z')
    const workspaceGrant = resolveApprovalLedgerRecord(
      make('ws-1', '2020-01-01T00:00:00.000Z'),
      'acceptForWorkspace',
      '2020-01-01T00:00:00.000Z'
    )
    const sessionGrant = resolveApprovalLedgerRecord(
      make('sess-1', '2020-01-01T00:00:00.000Z'),
      'acceptForSession',
      '2020-01-01T00:00:00.000Z'
    )
    const live = [pending, workspaceGrant, sessionGrant]

    // History: per-call autoAllow audit rows, newest = highest index.
    const base = Date.parse('2026-06-01T00:00:00.000Z')
    const history = Array.from({ length: MAX_APPROVAL_LEDGER_HISTORY + 5 }, (_, i) => {
      const ts = new Date(base + i * 1000).toISOString()
      return {
        ...make(`auto-${i}`, ts),
        status: 'approved' as const,
        decision: 'autoAllow' as const,
        grantedScope: 'request' as const,
        respondedAt: ts
      }
    })

    const capped = capApprovalLedgerRecords([...history, ...live])
    const ids = new Set(capped.map((record) => record.approvalId))

    // All live records kept.
    expect(ids.has('pending-1')).toBe(true)
    expect(ids.has('ws-1')).toBe(true)
    expect(ids.has('sess-1')).toBe(true)
    // History capped to MAX; the 5 oldest dropped, newest kept.
    expect(capped.filter((record) => record.decision === 'autoAllow')).toHaveLength(
      MAX_APPROVAL_LEDGER_HISTORY
    )
    expect(ids.has('auto-0')).toBe(false)
    expect(ids.has('auto-4')).toBe(false)
    expect(ids.has('auto-5')).toBe(true)
    expect(ids.has(`auto-${MAX_APPROVAL_LEDGER_HISTORY + 4}`)).toBe(true)

    // Under the cap, the same array is returned untouched.
    const small = [...history.slice(0, 3), ...live]
    expect(capApprovalLedgerRecords(small)).toBe(small)
  })

  it('maps user approval decisions to durable scopes and expirations', () => {
    const pending = createApprovalLedgerRecord(baseRequest, '2026-05-07T00:00:00.000Z')
    const runApproval = resolveApprovalLedgerRecord(pending, 'accept', '2026-05-07T00:01:00.000Z')
    const sessionApproval = resolveApprovalLedgerRecord(
      pending,
      'acceptForSession',
      '2026-05-07T00:02:00.000Z'
    )
    const workspaceApproval = resolveApprovalLedgerRecord(
      pending,
      'acceptForWorkspace',
      '2026-05-07T00:03:00.000Z'
    )

    expect(runApproval.status).toBe('approved')
    expect(runApproval.grantedScope).toBe('run')
    expect(runApproval.expiration.mode).toBe('run_end')
    expect(sessionApproval.grantedScope).toBe('session')
    expect(sessionApproval.expiration.mode).toBe('session_end')
    expect(workspaceApproval.grantedScope).toBe('workspace')
    expect(workspaceApproval.expiration.mode).toBe('workspace_revocation')
  })

  it('records declines and cancels as terminal request decisions', () => {
    const pending = createApprovalLedgerRecord(baseRequest, '2026-05-07T00:00:00.000Z')
    const denied = resolveApprovalLedgerRecord(pending, 'decline', '2026-05-07T00:01:00.000Z')
    const cancelled = resolveApprovalLedgerRecord(pending, 'cancel', '2026-05-07T00:02:00.000Z')

    expect(denied.status).toBe('denied')
    expect(denied.grantedScope).toBe('request')
    expect(denied.expiration.expiredAt).toBe('2026-05-07T00:01:00.000Z')
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.expiration.expiredReason).toBe('cancel')
  })

  it('recovers stale pending records as expired', () => {
    const pending = createApprovalLedgerRecord(baseRequest, '2026-05-07T00:00:00.000Z')
    const recovered = recoverExpiredApprovalLedgerRecords([pending], '2026-05-08T00:00:01.000Z')

    expect(recovered[0].status).toBe('expired')
    expect(recovered[0].expiration.expiredReason).toBe('pending_timeout')
  })

  it('expires approved run and session scoped grants by run', () => {
    const pending = createApprovalLedgerRecord(baseRequest, '2026-05-07T00:00:00.000Z')
    const runApproval = resolveApprovalLedgerRecord(pending, 'accept', '2026-05-07T00:01:00.000Z')
    const sessionApproval = resolveApprovalLedgerRecord(
      { ...pending, approvalId: 'approval-2', id: 'approval-2' },
      'acceptForSession',
      '2026-05-07T00:02:00.000Z'
    )
    const workspaceApproval = resolveApprovalLedgerRecord(
      { ...pending, approvalId: 'approval-3', id: 'approval-3' },
      'acceptForWorkspace',
      '2026-05-07T00:03:00.000Z'
    )

    const expired = expireScopedApprovalLedgerRecords(
      [runApproval, sessionApproval, workspaceApproval],
      { runId: 'run-1', scopes: ['run', 'session'], reason: 'run_completed' },
      '2026-05-07T00:04:00.000Z'
    )

    expect(expired.find((record) => record.approvalId === 'approval-1')?.status).toBe('expired')
    expect(expired.find((record) => record.approvalId === 'approval-2')?.status).toBe('expired')
    expect(expired.find((record) => record.approvalId === 'approval-3')?.status).toBe('approved')
  })

  // 1.0.4-AD: panel-consensus review — pending approval rows bound to a
  // finishing run were left as `pending` indefinitely (until the 24h
  // recovery sweep), even though the run was over and no decision was
  // ever going to land. This made the ledger UI accumulate "ghost"
  // pending rows for cancelled / completed runs. The fix sweeps pending
  // records belonging to the run on terminal lifecycle transitions,
  // transactionally with the existing approved-scope expiration.
  it('expires pending approvals bound to a finishing run', () => {
    const pendingInRun = createApprovalLedgerRecord(
      { ...baseRequest, approvalId: 'pending-1', id: 'pending-1' },
      '2026-05-07T00:00:00.000Z'
    )
    const pendingOtherRun = createApprovalLedgerRecord(
      {
        ...baseRequest,
        approvalId: 'pending-2',
        id: 'pending-2',
        runId: 'run-2'
      },
      '2026-05-07T00:00:00.000Z'
    )

    const expired = expireScopedApprovalLedgerRecords(
      [pendingInRun, pendingOtherRun],
      { runId: 'run-1', scopes: ['run', 'session'], reason: 'run_completed' },
      '2026-05-07T00:04:00.000Z'
    )

    const swept = expired.find((record) => record.approvalId === 'pending-1')
    expect(swept?.status).toBe('expired')
    expect(swept?.expiration.expiredAt).toBe('2026-05-07T00:04:00.000Z')
    expect(swept?.expiration.expiredReason).toBe('run_completed')
    // Pending row from an unrelated run is untouched.
    expect(expired.find((record) => record.approvalId === 'pending-2')?.status).toBe('pending')
  })

  it('leaves pending approvals without a matching runId untouched', () => {
    const orphanRunPending = createApprovalLedgerRecord(
      {
        ...baseRequest,
        approvalId: 'pending-no-run',
        id: 'pending-no-run',
        runId: undefined
      },
      '2026-05-07T00:00:00.000Z'
    )
    const expired = expireScopedApprovalLedgerRecords(
      [orphanRunPending],
      { runId: 'run-1', scopes: ['run', 'session'], reason: 'run_completed' },
      '2026-05-07T00:04:00.000Z'
    )
    expect(expired[0].status).toBe('pending')
  })

  it('filters ledger records while hiding expired history by default', () => {
    const pending = createApprovalLedgerRecord(baseRequest, '2026-05-07T00:00:00.000Z')
    const expired = recoverExpiredApprovalLedgerRecords(
      [{ ...pending, approvalId: 'approval-expired', id: 'approval-expired' }],
      '2026-05-08T00:00:01.000Z'
    )[0]

    expect(filterApprovalLedgerRecords([pending, expired], { provider: 'codex' })).toHaveLength(1)
    expect(
      filterApprovalLedgerRecords([pending, expired], {
        provider: 'codex',
        includeExpired: true
      })
    ).toHaveLength(2)
    expect(filterApprovalLedgerRecords([pending], { service: 'fileChanges' })).toHaveLength(0)
  })

  it('backfills historical Gemini-labelled titles for non-Gemini MCP approvals', () => {
    const records = [
      createApprovalLedgerRecord(
        {
          ...baseRequest,
          approvalId: 'codex-shell',
          id: 'codex-shell',
          provider: 'codex',
          method: 'codex-mcp/run_shell_command',
          title: 'Approve Gemini shell command'
        },
        '2026-05-07T00:00:00.000Z'
      ),
      createApprovalLedgerRecord(
        {
          ...baseRequest,
          approvalId: 'claude-delegate',
          id: 'claude-delegate',
          provider: 'claude',
          method: 'claude-mcp/delegate_to_subthread',
          title: 'Gemini wants to delegate to Codex sub-thread'
        },
        '2026-05-07T00:00:00.000Z'
      ),
      createApprovalLedgerRecord(
        {
          ...baseRequest,
          approvalId: 'gemini-shell',
          id: 'gemini-shell',
          provider: 'gemini',
          method: 'gemini-mcp/run_shell_command',
          title: 'Approve Gemini shell command'
        },
        '2026-05-07T00:00:00.000Z'
      ),
      createApprovalLedgerRecord(
        {
          ...baseRequest,
          approvalId: 'kimi-patch',
          id: 'kimi-patch',
          provider: 'kimi',
          method: 'kimi-mcp/apply_patch',
          title: 'Approve patch application'
        },
        '2026-05-07T00:00:00.000Z'
      )
    ]

    const result = backfillApprovalLedgerTitles(records, '2026-05-31T20:00:00.000Z')

    expect(result.changed).toBe(2)
    expect(result.staleRowsAfter).toEqual([])
    expect(result.records.find((record) => record.id === 'codex-shell')?.title).toBe(
      'Approve Codex shell command'
    )
    expect(result.records.find((record) => record.id === 'claude-delegate')?.title).toBe(
      'Claude wants to delegate to Codex sub-thread'
    )
    expect(result.records.find((record) => record.id === 'gemini-shell')?.title).toBe(
      'Approve Gemini shell command'
    )
    expect(result.records.find((record) => record.id === 'kimi-patch')?.title).toBe(
      'Approve patch application'
    )
    expect(
      result.records.find((record) => record.id === 'codex-shell')?.metadata?.approvalTitleBackfill
    ).toEqual({
      version: '1.0.7-M8',
      migratedAt: '2026-05-31T20:00:00.000Z',
      previousTitle: 'Approve Gemini shell command'
    })
  })

  it('treats a rerun of the approval-title backfill as a no-op', () => {
    const record = createApprovalLedgerRecord(
      {
        ...baseRequest,
        approvalId: 'codex-tool',
        id: 'codex-tool',
        provider: 'codex',
        method: 'codex-mcp/workspace_search',
        title: 'Approve Gemini tool call'
      },
      '2026-05-07T00:00:00.000Z'
    )
    const firstRun = backfillApprovalLedgerTitles([record], '2026-05-31T20:00:00.000Z')
    const secondRun = backfillApprovalLedgerTitles(
      firstRun.records,
      '2026-05-31T20:01:00.000Z'
    )

    expect(firstRun.changed).toBe(1)
    expect(secondRun.changed).toBe(0)
    expect(secondRun.records[0].title).toBe('Approve Codex tool call')
  })

  it('uses the MCP method prefix to correct a stale title even if provider metadata is wrong', () => {
    const record = createApprovalLedgerRecord(
      {
        ...baseRequest,
        approvalId: 'method-wins',
        id: 'method-wins',
        provider: 'gemini',
        method: 'claude-mcp/write_file',
        title: 'Approve Gemini file write'
      },
      '2026-05-07T00:00:00.000Z'
    )

    const result = backfillApprovalLedgerTitles([record], '2026-05-31T20:00:00.000Z')

    expect(result.changed).toBe(1)
    expect(result.records[0].title).toBe('Approve Claude file write')
    expect(result.staleRowsAfter).toEqual([])
  })

  /**
   * 2026-08-18: the June cap resurfaced through a scope change. Per-call
   * auto-allow AUDIT rows now ride the scope of the grant they exercised
   * (decisionSource 'workspace_grant', grantedScope 'workspace'), which made
   * every one of them "live" and therefore uncappable — measured 2,978 of
   * 3,005 workspace rows in an 11.3 MB ledger were decision:'autoAllow', and
   * the whole file is rewritten synchronously on every approval event. An
   * audit row is a usage log of a grant, not the grant: the row minted by the
   * user's acceptForWorkspace/acceptForSession click is what must survive.
   * Ageing an audit row can at worst trim history, never permissions —
   * enforcement lives in PermissionService, and a dropped grant row fails
   * closed to a re-prompt.
   */
  it('treats per-call autoAllow audit rows as history even when they carry the grant scope', () => {
    const make = (approvalId: string, requestedAt: string) =>
      createApprovalLedgerRecord({ ...baseRequest, approvalId, id: approvalId }, requestedAt)

    const realWorkspaceGrant = resolveApprovalLedgerRecord(
      make('ws-real', '2020-01-01T00:00:00.000Z'),
      'acceptForWorkspace',
      '2020-01-01T00:00:00.000Z'
    )
    const realSessionGrant = resolveApprovalLedgerRecord(
      make('sess-real', '2020-01-01T00:00:00.000Z'),
      'acceptForSession',
      '2020-01-01T00:00:00.000Z'
    )
    const pending = make('pending-live', '2020-01-01T00:00:00.000Z')

    const base = Date.parse('2026-06-01T00:00:00.000Z')
    const audits = Array.from({ length: MAX_APPROVAL_LEDGER_HISTORY + 5 }, (_, i) => {
      const ts = new Date(base + i * 1000).toISOString()
      return {
        ...make(`ws-auto-${i}`, ts),
        status: 'approved',
        decision: 'autoAllow',
        decisionSource: 'workspace_grant',
        grantedScope: 'workspace',
        respondedAt: ts
      } as unknown as ReturnType<typeof make>
    })

    const capped = capApprovalLedgerRecords([...audits, realWorkspaceGrant, realSessionGrant, pending])
    const ids = new Set(capped.map((record) => record.approvalId))

    // The user's actual grants and the pending request are untouchable.
    expect(ids.has('ws-real')).toBe(true)
    expect(ids.has('sess-real')).toBe(true)
    expect(ids.has('pending-live')).toBe(true)
    // Audit rows age like any other history: newest MAX kept, oldest shed.
    expect(capped.filter((record) => record.decision === 'autoAllow')).toHaveLength(
      MAX_APPROVAL_LEDGER_HISTORY
    )
    expect(ids.has('ws-auto-0')).toBe(false)
    expect(ids.has(`ws-auto-${MAX_APPROVAL_LEDGER_HISTORY + 4}`)).toBe(true)
  })

  /**
   * Backstop for the next liveness hole: even genuinely-live grants get a
   * generous ceiling (500 — the real profile that motivated this held 27).
   * Newest survive, pending requests are never dropped. Fails closed: a shed
   * grant re-prompts, it never auto-allows.
   */
  it('caps runaway live grants to the newest 500 while never dropping pending rows', () => {
    const make = (approvalId: string, requestedAt: string) =>
      createApprovalLedgerRecord({ ...baseRequest, approvalId, id: approvalId }, requestedAt)

    const base = Date.parse('2026-06-01T00:00:00.000Z')
    const grants = Array.from({ length: 505 }, (_, i) => {
      const ts = new Date(base + i * 1000).toISOString()
      return resolveApprovalLedgerRecord(make(`grant-${i}`, ts), 'acceptForWorkspace', ts)
    })
    const pendingOld = make('pending-old', '2019-01-01T00:00:00.000Z')

    const capped = capApprovalLedgerRecords([...grants, pendingOld])
    const ids = new Set(capped.map((record) => record.approvalId))

    expect(ids.has('pending-old')).toBe(true)
    expect(capped.filter((record) => record.status === 'approved')).toHaveLength(500)
    expect(ids.has('grant-0')).toBe(false)
    expect(ids.has('grant-4')).toBe(false)
    expect(ids.has('grant-5')).toBe(true)
    expect(ids.has('grant-504')).toBe(true)
  })
})
