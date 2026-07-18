import { describe, expect, it, vi } from 'vitest'

import type { ProjectReferenceProposalAppendResult } from '../services/ProjectReferenceProposalService'
import {
  createProjectReferenceToolExecutors,
  isProjectReferenceMcpToolName
} from './ProjectReferenceToolExecutors'

function storedProposal(created = true): ProjectReferenceProposalAppendResult {
  return {
    created,
    proposal: {
      payload: {
        schemaVersion: 1,
        purpose: 'library-addition-proposal',
        action: 'proposed',
        proposalId: 'proposal-a',
        projectId: 'project-a',
        materializationReferenceId: 'reference-a',
        candidate: {
          kind: 'file',
          locator: '/workspace/brief.docx',
          title: 'Brief'
        },
        reason: 'Useful for the report',
        proposedAt: 10
      },
      event: {
        schemaVersion: 1,
        id: 'event-a',
        sequence: 1,
        hash: 'a'.repeat(64),
        runId: 'run-a',
        chatId: 'chat-a',
        provider: 'codex',
        kind: 'reference_context',
        phase: 'control',
        source: 'main',
        timestamp: '2026-07-18T00:00:00.000Z'
      }
    }
  }
}

describe('ProjectReferenceToolExecutors', () => {
  it('recognizes only the propose-only Project reference tool', () => {
    expect(isProjectReferenceMcpToolName('project_reference_propose')).toBe(true)
    expect(isProjectReferenceMcpToolName('project_reference_add')).toBe(false)
  })

  it('stamps route/provider/tool identity and notifies only for a new proposal', async () => {
    const propose = vi.fn(() => storedProposal())
    const notifyChanged = vi.fn()
    const executor = createProjectReferenceToolExecutors({
      proposalService: { propose },
      notifyChanged
    })

    const result = await executor.executeProjectReferenceMcpTool(
      'project_reference_propose',
      {
        projectId: 'project-a',
        referenceKind: 'file',
        locator: '/workspace/brief.docx',
        title: 'Brief',
        reason: 'Useful for the report'
      },
      { appRunId: 'run-a', appChatId: 'chat-a' },
      { provider: 'codex', toolCallId: 'tool-a' }
    )

    expect(result).toMatchObject({
      isError: false,
      result: {
        ok: true,
        status: 'proposed_for_human_review',
        proposalId: 'proposal-a'
      }
    })
    expect(propose).toHaveBeenCalledWith({
      runId: 'run-a',
      chatId: 'chat-a',
      projectId: 'project-a',
      kind: 'file',
      locator: '/workspace/brief.docx',
      title: 'Brief',
      reason: 'Useful for the report',
      provider: 'codex',
      toolCallId: 'tool-a'
    })
    expect(notifyChanged).toHaveBeenCalledWith('project-a')
  })

  it('fails closed without a routed run or a reason', async () => {
    const propose = vi.fn(() => storedProposal())
    const executor = createProjectReferenceToolExecutors({ proposalService: { propose } })

    expect(
      await executor.executeProjectReferenceMcpTool(
        'project_reference_propose',
        { referenceKind: 'url', locator: 'https://example.com', reason: 'Useful' },
        { appChatId: 'chat-a' },
        { provider: 'claude' }
      )
    ).toMatchObject({ isError: true, result: { ok: false } })
    expect(
      await executor.executeProjectReferenceMcpTool(
        'project_reference_propose',
        { referenceKind: 'url', locator: 'https://example.com' },
        { appRunId: 'run-a', appChatId: 'chat-a' },
        { provider: 'claude' }
      )
    ).toMatchObject({ isError: true, result: { error: 'Proposal reason is required.' } })
    expect(propose).not.toHaveBeenCalled()
  })

  it('does not rebroadcast a same-run duplicate', async () => {
    const propose = vi.fn(() => storedProposal(false))
    const notifyChanged = vi.fn()
    const executor = createProjectReferenceToolExecutors({
      proposalService: { propose },
      notifyChanged
    })

    const result = await executor.executeProjectReferenceMcpTool(
      'project_reference_propose',
      { referenceKind: 'file', locator: '/workspace/brief.docx', reason: 'Useful' },
      { appRunId: 'run-a', appChatId: 'chat-a' },
      { provider: 'codex' }
    )

    expect(result).toMatchObject({ isError: false, result: { created: false } })
    expect(notifyChanged).not.toHaveBeenCalled()
  })
})
