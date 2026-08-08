import { describe, expect, it, vi } from 'vitest'

import type { Project, ProjectReference } from '../../shared/projects'
import type { ProjectReferenceProposalAppendResult } from '../services/ProjectReferenceProposalService'
import {
  createProjectReferenceToolExecutors,
  isProjectReferenceMcpToolName,
  PROJECT_REFERENCE_LIST_MAX,
  PROJECT_REFERENCE_MCP_TOOL_NAMES
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

function project(memberChatIds: string[] = ['chat-a']): Project {
  return {
    id: 'project-a',
    name: 'Alpha',
    hue: 120,
    memberChatIds,
    createdAt: 1,
    updatedAt: 1
  } as Project
}

function reference(
  overrides: Partial<ProjectReference> & Pick<ProjectReference, 'id' | 'kind' | 'locator' | 'title'>
): ProjectReference {
  return {
    projectId: 'project-a',
    provenance: { addedBy: 'user', addedAt: 1 },
    contextPolicy: 'available',
    updatedAt: 10,
    ...overrides
  }
}

describe('ProjectReferenceToolExecutors', () => {
  it('recognizes propose and list Project reference tools only', () => {
    expect(PROJECT_REFERENCE_MCP_TOOL_NAMES).toEqual([
      'project_reference_propose',
      'project_reference_list'
    ])
    expect(isProjectReferenceMcpToolName('project_reference_propose')).toBe(true)
    expect(isProjectReferenceMcpToolName('project_reference_list')).toBe(true)
    expect(isProjectReferenceMcpToolName('project_reference_add')).toBe(false)
  })

  it('stamps route/provider/tool identity and notifies only for a new proposal', async () => {
    const propose = vi.fn(() => storedProposal())
    const notifyChanged = vi.fn()
    const executor = createProjectReferenceToolExecutors({
      proposalService: { propose },
      getProjects: () => [project()],
      getReferences: () => [],
      notifyChanged
    })

    const result = await executor.executeProjectReferenceMcpTool(
      'project_reference_propose',
      {
        projectId: 'project-a',
        referenceKind: 'file',
        locator: '/workspace/brief.docx',
        title: 'Brief',
        reason: 'Useful for the report',
        previewSnippet: 'A short quote from an already-fetched page.',
        previewSource: 'web_fetch'
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
      previewSnippet: 'A short quote from an already-fetched page.',
      previewSource: 'web_fetch',
      provider: 'codex',
      toolCallId: 'tool-a'
    })
    expect(notifyChanged).toHaveBeenCalledWith('project-a')
  })

  it('fails closed without a routed run or a reason', async () => {
    const propose = vi.fn(() => storedProposal())
    const executor = createProjectReferenceToolExecutors({
      proposalService: { propose },
      getProjects: () => [project()],
      getReferences: () => []
    })

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
      getProjects: () => [project()],
      getReferences: () => [],
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

  it('lists metadata-only references for the chat project without requiring a run', async () => {
    const propose = vi.fn(() => storedProposal())
    const getReferences = vi.fn(() => [
      reference({
        id: 'ref-off',
        kind: 'url',
        locator: 'https://example.com/off',
        title: 'Off',
        contextPolicy: 'off',
        updatedAt: 30
      }),
      reference({
        id: 'ref-file',
        kind: 'file',
        locator: '/workspace/brief.docx',
        title: 'Brief',
        lastVerified: { at: 20, status: 'ok' },
        updatedAt: 40
      }),
      reference({
        id: 'ref-other',
        projectId: 'project-b',
        kind: 'folder',
        locator: '/workspace/other',
        title: 'Other'
      })
    ])
    const executor = createProjectReferenceToolExecutors({
      proposalService: { propose },
      getProjects: () => [project()],
      getReferences
    })

    const result = await executor.executeProjectReferenceMcpTool(
      'project_reference_list',
      {},
      { appChatId: 'chat-a' },
      { provider: 'codex' }
    )

    expect(result).toMatchObject({
      isError: false,
      result: {
        ok: true,
        tool: 'project_reference_list',
        projectId: 'project-a',
        truncated: false
      }
    })
    const listed = (result.result as { references: unknown[] }).references
    expect(listed).toEqual([
      {
        id: 'ref-file',
        kind: 'file',
        locator: '/workspace/brief.docx',
        title: 'Brief',
        contextPolicy: 'available',
        lastVerified: { at: 20, status: 'ok' },
        updatedAt: 40
      },
      {
        id: 'ref-off',
        kind: 'url',
        locator: 'https://example.com/off',
        title: 'Off',
        contextPolicy: 'off',
        updatedAt: 30
      }
    ])
    expect(propose).not.toHaveBeenCalled()
    expect(JSON.stringify(listed)).not.toMatch(/provenance|addedBy|projectId/)
  })

  it('honors includeOff=false, kind filter, membership resolution, and the 200 cap', async () => {
    const many = Array.from({ length: PROJECT_REFERENCE_LIST_MAX + 3 }, (_, index) =>
      reference({
        id: `ref-${index}`,
        kind: index % 2 === 0 ? 'file' : 'url',
        locator: `/workspace/item-${index}`,
        title: `Item ${index}`,
        contextPolicy: index === 0 ? 'off' : 'available',
        updatedAt: 1000 - index
      })
    )
    const executor = createProjectReferenceToolExecutors({
      proposalService: { propose: vi.fn(() => storedProposal()) },
      getProjects: () => [project()],
      getReferences: () => many
    })

    const filtered = await executor.executeProjectReferenceMcpTool(
      'project_reference_list',
      { includeOff: false, kind: 'file' },
      { appChatId: 'chat-a' },
      { provider: 'claude' }
    )
    expect(filtered).toMatchObject({ isError: false, result: { truncated: false } })
    const filteredRefs = (filtered.result as { references: Array<{ kind: string; contextPolicy: string }> })
      .references
    expect(filteredRefs.every((entry) => entry.kind === 'file')).toBe(true)
    expect(filteredRefs.every((entry) => entry.contextPolicy === 'available')).toBe(true)
    expect(filteredRefs.some((entry) => entry.contextPolicy === 'off')).toBe(false)

    const capped = await executor.executeProjectReferenceMcpTool(
      'project_reference_list',
      {},
      { appChatId: 'chat-a' },
      { provider: 'claude' }
    )
    expect(capped).toMatchObject({
      isError: false,
      result: {
        truncated: true,
        references: expect.any(Array)
      }
    })
    expect((capped.result as { references: unknown[] }).references).toHaveLength(
      PROJECT_REFERENCE_LIST_MAX
    )

    const multi = createProjectReferenceToolExecutors({
      proposalService: { propose: vi.fn(() => storedProposal()) },
      getProjects: () => [project(['chat-a']), { ...project(['chat-a']), id: 'project-b' }],
      getReferences: () => []
    })
    expect(
      await multi.executeProjectReferenceMcpTool(
        'project_reference_list',
        {},
        { appChatId: 'chat-a' },
        { provider: 'codex' }
      )
    ).toMatchObject({
      isError: true,
      result: {
        error: 'Current chat belongs to multiple Projects; an explicit Project id is required.'
      }
    })

    expect(
      await executor.executeProjectReferenceMcpTool(
        'project_reference_list',
        {},
        {},
        { provider: 'codex' }
      )
    ).toMatchObject({
      isError: true,
      result: { error: 'Project reference list requires an active routed chat.' }
    })
  })
})
