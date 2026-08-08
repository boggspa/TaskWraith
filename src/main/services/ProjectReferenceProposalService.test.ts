import { describe, expect, it, vi } from 'vitest'

import { applyProjectReferenceOp, type Project, type ProjectReference } from '../../shared/projects'
import { createRunEventRecord, lastRunEventHash } from '../RunEventStore'
import type { RunEventInput, RunEventRecord } from '../store/types'
import { ProjectReferenceProposalService } from './ProjectReferenceProposalService'

const projectA: Project = {
  schemaVersion: 1,
  id: 'project-a',
  name: 'Alpha',
  icon: { iconKind: 'seed', seed: 'a' },
  hue: 1,
  parentId: null,
  order: 1,
  memberChatIds: ['chat-a', 'chat-b'],
  createdAt: 1,
  updatedAt: 1
}

const projectB: Project = {
  ...projectA,
  id: 'project-b',
  name: 'Beta',
  memberChatIds: ['chat-a']
}

function fixture(options: { projects?: Project[]; maxPerRun?: number } = {}) {
  let projects = options.projects ?? [projectA]
  let references: ProjectReference[] = []
  let now = 10
  let id = 0
  let failNextReviewAppend = false
  const events = new Map<string, RunEventRecord[]>()
  const chatRuns = new Map<string, string[]>([
    ['chat-a', ['run-a']],
    ['chat-b', ['run-b']]
  ])
  const appendRunEvent = vi.fn((input: RunEventInput): RunEventRecord | null => {
    if (
      failNextReviewAppend &&
      input.payload &&
      typeof input.payload === 'object' &&
      (input.payload as { action?: string }).action === 'reviewed'
    ) {
      failNextReviewAppend = false
      return null
    }
    const current = events.get(input.runId) ?? []
    const record = createRunEventRecord(
      { ...input, id: `event-${input.runId}-${current.length + 1}` },
      current.length + 1,
      { previousHash: lastRunEventHash(current), now: new Date(now).toISOString() }
    )
    events.set(input.runId, [...current, record])
    return record
  })
  const applyReferenceOp = vi.fn((op: Parameters<typeof applyProjectReferenceOp>[2]) => {
    const result = applyProjectReferenceOp(references, projects, op)
    references = result.references
    return { references }
  })
  const getRunIdsForChat = vi.fn((chatId: string) => chatRuns.get(chatId) ?? [])
  const getRunEvents = vi.fn((runId: string) => events.get(runId) ?? [])
  const service = new ProjectReferenceProposalService({
    getProjects: () => projects,
    getReferences: () => references,
    getRunIdsForChat,
    getRunEvents,
    appendRunEvent,
    applyReferenceOp,
    createId: (kind) => `${kind}-${++id}`,
    now: () => now++,
    maxProposalsPerRun: options.maxPerRun
  })
  return {
    service,
    events,
    appendRunEvent,
    applyReferenceOp,
    getRunIdsForChat,
    getRunEvents,
    references: () => references,
    setReferences: (value: ProjectReference[]) => {
      references = value
    },
    setProjects: (value: Project[]) => {
      projects = value
    },
    failNextReview: () => {
      failNextReviewAppend = true
    }
  }
}

function proposeBrief(
  service: ProjectReferenceProposalService,
  overrides: Record<string, unknown> = {}
) {
  return service.propose({
    runId: 'run-a',
    chatId: 'chat-a',
    kind: 'file',
    locator: '/workspace/brief.docx',
    title: 'Brief',
    reason: 'Useful for the next report',
    provider: 'codex',
    toolCallId: 'tool-a',
    ...overrides
  })
}

describe('ProjectReferenceProposalService', () => {
  it('appends a proposal as reference_context evidence without any I/O or grant dependency', () => {
    const { service, events } = fixture()
    const result = proposeBrief(service)

    expect(result.created).toBe(true)
    expect(result.proposal.payload).toMatchObject({
      action: 'proposed',
      projectId: 'project-a',
      candidate: { kind: 'file', locator: '/workspace/brief.docx', title: 'Brief' }
    })
    expect(events.get('run-a')?.[0]).toMatchObject({
      kind: 'reference_context',
      phase: 'control',
      source: 'main',
      chatId: 'chat-a',
      provider: 'codex',
      toolCallId: 'tool-a'
    })
  })

  it('persists agent-claimed preview evidence on propose and never copies it onto an approved reference', () => {
    const { service } = fixture()
    const proposed = proposeBrief(service, {
      kind: 'url',
      locator: 'https://example.com/brief',
      title: 'Example',
      previewSnippet: 'A short quote from an already-fetched page.',
      previewSource: 'web_fetch'
    })
    expect(proposed.proposal.payload).toMatchObject({
      previewSnippet: 'A short quote from an already-fetched page.',
      previewSource: 'web_fetch'
    })
    expect(() =>
      proposeBrief(service, {
        kind: 'url',
        locator: 'https://example.com/other',
        title: 'Other',
        previewSnippet: 'orphan snippet'
      })
    ).toThrow(/together/)
    const reviewed = service.review({
      projectId: 'project-a',
      proposalId: proposed.proposal.payload.proposalId,
      decision: 'approve'
    })
    expect(reviewed.reference).toMatchObject({
      kind: 'url',
      locator: 'https://example.com/brief',
      title: 'Example'
    })
    expect(reviewed.reference).not.toHaveProperty('previewSnippet')
    expect(reviewed.reference).not.toHaveProperty('previewSource')
  })

  it('requires an explicit Project when the current chat has ambiguous membership', () => {
    const { service } = fixture({ projects: [projectA, projectB] })
    expect(() => proposeBrief(service)).toThrow(/multiple Projects/)
    expect(proposeBrief(service, { projectId: 'project-b' }).proposal.payload.projectId).toBe(
      'project-b'
    )
    expect(() => proposeBrief(service, { projectId: 'project-missing' })).toThrow(/not a member/)
  })

  it('deduplicates a source in one run and enforces the per-run proposal cap', () => {
    const { service, events } = fixture({ maxPerRun: 2 })
    expect(proposeBrief(service).created).toBe(true)
    expect(proposeBrief(service, { title: 'A different title' }).created).toBe(false)
    expect(
      proposeBrief(service, {
        kind: 'folder',
        locator: '/workspace/research',
        title: 'Research'
      }).created
    ).toBe(true)
    expect(() =>
      proposeBrief(service, {
        kind: 'url',
        locator: 'https://example.com',
        title: 'Website'
      })
    ).toThrow(/at most 2/)
    expect(events.get('run-a')).toHaveLength(2)
  })

  it('applies the per-run cap across Projects in a shared chat', () => {
    const { service } = fixture({ projects: [projectA, projectB], maxPerRun: 1 })
    expect(proposeBrief(service, { projectId: 'project-a' }).created).toBe(true)
    expect(() =>
      proposeBrief(service, {
        projectId: 'project-b',
        kind: 'url',
        locator: 'https://example.com',
        title: 'Website'
      })
    ).toThrow(/at most 1/)
  })

  it('lists pending proposals only through exact member-chat run ids', () => {
    const { service, getRunIdsForChat, getRunEvents } = fixture()
    const first = proposeBrief(service)
    service.propose({
      runId: 'run-b',
      chatId: 'chat-b',
      kind: 'url',
      locator: 'https://example.com/research',
      title: 'Research site'
    })
    service.review({
      projectId: 'project-a',
      proposalId: first.proposal.payload.proposalId,
      decision: 'reject'
    })

    const pending = service.listPending('project-a')
    expect(pending.map((proposal) => proposal.event.runId)).toEqual(['run-b'])
    expect(getRunIdsForChat).toHaveBeenCalledWith('chat-a')
    expect(getRunIdsForChat).toHaveBeenCalledWith('chat-b')
    expect(getRunEvents).toHaveBeenCalledWith('run-a')
    expect(getRunEvents).toHaveBeenCalledWith('run-b')
  })

  it('fails closed when any exact member run has a broken hash chain', () => {
    const { service, events } = fixture()
    proposeBrief(service)
    const [event] = events.get('run-a') ?? []
    events.set('run-a', [{ ...event, summary: 'tampered' }])
    expect(() => service.listPending('project-a')).toThrow(/hash chain is invalid/)
  })

  it('approves by ordinary add-reference op, appends the linked decision, and retries idempotently', () => {
    const { service, applyReferenceOp, references, events } = fixture()
    const proposed = proposeBrief(service)
    const input = {
      projectId: 'project-a',
      proposalId: proposed.proposal.payload.proposalId,
      decision: 'approve' as const
    }

    const reviewed = service.review(input)
    expect(reviewed.created).toBe(true)
    expect(applyReferenceOp).toHaveBeenCalledWith({
      kind: 'add-reference',
      id: proposed.proposal.payload.materializationReferenceId,
      projectId: 'project-a',
      referenceKind: 'file',
      locator: '/workspace/brief.docx',
      title: 'Brief',
      now: expect.any(Number)
    })
    expect(references()).toHaveLength(1)
    expect(references()[0].provenance.addedBy).toBe('user')
    expect(events.get('run-a')?.[1].payload).toMatchObject({
      action: 'reviewed',
      decision: 'approve',
      reviewedBy: 'user',
      source: {
        runId: 'run-a',
        eventId: proposed.proposal.event.id,
        eventHash: proposed.proposal.event.hash
      },
      referenceId: references()[0].id
    })

    expect(service.review(input).created).toBe(false)
    expect(applyReferenceOp).toHaveBeenCalledTimes(1)
    expect(events.get('run-a')).toHaveLength(2)
    expect(() => service.review({ ...input, decision: 'reject' })).toThrow(/another decision/)
  })

  it('can retry safely when materialization succeeded but the review append failed', () => {
    const { service, failNextReview, references, applyReferenceOp } = fixture()
    const proposed = proposeBrief(service)
    const input = {
      projectId: 'project-a',
      proposalId: proposed.proposal.payload.proposalId,
      decision: 'approve' as const
    }
    failNextReview()
    expect(() => service.review(input)).toThrow(/Could not append/)
    expect(references()).toHaveLength(1)
    expect(() => service.review({ ...input, decision: 'reject' })).toThrow(
      /materialization already started/
    )

    expect(service.review(input).created).toBe(true)
    expect(references()).toHaveLength(1)
    expect(applyReferenceOp).toHaveBeenCalledTimes(2)
  })

  it('rejects without mutating the Project registry and makes the retry a no-op', () => {
    const { service, applyReferenceOp } = fixture()
    const proposed = proposeBrief(service)
    const input = {
      projectId: 'project-a',
      proposalId: proposed.proposal.payload.proposalId,
      decision: 'reject' as const
    }
    expect(service.review(input).created).toBe(true)
    expect(service.review(input).created).toBe(false)
    expect(applyReferenceOp).not.toHaveBeenCalled()
  })

  it('fails closed if the reserved materialization id was taken by another source', () => {
    const { service, setReferences, applyReferenceOp } = fixture()
    const proposed = proposeBrief(service)
    setReferences([
      {
        id: proposed.proposal.payload.materializationReferenceId,
        projectId: 'project-a',
        kind: 'file',
        locator: '/workspace/other.docx',
        title: 'Other',
        provenance: { addedBy: 'user', addedAt: 1 },
        contextPolicy: 'available',
        updatedAt: 1
      }
    ])
    expect(() =>
      service.review({
        projectId: 'project-a',
        proposalId: proposed.proposal.payload.proposalId,
        decision: 'approve'
      })
    ).toThrow(/reserved Project reference id/i)
    expect(applyReferenceOp).not.toHaveBeenCalled()
  })

  it('rejects malformed proposal-marker events instead of silently hiding them', () => {
    const { service, events, appendRunEvent } = fixture()
    appendRunEvent({
      runId: 'run-a',
      chatId: 'chat-a',
      kind: 'reference_context',
      phase: 'control',
      source: 'main',
      payload: { purpose: 'library-addition-proposal', action: 'proposed' }
    })
    expect(events.get('run-a')).toHaveLength(1)
    expect(() => service.listPending('project-a')).toThrow(/payload is malformed/)
  })
})
