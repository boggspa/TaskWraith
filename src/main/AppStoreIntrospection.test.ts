import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { AppStore } from './store'
import { buildMemoryProposalPackInput } from './introspection/IntrospectionProposalGenerator'
import {
  createIntrospectionRunServiceDeps,
  runManualIntrospection
} from './introspection/IntrospectionRunService'
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

  it('runs manual introspection from persisted substrate', () => {
    AppStore.saveChat({
      appChatId: 'chat-intro',
      title: 'Intro chat',
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      provider: 'cursor',
      createdAt: Date.parse('2026-07-04T00:00:00.000Z'),
      updatedAt: Date.parse('2026-07-05T12:00:00.000Z'),
      archived: false,
      messages: [
        {
          id: 'msg-a',
          role: 'assistant',
          content: 'Done.',
          timestamp: '2026-07-05T11:59:00.000Z'
        },
        {
          id: 'msg-u',
          role: 'user',
          content: 'No — do not run repo-wide Prettier.',
          timestamp: '2026-07-05T12:00:00.000Z'
        }
      ],
      runs: []
    })

    AppStore.appendRunEvent({
      runId: 'run-intro',
      chatId: 'chat-intro',
      workspaceId: 'ws-1',
      kind: 'approval_response',
      phase: 'control',
      source: 'main',
      summary: 'Approval response: decline',
      payload: { requestId: 'apr-intro', action: 'decline' }
    })

    const result = runManualIntrospection(
      createIntrospectionRunServiceDeps({
        getChats: (workspaceId) => AppStore.getChats(workspaceId),
        getRunEvents: (filter) => AppStore.getRunEvents(filter),
        getApprovalLedger: (filter) => AppStore.getApprovalLedger(filter),
        getMessageFeedbackReceipts: (filter) => AppStore.getMessageFeedbackReceipts(filter),
        createIntrospectionRun: (record) => AppStore.createIntrospectionRun(record),
        updateIntrospectionRun: (id, partial) => AppStore.updateIntrospectionRun(id, partial),
        saveMemoryProposalPack: (pack) => AppStore.saveMemoryProposalPack(pack)
      }),
      {
        windowStart: '2026-07-05T00:00:00.000Z',
        windowEnd: '2026-07-05T23:59:59.999Z',
        workspaceId: 'ws-1',
        workspacePath: '/repo'
      }
    )

    expect(result.evidenceCount).toBeGreaterThanOrEqual(2)
    expect(result.proposalCount).toBeGreaterThanOrEqual(1)
    expect(AppStore.getIntrospectionRun(result.run.id)?.proposalPackId).toBe(result.pack.id)
    expect(AppStore.getMemoryProposalPack(result.pack.id)?.proposals.length).toBe(
      result.proposalCount
    )
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