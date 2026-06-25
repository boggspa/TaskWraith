import { describe, expect, it } from 'vitest'
import { findStaleAuditRuns } from './AuditReconciler'
import type { AuditRunRecord, AuditRunStatus } from '../store/types'

const run = (id: string, status: AuditRunStatus): AuditRunRecord =>
  ({
    schemaVersion: 1,
    id,
    mode: 'standard',
    chatId: 'c1',
    workspacePath: '/ws',
    status,
    phases: [],
    dimensions: [],
    participants: [],
    findings: [],
    verdicts: [],
    gates: [],
    budget: { maxAgents: 8, spentAgents: 0, spentTokens: 0, truncated: false },
    createdAt: 't',
    updatedAt: 't'
  }) as unknown as AuditRunRecord

describe('findStaleAuditRuns', () => {
  it('flags non-terminal runs (planning / awaitingConfirm / running) as orphaned', () => {
    const stale = findStaleAuditRuns([
      run('a', 'planning'),
      run('b', 'awaitingConfirm'),
      run('c', 'running')
    ])
    expect(stale).toEqual([
      { id: 'a', previousStatus: 'planning' },
      { id: 'b', previousStatus: 'awaitingConfirm' },
      { id: 'c', previousStatus: 'running' }
    ])
  })

  it('skips terminal runs (idempotent re-boot — a settled run is never re-flagged)', () => {
    expect(
      findStaleAuditRuns([run('a', 'completed'), run('b', 'failed'), run('c', 'cancelled')])
    ).toEqual([])
  })

  it('returns only the non-terminal subset from a mixed list', () => {
    const stale = findStaleAuditRuns([
      run('done', 'completed'),
      run('stuck', 'running'),
      run('killed', 'cancelled')
    ])
    expect(stale).toEqual([{ id: 'stuck', previousStatus: 'running' }])
  })

  it('handles an empty list and skips malformed records (no id)', () => {
    expect(findStaleAuditRuns([])).toEqual([])
    expect(findStaleAuditRuns([{ status: 'running' } as unknown as AuditRunRecord])).toEqual([])
  })
})
