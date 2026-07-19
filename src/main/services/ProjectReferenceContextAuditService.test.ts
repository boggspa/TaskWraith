import { describe, expect, it, vi } from 'vitest'

import type { Project, ProjectReference } from '../../shared/projects'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { ChatRecord, RunEventInput, RunEventRecord } from '../store/types'
import type {
  ProjectReferenceOwnedSnapshotBatchResult,
  ProjectReferenceOwnedSnapshotReceipt
} from './ProjectReferenceArtifactStore'
import {
  ProjectReferenceContextAuditService,
  projectReferenceOwnedArtifactRefsFromRunEvents
} from './ProjectReferenceContextAuditService'

const project: Project = {
  schemaVersion: 1,
  id: 'project-a',
  name: 'Alpha',
  icon: { iconKind: 'seed', seed: 'a' },
  hue: 1,
  parentId: null,
  order: 1,
  memberChatIds: ['chat-a'],
  createdAt: 1,
  updatedAt: 1
}

const reference: ProjectReference = {
  id: 'ref-a',
  projectId: project.id,
  kind: 'file',
  locator: '/workspace/brief.txt',
  title: 'Brief',
  provenance: { addedBy: 'user', addedAt: 1 },
  contextPolicy: 'available',
  updatedAt: 1
}

const payload = {
  provider: 'codex',
  scope: 'workspace',
  workspace: '/workspace',
  prompt: 'Use the brief',
  appRunId: 'run-a',
  appChatId: 'chat-a',
  projectReferenceContext: {
    schemaVersion: 1,
    projectId: project.id,
    projectName: project.name,
    references: [
      {
        id: reference.id,
        kind: reference.kind,
        title: reference.title,
        locator: reference.locator,
        access: 'workspace'
      }
    ]
  }
} satisfies AgentRunPayload

function fixture() {
  const events: RunEventInput[] = []
  const durabilityOrder: string[] = []
  const appendRunEvent = vi.fn((input: RunEventInput): RunEventRecord | null => {
    events.push(input)
    durabilityOrder.push('event-durable')
    return { ...input, schemaVersion: 1, id: `event-${events.length}`, sequence: events.length,
      timestamp: new Date().toISOString() } as RunEventRecord
  })
  const receipt = { id: 'receipt-a' } as ProjectReferenceOwnedSnapshotReceipt
  const snapshotOwnedMany = vi.fn(
    (input: { files: unknown[] }): ProjectReferenceOwnedSnapshotBatchResult => ({
      ok: true,
      artifacts: input.files.map(() => ({
        id: 'project-reference:abc',
        kind: 'snapshot' as const,
        path: '/private/context/abc.snapshot',
        sha256: 'abc',
        sizeBytes: 7
      })),
      receipt
    })
  )
  const commitOwnedBatch = vi.fn(() => {
    durabilityOrder.push('ownership-committed')
    return true
  })
  const rollbackOwnedBatch = vi.fn(() => ({ revokedOwners: 1, deletedArtifacts: 1 }))
  const service = new ProjectReferenceContextAuditService({
    getChat: () => ({ appChatId: 'chat-a', workspaceId: 'workspace-a' }) as ChatRecord,
    getProjects: () => [project],
    getReferences: () => [reference],
    appendDurableRunEvent: appendRunEvent,
    artifactStore: { snapshotOwnedMany, commitOwnedBatch, rollbackOwnedBatch } as never
  })
  return {
    service,
    events,
    appendRunEvent,
    durabilityOrder,
    snapshotOwnedMany,
    commitOwnedBatch,
    rollbackOwnedBatch
  }
}

describe('ProjectReferenceContextAuditService', () => {
  it('selects only main-owned Project-reference snapshots for startup reconciliation', () => {
    const base = {
      schemaVersion: 1 as const,
      id: 'event-a',
      sequence: 1,
      runId: 'run-a',
      chatId: 'chat-a',
      kind: 'reference_context' as const,
      phase: 'artifact' as const,
      source: 'main' as const,
      timestamp: new Date().toISOString()
    }
    const owned = {
      id: 'owned',
      kind: 'snapshot' as const,
      path: '/private/context/abc.snapshot',
      sha256: 'a'.repeat(64),
      sizeBytes: 7,
      metadata: {
        source: 'project_reference_context',
        storage: 'main_owned_snapshot'
      }
    }
    const refs = projectReferenceOwnedArtifactRefsFromRunEvents([
      { ...base, artifacts: [owned] },
      {
        ...base,
        id: 'event-unowned',
        sequence: 2,
        artifacts: [{ ...owned, id: 'wrong-storage', metadata: { storage: 'workspace' } }]
      },
      { ...base, id: 'event-other', sequence: 3, kind: 'lifecycle', artifacts: [owned] },
      { ...base, id: 'event-provider', sequence: 4, source: 'provider', artifacts: [owned] }
    ] as RunEventRecord[])

    expect(refs).toEqual([
      {
        sha256: 'a'.repeat(64),
        path: '/private/context/abc.snapshot',
        sizeBytes: 7,
        appChatId: 'chat-a',
        runId: 'run-a'
      }
    ])
  })

  it('projects pending deletion out of startup reachability while retaining shared survivors', () => {
    const artifact = {
      id: 'shared',
      kind: 'snapshot' as const,
      path: '/private/context/shared.snapshot',
      sha256: 'b'.repeat(64),
      sizeBytes: 12,
      metadata: {
        source: 'project_reference_context',
        storage: 'main_owned_snapshot'
      }
    }
    const event = (chatId: string, runId: string, sequence: number): RunEventRecord =>
      ({
        schemaVersion: 1,
        id: `event-${sequence}`,
        sequence,
        runId,
        chatId,
        kind: 'reference_context',
        phase: 'artifact',
        source: 'main',
        timestamp: new Date().toISOString(),
        artifacts: [artifact]
      }) as RunEventRecord
    const events = [event('deleted-chat', 'deleted-run', 1), event('survivor-chat', 'survivor-run', 2)]

    expect(
      projectReferenceOwnedArtifactRefsFromRunEvents(events, {
        kind: 'chat',
        chatIds: ['deleted-chat'],
        runIds: ['deleted-run']
      })
    ).toEqual([
      expect.objectContaining({ appChatId: 'survivor-chat', runId: 'survivor-run' })
    ])
    expect(
      projectReferenceOwnedArtifactRefsFromRunEvents(events, {
        kind: 'global',
        chatIds: ['deleted-chat', 'survivor-chat'],
        runIds: ['deleted-run', 'survivor-run']
      })
    ).toEqual([])
  })

  it('materializes authorized files without putting their locator in event payloads', () => {
    const { service, events, snapshotOwnedMany, commitOwnedBatch, durabilityOrder } = fixture()
    service.capture(payload)

    expect(snapshotOwnedMany).toHaveBeenCalledWith({
      appChatId: 'chat-a',
      runId: 'run-a',
      files: [
        {
          candidatePath: '/workspace/brief.txt',
          workspacePath: '/workspace',
          externalPathGrants: undefined
        }
      ]
    })
    expect(commitOwnedBatch).toHaveBeenCalledTimes(1)
    expect(durabilityOrder).toEqual(['event-durable', 'ownership-committed'])
    expect(events[0].kind).toBe('reference_context')
    expect(events[0].artifacts?.[0].path).toBe('/private/context/abc.snapshot')
    expect(JSON.stringify(events[0].payload)).not.toContain('/workspace/brief.txt')
  })

  it('links each approval once to the same immutable artifact set', () => {
    const { service, events } = fixture()
    service.capture(payload)

    expect(service.linkApproval('run-a', 'approval-a')).toBe(true)
    expect(service.linkApproval('run-a', 'approval-a')).toBe(false)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      kind: 'reference_context',
      approvalId: 'approval-a',
      parentSpanId: expect.stringMatching(/^reference-context:/)
    })
    expect(events[1].artifacts).toEqual(events[0].artifacts)
  })

  it('backfills an approval raised during preflight after artifacts exist', () => {
    const { service, events } = fixture()
    service.prepare(payload)
    expect(service.linkApproval('run-a', 'approval-preflight', 'codex')).toBe(false)

    service.capture(payload)

    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({
      kind: 'reference_context',
      approvalId: 'approval-preflight',
      provider: 'codex'
    })
  })

  it('fails closed if an Off reference changes after composition', () => {
    const { service } = fixture()
    ;(service as unknown as { deps: { getReferences: () => ProjectReference[] } }).deps.getReferences =
      () => [{ ...reference, contextPolicy: 'off' }]
    expect(() => service.capture(payload)).toThrow(/is Off/)
  })

  it('does not snapshot catalogue-only paths or URLs', () => {
    const { service, events, snapshotOwnedMany } = fixture()
    const externalReference = { ...reference, locator: '/external/brief.txt' }
    ;(service as unknown as { deps: { getReferences: () => ProjectReference[] } }).deps.getReferences =
      () => [externalReference]
    service.capture({
      ...payload,
      projectReferenceContext: {
        ...payload.projectReferenceContext,
        references: [
          {
            ...payload.projectReferenceContext.references[0],
            locator: externalReference.locator,
            access: 'catalogue-only'
          }
        ]
      }
    })
    expect(snapshotOwnedMany).toHaveBeenCalledWith({
      appChatId: 'chat-a',
      runId: 'run-a',
      files: []
    })
    expect(events[0].artifacts).toEqual([])
  })

  it('rolls back the exact owned snapshot batch when event append fails', () => {
    const { service, appendRunEvent, rollbackOwnedBatch, commitOwnedBatch } = fixture()
    appendRunEvent.mockReturnValueOnce(null)

    expect(() => service.capture(payload)).toThrow(/Could not record Project reference context/)
    expect(rollbackOwnedBatch).toHaveBeenCalledWith({ id: 'receipt-a' })
    expect(commitOwnedBatch).not.toHaveBeenCalled()
  })

  it('surfaces the exact later reference when an atomic multi-file snapshot fails', () => {
    const { service, snapshotOwnedMany, appendRunEvent, rollbackOwnedBatch } = fixture()
    snapshotOwnedMany.mockReturnValueOnce({
      ok: false,
      reason: 'missing',
      failedAt: 1
    })
    const secondReference: ProjectReference = {
      ...reference,
      id: 'ref-b',
      locator: '/workspace/missing.txt',
      title: 'Missing'
    }
    ;(service as unknown as { deps: { getReferences: () => ProjectReference[] } }).deps.getReferences =
      () => [reference, secondReference]
    const twoReferencePayload: AgentRunPayload = {
      ...payload,
      projectReferenceContext: {
        ...payload.projectReferenceContext,
        references: [
          ...payload.projectReferenceContext.references,
          {
            id: secondReference.id,
            kind: 'file',
            title: secondReference.title,
            locator: secondReference.locator,
            access: 'workspace'
          }
        ]
      }
    }

    expect(() => service.capture(twoReferencePayload)).toThrow(/Missing.*missing/i)
    expect(appendRunEvent).not.toHaveBeenCalled()
    expect(rollbackOwnedBatch).not.toHaveBeenCalled()
  })
})
