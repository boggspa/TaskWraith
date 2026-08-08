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

import { normalizeGitHubReferenceInput } from '../../../shared/projects'
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

interface ProjectReferencesDockPanelProps {
  projectId: string
  chatId?: string | null
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
  contextSelectionEnabled = true,
  onClose,
  showCloseButton = true,
  resolveOfficeTarget,
  onOpenInOffice
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

  useEffect(() => {
    const refresh = (): void =>
      setReferenceState({ projectId, references: listProjectReferences(projectId) })
    refresh()
    return subscribeProjects(refresh)
  }, [projectId])

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
          <span>{selectedReferenceIds.size} selected for the next send</span>
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
                  <strong>{reference.title}</strong>
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
                    aria-pressed={selectedReferenceIds.has(reference.id)}
                    onClick={() =>
                      toggleProjectReferenceContextSelection(chatId, projectId, reference.id)
                    }
                    title="Attach this catalogue entry to the next send"
                  >
                    {selectedReferenceIds.has(reference.id) ? 'Selected' : 'Use next'}
                  </button>
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
    </section>
  )
}
