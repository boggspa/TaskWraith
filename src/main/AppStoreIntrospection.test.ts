import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { AppStore } from './store'
import { buildMemoryProposalPackInput } from './introspection/IntrospectionProposalGenerator'
import type { IntrospectionEvidenceItem } from './store/types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-introspection-test-${process.pid}`)

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

function evidence(signal: string): IntrospectionEvidenceItem {
  return {
    id: `ev-${signal}`,
    source: 'run_event',
    signal,
    chatId: 'chat-1',
    runId: 'run-1',
    timestamp: '2026-07-05T12:00:00.000Z',
    summary: `summary for ${signal}`
  }
}

describe('AppStore thread introspection', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('creates and reads introspection runs', () => {
    const run = AppStore.createIntrospectionRun({
      status: 'collecting',
      trigger: 'manual',
      windowStart: '2026-07-04T00:00:00.000Z',
      windowEnd: '2026-07-05T00:00:00.000Z',
      workspaceId: 'ws-1',
      workspacePath: '/repo'
    })
    expect(run.schemaVersion).toBe(1)
    expect(run.evidenceItems).toEqual([])
    expect(AppStore.getIntrospectionRun(run.id)?.workspaceId).toBe('ws-1')
  })

  it('persists memory proposal packs and updates proposal status', () => {
    const run = AppStore.createIntrospectionRun({
      status: 'review_pending',
      trigger: 'scheduled',
      windowStart: '2026-07-04T00:00:00.000Z',
      windowEnd: '2026-07-05T00:00:00.000Z',
      workspaceId: 'ws-1'
    })
    const built = buildMemoryProposalPackInput({
      introspectionRunId: run.id,
      workspaceId: 'ws-1',
      windowStart: run.windowStart,
      windowEnd: run.windowEnd,
      evidenceItems: [evidence('approval_denied'), evidence('tool_loop')]
    })
    const pack = AppStore.saveMemoryProposalPack({
      introspectionRunId: run.id,
      workspaceId: 'ws-1',
      windowStart: run.windowStart,
      windowEnd: run.windowEnd,
      proposals: built.proposals,
      evidenceItemCount: built.evidenceItemCount,
      summary: 'Daily introspection'
    })
    expect(pack.proposals.length).toBeGreaterThan(0)
    const proposalId = pack.proposals[0]!.id
    const updated = AppStore.updateMemoryProposal(pack.id, proposalId, { status: 'approved' })
    expect(updated?.proposals.find((p) => p.id === proposalId)?.status).toBe('approved')
    AppStore.updateIntrospectionRun(run.id, {
      status: 'completed',
      proposalPackId: pack.id
    })
    expect(AppStore.getIntrospectionRun(run.id)?.proposalPackId).toBe(pack.id)
  })

  it('filters by workspace', () => {
    AppStore.createIntrospectionRun({
      status: 'collecting',
      trigger: 'manual',
      windowStart: '2026-07-04T00:00:00.000Z',
      windowEnd: '2026-07-05T00:00:00.000Z',
      workspaceId: 'ws-a'
    })
    AppStore.createIntrospectionRun({
      status: 'collecting',
      trigger: 'manual',
      windowStart: '2026-07-04T00:00:00.000Z',
      windowEnd: '2026-07-05T00:00:00.000Z',
      workspaceId: 'ws-b'
    })
    expect(AppStore.getIntrospectionRuns('ws-a')).toHaveLength(1)
    expect(AppStore.getIntrospectionRuns()).toHaveLength(2)
  })
})