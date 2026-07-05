import { describe, expect, it, vi } from 'vitest'
import type { MemoryProposalPack } from '../store/types'
import {
  createIntrospectionToolExecutors,
  defaultIntrospectionWindow,
  isIntrospectionMcpToolName,
  type IntrospectionToolExecutorDeps
} from './IntrospectionToolExecutors'

function samplePack(id = 'pack-1'): MemoryProposalPack {
  return {
    schemaVersion: 1,
    id,
    introspectionRunId: 'run-1',
    windowStart: '2026-07-05T00:00:00.000Z',
    windowEnd: '2026-07-05T23:59:59.999Z',
    proposals: [
      {
        id: 'prop-1',
        kind: 'repo_convention',
        scope: 'workspace',
        status: 'proposed',
        title: 'Avoid repo-wide Prettier',
        lesson: 'Do not run repo-wide Prettier.',
        confidence: 0.9,
        evidenceRefs: [],
        dedupKey: 'prettier',
        requiresReview: true,
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z'
      }
    ],
    evidenceItemCount: 2,
    workspaceId: 'ws-1',
    createdAt: '2026-07-05T12:00:00.000Z',
    updatedAt: '2026-07-05T12:00:00.000Z'
  }
}

function createDeps(): IntrospectionToolExecutorDeps {
  const pack = samplePack()
  return {
    getMemoryProposalPacks: vi.fn((workspaceId?: string) =>
      workspaceId ? [samplePack(`pack-${workspaceId}`)] : [pack]
    ),
    getMemoryProposalPack: vi.fn((id: string) => (id === 'pack-1' ? pack : null)),
    updateMemoryProposal: vi.fn((packId: string, proposalId: string, partial) => {
      if (packId !== 'pack-1' || proposalId !== 'prop-1') return null
      return {
        ...pack,
        proposals: [{ ...pack.proposals[0], ...partial, id: proposalId }]
      }
    }),
    runManualIntrospection: vi.fn(() => ({
      run: {
        schemaVersion: 1 as const,
        id: 'run-2',
        status: 'review_pending' as const,
        trigger: 'manual' as const,
        windowStart: '2026-07-04T12:00:00.000Z',
        windowEnd: '2026-07-05T12:00:00.000Z',
        evidenceItems: [],
        proposalPackId: 'pack-2',
        createdAt: '2026-07-05T12:00:00.000Z',
        updatedAt: '2026-07-05T12:00:00.000Z'
      },
      pack: samplePack('pack-2'),
      evidenceCount: 4,
      proposalCount: 1
    })),
    resolveCallerWorkspaceId: vi.fn(() => 'ws-caller'),
    resolveCallerWorkspacePath: vi.fn(() => '/tmp/workspace'),
    now: vi.fn(() => '2026-07-05T12:00:00.000Z')
  }
}

describe('isIntrospectionMcpToolName', () => {
  it('recognizes the introspection tool family', () => {
    expect(isIntrospectionMcpToolName('tw_introspection_run')).toBe(true)
    expect(isIntrospectionMcpToolName('tw_introspection_list')).toBe(true)
    expect(isIntrospectionMcpToolName('tw_introspection_read')).toBe(true)
    expect(isIntrospectionMcpToolName('tw_introspection_review')).toBe(true)
    expect(isIntrospectionMcpToolName('tw_recall_find')).toBe(false)
  })
})

describe('createIntrospectionToolExecutors', () => {
  it('runs manual introspection with a default rolling window', async () => {
    const deps = createDeps()
    const { executeIntrospectionTool } = createIntrospectionToolExecutors(deps)

    const result = await executeIntrospectionTool('tw_introspection_run', {}, { appChatId: 'chat-1' })
    const parsed = JSON.parse(result.text)

    expect(parsed.ok).toBe(true)
    expect(parsed.packId).toBe('pack-2')
    expect(parsed.proposalCount).toBe(1)
    expect(deps.runManualIntrospection).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'manual',
        workspaceId: 'ws-caller',
        workspacePath: '/tmp/workspace',
        chatId: 'chat-1',
        windowStart: defaultIntrospectionWindow('2026-07-05T12:00:00.000Z').windowStart,
        windowEnd: '2026-07-05T12:00:00.000Z'
      })
    )
  })

  it('lists proposal packs scoped to caller workspace by default', async () => {
    const deps = createDeps()
    const { executeIntrospectionTool } = createIntrospectionToolExecutors(deps)

    const result = await executeIntrospectionTool('tw_introspection_list', {}, {})
    const parsed = JSON.parse(result.text)

    expect(parsed.ok).toBe(true)
    expect(parsed.workspaceId).toBe('ws-caller')
    expect(parsed.packs).toHaveLength(1)
    expect(deps.getMemoryProposalPacks).toHaveBeenCalledWith('ws-caller')
  })

  it('reads a proposal pack by id', async () => {
    const deps = createDeps()
    const { executeIntrospectionTool } = createIntrospectionToolExecutors(deps)

    const result = await executeIntrospectionTool(
      'tw_introspection_read',
      { packId: 'pack-1' },
      {}
    )
    const parsed = JSON.parse(result.text)

    expect(parsed.ok).toBe(true)
    expect(parsed.pack.id).toBe('pack-1')
    expect(parsed.pack.proposals).toHaveLength(1)
  })

  it('rejects review patches outside the whitelist', async () => {
    const deps = createDeps()
    const { executeIntrospectionTool } = createIntrospectionToolExecutors(deps)

    const result = await executeIntrospectionTool(
      'tw_introspection_review',
      { packId: 'pack-1', proposalId: 'prop-1', status: 'applied' },
      {}
    )

    expect(result.isError).toBe(true)
    expect(JSON.parse(result.text).error).toContain('At least one reviewable field')
    expect(deps.updateMemoryProposal).not.toHaveBeenCalled()
  })

  it('updates review status for approved proposals', async () => {
    const deps = createDeps()
    const { executeIntrospectionTool } = createIntrospectionToolExecutors(deps)

    const result = await executeIntrospectionTool(
      'tw_introspection_review',
      {
        packId: 'pack-1',
        proposalId: 'prop-1',
        status: 'approved',
        reviewNote: 'Looks durable.'
      },
      {}
    )
    const parsed = JSON.parse(result.text)

    expect(parsed.ok).toBe(true)
    expect(parsed.proposal.status).toBe('approved')
    expect(parsed.proposal.reviewNote).toBe('Looks durable.')
    expect(deps.updateMemoryProposal).toHaveBeenCalledWith('pack-1', 'prop-1', {
      status: 'approved',
      reviewNote: 'Looks durable.'
    })
  })
})