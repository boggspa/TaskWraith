import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceFileEntry } from '../../../../main/store/types'
import {
  OFFICE_FORMAT_KINDS,
  exportFormatsForKind,
  defaultDocumentNameForKind,
  officeFormatForPath,
  officeFormatLabel,
  officeKindLabel,
  replaceOfficeExtension,
  type OfficeDocumentReadResult,
  type OfficeFileFormat
} from '../../../../shared/office/officeFormats'
import {
  OFFICE_DOCUMENT_KINDS,
  createEmptyOfficeDocumentModel,
  type OfficeDocumentKind,
  type OfficeDocumentModel
} from '../../../../shared/office/officeModels'
import { wordHtmlToModel } from '../../../../shared/office/wordHtml'
import { PillButton } from '../PillButton'
import { CalendarEditorView } from './CalendarEditorView'
import { DeckEditorView } from './DeckEditorView'
import { MailEditorView } from './MailEditorView'
import { SheetEditorView } from './SheetEditorView'
import { WordEditorView } from './WordEditorView'

export interface OfficeOpenRequest {
  path: string
  nonce: number
  /**
   * Absolute path outside the bound workspace, opened through the chat's
   * external path grants. `path` carries the absolute locator in this mode.
   */
  external?: boolean
}

/** Marker the main process uses when no chat grant covers a path. */
export const OFFICE_GRANT_REQUIRED_MARKER = 'external-grant-required'

export const officeErrorIsGrantRequired = (message: string): boolean =>
  message.includes(OFFICE_GRANT_REQUIRED_MARKER)

/** Human copy for the grant-required state; never shows the raw marker. */
export const officeGrantRequiredCopy = (path: string): string =>
  `${path} sits outside this workspace. Grant this chat access to open it in Office.`

export interface OfficeRailEntry {
  path: string
  name: string
  format: OfficeFileFormat
  kind: OfficeDocumentKind
}

export interface OfficeSuitePanelProps {
  workspacePath?: string
  width?: number
  openRequest?: OfficeOpenRequest | null
  /** Chat whose external path grants authorize out-of-workspace documents. */
  chatId?: string | null
  /**
   * Opens the OS consent picker for an external path; resolves true when a
   * grant was minted. `access` defaults to read — write is only requested
   * when the user explicitly asks to edit the file in place.
   */
  onRequestExternalAccess?: (path: string, access?: 'read' | 'write') => Promise<boolean>
  /** Test seam: preloaded document state rendered without any IPC. */
  initialDocument?: OfficeDocumentReadResult | null
  /** Test seam: preloaded rail entries rendered without any IPC. */
  initialRailEntries?: OfficeRailEntry[]
  /** Test seam: renders the delete confirmation card open. */
  initialConfirmDelete?: boolean
  /** Test seam: renders the discard-unsaved-changes card open for this path. */
  initialPendingOpenPath?: string | null
  /** Test seam: treats the initial document as externally granted. */
  initialExternalPath?: string | null
  /** Test seam: the chat that authorized `initialExternalPath`. */
  initialExternalChatId?: string | null
  /** Test seam: preset error banner (e.g. the grant-required state). */
  initialError?: { message: string; staleEtag?: boolean; grantPath?: string } | null
}

const KIND_ORDER: OfficeDocumentKind[] = ['word', 'sheet', 'deck', 'calendar', 'mail']

const KIND_GROUP_LABELS: Record<OfficeDocumentKind, string> = {
  word: 'Documents',
  sheet: 'Spreadsheets',
  deck: 'Slide decks',
  calendar: 'Calendars',
  mail: 'Email'
}

export function officeRailEntriesFromFiles(files: WorkspaceFileEntry[]): OfficeRailEntry[] {
  const entries: OfficeRailEntry[] = []
  for (const file of files) {
    if (file.isDirectory) continue
    const format = officeFormatForPath(file.path)
    if (!format) continue
    entries.push({ path: file.path, name: file.name, format, kind: OFFICE_FORMAT_KINDS[format] })
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}

/** 'Untitled Document.docx' → 'Untitled Document 2.docx' until unused. */
export function dedupeOfficeFileName(baseName: string, taken: ReadonlySet<string>): string {
  if (!taken.has(baseName)) return baseName
  const dot = baseName.lastIndexOf('.')
  const stem = dot === -1 ? baseName : baseName.slice(0, dot)
  const extension = dot === -1 ? '' : baseName.slice(dot)
  for (let counter = 2; counter < 1000; counter += 1) {
    const candidate = `${stem} ${counter}${extension}`
    if (!taken.has(candidate)) return candidate
  }
  return `${stem} ${Date.now()}${extension}`
}

interface OfficeErrorState {
  message: string
  staleEtag: boolean
  /** Path awaiting an access grant; drives the consent affordance. */
  grantPath?: string
}

export function OfficeSuitePanel({
  workspacePath,
  width,
  openRequest,
  chatId,
  onRequestExternalAccess,
  initialDocument = null,
  initialRailEntries = [],
  initialConfirmDelete = false,
  initialPendingOpenPath = null,
  initialExternalPath = null,
  initialExternalChatId = null,
  initialError = null
}: OfficeSuitePanelProps) {
  const [railEntries, setRailEntries] = useState<OfficeRailEntry[]>(initialRailEntries)
  const [doc, setDoc] = useState<OfficeDocumentReadResult | null>(initialDocument)
  const [docRevision, setDocRevision] = useState(0)
  // Cheap dirty tracking: model editors flag on change; the Word surface
  // flags on input. Deliberately NOT a deep-compare — reverting an edit by
  // hand keeps the dirty dot until save, like every desktop editor.
  const [modelDirty, setModelDirty] = useState(false)
  const [wordDirty, setWordDirty] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(initialConfirmDelete)
  const [pendingOpenPath, setPendingOpenPath] = useState<string | null>(initialPendingOpenPath)
  const [status, setStatus] = useState(initialDocument ? initialDocument.path : '')
  const [error, setError] = useState<OfficeErrorState | null>(
    initialError ? { staleEtag: false, ...initialError } : null
  )
  /** Absolute path when the open document lives outside the workspace. */
  const [externalPath, setExternalPath] = useState<string | null>(initialExternalPath)
  /**
   * Chat whose grants authorized the open external document. Grants are
   * per-chat, so switching chats must not silently re-bind the document to a
   * chat that never consented to it.
   */
  const [externalChatId, setExternalChatId] = useState<string | null>(
    initialExternalPath ? (initialExternalChatId ?? chatId ?? null) : null
  )
  const [warnings, setWarnings] = useState<string[]>(initialDocument?.warnings ?? [])
  const [isBusy, setIsBusy] = useState(false)
  const wordHtmlRef = useRef<string | null>(null)
  const lastOpenNonceRef = useRef<number | null>(null)
  // Identity of the document the panel currently shows. Async completions
  // (a save resolving after the user opened another file) compare against it
  // and drop their state updates instead of clobbering the newer document.
  const activeDocPathRef = useRef<string | null>(initialDocument?.path ?? null)
  const pendingOpenExternalRef = useRef(false)

  const dirty = doc ? (doc.kind === 'word' ? wordDirty : modelDirty) : false

  const refreshRail = useCallback(async () => {
    if (!workspacePath) return
    try {
      const files = await window.api.listWorkspaceFiles(workspacePath)
      setRailEntries(officeRailEntriesFromFiles(files))
    } catch {
      // Rail refresh is best-effort; the editor keeps working without it.
    }
  }, [workspacePath])

  const loadDocument = useCallback(
    async (path: string, options: { external?: boolean } = {}) => {
      const external = options.external === true
      if (!workspacePath && !external) return
      if (external && !chatId) {
        setError({
          message: 'Open a chat in this workspace before opening external documents.',
          staleEtag: false
        })
        return
      }
      setIsBusy(true)
      setError(null)
      setStatus(`Opening ${path}…`)
      // Restored on failure: a grant-required rejection is the ROUTINE first
      // outcome of an external open, and leaving the ref pointing at a
      // document that never loaded makes the next successful save drop its
      // own state update as "stale".
      const previousActivePath = activeDocPathRef.current
      activeDocPathRef.current = path
      try {
        const result = external
          ? await window.api.readExternalOfficeDocument(chatId as string, path)
          : await window.api.readOfficeDocument(workspacePath as string, path)
        if (activeDocPathRef.current !== path) return
        activeDocPathRef.current = result.path
        setDoc(result)
        setExternalPath(external ? result.path : null)
        setExternalChatId(external ? (chatId ?? null) : null)
        setModelDirty(false)
        setWarnings(result.warnings)
        setWordDirty(false)
        wordHtmlRef.current = null
        setDocRevision((revision) => revision + 1)
        setStatus(result.path)
      } catch (loadError) {
        if (activeDocPathRef.current === path) activeDocPathRef.current = previousActivePath
        const message = loadError instanceof Error ? loadError.message : `Could not open ${path}`
        setError(
          officeErrorIsGrantRequired(message)
            ? { message: officeGrantRequiredCopy(path), staleEtag: false, grantPath: path }
            : { message, staleEtag: false }
        )
        setStatus('')
      } finally {
        setIsBusy(false)
      }
    },
    [chatId, workspacePath]
  )

  /**
   * Runs the OS consent picker, then reopens the document. Routed through
   * `requestOpenDocument` so unsaved edits get the discard confirmation
   * first — the grant-revoked-mid-edit banner offers this button, and a bare
   * reload there would throw away exactly the work the user is trying to
   * rescue.
   */
  const requestAccessAndOpen = useCallback(
    async (path: string, access: 'read' | 'write' = 'read') => {
      if (!onRequestExternalAccess) return
      setIsBusy(true)
      try {
        const granted = await onRequestExternalAccess(path, access)
        if (!granted) return
        setError(null)
        requestOpenDocumentRef.current(path, { external: true })
      } finally {
        setIsBusy(false)
      }
    },
    [onRequestExternalAccess]
  )

  useEffect(() => {
    void refreshRail()
  }, [refreshRail])

  /**
   * Single entry point for opening a document: unsaved edits always get a
   * confirmation card first — the panel holds one document, so a bare load
   * would discard work with no undo.
   */
  const requestOpenDocument = useCallback(
    (path: string, options: { external?: boolean } = {}) => {
      // Reopening the SAME path with unsaved edits still confirms: the only
      // reason to do that is discarding in favour of what is on disk.
      if (doc && dirty) {
        setPendingOpenPath(path)
        pendingOpenExternalRef.current = options.external === true
        return
      }
      void loadDocument(path, options)
    },
    [dirty, doc, loadDocument]
  )
  // Consent flow calls back into the opener; a ref keeps that edge out of
  // the callback dependency cycle.
  const requestOpenDocumentRef = useRef(requestOpenDocument)
  requestOpenDocumentRef.current = requestOpenDocument

  useEffect(() => {
    if (!openRequest || openRequest.nonce === lastOpenNonceRef.current) return
    lastOpenNonceRef.current = openRequest.nonce
    const { path, external } = openRequest
    queueMicrotask(() => {
      requestOpenDocument(path, { external })
    })
  }, [openRequest, requestOpenDocument])

  const currentModelForSave = useCallback((): OfficeDocumentModel | null => {
    if (!doc) return null
    if (doc.kind === 'word' && wordDirty && wordHtmlRef.current !== null) {
      return wordHtmlToModel(wordHtmlRef.current)
    }
    return doc.model
  }, [doc, wordDirty])

  /**
   * The document was opened under a different chat's grants. Saving would
   * be authorized against a chat that never consented, so main would refuse
   * — surface it as its own state rather than a misleading "revoked".
   */
  const externalChatMismatch =
    externalPath !== null && externalChatId !== null && chatId !== externalChatId
  const readOnlyExternal =
    externalPath !== null && (doc?.externalAccess !== 'write' || externalChatMismatch)

  const save = useCallback(async () => {
    if (!doc) return
    if (externalPath ? !chatId || readOnlyExternal : !workspacePath) return
    const model = currentModelForSave()
    if (!model) return
    setIsBusy(true)
    setError(null)
    const pathAtSave = doc.path
    try {
      const result = externalPath
        ? await window.api.writeExternalOfficeDocument(
            chatId as string,
            externalPath,
            model,
            doc.etag
          )
        : await window.api.writeOfficeDocument(workspacePath as string, doc.path, model, doc.etag)
      void refreshRail()
      // The user may have opened another document while the save ran; the
      // write itself succeeded, but its state must not replace the new doc.
      if (activeDocPathRef.current !== pathAtSave) return
      setDoc(result)
      setModelDirty(false)
      setWarnings(result.warnings)
      setWordDirty(false)
      setStatus(`Saved ${result.path}`)
    } catch (saveError) {
      if (activeDocPathRef.current !== pathAtSave) return
      const message = saveError instanceof Error ? saveError.message : 'Save failed'
      if (officeErrorIsGrantRequired(message)) {
        setError({
          message: `Access to ${pathAtSave} was revoked. Re-grant it or export a copy into the workspace.`,
          staleEtag: false,
          grantPath: pathAtSave
        })
        return
      }
      setError({ message, staleEtag: /changed on disk|no longer exists/i.test(message) })
    } finally {
      setIsBusy(false)
    }
  }, [chatId, currentModelForSave, doc, externalPath, readOnlyExternal, refreshRail, workspacePath])

  /**
   * Export ALWAYS writes into the bound workspace — for external documents
   * that makes it the "save a copy I can keep editing" escape hatch, which
   * is also the only way to persist edits to a read-only granted file.
   */
  const exportAs = useCallback(
    async (format: OfficeFileFormat) => {
      if (!workspacePath || !doc) return
      const model = currentModelForSave()
      if (!model) return
      const takenNames = new Set(railEntries.map((entry) => entry.path))
      // External docs carry an absolute path; land the copy at the workspace
      // root under the file's own name rather than mirroring the absolute
      // directory structure.
      const sourcePath = externalPath ? (externalPath.split(/[\\/]/).pop() ?? 'Document') : doc.path
      let targetPath = replaceOfficeExtension(sourcePath, format)
      if (targetPath === doc.path || takenNames.has(targetPath)) {
        const slash = targetPath.lastIndexOf('/')
        const directory = slash === -1 ? '' : targetPath.slice(0, slash + 1)
        const baseName = slash === -1 ? targetPath : targetPath.slice(slash + 1)
        const taken = new Set(
          railEntries
            .filter((entry) => entry.path.startsWith(directory))
            .map((entry) => entry.path.slice(directory.length))
        )
        if (targetPath === doc.path) taken.add(baseName)
        targetPath = `${directory}${dedupeOfficeFileName(baseName, taken)}`
      }
      setIsBusy(true)
      setError(null)
      try {
        const result = await window.api.writeOfficeDocument(workspacePath, targetPath, model, null)
        setStatus(`Exported ${result.path}`)
        if (result.warnings.length > 0) setWarnings(result.warnings)
        void refreshRail()
      } catch (exportError) {
        setError({
          message: exportError instanceof Error ? exportError.message : 'Export failed',
          staleEtag: false
        })
      } finally {
        setIsBusy(false)
      }
    },
    [currentModelForSave, doc, externalPath, railEntries, refreshRail, workspacePath]
  )

  const createDocument = useCallback(
    async (kind: OfficeDocumentKind) => {
      if (!workspacePath) return
      const taken = new Set(
        railEntries.filter((entry) => !entry.path.includes('/')).map((entry) => entry.path)
      )
      const name = dedupeOfficeFileName(defaultDocumentNameForKind(kind), taken)
      setIsBusy(true)
      setError(null)
      try {
        const result = await window.api.writeOfficeDocument(
          workspacePath,
          name,
          createEmptyOfficeDocumentModel(kind),
          null
        )
        activeDocPathRef.current = result.path
        setExternalPath(null)
        setExternalChatId(null)
        setDoc(result)
        setModelDirty(false)
        setWarnings(result.warnings)
        setWordDirty(false)
        wordHtmlRef.current = null
        setDocRevision((revision) => revision + 1)
        setStatus(`Created ${result.path}`)
        void refreshRail()
      } catch (createError) {
        setError({
          message: createError instanceof Error ? createError.message : 'Could not create file',
          staleEtag: false
        })
      } finally {
        setIsBusy(false)
      }
    },
    [railEntries, refreshRail, workspacePath]
  )

  const updateModel = useCallback((next: OfficeDocumentModel) => {
    setDoc((current) => (current ? { ...current, model: next } : current))
    setModelDirty(true)
  }, [])

  const deleteCurrentDocument = useCallback(async () => {
    if (!workspacePath || !doc) return
    setIsBusy(true)
    setError(null)
    try {
      await window.api.deleteOfficeDocument(workspacePath, doc.path, doc.etag)
      activeDocPathRef.current = null
      setExternalPath(null)
      setExternalChatId(null)
      setStatus(`Deleted ${doc.path}`)
      setDoc(null)
      setModelDirty(false)
      setWordDirty(false)
      setWarnings([])
      wordHtmlRef.current = null
      void refreshRail()
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : 'Delete failed'
      setError({ message, staleEtag: /changed on disk|no longer exists/i.test(message) })
    } finally {
      setIsBusy(false)
      setConfirmingDelete(false)
    }
  }, [doc, refreshRail, workspacePath])

  const groupedRail = useMemo(() => {
    const groups = new Map<OfficeDocumentKind, OfficeRailEntry[]>()
    for (const entry of railEntries) {
      const bucket = groups.get(entry.kind)
      if (bucket) bucket.push(entry)
      else groups.set(entry.kind, [entry])
    }
    return groups
  }, [railEntries])

  const docKey = doc ? `${doc.path}#${docRevision}` : 'none'

  // A workspace is required for the rail, New and Export; an externally
  // granted document can still be open without one.
  if (!workspacePath && !doc) {
    return (
      <aside className="office-suite office-suite-empty-shell">
        <p className="office-muted">Office needs a bound workspace.</p>
      </aside>
    )
  }

  return (
    <aside className="office-suite" style={width ? { width } : undefined}>
      <nav className="office-rail" aria-label="Office documents">
        <div className="office-rail-header">
          <span className="office-rail-eyebrow">Office</span>
          <label className="office-new-picker">
            <span className="office-visually-hidden">Create new</span>
            <select
              value=""
              disabled={isBusy}
              aria-label="Create a new office document"
              onChange={(event) => {
                const kind = event.target.value as OfficeDocumentKind | ''
                if (kind) void createDocument(kind)
              }}
            >
              <option value="" disabled>
                + New…
              </option>
              {OFFICE_DOCUMENT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {officeKindLabel(kind)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="office-rail-list">
          {KIND_ORDER.map((kind) => {
            const entries = groupedRail.get(kind)
            if (!entries || entries.length === 0) return null
            return (
              <div key={kind} className="office-rail-group">
                <span className="office-rail-group-label">{KIND_GROUP_LABELS[kind]}</span>
                {entries.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    className={`office-rail-item${doc?.path === entry.path ? ' is-active' : ''}`}
                    title={entry.path}
                    onClick={() => requestOpenDocument(entry.path)}
                  >
                    <span className="office-rail-item-name">{entry.name}</span>
                    <span className="office-rail-item-format">.{entry.format}</span>
                  </button>
                ))}
              </div>
            )
          })}
          {railEntries.length === 0 ? (
            <p className="office-muted office-rail-empty">
              No office files in this workspace yet. Create one with “+ New…”, or drop
              .docx/.xlsx/.pptx/.ics/.eml files into the workspace.
            </p>
          ) : null}
        </div>
      </nav>

      <section className="office-editor-column">
        {doc ? (
          <header className="office-editor-header">
            <div className="office-editor-title">
              <span className="office-editor-kind">{officeKindLabel(doc.kind)}</span>
              <h3 title={doc.path}>{doc.path.split('/').pop()}</h3>
              {externalPath ? (
                <span
                  className="office-editor-external"
                  title={`Outside this workspace — opened through a chat access grant (${
                    readOnlyExternal ? 'read-only' : 'read + write'
                  })`}
                >
                  {readOnlyExternal ? 'External · read-only' : 'External'}
                </span>
              ) : null}
              {dirty ? <span className="office-dirty-dot" title="Unsaved changes" /> : null}
            </div>
            <div className="office-editor-actions">
              <button
                type="button"
                className="office-toolbar-button office-save-button"
                disabled={!dirty || isBusy || readOnlyExternal}
                title={
                  readOnlyExternal
                    ? 'This chat has read-only access — use Export to save a copy in the workspace'
                    : undefined
                }
                onClick={() => void save()}
              >
                Save
              </button>
              <select
                className="office-toolbar-select"
                value=""
                disabled={isBusy}
                aria-label="Export document as"
                onChange={(event) => {
                  const format = event.target.value as OfficeFileFormat | ''
                  if (format) void exportAs(format)
                }}
              >
                <option value="" disabled>
                  Export…
                </option>
                {exportFormatsForKind(doc.kind).map((format) => (
                  <option key={format} value={format}>
                    {officeFormatLabel(format)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="office-toolbar-button"
                disabled={isBusy}
                title="Reload from disk (discards unsaved changes)"
                onClick={() => requestOpenDocument(doc.path, { external: externalPath !== null })}
              >
                Reload
              </button>
              {externalPath ? null : (
                <button
                  type="button"
                  className="office-toolbar-button office-danger"
                  disabled={isBusy}
                  title="Delete this document from the workspace"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete
                </button>
              )}
            </div>
          </header>
        ) : null}

        {pendingOpenPath && doc ? (
          <div className="office-modal-backdrop">
            <div
              className="office-confirm-card"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="office-discard-title"
              aria-describedby="office-discard-body"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setPendingOpenPath(null)
                }
              }}
            >
              <strong id="office-discard-title">Discard unsaved changes?</strong>
              <span id="office-discard-body">
                {doc.path} has unsaved edits. Opening {pendingOpenPath} discards them.
              </span>
              <div className="office-confirm-actions">
                <PillButton
                  variant="danger"
                  size="compact"
                  onClick={() => {
                    const target = pendingOpenPath
                    const external = pendingOpenExternalRef.current
                    setPendingOpenPath(null)
                    pendingOpenExternalRef.current = false
                    void loadDocument(target, { external })
                  }}
                >
                  Discard &amp; open
                </PillButton>
                <PillButton size="compact" onClick={() => setPendingOpenPath(null)} autoFocus>
                  Keep editing
                </PillButton>
              </div>
            </div>
          </div>
        ) : null}

        {confirmingDelete && doc ? (
          <div className="office-modal-backdrop">
            <div
              className="office-confirm-card"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="office-delete-title"
              aria-describedby="office-delete-body"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setConfirmingDelete(false)
                }
              }}
            >
              <strong id="office-delete-title">Delete document?</strong>
              <span id="office-delete-body">{doc.path} will be removed from this workspace.</span>
              <div className="office-confirm-actions">
                <PillButton
                  variant="danger"
                  size="compact"
                  onClick={() => void deleteCurrentDocument()}
                >
                  Delete
                </PillButton>
                <PillButton size="compact" onClick={() => setConfirmingDelete(false)} autoFocus>
                  Cancel
                </PillButton>
              </div>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="office-banner office-banner-error" role="alert">
            <span>{error.message}</span>
            {error.staleEtag && doc ? (
              <button
                type="button"
                onClick={() => void loadDocument(doc.path, { external: externalPath !== null })}
              >
                Reload from disk
              </button>
            ) : null}
            {error.grantPath && onRequestExternalAccess ? (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void requestAccessAndOpen(error.grantPath as string)}
              >
                Grant access…
              </button>
            ) : null}
          </div>
        ) : null}
        {externalChatMismatch && doc ? (
          <div className="office-banner office-banner-warning">
            <span>
              {doc.path} was opened from another chat. Access grants are per-chat — reopen it here,
              or use Export to save a copy into the workspace.
            </span>
          </div>
        ) : readOnlyExternal && doc ? (
          <div className="office-banner office-banner-warning">
            <span>
              Read-only: this chat can open {doc.path} but not write to it. Export saves an editable
              copy into the workspace.
            </span>
            {onRequestExternalAccess ? (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => void requestAccessAndOpen(doc.path, 'write')}
              >
                Request write access…
              </button>
            ) : null}
          </div>
        ) : null}
        {warnings.length > 0 ? (
          <div className="office-banner office-banner-warning">
            {warnings.map((warning, index) => (
              <span key={index}>{warning}</span>
            ))}
          </div>
        ) : null}

        <div className="office-editor-body">
          {!doc ? (
            <div className="office-empty-state">
              <h3>Word, sheets, decks, calendar &amp; mail</h3>
              <p className="office-muted">
                Pick a document from the rail, create one with “+ New…”, or open a
                .docx/.xlsx/.pptx/.ics/.eml file from the Files tree — it routes here. Everything
                saves as Microsoft- and Google-importable formats.
              </p>
            </div>
          ) : doc.kind === 'word' && doc.model.kind === 'word' ? (
            <WordEditorView
              model={doc.model}
              docKey={docKey}
              onHtmlChange={(html) => {
                wordHtmlRef.current = html
                setWordDirty(true)
              }}
            />
          ) : doc.kind === 'sheet' && doc.model.kind === 'sheet' ? (
            <SheetEditorView model={doc.model} onChange={updateModel} />
          ) : doc.kind === 'deck' && doc.model.kind === 'deck' ? (
            <DeckEditorView model={doc.model} onChange={updateModel} />
          ) : doc.kind === 'calendar' && doc.model.kind === 'calendar' ? (
            <CalendarEditorView model={doc.model} onChange={updateModel} />
          ) : doc.kind === 'mail' && doc.model.kind === 'mail' ? (
            <MailEditorView model={doc.model} onChange={updateModel} />
          ) : null}
        </div>

        <footer className="office-statusbar">
          <span className="office-status-text">{isBusy ? 'Working…' : status}</span>
          {doc ? <span className="office-status-format">.{doc.format}</span> : null}
        </footer>
      </section>
    </aside>
  )
}
