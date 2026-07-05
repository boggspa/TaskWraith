import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { AppStore } from './store'
import { buildMemoryProposalPackInput } from './introspection/IntrospectionProposalGenerator'
import { applyMemoryProposal } from './introspection/IntrospectionApplyService'
import {
  expireDueMemoryProposals,
  supersedeMemoryProposal
} from './introspection/IntrospectionLifecycleService'
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

  it('persists per-workspace introspection schedules', () => {
    const disabled = AppStore.getIntrospectionSchedule('ws-1')
    expect(disabled.enabled).toBe(false)
    expect(disabled.workspaceId).toBe('ws-1')

    const enabled = AppStore.updateIntrospectionSchedule({
      workspaceId: 'ws-1',
      enabled: true
    })
    expect(enabled.enabled).toBe(true)
    expect(enabled.nextRunAt).toBeTypeOf('string')

    const loaded = AppStore.getIntrospectionSchedule('ws-1')
    expect(loaded.enabled).toBe(true)
    expect(loaded.nextRunAt).toBe(enabled.nextRunAt)

    const disabledAgain = AppStore.updateIntrospectionSchedule({
      workspaceId: 'ws-1',
      enabled: false
    })
    expect(disabledAgain.enabled).toBe(false)
    expect(disabledAgain.nextRunAt).toBeNull()
  })

  it('applies approved repo_convention proposals into RepoConventionIndex', () => {
    const run = AppStore.createIntrospectionRun({
      status: 'review_pending',
      trigger: 'manual',
      windowStart: '2026-07-04T00:00:00.000Z',
      windowEnd: '2026-07-05T00:00:00.000Z',
      workspaceId: 'ws-1',
      workspacePath: '/repo'
    })
    const pack = AppStore.saveMemoryProposalPack({
      introspectionRunId: run.id,
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      windowStart: run.windowStart,
      windowEnd: run.windowEnd,
      proposals: [
        {
          id: 'prop-apply',
          kind: 'repo_convention',
          scope: 'workspace',
          status: 'approved',
          title: 'No repo-wide Prettier',
          lesson: 'Do not run repo-wide Prettier.',
          confidence: 0.9,
          evidenceRefs: [
            {
              chatId: 'chat-1',
              timestamp: '2026-07-05T12:00:00.000Z',
              summary: 'User correction'
            }
          ],
          dedupKey: 'no-prettier',
          requiresReview: false,
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z'
        }
      ],
      evidenceItemCount: 1
    })

    const result = applyMemoryProposal(
      {
        store: {
          getMemoryProposalPack: (id) => AppStore.getMemoryProposalPack(id),
          updateMemoryProposal: (packId, proposalId, partial) =>
            AppStore.updateMemoryProposal(packId, proposalId, partial),
          getRepoConventionIndexes: (workspaceId) => AppStore.getRepoConventionIndexes(workspaceId),
          saveRepoConventionIndex: (snapshot) => AppStore.saveRepoConventionIndex(snapshot)
        },
        now: () => '2026-07-05T18:00:00.000Z'
      },
      pack.id,
      'prop-apply'
    )

    expect(result.ok).toBe(true)
    expect(result.conventionEntryId).toBe('intro-prop-apply')
    const indexes = AppStore.getRepoConventionIndexes('ws-1')
    expect(indexes[0]?.entries).toEqual([
      expect.objectContaining({
        id: 'intro-prop-apply',
        kind: 'decision',
        provenance: 'introspection',
        title: 'No repo-wide Prettier'
      })
    ])
    const updated = AppStore.getMemoryProposalPack(pack.id)
    expect(updated?.proposals[0]?.status).toBe('applied')
    expect(updated?.proposals[0]?.applyReceipt?.conventionEntryId).toBe('intro-prop-apply')

    const again = applyMemoryProposal(
      {
        store: {
          getMemoryProposalPack: (id) => AppStore.getMemoryProposalPack(id),
          updateMemoryProposal: (packId, proposalId, partial) =>
            AppStore.updateMemoryProposal(packId, proposalId, partial),
          getRepoConventionIndexes: (workspaceId) => AppStore.getRepoConventionIndexes(workspaceId),
          saveRepoConventionIndex: (snapshot) => AppStore.saveRepoConventionIndex(snapshot)
        },
        now: () => '2026-07-05T19:00:00.000Z'
      },
      pack.id,
      'prop-apply'
    )
    expect(again.ok).toBe(true)
    expect(AppStore.getRepoConventionIndexes('ws-1')[0]?.entries).toHaveLength(1)
  })

  it('supersedes and expires proposals through the lifecycle service', () => {
    const run = AppStore.createIntrospectionRun({
      status: 'review_pending',
      trigger: 'manual',
      windowStart: '2026-07-04T00:00:00.000Z',
      windowEnd: '2026-07-05T00:00:00.000Z',
      workspaceId: 'ws-1'
    })
    const oldPack = AppStore.saveMemoryProposalPack({
      introspectionRunId: run.id,
      workspaceId: 'ws-1',
      windowStart: run.windowStart,
      windowEnd: run.windowEnd,
      proposals: [
        {
          id: 'prop-old',
          kind: 'repo_convention',
          scope: 'workspace',
          status: 'proposed',
          title: 'Old lesson',
          lesson: 'Old wording.',
          confidence: 0.8,
          evidenceRefs: [
            {
              chatId: 'chat-1',
              timestamp: '2026-07-05T12:00:00.000Z',
              summary: 'evidence'
            }
          ],
          dedupKey: 'lesson-a',
          requiresReview: false,
          createdAt: '2026-07-05T12:00:00.000Z',
          updatedAt: '2026-07-05T12:00:00.000Z'
        }
      ],
      evidenceItemCount: 1
    })
    const newPack = AppStore.saveMemoryProposalPack({
      introspectionRunId: run.id,
      workspaceId: 'ws-1',
      windowStart: run.windowStart,
      windowEnd: run.windowEnd,
      proposals: [
        {
          id: 'prop-new',
          kind: 'repo_convention',
          scope: 'workspace',
          status: 'proposed',
          title: 'New lesson',
          lesson: 'Refined wording.',
          confidence: 0.85,
          evidenceRefs: [
            {
              chatId: 'chat-2',
              timestamp: '2026-07-05T13:00:00.000Z',
              summary: 'new evidence'
            }
          ],
          dedupKey: 'lesson-a',
          requiresReview: false,
          createdAt: '2026-07-05T13:00:00.000Z',
          updatedAt: '2026-07-05T13:00:00.000Z'
        },
        {
          id: 'prop-stale',
          kind: 'preference',
          scope: 'user',
          status: 'proposed',
          title: 'Stale preference',
          lesson: 'Expired lesson.',
          confidence: 0.7,
          evidenceRefs: [
            {
              chatId: 'chat-3',
              timestamp: '2026-07-05T10:00:00.000Z',
              summary: 'old preference'
            }
          ],
          dedupKey: 'pref-stale',
          requiresReview: true,
          expiresAt: '2026-07-05T12:00:00.000Z',
          createdAt: '2026-07-05T10:00:00.000Z',
          updatedAt: '2026-07-05T10:00:00.000Z'
        }
      ],
      evidenceItemCount: 2
    })

    const lifecycleStore = {
      getMemoryProposalPacks: (workspaceId?: string) => AppStore.getMemoryProposalPacks(workspaceId),
      getMemoryProposalPack: (id: string) => AppStore.getMemoryProposalPack(id),
      applyMemoryProposalPatches: (patches) => AppStore.applyMemoryProposalPatches(patches)
    }

    const supersedeResult = supersedeMemoryProposal(
      { store: lifecycleStore, now: () => '2026-07-05T18:00:00.000Z' },
      {
        successorPackId: newPack.id,
        successorProposalId: 'prop-new',
        predecessorProposalId: 'prop-old'
      }
    )
    expect(supersedeResult.ok).toBe(true)
    expect(AppStore.getMemoryProposalPack(oldPack.id)?.proposals[0]).toMatchObject({
      status: 'superseded',
      supersededById: 'prop-new'
    })
    expect(AppStore.getMemoryProposalPack(newPack.id)?.proposals[0]).toMatchObject({
      supersedesId: 'prop-old'
    })

    const expireResult = expireDueMemoryProposals(
      { store: lifecycleStore, now: () => '2026-07-05T18:00:00.000Z' },
      { workspaceId: 'ws-1' }
    )
    expect(expireResult.expiredCount).toBe(1)
    expect(
      AppStore.getMemoryProposalPack(newPack.id)?.proposals.find((item) => item.id === 'prop-stale')
        ?.status
    ).toBe('expired')
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