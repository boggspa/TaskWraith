import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { AppStore } from './store'
import type {
  AuditFinding,
  AuditGateResult,
  AuditParticipant,
  AuditRunRecord,
  AuditVerdict
} from './store/types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-audit-runs-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

function baseInput(overrides: Partial<AuditRunRecord> = {}) {
  return {
    mode: 'quick' as const,
    chatId: 'chat-1',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    status: 'planning' as const,
    dimensions: ['code health', 'test depth'],
    budget: { maxAgents: 8, spentAgents: 0, spentTokens: 0, truncated: false },
    ...overrides
  }
}

function finding(id: string, over: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id,
    dimension: 'code health',
    polarity: 'weakness',
    claim: 'God module',
    severity: 'high',
    confidence: 0.8,
    evidenceRefs: [{ path: 'src/main/index.ts', line: 1 }],
    authorProvider: 'claude',
    dedupKey: `k-${id}`,
    verdictState: 'pending',
    createdAt: '2026-06-13T00:00:00.000Z',
    ...over
  }
}

describe('AppStore audit runs', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('creates and reads back a run with defaulted arrays', () => {
    const run = AppStore.createAuditRun(baseInput())
    expect(run.id).toBeTruthy()
    expect(run.schemaVersion).toBe(1)
    expect(run.findings).toEqual([])
    expect(run.participants).toEqual([])
    const loaded = AppStore.getAuditRun(run.id)
    expect(loaded?.mode).toBe('quick')
    expect(loaded?.dimensions).toEqual(['code health', 'test depth'])
  })

  it('updates status and merges fields', () => {
    const run = AppStore.createAuditRun(baseInput())
    const updated = AppStore.updateAuditRun(run.id, { status: 'running', report: 'done' })
    expect(updated?.status).toBe('running')
    expect(updated?.report).toBe('done')
    expect(AppStore.getAuditRun(run.id)?.status).toBe('running')
  })

  it('appends findings/verdicts/gates idempotently by id', () => {
    const run = AppStore.createAuditRun(baseInput())
    AppStore.appendAuditFinding(run.id, finding('f1'))
    AppStore.appendAuditFinding(run.id, finding('f1', { claim: 'updated claim' }))
    AppStore.appendAuditFinding(run.id, finding('f2'))
    const verdict: AuditVerdict = {
      id: 'v1',
      findingId: 'f1',
      skepticProvider: 'codex',
      decision: 'refute',
      counterEvidence: [{ path: 'src/x.ts', line: 9 }],
      createdAt: '2026-06-13T00:01:00.000Z'
    }
    AppStore.appendAuditVerdict(run.id, verdict)
    const gate: AuditGateResult = {
      id: 'g1',
      check: 'typecheck',
      command: 'npm run typecheck',
      status: 'pass'
    }
    AppStore.appendAuditGateResult(run.id, gate)

    const loaded = AppStore.getAuditRun(run.id)!
    expect(loaded.findings).toHaveLength(2)
    expect(loaded.findings.find((f) => f.id === 'f1')?.claim).toBe('updated claim')
    expect(loaded.verdicts).toHaveLength(1)
    expect(loaded.gates).toHaveLength(1)
  })

  it('upserts participants by runId', () => {
    const run = AppStore.createAuditRun(baseInput())
    const p = (status: AuditParticipant['status']): AuditParticipant => ({
      runId: 'r1',
      role: 'reviewer',
      provider: 'claude',
      status
    })
    AppStore.upsertAuditParticipant(run.id, p('running'))
    AppStore.upsertAuditParticipant(run.id, p('completed'))
    const loaded = AppStore.getAuditRun(run.id)!
    expect(loaded.participants).toHaveLength(1)
    expect(loaded.participants[0].status).toBe('completed')
  })

  it('filters by workspace and sorts newest-first', () => {
    const a = AppStore.createAuditRun(
      baseInput({ workspaceId: 'ws-a', createdAt: '2026-06-10T00:00:00.000Z' } as never)
    )
    const b = AppStore.createAuditRun(
      baseInput({ workspaceId: 'ws-b', createdAt: '2026-06-12T00:00:00.000Z' } as never)
    )
    const wsA = AppStore.getAuditRuns('ws-a')
    expect(wsA.map((r) => r.id)).toEqual([a.id])
    const all = AppStore.getAuditRuns()
    expect(all[0].id).toBe(b.id) // newest first
  })

  it('caps stored runs at the history limit', () => {
    const template = AppStore.createAuditRun(baseInput({ id: 'seed-template' }))
    const seededRuns = Array.from({ length: 100 }, (_, index) => ({
      ...template,
      id: `seed-${index}`,
      createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, 100 - index)).toISOString(),
      updatedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, 100 - index)).toISOString()
    }))
    fs.writeFileSync(path.join(userDataPath, 'audit-runs.json'), JSON.stringify(seededRuns))

    const newest = AppStore.createAuditRun(baseInput({ id: 'newest' }))
    const all = AppStore.getAuditRuns()

    expect(all.length).toBe(100)
    expect(all[0].id).toBe(newest.id)
    expect(all.some((run) => run.id === 'seed-99')).toBe(false)
  })

  it('deletes a run', () => {
    const run = AppStore.createAuditRun(baseInput())
    AppStore.deleteAuditRun(run.id)
    expect(AppStore.getAuditRun(run.id)).toBeNull()
  })

  it('returns null updating an unknown run', () => {
    expect(AppStore.updateAuditRun('nope', { status: 'failed' })).toBeNull()
  })
})
