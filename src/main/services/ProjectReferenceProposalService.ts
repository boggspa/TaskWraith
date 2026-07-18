import {
  MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH,
  MAX_PROJECT_REFERENCE_PROPOSAL_LOCATOR_LENGTH,
  MAX_PROJECT_REFERENCE_PROPOSAL_REASON_LENGTH,
  MAX_PROJECT_REFERENCE_PROPOSAL_TITLE_LENGTH,
  PROJECT_REFERENCE_PROPOSAL_PURPOSE,
  isProjectReferenceProposalPayload,
  parseProjectReferenceProposalCandidate,
  parseProjectReferenceProposalEventPayload,
  parseProjectReferenceProposedPayload,
  parseProjectReferenceReviewedPayload,
  type ProjectReferenceProposalCandidate,
  type ProjectReferenceProposalDecision,
  type ProjectReferenceProposedPayload,
  type ProjectReferenceReviewedPayload
} from '../../shared/projectReferenceProposal'
import {
  defaultProjectReferenceTitle,
  type Project,
  type ProjectReference,
  type ProjectReferenceKind,
  type ProjectReferenceOp
} from '../../shared/projects'
import { verifyRunEventHashChain } from '../RunEventStore'
import type { ProviderId, RunEventInput, RunEventRecord } from '../store/types'

export const DEFAULT_MAX_PROJECT_REFERENCE_PROPOSALS_PER_RUN = 8
export const DEFAULT_MAX_PROJECT_REFERENCE_PROPOSAL_RUNS_PER_PROJECT = 4096
export const DEFAULT_MAX_PROJECT_REFERENCE_PROPOSALS_PER_PROJECT = 1000

export interface ProjectReferenceProposalServiceDeps {
  getProjects: () => readonly Project[]
  getReferences: () => readonly ProjectReference[]
  /** Must return only run ids whose authoritative owner is this exact chat. */
  getRunIdsForChat: (chatId: string) => readonly string[]
  /** Must return the full ledger for one exact run, not a filtered suffix. */
  getRunEvents: (runId: string) => readonly RunEventRecord[]
  appendRunEvent: (input: RunEventInput) => RunEventRecord | null
  applyReferenceOp: (op: ProjectReferenceOp) => { references: readonly ProjectReference[] }
  /** Must return a collision-resistant id in the corresponding global namespace. */
  createId: (kind: 'proposal' | 'reference') => string
  now: () => number
  maxProposalsPerRun?: number
  maxRunsPerProject?: number
  maxProposalsPerProject?: number
}

export interface ProposeProjectReferenceInput {
  /** Main-authoritative invocation route; never expose these fields as agent arguments. */
  runId: string
  chatId: string
  projectId?: string
  kind: ProjectReferenceKind
  locator: string
  title?: string
  reason?: string
  provider?: ProviderId
  toolCallId?: string
}

export interface StoredProjectReferenceProposal {
  payload: ProjectReferenceProposedPayload
  event: RunEventRecord
  review?: {
    payload: ProjectReferenceReviewedPayload
    event: RunEventRecord
  }
}

export interface ProjectReferenceProposalAppendResult {
  created: boolean
  proposal: StoredProjectReferenceProposal
}

export interface ReviewProjectReferenceProposalInput {
  projectId: string
  proposalId: string
  decision: ProjectReferenceProposalDecision
}

export interface ReviewProjectReferenceProposalResult {
  created: boolean
  proposal: StoredProjectReferenceProposal
  reference?: ProjectReference
}

interface ProjectProposalScan {
  project: Project
  proposals: StoredProjectReferenceProposal[]
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} is required.`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) throw new Error(`${label} is invalid.`)
  return trimmed
}

function boundedOptionalString(
  value: unknown,
  label: string,
  maxLength: number
): string | undefined {
  if (value === undefined) return undefined
  return boundedString(value, label, maxLength)
}

function exactPositiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function candidateKey(projectId: string, candidate: ProjectReferenceProposalCandidate): string {
  return JSON.stringify([projectId, candidate.kind, candidate.locator])
}

function canonicalCandidate(
  input: ProposeProjectReferenceInput
): ProjectReferenceProposalCandidate {
  const locator = boundedString(
    input.locator,
    'Reference locator',
    MAX_PROJECT_REFERENCE_PROPOSAL_LOCATOR_LENGTH
  )
  const requestedTitle = boundedOptionalString(
    input.title,
    'Reference title',
    MAX_PROJECT_REFERENCE_PROPOSAL_TITLE_LENGTH
  )
  const defaultTitle = defaultProjectReferenceTitle(input.kind, locator)
  const title = (requestedTitle ?? defaultTitle).slice(
    0,
    MAX_PROJECT_REFERENCE_PROPOSAL_TITLE_LENGTH
  )
  const parsed = parseProjectReferenceProposalCandidate({ kind: input.kind, locator, title })
  if (!parsed) throw new Error('Proposed Project reference is invalid.')
  return parsed
}

function cloneProjectReference(reference: ProjectReference): ProjectReference {
  return {
    ...reference,
    provenance: { ...reference.provenance },
    ...(reference.lastVerified ? { lastVerified: { ...reference.lastVerified } } : {})
  }
}

/**
 * Append-only agent proposal workflow. This service deliberately has no file,
 * URL, grant, or probe dependency: proposing records catalogue metadata and
 * nothing else. Only a human approval invokes the ordinary Project reference
 * mutation supplied by main.
 */
export class ProjectReferenceProposalService {
  constructor(private readonly deps: ProjectReferenceProposalServiceDeps) {}

  propose(input: ProposeProjectReferenceInput): ProjectReferenceProposalAppendResult {
    const runId = boundedString(input.runId, 'Run id', MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH)
    const chatId = boundedString(input.chatId, 'Chat id', MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH)
    const toolCallId = boundedOptionalString(
      input.toolCallId,
      'Tool call id',
      MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH
    )
    const reason = boundedOptionalString(
      input.reason,
      'Proposal reason',
      MAX_PROJECT_REFERENCE_PROPOSAL_REASON_LENGTH
    )
    const project = this.resolveProjectForChat(chatId, input.projectId)
    const runIds = this.exactRunIdsForChat(chatId)
    if (!runIds.includes(runId)) {
      throw new Error('Current run does not belong to the current Project chat.')
    }

    const events = this.readVerifiedRun(runId, chatId)
    const existing = this.proposalsFromRun(events)
    const candidate = canonicalCandidate(input)
    const duplicate = existing.find(
      (proposal) =>
        candidateKey(proposal.payload.projectId, proposal.payload.candidate) ===
        candidateKey(project.id, candidate)
    )
    if (duplicate) return { created: false, proposal: duplicate }

    const maxPerRun = exactPositiveLimit(
      this.deps.maxProposalsPerRun,
      DEFAULT_MAX_PROJECT_REFERENCE_PROPOSALS_PER_RUN
    )
    if (existing.length >= maxPerRun) {
      throw new Error(`A run may propose at most ${maxPerRun} Project references.`)
    }

    const proposalId = this.newId('proposal')
    if (existing.some((proposal) => proposal.payload.proposalId === proposalId)) {
      throw new Error('Generated Project reference proposal id is already in use.')
    }
    const materializationReferenceId = this.newId('reference')
    if (
      this.deps.getReferences().some((reference) => reference.id === materializationReferenceId)
    ) {
      throw new Error('Generated Project reference id is already in use.')
    }
    const proposedAt = this.now()
    const proposedPayload: ProjectReferenceProposedPayload = {
      schemaVersion: 1,
      purpose: PROJECT_REFERENCE_PROPOSAL_PURPOSE,
      action: 'proposed',
      proposalId,
      projectId: project.id,
      materializationReferenceId,
      candidate,
      ...(reason ? { reason } : {}),
      proposedAt
    }
    const payload = parseProjectReferenceProposedPayload(proposedPayload)
    if (!payload) throw new Error('Project reference proposal payload is invalid.')

    const projectScan = this.scanProject(project.id)
    const maxPerProject = exactPositiveLimit(
      this.deps.maxProposalsPerProject,
      DEFAULT_MAX_PROJECT_REFERENCE_PROPOSALS_PER_PROJECT
    )
    if (projectScan.proposals.length >= maxPerProject) {
      throw new Error(`Project proposal review is limited to ${maxPerProject} proposals at a time.`)
    }
    if (
      projectScan.proposals.some(
        (proposal) =>
          proposal.payload.proposalId === payload.proposalId ||
          proposal.payload.materializationReferenceId === payload.materializationReferenceId
      )
    ) {
      throw new Error('Generated Project reference proposal identity is already in use.')
    }

    const event = this.append({
      runId,
      chatId,
      provider: input.provider,
      toolCallId,
      kind: 'reference_context',
      phase: 'control',
      source: 'main',
      summary: `Proposed adding “${candidate.title}” to Project references`,
      payload
    })
    return { created: true, proposal: { payload, event } }
  }

  listPending(projectId: string): StoredProjectReferenceProposal[] {
    return this.scanProject(projectId).proposals.filter((proposal) => !proposal.review)
  }

  review(input: ReviewProjectReferenceProposalInput): ReviewProjectReferenceProposalResult {
    const projectId = boundedString(
      input.projectId,
      'Project id',
      MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH
    )
    const proposalId = boundedString(
      input.proposalId,
      'Proposal id',
      MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH
    )
    if (input.decision !== 'approve' && input.decision !== 'reject') {
      throw new Error('Project reference proposal decision is invalid.')
    }

    const scan = this.scanProject(projectId)
    const proposal = scan.proposals.find((candidate) => candidate.payload.proposalId === proposalId)
    if (!proposal) throw new Error('Project reference proposal was not found in this Project.')
    if (proposal.review) {
      if (proposal.review.payload.decision !== input.decision) {
        throw new Error(
          'Project reference proposal has already been reviewed with another decision.'
        )
      }
      const reference = proposal.review.payload.referenceId
        ? this.deps
            .getReferences()
            .find((candidate) => candidate.id === proposal.review?.payload.referenceId)
        : undefined
      return {
        created: false,
        proposal,
        ...(reference ? { reference: cloneProjectReference(reference) } : {})
      }
    }

    // Review is intentionally a fresh read, not an action on a stale list row.
    // This re-verifies the source hash chain immediately before mutation.
    const sourceEvents = this.readVerifiedRun(proposal.event.runId, proposal.event.chatId || '')
    const source = sourceEvents.find(
      (event) =>
        event.id === proposal.event.id &&
        event.hash === proposal.event.hash &&
        event.kind === 'reference_context'
    )
    if (!source || !source.hash) {
      throw new Error('Project reference proposal source changed before review.')
    }
    const sourcePayload = parseProjectReferenceProposalEventPayload(source.payload)
    if (
      sourcePayload?.action !== 'proposed' ||
      sourcePayload.projectId !== projectId ||
      sourcePayload.proposalId !== proposalId
    ) {
      throw new Error('Project reference proposal source is invalid.')
    }

    const reviewedAt = this.now()
    let reference: ProjectReference | undefined
    const reservedIdOwner = this.deps
      .getReferences()
      .find((candidate) => candidate.id === sourcePayload.materializationReferenceId)
    const reservedIdMatchesProposal = Boolean(
      reservedIdOwner &&
      reservedIdOwner.projectId === projectId &&
      reservedIdOwner.kind === sourcePayload.candidate.kind &&
      reservedIdOwner.locator === sourcePayload.candidate.locator
    )
    if (reservedIdMatchesProposal && input.decision === 'reject') {
      throw new Error(
        'Approval materialization already started for this proposal; retry Approve to finish its audit event.'
      )
    }
    if (input.decision === 'approve') {
      if (
        reservedIdOwner &&
        (reservedIdOwner.projectId !== projectId ||
          reservedIdOwner.kind !== sourcePayload.candidate.kind ||
          reservedIdOwner.locator !== sourcePayload.candidate.locator)
      ) {
        throw new Error('Reserved Project reference id is already used by another source.')
      }
      const result = this.deps.applyReferenceOp({
        kind: 'add-reference',
        id: sourcePayload.materializationReferenceId,
        projectId,
        referenceKind: sourcePayload.candidate.kind,
        locator: sourcePayload.candidate.locator,
        title: sourcePayload.candidate.title,
        now: reviewedAt
      })
      reference = result.references.find(
        (candidate) =>
          candidate.projectId === projectId &&
          candidate.kind === sourcePayload.candidate.kind &&
          candidate.locator === sourcePayload.candidate.locator
      )
      if (!reference) {
        throw new Error('Approved Project reference was not materialized by the registry.')
      }
      reference = cloneProjectReference(reference)
    }

    const reviewedPayload: ProjectReferenceReviewedPayload = {
      schemaVersion: 1,
      purpose: PROJECT_REFERENCE_PROPOSAL_PURPOSE,
      action: 'reviewed',
      proposalId,
      projectId,
      decision: input.decision,
      reviewedBy: 'user',
      source: {
        runId: source.runId,
        eventId: source.id,
        eventHash: source.hash
      },
      reviewedAt,
      ...(reference ? { referenceId: reference.id } : {})
    }
    const reviewed = parseProjectReferenceReviewedPayload(reviewedPayload)
    if (!reviewed) throw new Error('Project reference review payload is invalid.')
    const reviewEvent = this.append({
      runId: source.runId,
      chatId: source.chatId,
      workspaceId: source.workspaceId,
      workspacePath: source.workspacePath,
      provider: source.provider,
      providerSessionId: source.providerSessionId,
      parentSpanId: source.spanId,
      toolCallId: source.toolCallId,
      kind: 'reference_context',
      phase: 'control',
      source: 'main',
      summary:
        input.decision === 'approve'
          ? `Approved adding “${sourcePayload.candidate.title}” to Project references`
          : `Rejected adding “${sourcePayload.candidate.title}” to Project references`,
      payload: reviewed
    })
    const stored: StoredProjectReferenceProposal = {
      payload: sourcePayload,
      event: source,
      review: { payload: reviewed, event: reviewEvent }
    }
    return { created: true, proposal: stored, ...(reference ? { reference } : {}) }
  }

  private resolveProjectForChat(chatId: string, requestedProjectId?: string): Project {
    const projects = this.deps
      .getProjects()
      .filter((project) => project.memberChatIds.includes(chatId))
    const requested = requestedProjectId?.trim()
    if (requested) {
      const project = projects.find((candidate) => candidate.id === requested)
      if (!project) throw new Error('Current chat is not a member of the requested Project.')
      return project
    }
    if (projects.length === 0) throw new Error('Current chat is not a member of a Project.')
    if (projects.length > 1) {
      throw new Error(
        'Current chat belongs to multiple Projects; an explicit Project id is required.'
      )
    }
    return projects[0]
  }

  private exactRunIdsForChat(chatId: string): string[] {
    const ids: string[] = []
    const seen = new Set<string>()
    for (const value of this.deps.getRunIdsForChat(chatId)) {
      const id = boundedString(value, 'Run id', MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH)
      if (!seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
    return ids
  }

  private scanProject(projectIdValue: string): ProjectProposalScan {
    const projectId = boundedString(
      projectIdValue,
      'Project id',
      MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH
    )
    const project = this.deps.getProjects().find((candidate) => candidate.id === projectId)
    if (!project) throw new Error('Project was not found.')

    const runOwners = new Map<string, string>()
    for (const chatId of new Set(project.memberChatIds)) {
      for (const runId of this.exactRunIdsForChat(chatId)) {
        const owner = runOwners.get(runId)
        if (owner && owner !== chatId) {
          throw new Error('A Project proposal run is ambiguously owned by multiple chats.')
        }
        runOwners.set(runId, chatId)
      }
    }
    const maxRuns = exactPositiveLimit(
      this.deps.maxRunsPerProject,
      DEFAULT_MAX_PROJECT_REFERENCE_PROPOSAL_RUNS_PER_PROJECT
    )
    if (runOwners.size > maxRuns) {
      throw new Error(`Project proposal review is limited to ${maxRuns} runs at a time.`)
    }

    const proposals = new Map<string, StoredProjectReferenceProposal>()
    const reviews: Array<{ payload: ProjectReferenceReviewedPayload; event: RunEventRecord }> = []
    for (const [runId, chatId] of runOwners) {
      const events = this.readVerifiedRun(runId, chatId)
      for (const event of events) {
        if (event.kind !== 'reference_context') continue
        if (!isProjectReferenceProposalPayload(event.payload)) continue
        const payload = parseProjectReferenceProposalEventPayload(event.payload)
        if (!payload) throw new Error('Project reference proposal event payload is malformed.')
        if (payload.projectId !== projectId) continue
        if (!event.hash) throw new Error('Project reference proposal event is not hash chained.')
        if (event.source !== 'main' || event.phase !== 'control') {
          throw new Error('Project reference proposal event lacks canonical main authority.')
        }
        if (event.chatId !== chatId) {
          throw new Error(
            'Project reference proposal event is missing its exact Project chat route.'
          )
        }
        if (payload.action === 'proposed') {
          if (proposals.has(payload.proposalId)) {
            throw new Error('Project reference proposal id is duplicated in this Project.')
          }
          proposals.set(payload.proposalId, { payload, event })
        } else {
          reviews.push({ payload, event })
        }
      }
    }

    const maxProposals = exactPositiveLimit(
      this.deps.maxProposalsPerProject,
      DEFAULT_MAX_PROJECT_REFERENCE_PROPOSALS_PER_PROJECT
    )
    if (proposals.size > maxProposals) {
      throw new Error(`Project proposal review is limited to ${maxProposals} proposals at a time.`)
    }
    for (const review of reviews) {
      const proposal = proposals.get(review.payload.proposalId)
      if (!proposal) throw new Error('Project reference review has no proposal in this Project.')
      if (
        review.event.runId !== proposal.event.runId ||
        review.payload.source.runId !== proposal.event.runId ||
        review.payload.source.eventId !== proposal.event.id ||
        review.payload.source.eventHash !== proposal.event.hash ||
        review.event.sequence <= proposal.event.sequence
      ) {
        throw new Error('Project reference review does not match its immutable proposal source.')
      }
      if (proposal.review) {
        throw new Error('Project reference proposal has multiple review events.')
      }
      proposal.review = review
    }

    return {
      project,
      proposals: [...proposals.values()].sort(
        (left, right) =>
          right.payload.proposedAt - left.payload.proposedAt ||
          right.event.sequence - left.event.sequence
      )
    }
  }

  private proposalsFromRun(events: readonly RunEventRecord[]): StoredProjectReferenceProposal[] {
    const proposals: StoredProjectReferenceProposal[] = []
    for (const event of events) {
      if (event.kind !== 'reference_context') continue
      if (!isProjectReferenceProposalPayload(event.payload)) continue
      const payload = parseProjectReferenceProposalEventPayload(event.payload)
      if (!payload) throw new Error('Project reference proposal event payload is malformed.')
      if (payload.action === 'proposed') {
        if (!event.hash) throw new Error('Project reference proposal event is not hash chained.')
        if (event.source !== 'main' || event.phase !== 'control') {
          throw new Error('Project reference proposal event lacks canonical main authority.')
        }
        proposals.push({ payload, event })
      }
    }
    return proposals
  }

  private readVerifiedRun(runId: string, chatId: string): RunEventRecord[] {
    const events = [...this.deps.getRunEvents(runId)].sort((a, b) => a.sequence - b.sequence)
    if (
      events.some(
        (event) => event.runId !== runId || (event.chatId !== undefined && event.chatId !== chatId)
      )
    ) {
      throw new Error('Project proposal run events do not match their exact chat route.')
    }
    if (!verifyRunEventHashChain(events)) {
      throw new Error('Project proposal run-event hash chain is invalid.')
    }
    return events
  }

  private append(input: RunEventInput): RunEventRecord {
    const event = this.deps.appendRunEvent(input)
    if (!event?.id || !event.hash)
      throw new Error('Could not append Project reference proposal event.')
    return event
  }

  private newId(kind: 'proposal' | 'reference'): string {
    return boundedString(
      this.deps.createId(kind),
      `${kind === 'proposal' ? 'Proposal' : 'Reference'} id`,
      MAX_PROJECT_REFERENCE_PROPOSAL_ID_LENGTH
    )
  }

  private now(): number {
    const value = this.deps.now()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Proposal timestamp is invalid.')
    return value
  }
}

// Keep the discriminant reachable to callers building safe event queries.
export const PROJECT_REFERENCE_PROPOSAL_EVENT_PURPOSE = PROJECT_REFERENCE_PROPOSAL_PURPOSE
