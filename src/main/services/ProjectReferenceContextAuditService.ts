import { randomUUID } from 'node:crypto'

import {
  projectReferenceContextDisclosure,
  serializeResolvedProjectReferenceContext,
  type ResolvedProjectReferenceContext
} from '../../shared/projectReferenceContext'
import type { Project, ProjectReference } from '../../shared/projects'
import type { AgentRunPayload } from '../run/AgentRunTypes'
import type {
  ChatRecord,
  RunEventArtifactRef,
  RunEventInput,
  RunEventRecord
} from '../store/types'
import { ProjectReferenceArtifactStore } from './ProjectReferenceArtifactStore'
import { resolveProjectReferenceContext } from './ProjectReferenceContextService'

interface CapturedReferenceContext {
  runId: string
  chatId: string
  provider: AgentRunPayload['provider']
  workspaceId?: string
  workspacePath?: string
  spanId: string
  context: ResolvedProjectReferenceContext
  artifacts: RunEventArtifactRef[]
  linkedApprovalIds: Set<string>
}

export interface ProjectReferenceContextAuditServiceDeps {
  getChat: (chatId: string) => ChatRecord | null
  getProjects: () => Project[]
  getReferences: () => ProjectReference[]
  appendRunEvent: (input: RunEventInput) => RunEventRecord | null
  artifactStore: ProjectReferenceArtifactStore
  maxActiveContexts?: number
}

function cloneArtifact(artifact: RunEventArtifactRef): RunEventArtifactRef {
  return {
    ...artifact,
    ...(artifact.metadata ? { metadata: { ...artifact.metadata } } : {})
  }
}

/**
 * Materializes the exact, signed reference context immediately before provider
 * dispatch and keeps a bounded in-memory receipt so every later approval can
 * point back to the same immutable artifacts.
 */
export class ProjectReferenceContextAuditService {
  private readonly active = new Map<string, CapturedReferenceContext>()
  private readonly expectedRuns = new Set<string>()
  private readonly pendingApprovalLinks = new Map<
    string,
    Map<string, AgentRunPayload['provider'] | undefined>
  >()

  constructor(private readonly deps: ProjectReferenceContextAuditServiceDeps) {}

  /** No I/O: marks a signed context run so preflight approval IDs can be
   * backfilled after its immutable artifacts are materialized. */
  prepare(payload: AgentRunPayload): void {
    if (!payload.projectReferenceContext) return
    const runId = payload.appRunId?.trim()
    if (!runId) throw new Error('Project reference context requires a routed run.')
    this.evictIfNeeded()
    this.expectedRuns.add(runId)
  }

  capture(payload: AgentRunPayload): void {
    const context = payload.projectReferenceContext
    if (!context) return
    const runId = payload.appRunId?.trim()
    const chatId = payload.appChatId?.trim()
    if (!runId || !chatId) {
      throw new Error('Project reference context requires a routed run and chat.')
    }
    if (this.active.has(runId)) return

    const chat = this.deps.getChat(chatId)
    if (!chat) throw new Error('Project reference context chat no longer exists.')
    const reResolved = resolveProjectReferenceContext({
      selection: {
        schemaVersion: 1,
        projectId: context.projectId,
        referenceIds: context.references.map((reference) => reference.id)
      },
      chatId,
      provider: payload.provider,
      workspacePath: payload.scope === 'workspace' ? payload.workspace : undefined,
      projects: this.deps.getProjects(),
      references: this.deps.getReferences(),
      externalPathGrants: payload.externalPathGrants
    })
    if (
      serializeResolvedProjectReferenceContext(reResolved) !==
      serializeResolvedProjectReferenceContext(context)
    ) {
      throw new Error('Project reference context changed before dispatch; select it again.')
    }

    const artifacts: RunEventArtifactRef[] = []
    for (const reference of context.references) {
      if (reference.kind !== 'file' || reference.access === 'catalogue-only') continue
      const snapshot = this.deps.artifactStore.snapshot({
        candidatePath: reference.locator,
        workspacePath: payload.scope === 'workspace' ? payload.workspace : undefined,
        externalPathGrants: payload.externalPathGrants
      })
      if (!snapshot.ok) {
        throw new Error(
          `Could not materialize Project reference “${reference.title}” (${snapshot.reason}).`
        )
      }
      artifacts.push({
        ...snapshot.artifact,
        metadata: {
          ...snapshot.artifact.metadata,
          referenceId: reference.id,
          referenceKind: reference.kind,
          referenceTitle: reference.title
        }
      })
    }

    const spanId = `reference-context:${randomUUID()}`
    const event = this.deps.appendRunEvent({
      runId,
      chatId,
      workspaceId: chat.workspaceId,
      workspacePath: payload.scope === 'workspace' ? payload.workspace : undefined,
      provider: payload.provider,
      providerSessionId: payload.providerSessionId || undefined,
      spanId,
      kind: 'reference_context',
      phase: 'artifact',
      source: 'main',
      summary: `Materialized ${context.references.length} Project reference${context.references.length === 1 ? '' : 's'}`,
      payload: {
        schemaVersion: 1,
        purpose: 'run-context',
        action: 'materialized',
        context: projectReferenceContextDisclosure(context)
      },
      artifacts: artifacts.map(cloneArtifact)
    })
    if (!event) throw new Error('Could not record Project reference context.')

    this.active.set(runId, {
      runId,
      chatId,
      provider: payload.provider,
      workspaceId: chat.workspaceId,
      workspacePath: payload.scope === 'workspace' ? payload.workspace : undefined,
      spanId,
      context,
      artifacts,
      linkedApprovalIds: new Set()
    })
    const pending = this.pendingApprovalLinks.get(runId)
    this.pendingApprovalLinks.delete(runId)
    if (pending) {
      for (const [approvalId, provider] of pending) {
        this.linkApproval(runId, approvalId, provider)
      }
    }
  }

  linkApproval(
    runId: string | null | undefined,
    approvalId: string | null | undefined,
    provider?: AgentRunPayload['provider']
  ): boolean {
    const normalizedRunId = runId?.trim()
    const normalizedApprovalId = approvalId?.trim()
    if (!normalizedRunId || !normalizedApprovalId) return false
    const captured = this.active.get(normalizedRunId)
    if (!captured) {
      if (this.expectedRuns.has(normalizedRunId)) {
        const pending = this.pendingApprovalLinks.get(normalizedRunId) ?? new Map()
        pending.set(normalizedApprovalId, provider)
        this.pendingApprovalLinks.set(normalizedRunId, pending)
      }
      return false
    }
    if (captured.linkedApprovalIds.has(normalizedApprovalId)) return false
    const event = this.deps.appendRunEvent({
      runId: captured.runId,
      chatId: captured.chatId,
      workspaceId: captured.workspaceId,
      workspacePath: captured.workspacePath,
      provider: provider ?? captured.provider,
      approvalId: normalizedApprovalId,
      parentSpanId: captured.spanId,
      kind: 'reference_context',
      phase: 'artifact',
      source: 'main',
      summary: 'Linked approval to explicit Project reference context',
      payload: {
        schemaVersion: 1,
        purpose: 'approval-context',
        action: 'linked',
        context: projectReferenceContextDisclosure(captured.context)
      },
      artifacts: captured.artifacts.map(cloneArtifact)
    })
    if (!event) return false
    captured.linkedApprovalIds.add(normalizedApprovalId)
    return true
  }

  release(runId: string | null | undefined): void {
    const normalized = runId?.trim()
    if (normalized) {
      this.active.delete(normalized)
      this.expectedRuns.delete(normalized)
      this.pendingApprovalLinks.delete(normalized)
    }
  }

  private evictIfNeeded(): void {
    const max = Math.max(1, this.deps.maxActiveContexts ?? 256)
    while (this.expectedRuns.size >= max) {
      const oldest = this.expectedRuns.values().next().value as string | undefined
      if (!oldest) return
      this.expectedRuns.delete(oldest)
      this.active.delete(oldest)
      this.pendingApprovalLinks.delete(oldest)
    }
  }
}
