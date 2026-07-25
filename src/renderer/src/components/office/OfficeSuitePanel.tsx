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
import { CalendarEditorView } from './CalendarEditorView'
import { DeckEditorView } from './DeckEditorView'
import { MailEditorView } from './MailEditorView'
import { SheetEditorView } from './SheetEditorView'
import { WordEditorView } from './WordEditorView'

export interface OfficeOpenRequest {
  path: string
  nonce: number
}

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
  /** Test seam: preloaded document state rendered without any IPC. */
  initialDocument?: OfficeDocumentReadResult | null
  /** Test seam: preloaded rail entries rendered without any IPC. */
  initialRailEntries?: OfficeRailEntry[]
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
}

export function OfficeSuitePanel({
  workspacePath,
  width,
  openRequest,
  initialDocument = null,
  initialRailEntries = []
}: OfficeSuitePanelProps) {
  const [railEntries, setRailEntries] = useState<OfficeRailEntry[]>(initialRailEntries)
  const [doc, setDoc] = useState<OfficeDocumentReadResult | null>(initialDocument)
  const [docRevision, setDocRevision] = useState(0)
  // Cheap dirty tracking: model editors flag on change; the Word surface
  // flags on input. Deliberately NOT a deep-compare — reverting an edit by
  // hand keeps the dirty dot until save, like every desktop editor.
  const [modelDirty, setModelDirty] = useState(false)
  const [wordDirty, setWordDirty] = useState(false)
  const [status, setStatus] = useState(initialDocument ? initialDocument.path : '')
  const [error, setError] = useState<OfficeErrorState | null>(null)
  const [warnings, setWarnings] = useState<string[]>(initialDocument?.warnings ?? [])
  const [isBusy, setIsBusy] = useState(false)
  const wordHtmlRef = useRef<string | null>(null)
  const lastOpenNonceRef = useRef<number | null>(null)

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
    async (path: string) => {
      if (!workspacePath) return
      setIsBusy(true)
      setError(null)
      setStatus(`Opening ${path}…`)
      try {
        const result = await window.api.readOfficeDocument(workspacePath, path)
        setDoc(result)
        setModelDirty(false)
        setWarnings(result.warnings)
        setWordDirty(false)
        wordHtmlRef.current = null
        setDocRevision((revision) => revision + 1)
        setStatus(result.path)
      } catch (loadError) {
        setError({
          message: loadError instanceof Error ? loadError.message : `Could not open ${path}`,
          staleEtag: false
        })
        setStatus('')
      } finally {
        setIsBusy(false)
      }
    },
    [workspacePath]
  )

  useEffect(() => {
    void refreshRail()
  }, [refreshRail])

  useEffect(() => {
    if (!openRequest || openRequest.nonce === lastOpenNonceRef.current) return
    lastOpenNonceRef.current = openRequest.nonce
    queueMicrotask(() => {
      void loadDocument(openRequest.path)
    })
  }, [loadDocument, openRequest])

  const currentModelForSave = useCallback((): OfficeDocumentModel | null => {
    if (!doc) return null
    if (doc.kind === 'word' && wordDirty && wordHtmlRef.current !== null) {
      return wordHtmlToModel(wordHtmlRef.current)
    }
    return doc.model
  }, [doc, wordDirty])

  const save = useCallback(async () => {
    if (!workspacePath || !doc) return
    const model = currentModelForSave()
    if (!model) return
    setIsBusy(true)
    setError(null)
    try {
      const result = await window.api.writeOfficeDocument(workspacePath, doc.path, model, doc.etag)
      setDoc(result)
      setModelDirty(false)
      setWarnings(result.warnings)
      setWordDirty(false)
      setStatus(`Saved ${result.path}`)
      void refreshRail()
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : 'Save failed'
      setError({ message, staleEtag: /changed on disk|no longer exists/i.test(message) })
    } finally {
      setIsBusy(false)
    }
  }, [currentModelForSave, doc, refreshRail, workspacePath])

  const exportAs = useCallback(
    async (format: OfficeFileFormat) => {
      if (!workspacePath || !doc) return
      const model = currentModelForSave()
      if (!model) return
      const takenNames = new Set(railEntries.map((entry) => entry.path))
      let targetPath = replaceOfficeExtension(doc.path, format)
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
    [currentModelForSave, doc, railEntries, refreshRail, workspacePath]
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

  if (!workspacePath) {
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
                    onClick={() => void loadDocument(entry.path)}
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
              {dirty ? <span className="office-dirty-dot" title="Unsaved changes" /> : null}
            </div>
            <div className="office-editor-actions">
              <button
                type="button"
                className="office-toolbar-button office-save-button"
                disabled={!dirty || isBusy}
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
                onClick={() => void loadDocument(doc.path)}
              >
                Reload
              </button>
            </div>
          </header>
        ) : null}

        {error ? (
          <div className="office-banner office-banner-error" role="alert">
            <span>{error.message}</span>
            {error.staleEtag && doc ? (
              <button type="button" onClick={() => void loadDocument(doc.path)}>
                Reload from disk
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
