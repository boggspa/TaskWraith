import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type JSX,
  type ClipboardEvent
} from 'react'

import {
  parseProjectReferenceExtract,
  type ProjectReferenceExtract,
  type ProjectReferenceExtractPageSpan
} from '../../../shared/projectReferenceExtract'
import {
  parseProjectStudioKind,
  parseProjectStudioStatus,
  type ProjectStudioKind,
  type ProjectStudioStatus
} from '../../../shared/projectStudio'
import { normalizeGitHubReferenceInput, type ProjectReference } from '../../../shared/projects'
import {
  addProjectReference,
  listProjectReferences,
  listProjects,
  removeProjectReference,
  subscribeProjects,
  updateProjectReference,
  verifyProjectReference
} from '../lib/projectsStore'
import {
  projectReferencePresentation,
  summarizeReferenceAttention
} from '../lib/projectReferencePresentation'
import {
  clearProjectReferenceContextSelection,
  getProjectReferenceContextSelection,
  setProjectReferenceContextSelection,
  subscribeProjectReferenceContextSelection,
  toggleProjectReferenceContextSelection
} from '../lib/projectReferenceContextSelection'
import {
  applyProjectReferenceActionResult,
  referencesForActiveProject,
  type ProjectReferencesDockState
} from '../lib/projectReferencesDockState'
import {
  classifyDroppedPath,
  classifyPastedReferenceText,
  type DockIngestCandidate
} from '../lib/projectReferencesDockIngest'
import {
  decideProjectReferenceCitationOpen,
  type ProjectReferenceCitationOpenRequest
} from '../lib/projectReferenceCitationOpen'
import { ProjectReferenceSourceViewer } from './ProjectReferenceSourceViewer'

/** Consent dialog copy for one-shot Project-reference extracts (P1 doctrine). */
export const PROJECT_REFERENCE_EXTRACT_CONSENT_COPY =
  'Save a readable text copy into this Project. Agents see it only if you Use next. Extract text sent on Use next may remain in provider history, and revoke cannot erase provider memory. You can revoke the Project copy anytime. Does not grant ongoing website or file access.'

/** Tooltip when Studio generate IPC is not bridged in this build. */
export const PROJECT_STUDIO_IPC_UNAVAILABLE_TOOLTIP = 'Studio is unavailable in this build'

const EXTRACTABLE_FILE_EXTENSIONS = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'md', 'csv', 'tsv'])

const PROJECT_STUDIO_KIND_ACTIONS: ReadonlyArray<{
  kind: ProjectStudioKind
  label: string
}> = [
  { kind: 'briefing', label: 'Briefing' },
  { kind: 'faq', label: 'FAQ' },
  { kind: 'decision-log', label: 'Decision log' }
]

/** Pure enablement for Studio generate buttons (selection + IPC + not busy). */
export function isProjectStudioGenerateEnabled(input: {
  selectedReferenceCount: number
  studioApiAvailable: boolean
  busy: boolean
}): boolean {
  return input.selectedReferenceCount >= 1 && input.studioApiAvailable && !input.busy
}

/** Presentation badge for a saved Studio keepable row (not a new reference kind). */
export function projectStudioKindBadgeLabel(kind: ProjectStudioKind): string {
  switch (kind) {
    case 'briefing':
      return 'Briefing'
    case 'faq':
      return 'FAQ'
    case 'decision-log':
      return 'Decisions'
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

export type ProjectStudioDraftView = {
  draftId: string
  kind: ProjectStudioKind
  path: string
  status: 'draft'
  title?: string
}

export type ProjectStudioArtifactView = {
  draftId: string
  kind: ProjectStudioKind
  title: string
  status: ProjectStudioStatus
  sourceReferenceIds: string[]
  referenceId?: string
}

const studioDraftSeedsForTests = new Map<string, ProjectStudioDraftView>()
const studioArtifactSeedsForTests = new Map<string, ProjectStudioArtifactView[]>()

/** Test-only: seed an in-panel Studio draft for Save/Discard markup. */
export function seedProjectStudioDraftForTests(draft: {
  projectId: string
  draftId: string
  kind: ProjectStudioKind
  path: string
  status: 'draft'
  title?: string
}): void {
  studioDraftSeedsForTests.set(draft.projectId, {
    draftId: draft.draftId,
    kind: draft.kind,
    path: draft.path,
    status: 'draft',
    ...(draft.title ? { title: draft.title } : {})
  })
}

/** Test-only: seed companion Studio artifacts for keepable badges. */
export function seedProjectStudioArtifactsForTests(
  projectId: string,
  artifacts: readonly ProjectStudioArtifactView[]
): void {
  studioArtifactSeedsForTests.set(
    projectId,
    artifacts.map((artifact) => ({
      ...artifact,
      sourceReferenceIds: [...artifact.sourceReferenceIds]
    }))
  )
}

export function clearProjectStudioSeedsForTests(): void {
  studioDraftSeedsForTests.clear()
  studioArtifactSeedsForTests.clear()
}

/** URL / PDF / Office (and plain markdown/csv) rows that can request a consentful extract. */
export function isProjectReferenceExtractCandidate(
  reference: Pick<ProjectReference, 'kind' | 'locator'>
): boolean {
  if (reference.kind === 'url') return true
  if (reference.kind !== 'file') return false
  const filename = reference.locator.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : ''
  return EXTRACTABLE_FILE_EXTENSIONS.has(extension)
}

const extractSeedsForTests = new Map<string, ProjectReferenceExtract>()

function extractCacheKey(projectId: string, referenceId: string): string {
  return `${projectId}\u0000${referenceId}`
}

/** Test-only: seed a ready extract so static markup can assert badges/actions. */
export function seedProjectReferenceExtractForTests(
  projectId: string,
  referenceId: string,
  extract: unknown
): void {
  const parsed = parseProjectReferenceExtract(extract)
  if (!parsed) {
    extractSeedsForTests.delete(extractCacheKey(projectId, referenceId))
    return
  }
  extractSeedsForTests.set(extractCacheKey(projectId, referenceId), parsed)
}

export function clearProjectReferenceExtractSeedsForTests(): void {
  extractSeedsForTests.clear()
}

interface ProjectReferenceExtractBridge {
  extractProjectReference?: (input: {
    projectId: string
    referenceId: string
    chatId?: string
    consent: {
      at: number
      actor: 'user'
      scope: 'this-reference'
      chatId?: string
    }
  }) => Promise<unknown>
  getProjectReferenceExtract?: (input: {
    projectId: string
    referenceId: string
  }) => Promise<unknown>
  revokeProjectReferenceExtract?: (input: { extractId: string } | string) => Promise<unknown>
  readProjectReferenceExtractText?: (input: {
    extractId: string
    maxChars?: number
  }) => Promise<unknown>
}

function extractBridge(): ProjectReferenceExtractBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return window.api as unknown as ProjectReferenceExtractBridge
}

function extractApiAvailable(api: ProjectReferenceExtractBridge | undefined): boolean {
  return typeof api?.extractProjectReference === 'function'
}

interface ProjectStudioBridge {
  generateProjectStudioDraft?: (input: {
    projectId: string
    kind: ProjectStudioKind
    referenceIds: string[]
    title?: string
    chatId?: string
    workspacePath?: string
  }) => Promise<unknown>
  saveProjectStudioDraft?: (input: {
    projectId: string
    draftId: string
    title?: string
  }) => Promise<unknown>
  discardProjectStudioDraft?: (input: { projectId: string; draftId: string }) => Promise<unknown>
  listProjectStudioArtifacts?: (input: { projectId: string } | string) => Promise<unknown>
}

function studioBridge(): ProjectStudioBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return window.api as unknown as ProjectStudioBridge
}

function studioGenerateApiAvailable(api: ProjectStudioBridge | undefined): boolean {
  return typeof api?.generateProjectStudioDraft === 'function'
}

function studioFailureMessage(value: unknown): string | null {
  if (!isRecord(value) || value.ok !== false) return null
  return text(value.message) ?? 'Studio request failed.'
}

function studioDraftFromUnknown(value: unknown): ProjectStudioDraftView | null {
  if (!isRecord(value)) return null
  if (value.ok === false) return null
  const nested = isRecord(value.artifact)
    ? value.artifact
    : isRecord(value.draft)
      ? value.draft
      : value
  const draftId = text(nested.draftId) ?? text(nested.id) ?? text(value.draftId) ?? text(value.id)
  const kind = parseProjectStudioKind(nested.kind) ?? parseProjectStudioKind(value.kind)
  const path =
    text(nested.path) ??
    text(nested.absolutePath) ??
    text(nested.relativePath) ??
    text(value.path) ??
    text(value.relativePath)
  const status = parseProjectStudioStatus(nested.status) ?? parseProjectStudioStatus(value.status)
  // Companion meta always carries status; accept missing status only on ok:true wraps.
  if (!draftId || !kind || !path) return null
  if (status !== 'draft' && !(value.ok === true && status == null)) return null
  const title = text(nested.title) ?? text(value.title) ?? undefined
  return {
    draftId,
    kind,
    path,
    status: 'draft',
    ...(title ? { title } : {})
  }
}

function studioArtifactsFromUnknown(
  value: unknown,
  projectId: string
): ProjectStudioArtifactView[] {
  if (isRecord(value) && value.ok === false) return []
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.artifacts)
      ? value.artifacts
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : []
  const artifacts: ProjectStudioArtifactView[] = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const entryProjectId = text(entry.projectId)
    if (entryProjectId && entryProjectId !== projectId) continue
    const draftId = text(entry.draftId) ?? text(entry.id)
    const kind = parseProjectStudioKind(entry.kind)
    const status = parseProjectStudioStatus(entry.status)
    const title = text(entry.title) ?? 'Studio keepable'
    if (!draftId || !kind || !status) continue
    const referenceId = text(entry.referenceId) ?? text(entry.libraryReferenceId) ?? undefined
    const sourceReferenceIds = Array.isArray(entry.sourceReferenceIds)
      ? entry.sourceReferenceIds.filter(
          (id): id is string => typeof id === 'string' && id.trim().length > 0
        )
      : []
    artifacts.push({
      draftId,
      kind,
      title,
      status,
      sourceReferenceIds,
      ...(referenceId ? { referenceId } : {})
    })
  }
  return artifacts
}

interface ProjectReferencesDockPanelProps {
  projectId: string
  chatId?: string | null
  /** Active workspace path for Studio draft writes (IPC generate requires it). */
  workspacePath?: string | null
  contextSelectionEnabled?: boolean
  onClose: () => void
  showCloseButton?: boolean
  /**
   * Classifies a file reference for the Office row action: workspace files
   * open by relative path; office-format files outside the workspace open
   * through the chat's external access grants (consent happens in the Office
   * panel). Returns null when the reference is not an office document.
   */
  resolveOfficeTarget?: (locator: string) => { path: string; external: boolean } | null
  /** Opens a resolved Office target in the dock surface. */
  onOpenInOffice?: (target: { path: string; external: boolean }) => void
  /**
   * One-shot citation-chip handoff: open the extract viewer for this extractId.
   * Consumed by nonce (officeOpenRequest-shaped); cleared via onCitationOpenRequestConsumed.
   */
  citationOpenRequest?: ProjectReferenceCitationOpenRequest | null
  /** Clear App's pending citationOpenRequest after this panel consumes it. */
  onCitationOpenRequestConsumed?: () => void
}

/**
 * A deliberately presentation-only projection of append-only agent evidence.
 * It is not a ProjectReference: a suggestion grants no authority and does not
 * join the catalogue until a human explicitly accepts it.
 */
export type ProjectReferenceProposalPreviewSourceView =
  | 'web_search'
  | 'web_fetch'
  | 'document_extract'
  | 'agent_context'
  | 'manual'

export interface ProjectReferenceProposalView {
  proposalId: string
  projectId: string
  candidate: {
    kind: 'file' | 'folder' | 'url'
    locator: string
    title: string
  }
  reason?: string
  /** Untrusted agent-claimed review snippet — never treated as host-fetched proof. */
  previewSnippet?: string
  previewSource?: ProjectReferenceProposalPreviewSourceView
  proposedAt: number
  provider?: string
  runId: string
}

const PROPOSAL_PREVIEW_SOURCES = new Set<ProjectReferenceProposalPreviewSourceView>([
  'web_search',
  'web_fetch',
  'document_extract',
  'agent_context',
  'manual'
])

/**
 * Resolve a dropped File's absolute path. Prefer legacy `File.path` when
 * present (tests + older Electron), else Electron 39's preload
 * `window.api.getPathForFile`.
 */
export function resolveDockDroppedFilePath(file: File): string {
  const legacyPath = (file as File & { path?: string }).path
  if (typeof legacyPath === 'string' && legacyPath.trim()) return legacyPath.trim()
  try {
    const bridged = typeof window !== 'undefined' ? window.api?.getPathForFile?.(file) : undefined
    return typeof bridged === 'string' ? bridged.trim() : ''
  } catch {
    return ''
  }
}

function droppedItemIsDirectory(file: File, item: DataTransferItem | null): boolean {
  const entry = item && typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
  if (entry && typeof entry.isDirectory === 'boolean') return entry.isDirectory
  // No path-stat IPC in the renderer: do not guess from extension / empty type.
  void file
  return false
}

function isEditablePasteTarget(element: Element | null): boolean {
  if (!element) return false
  const tag = element.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  const html = element as HTMLElement
  if (html.isContentEditable) return true
  return Boolean(element.closest?.('[contenteditable=""], [contenteditable="true"]'))
}

function isInsideComposer(element: Element | null): boolean {
  if (!element || typeof element.closest !== 'function') return false
  return Boolean(element.closest('.composer-area, .composer-surface'))
}

/**
 * Paste ingest is dock-scoped: the event target must be the dock (or its
 * dropzone), and the focused control must not be an editable field or the
 * chat composer.
 */
export function shouldHandleProjectReferencesDockPaste(input: {
  eventTarget: EventTarget | null
  activeElement: Element | null
}): boolean {
  if (isEditablePasteTarget(input.activeElement) || isInsideComposer(input.activeElement)) {
    return false
  }
  const target =
    input.eventTarget && typeof (input.eventTarget as Element).closest === 'function'
      ? (input.eventTarget as Element)
      : null
  if (!target) return false
  return Boolean(target.closest('.project-references-dock, .project-references-dock-dropzone'))
}

interface ProjectReferenceProposalState {
  projectId: string
  proposals: ProjectReferenceProposalView[]
  loading: boolean
  unsupported: boolean
  error: string | null
}

interface ProjectReferenceProposalBridge {
  listProjectReferenceProposals?: (projectId: string) => Promise<unknown>
  reviewProjectReferenceProposal?: (input: {
    projectId: string
    proposalId: string
    decision: 'approve' | 'reject'
  }) => Promise<unknown>
  onProjectReferenceProposalsChanged?: (
    listener: (payload?: { projectId?: string } | void) => void
  ) => (() => void) | undefined
}

function proposalBridge(): ProjectReferenceProposalBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return window.api as unknown as ProjectReferenceProposalBridge
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function extractFromRequestResult(value: unknown): ProjectReferenceExtract | null {
  if (!isRecord(value)) return parseProjectReferenceExtract(value)
  if ('extract' in value) {
    const nested = parseProjectReferenceExtract(value.extract)
    if (nested) return nested
  }
  return parseProjectReferenceExtract(value)
}

function extractRequestFailedMessage(value: unknown): string | null {
  if (!isRecord(value) || value.ok !== false) return null
  return text(value.message) ?? 'Extract failed.'
}

function extractTextFromUnknown(value: unknown): {
  text: string
  pages?: ProjectReferenceExtractPageSpan[]
} | null {
  if (typeof value === 'string') return { text: value }
  if (!isRecord(value)) return null
  if (value.ok === false) return null
  const textValue = text(value.text)
  if (!textValue) return null
  const pagesRaw = value.pages
  if (!Array.isArray(pagesRaw)) return { text: textValue }
  const pages: ProjectReferenceExtractPageSpan[] = []
  for (const entry of pagesRaw) {
    if (!isRecord(entry)) continue
    const pageNumber =
      typeof entry.pageNumber === 'number' && Number.isSafeInteger(entry.pageNumber)
        ? entry.pageNumber
        : null
    const startOffset =
      typeof entry.startOffset === 'number' && Number.isSafeInteger(entry.startOffset)
        ? entry.startOffset
        : null
    const endOffset =
      typeof entry.endOffset === 'number' && Number.isSafeInteger(entry.endOffset)
        ? entry.endOffset
        : null
    if (
      pageNumber === null ||
      startOffset === null ||
      endOffset === null ||
      pageNumber < 1 ||
      startOffset < 0 ||
      endOffset < startOffset
    ) {
      continue
    }
    pages.push({ pageNumber, startOffset, endOffset })
  }
  return pages.length > 0 ? { text: textValue, pages } : { text: textValue }
}

function proposalPreviewFromUnknown(item: Record<string, unknown>): {
  previewSnippet?: string
  previewSource?: ProjectReferenceProposalPreviewSourceView
} {
  const previewSnippet = text(item.previewSnippet) ?? undefined
  const previewSourceRaw = text(item.previewSource)
  const previewSource =
    previewSourceRaw &&
    PROPOSAL_PREVIEW_SOURCES.has(previewSourceRaw as ProjectReferenceProposalPreviewSourceView)
      ? (previewSourceRaw as ProjectReferenceProposalPreviewSourceView)
      : undefined
  if (!previewSnippet || !previewSource) return {}
  return { previewSnippet, previewSource }
}

/**
 * The main process owns validation and hash-chain verification. This narrow
 * parser is defense in depth at the UI boundary, so a malformed bridge result
 * cannot render misleading controls or bleed a different Project into view.
 */
export function projectReferenceProposalViewsFromUnknown(
  value: unknown,
  projectId: string
): ProjectReferenceProposalView[] {
  if (!Array.isArray(value)) return []
  const proposals: ProjectReferenceProposalView[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) continue
    const proposalId = text(item.proposalId)
    const itemProjectId = text(item.projectId)
    const runId = text(item.runId)
    const candidate = isRecord(item.candidate) ? item.candidate : null
    const kind = candidate?.kind
    const locator = candidate ? text(candidate.locator) : null
    const title = candidate ? text(candidate.title) : null
    if (
      !proposalId ||
      itemProjectId !== projectId ||
      !runId ||
      (kind !== 'file' && kind !== 'folder' && kind !== 'url') ||
      !locator ||
      !title ||
      seen.has(proposalId)
    ) {
      continue
    }
    seen.add(proposalId)
    const reason = text(item.reason) ?? undefined
    const provider = text(item.provider) ?? undefined
    const preview = proposalPreviewFromUnknown(item)
    proposals.push({
      proposalId,
      projectId: itemProjectId,
      candidate: { kind, locator, title },
      ...(reason ? { reason } : {}),
      ...preview,
      proposedAt:
        typeof item.proposedAt === 'number' && Number.isFinite(item.proposedAt)
          ? item.proposedAt
          : 0,
      ...(provider ? { provider } : {}),
      runId
    })
  }
  return proposals
}

function proposalKindLabel(kind: ProjectReferenceProposalView['candidate']['kind']): string {
  if (kind === 'url') return 'Link'
  return kind === 'folder' ? 'Folder' : 'File'
}

export function ProjectReferenceSuggestions({
  proposals,
  loading,
  unsupported,
  error,
  actingProposalId,
  onReview
}: {
  proposals: ProjectReferenceProposalView[]
  loading: boolean
  unsupported: boolean
  error: string | null
  actingProposalId: string | null
  onReview: (proposal: ProjectReferenceProposalView, decision: 'approve' | 'reject') => void
}): JSX.Element {
  return (
    <section className="project-reference-suggestions" aria-label="Agent suggestions">
      <div className="project-reference-suggestions-heading">
        <div>
          <span className="project-references-dock-eyebrow">Agent suggestions</span>
          <h4>Review before adding</h4>
        </div>
        {proposals.length > 0 && (
          <span className="project-reference-suggestions-count">{proposals.length}</span>
        )}
      </div>
      <p className="project-reference-suggestions-boundary" role="note">
        <strong>Untrusted agent suggestions.</strong> Adding one creates catalogue metadata only; it
        grants no file, folder, or website access.
      </p>
      {error && (
        <p className="project-reference-suggestions-error" role="alert">
          {error}
        </p>
      )}
      {unsupported ? (
        <p className="project-reference-suggestions-empty">
          Agent suggestions are unavailable in this build.
        </p>
      ) : loading && proposals.length === 0 ? (
        <p className="project-reference-suggestions-empty">Loading agent suggestions…</p>
      ) : proposals.length === 0 ? (
        <p className="project-reference-suggestions-empty">No pending agent suggestions.</p>
      ) : (
        <div className="project-reference-suggestions-list">
          {proposals.map((proposal) => {
            const acting = actingProposalId === proposal.proposalId
            return (
              <article className="project-reference-suggestion" key={proposal.proposalId}>
                <div className="project-reference-suggestion-kind">
                  {proposalKindLabel(proposal.candidate.kind)}
                </div>
                <div className="project-reference-suggestion-copy">
                  <strong>{proposal.candidate.title}</strong>
                  {/* Plain text by design: never navigate, fetch, preview, or favicon a suggestion. */}
                  <span
                    className="project-reference-suggestion-locator"
                    title={proposal.candidate.locator}
                  >
                    {proposal.candidate.locator}
                  </span>
                  <span className="project-reference-suggestion-provider">
                    Proposed by {proposal.provider || 'an agent'}
                  </span>
                  {proposal.reason && (
                    <span className="project-reference-suggestion-reason">{proposal.reason}</span>
                  )}
                  {proposal.previewSnippet && proposal.previewSource && (
                    <span className="project-reference-suggestion-preview">
                      <span className="project-reference-suggestion-preview-label">
                        Agent-claimed · {proposal.previewSource}
                      </span>
                      <span className="project-reference-suggestion-preview-snippet">
                        {proposal.previewSnippet}
                      </span>
                    </span>
                  )}
                </div>
                <div className="project-reference-suggestion-actions">
                  <button
                    type="button"
                    disabled={actingProposalId !== null}
                    onClick={() => onReview(proposal, 'approve')}
                  >
                    {acting ? 'Saving…' : 'Add to library'}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={actingProposalId !== null}
                    onClick={() => onReview(proposal, 'reject')}
                  >
                    Reject
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

export function ProjectReferencesDockPanel({
  projectId,
  chatId,
  workspacePath,
  contextSelectionEnabled = true,
  onClose,
  showCloseButton = true,
  resolveOfficeTarget,
  onOpenInOffice,
  citationOpenRequest,
  onCitationOpenRequestConsumed
}: ProjectReferencesDockPanelProps): JSX.Element {
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  const [referenceState, setReferenceState] = useState<ProjectReferencesDockState>(() => ({
    projectId,
    references: listProjectReferences(projectId)
  }))
  const [proposalState, setProposalState] = useState<ProjectReferenceProposalState>(() => ({
    projectId,
    proposals: [],
    loading: false,
    unsupported: false,
    error: null
  }))
  const proposalRequestTokenRef = useRef(0)
  const proposalActionTokenRef = useRef(0)
  const proposalProjectEpochRef = useRef(0)
  const [actingProposal, setActingProposal] = useState<{
    projectId: string
    proposalId: string
  } | null>(null)
  const references = referencesForActiveProject(referenceState, projectId, listProjectReferences)
  const attention = summarizeReferenceAttention(references)
  const proposals =
    proposalState.projectId === projectId
      ? proposalState.proposals
      : ([] as ProjectReferenceProposalView[])
  const proposalsLoading = proposalState.projectId === projectId && proposalState.loading
  const proposalsUnsupported = proposalState.projectId === projectId && proposalState.unsupported
  const proposalsError = proposalState.projectId === projectId ? proposalState.error : null
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null)
  const busy = busyProjectId === projectId
  const [dragOver, setDragOver] = useState(false)
  const dragDepthRef = useRef(0)
  const [extractsByReferenceId, setExtractsByReferenceId] = useState<
    Record<string, ProjectReferenceExtract | null>
  >(() => {
    const seeded: Record<string, ProjectReferenceExtract | null> = {}
    for (const [key, extract] of extractSeedsForTests) {
      const separator = key.indexOf('\u0000')
      if (separator < 0) continue
      if (key.slice(0, separator) !== projectId) continue
      seeded[key.slice(separator + 1)] = extract
    }
    return seeded
  })
  const [extractActingReferenceId, setExtractActingReferenceId] = useState<string | null>(null)
  const [viewerState, setViewerState] = useState<{
    title: string
    text: string
    pages?: ProjectReferenceExtractPageSpan[]
  } | null>(null)
  const extractBridgeApi = extractBridge()
  const canExtractViaApi = extractApiAvailable(extractBridgeApi)
  const canReadExtractViaApi =
    typeof extractBridgeApi?.readProjectReferenceExtractText === 'function'
  const canRevokeExtractViaApi =
    typeof extractBridgeApi?.revokeProjectReferenceExtract === 'function'
  const studioBridgeApi = studioBridge()
  const canGenerateStudioViaApi = studioGenerateApiAvailable(studioBridgeApi)
  const canSaveStudioViaApi = typeof studioBridgeApi?.saveProjectStudioDraft === 'function'
  const canDiscardStudioViaApi = typeof studioBridgeApi?.discardProjectStudioDraft === 'function'
  const canListStudioViaApi = typeof studioBridgeApi?.listProjectStudioArtifacts === 'function'
  const [studioDraft, setStudioDraft] = useState<ProjectStudioDraftView | null>(
    () => studioDraftSeedsForTests.get(projectId) ?? null
  )
  const [studioActing, setStudioActing] = useState(false)
  const [studioError, setStudioError] = useState<string | null>(null)
  const [studioArtifacts, setStudioArtifacts] = useState<ProjectStudioArtifactView[]>(
    () => studioArtifactSeedsForTests.get(projectId) ?? []
  )
  const studioArtifactsByReferenceId = useMemo(() => {
    const map = new Map<string, ProjectStudioArtifactView>()
    for (const artifact of studioArtifacts) {
      if (artifact.status === 'saved' && artifact.referenceId) {
        map.set(artifact.referenceId, artifact)
      }
    }
    return map
  }, [studioArtifacts])
  const contextSelection = useSyncExternalStore(
    useCallback(
      (listener) => subscribeProjectReferenceContextSelection(chatId, listener),
      [chatId]
    ),
    () => getProjectReferenceContextSelection(chatId),
    () => getProjectReferenceContextSelection(chatId)
  )
  const project = useMemo(
    () => listProjects().find((candidate) => candidate.id === projectId) ?? null,
    [projectId, references]
  )
  const selectedReferenceIds = useMemo(
    () => new Set(contextSelection?.projectId === projectId ? contextSelection.referenceIds : []),
    [contextSelection, projectId]
  )
  const canSelectForNextSend = Boolean(
    contextSelectionEnabled && chatId && project?.memberChatIds.includes(chatId)
  )
  const selectedExtractCount = useMemo(() => {
    let count = 0
    for (const referenceId of selectedReferenceIds) {
      if (extractsByReferenceId[referenceId]?.status === 'ready') count += 1
    }
    return count
  }, [extractsByReferenceId, selectedReferenceIds])

  const studioSelectionIds = useMemo(() => [...selectedReferenceIds], [selectedReferenceIds])
  const studioGenerateEnabled = isProjectStudioGenerateEnabled({
    selectedReferenceCount: studioSelectionIds.length,
    studioApiAvailable: canGenerateStudioViaApi,
    busy: busy || studioActing
  })
  const studioDisabledTitle =
    studioSelectionIds.length < 1
      ? 'Select at least one Use next source'
      : !canGenerateStudioViaApi
        ? PROJECT_STUDIO_IPC_UNAVAILABLE_TOOLTIP
        : studioActing
          ? 'Studio is generating…'
          : undefined

  useEffect(() => {
    const refresh = (): void =>
      setReferenceState({ projectId, references: listProjectReferences(projectId) })
    refresh()
    return subscribeProjects(refresh)
  }, [projectId])

  useEffect(() => {
    setStudioDraft(studioDraftSeedsForTests.get(projectId) ?? null)
    setStudioError(null)
    setStudioActing(false)
    const seeded = studioArtifactSeedsForTests.get(projectId)
    if (seeded) {
      setStudioArtifacts(seeded)
      return
    }
    setStudioArtifacts([])
    if (!canListStudioViaApi) return
    let cancelled = false
    void Promise.resolve()
      .then(() => studioBridgeApi?.listProjectStudioArtifacts?.({ projectId }))
      .then((result) => {
        if (cancelled || projectIdRef.current !== projectId) return
        setStudioArtifacts(studioArtifactsFromUnknown(result, projectId))
      })
      .catch(() => {
        if (cancelled || projectIdRef.current !== projectId) return
        setStudioArtifacts([])
      })
    return () => {
      cancelled = true
    }
  }, [projectId, canListStudioViaApi, studioBridgeApi])

  useEffect(() => {
    const seeded: Record<string, ProjectReferenceExtract | null> = {}
    for (const [key, extract] of extractSeedsForTests) {
      const separator = key.indexOf('\u0000')
      if (separator < 0) continue
      if (key.slice(0, separator) !== projectId) continue
      seeded[key.slice(separator + 1)] = extract
    }
    // Drop extracts from a previous project so citation open cannot read a
    // stale ready id after a fast Work-project switch.
    setExtractsByReferenceId(seeded)

    const api = extractBridge()
    if (typeof api?.getProjectReferenceExtract !== 'function') return

    let cancelled = false
    const loadable = referencesForActiveProject(
      { projectId, references: listProjectReferences(projectId) },
      projectId,
      listProjectReferences
    ).filter((reference) => isProjectReferenceExtractCandidate(reference))

    void Promise.all(
      loadable.map(async (reference) => {
        try {
          const result = await api.getProjectReferenceExtract?.({
            projectId,
            referenceId: reference.id
          })
          return [reference.id, parseProjectReferenceExtract(result)] as const
        } catch {
          return [reference.id, null] as const
        }
      })
    ).then((entries) => {
      if (cancelled) return
      setExtractsByReferenceId((prev) => {
        const next = { ...prev }
        for (const [referenceId, extract] of entries) {
          next[referenceId] = extract
        }
        return next
      })
    })

    return () => {
      cancelled = true
    }
  }, [projectId, references.length])

  const refreshProjectReferenceProposals = useCallback(
    (requestedProjectId: string): Promise<void> => {
      const requestToken = ++proposalRequestTokenRef.current
      const api = proposalBridge()
      if (typeof api?.listProjectReferenceProposals !== 'function') {
        if (projectIdRef.current === requestedProjectId) {
          setProposalState({
            projectId: requestedProjectId,
            proposals: [],
            loading: false,
            unsupported: true,
            error: null
          })
        }
        return Promise.resolve()
      }

      if (projectIdRef.current === requestedProjectId) {
        setProposalState((state) =>
          state.projectId === requestedProjectId
            ? { ...state, loading: true, unsupported: false, error: null }
            : {
                projectId: requestedProjectId,
                proposals: [],
                loading: true,
                unsupported: false,
                error: null
              }
        )
      }

      return Promise.resolve()
        .then(() => api.listProjectReferenceProposals?.(requestedProjectId))
        .then(
          (result) => {
            if (
              projectIdRef.current !== requestedProjectId ||
              proposalRequestTokenRef.current !== requestToken
            ) {
              return
            }
            setProposalState({
              projectId: requestedProjectId,
              proposals: projectReferenceProposalViewsFromUnknown(result, requestedProjectId),
              loading: false,
              unsupported: false,
              error: null
            })
          },
          (error: unknown) => {
            if (
              projectIdRef.current !== requestedProjectId ||
              proposalRequestTokenRef.current !== requestToken
            ) {
              return
            }
            setProposalState((state) => ({
              projectId: requestedProjectId,
              proposals: state.projectId === requestedProjectId ? state.proposals : [],
              loading: false,
              unsupported: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Could not load agent suggestions for this Project.'
            }))
          }
        )
    },
    []
  )

  useEffect(() => {
    const projectEpoch = ++proposalProjectEpochRef.current
    void refreshProjectReferenceProposals(projectId)
    const api = proposalBridge()
    if (typeof api?.onProjectReferenceProposalsChanged !== 'function') {
      return () => {
        proposalRequestTokenRef.current += 1
        if (proposalProjectEpochRef.current === projectEpoch) {
          proposalProjectEpochRef.current += 1
        }
      }
    }
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = api.onProjectReferenceProposalsChanged((payload) => {
        const changedProjectId =
          payload && typeof payload === 'object' && 'projectId' in payload
            ? (payload as { projectId?: unknown }).projectId
            : undefined
        if (changedProjectId !== undefined && changedProjectId !== projectId) return
        void refreshProjectReferenceProposals(projectId)
      })
    } catch (error) {
      if (projectIdRef.current === projectId) {
        setProposalState((state) => ({
          ...state,
          error:
            error instanceof Error
              ? error.message
              : 'Could not watch agent suggestions for this Project.'
        }))
      }
    }
    return () => {
      proposalRequestTokenRef.current += 1
      if (proposalProjectEpochRef.current === projectEpoch) {
        proposalProjectEpochRef.current += 1
      }
      unsubscribe?.()
    }
  }, [projectId, refreshProjectReferenceProposals])

  useEffect(() => {
    if (!chatId || contextSelection?.projectId !== projectId) return
    const availableIds = new Set(
      references
        .filter((reference) => reference.contextPolicy === 'available')
        .map((reference) => reference.id)
    )
    const nextIds = contextSelection.referenceIds.filter((id) => availableIds.has(id))
    if (nextIds.length === contextSelection.referenceIds.length) return
    if (nextIds.length > 0) {
      setProjectReferenceContextSelection(chatId, projectId, nextIds)
    } else {
      clearProjectReferenceContextSelection(chatId)
    }
  }, [chatId, contextSelection, projectId, references])

  const runAction = (action: () => Promise<void>): void => {
    if (busy) return
    const actionProjectId = projectId
    setBusyProjectId(actionProjectId)
    void action()
      .then(() => {
        setReferenceState((state) =>
          applyProjectReferenceActionResult({
            state,
            activeProjectId: projectIdRef.current,
            actionProjectId,
            loadReferences: listProjectReferences
          })
        )
      })
      .catch((error) => {
        if (projectIdRef.current === actionProjectId) {
          window.alert(error instanceof Error ? error.message : 'Reference update failed.')
        }
      })
      .finally(() => {
        if (projectIdRef.current === actionProjectId) setBusyProjectId(null)
      })
  }

  const refreshStudioArtifacts = useCallback(async (): Promise<void> => {
    if (!canListStudioViaApi) return
    try {
      const result = await studioBridgeApi?.listProjectStudioArtifacts?.({ projectId })
      if (projectIdRef.current !== projectId) return
      setStudioArtifacts(studioArtifactsFromUnknown(result, projectId))
    } catch {
      if (projectIdRef.current === projectId) setStudioArtifacts([])
    }
  }, [canListStudioViaApi, projectId, studioBridgeApi])

  const generateStudioDraft = (kind: ProjectStudioKind): void => {
    if (!studioGenerateEnabled) return
    const api = studioBridge()
    if (typeof api?.generateProjectStudioDraft !== 'function') return
    const actionProjectId = projectId
    const referenceIds = [...studioSelectionIds]
    if (referenceIds.length < 1) return
    if (!chatId?.trim()) {
      setStudioError('Open a chat in this Project before generating a Studio draft.')
      return
    }
    if (!workspacePath?.trim()) {
      setStudioError('Set an active workspace before generating a Studio draft.')
      return
    }
    setStudioActing(true)
    setStudioError(null)
    void Promise.resolve()
      .then(() =>
        api.generateProjectStudioDraft?.({
          projectId: actionProjectId,
          kind,
          referenceIds,
          chatId: chatId.trim(),
          workspacePath: workspacePath.trim()
        })
      )
      .then((result) => {
        if (projectIdRef.current !== actionProjectId) return
        const failure = studioFailureMessage(result)
        if (failure) {
          setStudioError(failure)
          return
        }
        const draft = studioDraftFromUnknown(result)
        if (!draft) {
          setStudioError('Studio draft response was incomplete.')
          return
        }
        setStudioDraft(draft)
      })
      .catch((error: unknown) => {
        if (projectIdRef.current !== actionProjectId) return
        setStudioError(error instanceof Error ? error.message : 'Studio draft failed.')
      })
      .finally(() => {
        if (projectIdRef.current === actionProjectId) setStudioActing(false)
      })
  }

  const saveStudioDraft = (): void => {
    if (!studioDraft || !canSaveStudioViaApi || studioActing) return
    const api = studioBridge()
    if (typeof api?.saveProjectStudioDraft !== 'function') return
    const actionProjectId = projectId
    const draftId = studioDraft.draftId
    setStudioActing(true)
    setStudioError(null)
    void Promise.resolve()
      .then(() =>
        api.saveProjectStudioDraft?.({
          projectId: actionProjectId,
          draftId,
          ...(studioDraft.title ? { title: studioDraft.title } : {})
        })
      )
      .then((result) => {
        if (projectIdRef.current !== actionProjectId) return
        const failure = studioFailureMessage(result)
        if (failure) {
          setStudioError(failure)
          return
        }
        setStudioDraft(null)
        setReferenceState({
          projectId: actionProjectId,
          references: listProjectReferences(actionProjectId)
        })
        return refreshStudioArtifacts()
      })
      .catch((error: unknown) => {
        if (projectIdRef.current !== actionProjectId) return
        setStudioError(error instanceof Error ? error.message : 'Could not save Studio draft.')
      })
      .finally(() => {
        if (projectIdRef.current === actionProjectId) setStudioActing(false)
      })
  }

  const discardStudioDraft = (): void => {
    if (!studioDraft || studioActing) return
    const actionProjectId = projectId
    const draftId = studioDraft.draftId
    setStudioActing(true)
    setStudioError(null)
    const finishLocalDiscard = (): void => {
      if (projectIdRef.current !== actionProjectId) return
      setStudioDraft(null)
    }
    if (!canDiscardStudioViaApi) {
      finishLocalDiscard()
      setStudioActing(false)
      return
    }
    const api = studioBridge()
    void Promise.resolve()
      .then(() =>
        api?.discardProjectStudioDraft?.({
          projectId: actionProjectId,
          draftId
        })
      )
      .then(() => {
        finishLocalDiscard()
        return refreshStudioArtifacts()
      })
      .catch((error: unknown) => {
        if (projectIdRef.current !== actionProjectId) return
        setStudioError(error instanceof Error ? error.message : 'Could not discard Studio draft.')
      })
      .finally(() => {
        if (projectIdRef.current === actionProjectId) setStudioActing(false)
      })
  }

  const addPath = (kind: 'file' | 'folder'): void => {
    runAction(async () => {
      const locator = await window.api?.pickProjectReferencePath?.(kind)
      if (!locator) return
      await addProjectReference({ projectId, kind, locator })
    })
  }

  const addLink = (): void => {
    const locator = window.prompt('Link URL (https://…)')?.trim()
    if (!locator) return
    runAction(() => addProjectReference({ projectId, kind: 'url', locator }))
  }

  const addGitHub = (): void => {
    const input = window.prompt(
      'GitHub resource (owner/repo, a github.com URL, or github://owner/repo/path@ref)'
    )
    const trimmed = input?.trim()
    if (!trimmed) return
    const locator = normalizeGitHubReferenceInput(trimmed)
    if (!locator) {
      window.alert('Use owner/repo, a github.com URL, or github://owner/repo[/path][@ref].')
      return
    }
    runAction(() => addProjectReference({ projectId, kind: 'connector', locator }))
  }

  const ingestCandidate = (candidate: DockIngestCandidate): void => {
    runAction(() =>
      addProjectReference({
        projectId,
        kind: candidate.kind,
        locator: candidate.locator
      })
    )
  }

  const handleDockDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (![...event.dataTransfer.types].includes('Files')) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDragOver(true)
  }

  const handleDockDragOver = (event: DragEvent<HTMLElement>): void => {
    if (![...event.dataTransfer.types].includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDockDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (![...event.dataTransfer.types].includes('Files')) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragOver(false)
  }

  const handleDockDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    const files = Array.from(event.dataTransfer.files || [])
    const items = Array.from(event.dataTransfer.items || [])
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      const item = items[index] ?? null
      const path = resolveDockDroppedFilePath(file)
      if (!path) continue
      const candidate = classifyDroppedPath(path, droppedItemIsDirectory(file, item))
      if (candidate) ingestCandidate(candidate)
    }
  }

  const handleDockPaste = (event: ClipboardEvent<HTMLElement>): void => {
    if (
      !shouldHandleProjectReferencesDockPaste({
        eventTarget: event.target,
        activeElement: typeof document !== 'undefined' ? document.activeElement : null
      })
    ) {
      return
    }
    const textValue = event.clipboardData?.getData('text/plain') ?? ''
    const candidate = classifyPastedReferenceText(textValue)
    if (!candidate) return
    event.preventDefault()
    ingestCandidate(candidate)
  }

  const requestExtract = (reference: ProjectReference): void => {
    const api = extractBridge()
    if (typeof api?.extractProjectReference !== 'function') {
      window.alert('Extract is unavailable in this build.')
      return
    }
    const confirmed =
      typeof window.confirm === 'function'
        ? window.confirm(PROJECT_REFERENCE_EXTRACT_CONSENT_COPY)
        : false
    if (!confirmed) return
    const consentAt = Date.now()
    const consent = {
      at: consentAt,
      actor: 'user' as const,
      scope: 'this-reference' as const,
      ...(chatId ? { chatId } : {})
    }
    setExtractActingReferenceId(reference.id)
    void Promise.resolve()
      .then(() =>
        api.extractProjectReference?.({
          projectId,
          referenceId: reference.id,
          ...(chatId ? { chatId } : {}),
          consent
        })
      )
      .then((result) => {
        const parsed = extractFromRequestResult(result)
        setExtractsByReferenceId((prev) => ({
          ...prev,
          [reference.id]: parsed
        }))
        const failure = extractRequestFailedMessage(result)
        if (failure) {
          window.alert(failure)
        } else if (!parsed) {
          window.alert('Extract failed.')
        } else if (parsed.status === 'failed') {
          window.alert(parsed.error?.message || 'Extract failed.')
        }
      })
      .catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : 'Extract failed.')
      })
      .finally(() => {
        setExtractActingReferenceId((current) => (current === reference.id ? null : current))
      })
  }

  const openExtractViewer = (
    reference: ProjectReference | undefined,
    extractId: string,
    cachedExtract?: ProjectReferenceExtract | null
  ): void => {
    const api = extractBridge()
    if (typeof api?.readProjectReferenceExtractText !== 'function') {
      window.alert('Extract text is unavailable.')
      return
    }
    const actingReferenceId = reference?.id ?? null
    if (actingReferenceId) setExtractActingReferenceId(actingReferenceId)
    void Promise.resolve()
      .then(() =>
        api.readProjectReferenceExtractText?.({
          extractId
        })
      )
      .then((result) => {
        const failure = extractRequestFailedMessage(result)
        if (failure) {
          window.alert(failure)
          return
        }
        const parsed = extractTextFromUnknown(result)
        if (!parsed) {
          window.alert('Extract text is unavailable.')
          return
        }
        setViewerState({
          title: reference?.title || 'Extract',
          text: parsed.text,
          ...(parsed.pages
            ? { pages: parsed.pages }
            : cachedExtract?.text?.pages
              ? { pages: cachedExtract.text.pages }
              : {})
        })
      })
      .catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : 'Could not read extract text.')
      })
      .finally(() => {
        if (!actingReferenceId) return
        setExtractActingReferenceId((current) => (current === actingReferenceId ? null : current))
      })
  }

  const viewExtract = (reference: ProjectReference): void => {
    const extract = extractsByReferenceId[reference.id]
    if (!extract || extract.status !== 'ready') {
      window.alert('Extract text is unavailable.')
      return
    }
    openExtractViewer(reference, extract.id, extract)
  }

  const lastCitationOpenNonceRef = useRef<number | null>(null)
  const onCitationOpenRequestConsumedRef = useRef(onCitationOpenRequestConsumed)
  onCitationOpenRequestConsumedRef.current = onCitationOpenRequestConsumed
  useEffect(() => {
    if (!citationOpenRequest) return
    if (citationOpenRequest.nonce === lastCitationOpenNonceRef.current) return
    if (citationOpenRequest.projectId && citationOpenRequest.projectId !== projectId) return
    const reference = references.find((entry) => entry.id === citationOpenRequest.referenceId)
    const cachedLookup = reference
      ? Object.prototype.hasOwnProperty.call(extractsByReferenceId, reference.id)
        ? extractsByReferenceId[reference.id]
        : undefined
      : undefined
    const decision = decideProjectReferenceCitationOpen({
      referenceId: citationOpenRequest.referenceId,
      requestExtractId: citationOpenRequest.extractId,
      referenceFound: Boolean(reference),
      cached: cachedLookup
        ? { id: cachedLookup.id, status: cachedLookup.status }
        : cachedLookup === null
          ? null
          : undefined
    })
    if (decision.action === 'wait') return
    lastCitationOpenNonceRef.current = citationOpenRequest.nonce
    onCitationOpenRequestConsumedRef.current?.()
    const requestProjectId = citationOpenRequest.projectId
    const requestNonce = citationOpenRequest.nonce
    if (decision.action === 'missing' || decision.action === 'unavailable') {
      queueMicrotask(() => {
        if (projectIdRef.current !== projectId) return
        if (requestProjectId && projectIdRef.current !== requestProjectId) return
        window.alert(
          decision.action === 'missing'
            ? 'That reference is not in this project library.'
            : 'Extract text is unavailable.'
        )
      })
      return
    }
    const openCached =
      cachedLookup && cachedLookup.id === decision.extractId ? cachedLookup : cachedLookup ?? null
    queueMicrotask(() => {
      if (projectIdRef.current !== projectId) return
      if (requestProjectId && projectIdRef.current !== requestProjectId) return
      if (lastCitationOpenNonceRef.current !== requestNonce) return
      openExtractViewer(reference, decision.extractId, openCached)
    })
    // openExtractViewer closes over the latest bridge/extracts; nonce gates re-entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citationOpenRequest, projectId, references, extractsByReferenceId])

  const revokeExtract = (reference: ProjectReference): void => {
    const api = extractBridge()
    const extract = extractsByReferenceId[reference.id]
    if (typeof api?.revokeProjectReferenceExtract !== 'function' || !extract) {
      window.alert('Revoke extract is unavailable in this build.')
      return
    }
    const confirmed =
      typeof window.confirm === 'function'
        ? window.confirm(
            'Revoke this extract? Agents will no longer see the saved text on Use next.'
          )
        : false
    if (!confirmed) return
    setExtractActingReferenceId(reference.id)
    void Promise.resolve()
      .then(() => api.revokeProjectReferenceExtract?.({ extractId: extract.id }))
      .then((result) => {
        const failure = extractRequestFailedMessage(result)
        if (failure) {
          window.alert(failure)
          return
        }
        setExtractsByReferenceId((prev) => ({ ...prev, [reference.id]: null }))
        setViewerState(null)
      })
      .catch((error: unknown) => {
        window.alert(error instanceof Error ? error.message : 'Could not revoke extract.')
      })
      .finally(() => {
        setExtractActingReferenceId((current) => (current === reference.id ? null : current))
      })
  }

  const reviewProposal = (
    proposal: ProjectReferenceProposalView,
    decision: 'approve' | 'reject'
  ): void => {
    const api = proposalBridge()
    const actionProjectId = projectId
    if (typeof api?.reviewProjectReferenceProposal !== 'function') {
      setProposalState((state) =>
        projectIdRef.current === actionProjectId && state.projectId === actionProjectId
          ? {
              ...state,
              error: 'Agent suggestions are unavailable in this build.'
            }
          : state
      )
      return
    }
    const actionToken = ++proposalActionTokenRef.current
    const projectEpoch = proposalProjectEpochRef.current
    setActingProposal({ projectId: actionProjectId, proposalId: proposal.proposalId })
    setProposalState((state) =>
      state.projectId === actionProjectId ? { ...state, error: null } : state
    )
    void Promise.resolve()
      .then(() =>
        api.reviewProjectReferenceProposal?.({
          projectId: actionProjectId,
          proposalId: proposal.proposalId,
          decision
        })
      )
      .then(() => {
        if (
          projectIdRef.current !== actionProjectId ||
          proposalActionTokenRef.current !== actionToken ||
          proposalProjectEpochRef.current !== projectEpoch
        ) {
          return
        }
        return refreshProjectReferenceProposals(actionProjectId)
      })
      .catch((error: unknown) => {
        if (
          projectIdRef.current !== actionProjectId ||
          proposalActionTokenRef.current !== actionToken ||
          proposalProjectEpochRef.current !== projectEpoch
        ) {
          return
        }
        setProposalState((state) =>
          state.projectId === actionProjectId
            ? {
                ...state,
                error:
                  error instanceof Error ? error.message : 'Could not review this agent suggestion.'
              }
            : state
        )
      })
      .finally(() => {
        if (
          projectIdRef.current === actionProjectId &&
          proposalActionTokenRef.current === actionToken &&
          proposalProjectEpochRef.current === projectEpoch
        ) {
          setActingProposal(null)
        }
      })
  }

  return (
    <section
      className={`project-references-dock${dragOver ? ' is-drop-target' : ''}`}
      aria-label="Project references"
      tabIndex={0}
      onDragEnter={handleDockDragEnter}
      onDragOver={handleDockDragOver}
      onDragLeave={handleDockDragLeave}
      onDrop={handleDockDrop}
      onPaste={handleDockPaste}
    >
      <header className="project-references-dock-header">
        <div>
          <span className="project-references-dock-eyebrow">Project library</span>
          <h3>{project?.name || 'References'}</h3>
        </div>
        {showCloseButton ? (
          <button type="button" className="project-references-dock-close" onClick={onClose}>
            Close
          </button>
        ) : null}
      </header>

      <p className="project-references-dock-boundary">
        Catalogue only until you choose Use next. Selection grants no new access; main rechecks
        every item when you send.
      </p>

      {!canSelectForNextSend && (
        <p className="project-references-dock-context-note">
          {contextSelectionEnabled
            ? 'Open a chat in this Project to use references in a turn.'
            : 'Reference context for Ensemble turns is not available in this version.'}
        </p>
      )}

      {selectedReferenceIds.size > 0 && (
        <div className="project-references-dock-selection">
          <span>
            {selectedReferenceIds.size} selected for the next send
            {selectedExtractCount > 0 ? ` · ${selectedExtractCount} with extract` : ''}
          </span>
          <button type="button" onClick={() => clearProjectReferenceContextSelection(chatId)}>
            Clear
          </button>
        </div>
      )}

      <div className="project-references-dock-add" role="toolbar" aria-label="Add reference">
        <button type="button" disabled={busy} onClick={() => addPath('file')}>
          + File
        </button>
        <button type="button" disabled={busy} onClick={() => addPath('folder')}>
          + Folder
        </button>
        <button type="button" disabled={busy} onClick={addLink}>
          + Link
        </button>
        <button type="button" disabled={busy} onClick={addGitHub}>
          + GitHub
        </button>
      </div>

      <div className="project-references-dock-studio" aria-label="Studio">
        <div className="project-references-dock-studio-heading">
          <span className="project-references-dock-studio-eyebrow">Studio</span>
          <span className="project-references-dock-studio-hint">
            From selected Use next sources
          </span>
        </div>
        <div className="project-references-dock-studio-actions" role="toolbar" aria-label="Studio">
          {PROJECT_STUDIO_KIND_ACTIONS.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              disabled={!studioGenerateEnabled}
              title={studioDisabledTitle ?? `Generate a ${label} from selected Use next sources`}
              onClick={() => generateStudioDraft(kind)}
            >
              {studioActing ? `${label}…` : label}
            </button>
          ))}
        </div>
        {studioError ? (
          <p className="project-references-dock-studio-error" role="alert">
            {studioError}
          </p>
        ) : null}
        {studioDraft ? (
          <div className="project-references-dock-studio-draft" role="status">
            <div className="project-references-dock-studio-draft-copy">
              <strong>Studio draft ready</strong>
              <span title={studioDraft.path}>
                {projectStudioKindBadgeLabel(studioDraft.kind)}
                {studioDraft.title ? ` · ${studioDraft.title}` : ''}
              </span>
            </div>
            <div className="project-references-dock-studio-draft-actions">
              <button
                type="button"
                disabled={studioActing || !canSaveStudioViaApi}
                title={
                  canSaveStudioViaApi
                    ? 'Save this keepable into the Project library'
                    : PROJECT_STUDIO_IPC_UNAVAILABLE_TOOLTIP
                }
                onClick={saveStudioDraft}
              >
                Save to library
              </button>
              <button
                type="button"
                className="danger"
                disabled={studioActing}
                onClick={discardStudioDraft}
              >
                Discard
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {attention.actionable.length > 0 && (
        <div className="project-references-dock-attention" role="status">
          <span>
            Needs attention:{' '}
            {[
              attention.missing.length > 0 ? `${attention.missing.length} missing` : null,
              attention.unverified.length > 0 ? `${attention.unverified.length} unverified` : null
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              runAction(async () => {
                // Explicit, user-triggered, and sequential: one probe per
                // entry, never on browse. Failures stop the pass so the
                // first real error (e.g. credential loss) is surfaced.
                for (const reference of attention.actionable) {
                  await verifyProjectReference(reference.id)
                }
              })
            }
            aria-label={`Verify ${attention.actionable.length} references needing attention`}
          >
            Verify {attention.actionable.length}
          </button>
        </div>
      )}

      <div className="project-references-dock-list">
        <ProjectReferenceSuggestions
          proposals={proposals}
          loading={proposalsLoading}
          unsupported={proposalsUnsupported}
          error={proposalsError}
          actingProposalId={
            actingProposal?.projectId === projectId ? actingProposal.proposalId : null
          }
          onReview={reviewProposal}
        />
        {references.length === 0 ? (
          <div className="project-references-dock-empty">
            Drop files or folders, paste a path, URL, or GitHub repo, or use + File / + Folder / +
            Link / + GitHub.
          </div>
        ) : (
          references.map((reference) => {
            const presentation = projectReferencePresentation(reference)
            const extractable = isProjectReferenceExtractCandidate(reference)
            const extract = extractsByReferenceId[reference.id] ?? null
            const extractReady = extract?.status === 'ready'
            const extractBusy = extractActingReferenceId === reference.id
            const selected = selectedReferenceIds.has(reference.id)
            const studioKeepable = studioArtifactsByReferenceId.get(reference.id)
            return (
              <article
                key={reference.id}
                className={`project-references-dock-row${
                  reference.contextPolicy === 'off' ? ' is-off' : ''
                }`}
              >
                <div className={`project-references-dock-kind kind-${presentation.kind}`}>
                  {presentation.label}
                </div>
                <div className="project-references-dock-copy">
                  <strong>
                    {reference.title}
                    {extractReady ? (
                      <span className="project-references-dock-extract-badge">Extracted</span>
                    ) : null}
                    {studioKeepable ? (
                      <span className="project-references-dock-studio-badge">
                        {projectStudioKindBadgeLabel(studioKeepable.kind)}
                      </span>
                    ) : null}
                  </strong>
                  <span title={reference.locator}>{reference.locator}</span>
                </div>
                {reference.lastVerified && (
                  <span
                    className={`project-references-dock-status ${reference.lastVerified.status}`}
                    title={`${
                      reference.lastVerified.status === 'ok' ? 'Available' : 'Missing'
                    } when last verified`}
                    aria-label={
                      reference.lastVerified.status === 'ok'
                        ? 'Available when last verified'
                        : 'Missing when last verified'
                    }
                  />
                )}
                <div className="project-references-dock-actions">
                  <button
                    type="button"
                    disabled={busy || !canSelectForNextSend || reference.contextPolicy === 'off'}
                    aria-pressed={selected}
                    onClick={() =>
                      toggleProjectReferenceContextSelection(chatId, projectId, reference.id)
                    }
                    title={
                      selected && extractReady
                        ? 'Selected for next send (includes extract)'
                        : 'Attach this catalogue entry to the next send'
                    }
                  >
                    {selected ? (extractReady ? 'Selected · extract' : 'Selected') : 'Use next'}
                  </button>
                  {selected && extractReady ? (
                    <span className="project-references-dock-extract-chip">includes extract</span>
                  ) : null}
                  {reference.kind !== 'url' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => runAction(() => verifyProjectReference(reference.id))}
                      title="Verify reference"
                    >
                      Verify
                    </button>
                  )}
                  {extractable ? (
                    extractReady ? (
                      <>
                        <button
                          type="button"
                          disabled={busy || extractBusy || !canReadExtractViaApi}
                          onClick={() => viewExtract(reference)}
                          title={
                            canReadExtractViaApi
                              ? 'View the saved extract text'
                              : 'Extract is unavailable in this build'
                          }
                        >
                          View
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={busy || extractBusy || !canRevokeExtractViaApi}
                          onClick={() => revokeExtract(reference)}
                          title={
                            canRevokeExtractViaApi
                              ? 'Revoke the saved extract'
                              : 'Extract is unavailable in this build'
                          }
                        >
                          Revoke extract
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={busy || extractBusy || !canExtractViaApi}
                        onClick={() => requestExtract(reference)}
                        title={
                          canExtractViaApi
                            ? PROJECT_REFERENCE_EXTRACT_CONSENT_COPY
                            : 'Extract is unavailable in this build'
                        }
                      >
                        {extractBusy ? 'Extracting…' : 'Extract…'}
                      </button>
                    )
                  ) : null}
                  {(() => {
                    if (reference.kind !== 'file' || !onOpenInOffice || !resolveOfficeTarget) {
                      return null
                    }
                    const officeTarget = resolveOfficeTarget(reference.locator)
                    if (!officeTarget) return null
                    return (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onOpenInOffice(officeTarget)}
                        title={
                          officeTarget.external
                            ? 'Open in the Office editor (asks for access first)'
                            : 'Open in the Office editor'
                        }
                      >
                        {officeTarget.external ? 'Office…' : 'Office'}
                      </button>
                    )
                  })()}
                  <button
                    type="button"
                    disabled={busy}
                    aria-pressed={reference.contextPolicy === 'off'}
                    onClick={() =>
                      runAction(() =>
                        updateProjectReference(reference.id, {
                          contextPolicy: reference.contextPolicy === 'off' ? 'available' : 'off'
                        })
                      )
                    }
                  >
                    {reference.contextPolicy === 'off' ? 'Include' : 'Off'}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => runAction(() => removeProjectReference(reference.id))}
                  >
                    Remove
                  </button>
                </div>
              </article>
            )
          })
        )}
      </div>
      {viewerState ? (
        <div className="project-reference-source-viewer-shell">
          <ProjectReferenceSourceViewer
            title={viewerState.title}
            text={viewerState.text}
            pages={viewerState.pages}
            onClose={() => setViewerState(null)}
          />
        </div>
      ) : null}
    </section>
  )
}
