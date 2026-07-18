import { describe, expect, it, vi } from 'vitest'

import type { Project, ProjectReference } from '../../shared/projects'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { ChatRecord, RunEventInput, RunEventRecord } from '../store/types'
import { ProjectReferenceContextAuditService } from './ProjectReferenceContextAuditService'

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
  const appendRunEvent = vi.fn((input: RunEventInput) => {
    events.push(input)
    return { ...input, schemaVersion: 1, id: `event-${events.length}`, sequence: events.length,
      timestamp: new Date().toISOString() } as RunEventRecord
  })
  const snapshot = vi.fn(() => ({
    ok: true as const,
    artifact: {
      id: 'project-reference:abc',
      kind: 'snapshot' as const,
      path: '/private/context/abc.snapshot',
      sha256: 'abc',
      sizeBytes: 7
    }
  }))
  const service = new ProjectReferenceContextAuditService({
    getChat: () => ({ appChatId: 'chat-a', workspaceId: 'workspace-a' }) as ChatRecord,
    getProjects: () => [project],
    getReferences: () => [reference],
    appendRunEvent,
    artifactStore: { snapshot } as never
  })
  return { service, events, appendRunEvent, snapshot }
}

describe('ProjectReferenceContextAuditService', () => {
  it('materializes authorized files without putting their locator in event payloads', () => {
    const { service, events, snapshot } = fixture()
    service.capture(payload)

    expect(snapshot).toHaveBeenCalledWith({
      candidatePath: '/workspace/brief.txt',
      workspacePath: '/workspace',
      externalPathGrants: undefined
    })
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
    const { service, events, snapshot } = fixture()
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
    expect(snapshot).not.toHaveBeenCalled()
    expect(events[0].artifacts).toEqual([])
  })
})
