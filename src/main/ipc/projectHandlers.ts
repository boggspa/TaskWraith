import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  parseProjectOp,
  parseProjectReferenceOp,
  type Project,
  type ProjectOp,
  type ProjectReference,
  type ProjectReferenceAvailability,
  type ProjectReferenceKind,
  type ProjectReferenceOp,
  type ProjectWorkProfile
} from '../../shared/projects'
import type {
  ReviewProjectReferenceProposalInput,
  ReviewProjectReferenceProposalResult,
  StoredProjectReferenceProposal
} from '../services/ProjectReferenceProposalService'
import type { ProviderId } from '../store/types'
import type {
  ProjectLegacyImportMarker,
  ProjectLegacyImportResult,
  ProjectRegistryMutationResult
} from '../store/ProjectRegistry'

/** Boot payload for the renderer facade: current authoritative records plus
 * the one-shot import marker (so the facade knows whether the localStorage
 * handshake is still owed). */
export interface ProjectsSnapshot {
  projects: Project[]
  workProfiles: ProjectWorkProfile[]
  references: ProjectReference[]
  legacyImportMarker: ProjectLegacyImportMarker | null
}

/**
 * The renderer gets a deliberately flat proposal view, never the mutable
 * run-event record used to establish its provenance. The locator remains
 * visible because this is a human review surface; it is still catalogue
 * metadata, not a grant to open, read, or fetch the target.
 */
export interface ProjectReferenceProposalView {
  proposalId: string
  projectId: string
  candidate: {
    kind: ProjectReferenceKind
    locator: string
    title: string
  }
  reason?: string
  proposedAt: number
  provider?: ProviderId
  runId: string
}

export interface ProjectReferenceProposalReviewView {
  created: boolean
  referenceId?: string
}

export interface ProjectReferenceProposalServiceFacade {
  listPending(projectId: string): readonly StoredProjectReferenceProposal[]
  review(input: ReviewProjectReferenceProposalInput): ReviewProjectReferenceProposalResult
}

export interface ProjectHandlerDeps {
  getProjects: () => Project[]
  getWorkProfiles: () => ProjectWorkProfile[]
  getReferences: () => ProjectReference[]
  getLegacyImportMarker: () => ProjectLegacyImportMarker | null
  applyProjectOp: (op: ProjectOp) => ProjectRegistryMutationResult
  applyReferenceOp: (op: ProjectReferenceOp) => ProjectRegistryMutationResult
  setProjectHomeChat: (projectId: string, chatId: string | null) => ProjectRegistryMutationResult
  setProjectWorkProfileFields: (
    projectId: string,
    patch: { brief?: string | null; preferredWorkspaceId?: string | null }
  ) => ProjectRegistryMutationResult
  /** Home claims must reference a chat main actually knows — the registry is
   * deliberately chat-blind, so existence is validated here at the boundary. */
  chatExists: (chatId: string) => boolean
  /** Preferred-workspace pointers must reference a registered workspace —
   * the registry is workspace-blind, so existence is validated here. */
  workspaceExists: (workspaceId: string) => boolean
  /** One existence stat for a local locator — NEVER content. URLs are not
   * probed in this phase (no network on behalf of the library). */
  probeReferenceLocator: (
    kind: Exclude<ProjectReferenceKind, 'url'>,
    locator: string
  ) => ProjectReferenceAvailability
  /** Plain OS picker for reference locators. Deliberately DISTINCT from the
   * external-path grant pickers: choosing a reference catalogues it and
   * grants NOTHING — reference ≠ access is the safety boundary. */
  pickReferencePath: (mode: 'file' | 'folder') => Promise<string | null>
  importLegacyProjects: (rawJson: string | null) => ProjectLegacyImportResult
  /** Append-only proposal evidence is resolved in main and is only surfaced
   * to the renderer through the narrow view above. */
  referenceProposalService: ProjectReferenceProposalServiceFacade
  /** Broadcast a dedicated invalidation after an IPC-originated review. MCP
   * proposal creation uses the same callback at its own main-only boundary. */
  notifyReferenceProposalsChanged: (projectId: string) => void
  /**
   * Projects are app-level organisational state managed from the main window.
   * Every channel — reads included — is main-renderer-only until a secondary
   * surface (popout, bridge webview) actually needs them; loosening later is
   * a one-line change here, tightening later is an incident.
   */
  assertSenderCanManageProjects: (event: IpcMainInvokeEvent) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireProjectReferenceProposalId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  return value.trim()
}

function parseProjectReferenceProposalReview(
  value: unknown
): ReviewProjectReferenceProposalInput {
  if (!isRecord(value)) throw new Error('Malformed Project reference proposal review.')
  const allowed = new Set(['projectId', 'proposalId', 'decision'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Malformed Project reference proposal review.')
  }
  const projectId = requireProjectReferenceProposalId(value.projectId, 'Project id')
  const proposalId = requireProjectReferenceProposalId(value.proposalId, 'Proposal id')
  if (value.decision !== 'approve' && value.decision !== 'reject') {
    throw new Error('Project reference proposal decision is invalid.')
  }
  return { projectId, proposalId, decision: value.decision }
}

function toProjectReferenceProposalView(
  proposal: StoredProjectReferenceProposal
): ProjectReferenceProposalView {
  const { payload, event } = proposal
  return {
    proposalId: payload.proposalId,
    projectId: payload.projectId,
    candidate: {
      kind: payload.candidate.kind,
      locator: payload.candidate.locator,
      title: payload.candidate.title
    },
    ...(payload.reason ? { reason: payload.reason } : {}),
    proposedAt: payload.proposedAt,
    ...(event.provider ? { provider: event.provider } : {}),
    runId: event.runId
  }
}

export function registerProjectHandlers(deps: ProjectHandlerDeps): void {
  ipcMain.handle('projects:snapshot', (event): ProjectsSnapshot => {
    deps.assertSenderCanManageProjects(event)
    return {
      projects: deps.getProjects(),
      workProfiles: deps.getWorkProfiles(),
      references: deps.getReferences(),
      legacyImportMarker: deps.getLegacyImportMarker()
    }
  })

  ipcMain.handle('projects:update-work-profile', (event, projectId: unknown, patch: unknown) => {
    deps.assertSenderCanManageProjects(event)
    if (typeof projectId !== 'string' || !projectId.trim()) {
      throw new Error('Project id is required.')
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('Malformed profile patch.')
    }
    const candidate = patch as { brief?: unknown; preferredWorkspaceId?: unknown }
    const normalized: { brief?: string | null; preferredWorkspaceId?: string | null } = {}
    if ('brief' in candidate) {
      if (candidate.brief !== null && typeof candidate.brief !== 'string') {
        throw new Error('Malformed brief.')
      }
      normalized.brief = candidate.brief
    }
    if ('preferredWorkspaceId' in candidate) {
      if (
        candidate.preferredWorkspaceId !== null &&
        typeof candidate.preferredWorkspaceId !== 'string'
      ) {
        throw new Error('Malformed preferred workspace.')
      }
      const preferred =
        typeof candidate.preferredWorkspaceId === 'string'
          ? candidate.preferredWorkspaceId.trim()
          : null
      if (preferred && !deps.workspaceExists(preferred)) {
        throw new Error('Preferred workspace is not registered.')
      }
      normalized.preferredWorkspaceId = preferred
    }
    return deps.setProjectWorkProfileFields(projectId, normalized)
  })

  ipcMain.handle('projects:reference-op', (event, op: unknown) => {
    deps.assertSenderCanManageProjects(event)
    const parsed = parseProjectReferenceOp(op)
    if (!parsed) throw new Error('Malformed project reference operation.')
    // Verification records are MAIN-initiated only (projects:verify-reference
    // runs the probe); a renderer-supplied status would let a buggy or
    // compromised renderer assert availability it never checked.
    if (parsed.kind === 'record-reference-verification') {
      throw new Error('Reference verification is main-initiated.')
    }
    return deps.applyReferenceOp(parsed)
  })

  ipcMain.handle('projects:verify-reference', (event, id: unknown) => {
    deps.assertSenderCanManageProjects(event)
    if (typeof id !== 'string' || !id.trim()) throw new Error('Reference id is required.')
    const reference = deps.getReferences().find((entry) => entry.id === id.trim())
    if (!reference) throw new Error('Reference not found.')
    if (reference.kind === 'url') {
      throw new Error('URL references cannot be verified automatically.')
    }
    const status = deps.probeReferenceLocator(reference.kind, reference.locator)
    return deps.applyReferenceOp({
      kind: 'record-reference-verification',
      id: reference.id,
      status,
      now: Date.now()
    })
  })

  ipcMain.handle('projects:pick-reference-path', async (event, mode: unknown) => {
    deps.assertSenderCanManageProjects(event)
    if (mode !== 'file' && mode !== 'folder') throw new Error('Malformed picker mode.')
    return deps.pickReferencePath(mode)
  })

  ipcMain.handle('projects:list-reference-proposals', (event, projectId: unknown) => {
    deps.assertSenderCanManageProjects(event)
    const normalizedProjectId = requireProjectReferenceProposalId(projectId, 'Project id')
    return deps.referenceProposalService
      .listPending(normalizedProjectId)
      .map(toProjectReferenceProposalView)
  })

  ipcMain.handle('projects:review-reference-proposal', (event, input: unknown) => {
    deps.assertSenderCanManageProjects(event)
    const review = parseProjectReferenceProposalReview(input)
    const result = deps.referenceProposalService.review(review)
    if (result.created) deps.notifyReferenceProposalsChanged(review.projectId)
    return {
      created: result.created,
      ...(result.reference ? { referenceId: result.reference.id } : {})
    } satisfies ProjectReferenceProposalReviewView
  })

  ipcMain.handle('projects:apply-op', (event, op: unknown) => {
    deps.assertSenderCanManageProjects(event)
    // Field-type validation (parseProjectOp) precedes semantic validation
    // inside the apply functions; both reject by throwing so the renderer
    // facade sees a rejected invoke and reconciles from the next snapshot.
    const parsed = parseProjectOp(op)
    if (!parsed) throw new Error('Malformed project operation.')
    return deps.applyProjectOp(parsed)
  })

  ipcMain.handle('projects:set-home-chat', (event, projectId: unknown, chatId: unknown) => {
    deps.assertSenderCanManageProjects(event)
    if (typeof projectId !== 'string' || !projectId.trim()) {
      throw new Error('Project id is required.')
    }
    if (chatId !== undefined && chatId !== null && typeof chatId !== 'string') {
      throw new Error('Malformed chat id.')
    }
    const normalized = typeof chatId === 'string' ? chatId.trim() : null
    if (normalized !== null) {
      if (!normalized) throw new Error('Chat id is required.')
      if (!deps.chatExists(normalized)) throw new Error('Chat not found.')
    }
    return deps.setProjectHomeChat(projectId, normalized)
  })

  ipcMain.handle('projects:import-legacy', (event, rawJson: unknown) => {
    deps.assertSenderCanManageProjects(event)
    return deps.importLegacyProjects(typeof rawJson === 'string' ? rawJson : null)
  })
}
