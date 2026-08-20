import { useCallback, useEffect, useState } from 'react'
import {
  ARCHIVED_CHAT_EXPORT_FORMATS,
  type ArchivedChatExportFormat
} from '../../../shared/archivedChatExport'
import {
  EXTERNAL_PROVIDER_THREAD_IMPORT_PROVIDERS,
  externalProviderThreadImportLabel,
  type ExternalProviderThreadImportProvider
} from '../../../shared/externalProviderThreadImport'
import './ArchivedThreadsSettings.css'

interface ArchivedThreadSummary {
  appChatId: string
  title: string
  scope?: string
  chatKind?: string
  parentChatRelation?: string
  archived: boolean
  updatedAt: number
  messageCount: number
  externalProviderThreadImport?: {
    provider: ExternalProviderThreadImportProvider
    truncated: boolean
  }
}

function displayDate(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return 'Unknown date'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(timestamp))
}

function chatKindLabel(chat: ArchivedThreadSummary): string {
  if (chat.externalProviderThreadImport) {
    return `Imported ${externalProviderThreadImportLabel(chat.externalProviderThreadImport.provider)}`
  }
  if (chat.parentChatRelation === 'sideChat') return 'Side chat'
  if (chat.parentChatRelation === 'subThread') return 'Sub-thread'
  if (chat.chatKind === 'ensemble') return 'Ensemble'
  return chat.scope === 'global' ? 'Global' : 'Workspace'
}

export function ArchivedThreadsSettings(): React.JSX.Element {
  const [archivedChats, setArchivedChats] = useState<ArchivedThreadSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busyChatId, setBusyChatId] = useState<string | null>(null)
  const [importProvider, setImportProvider] =
    useState<ExternalProviderThreadImportProvider>('codex')
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadArchivedChats = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const chats = await window.api.getChatList()
      setArchivedChats(
        chats
          .filter((chat) => chat.archived)
          .sort((left, right) => right.updatedAt - left.updatedAt)
      )
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load archived threads.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadArchivedChats()
  }, [loadArchivedChats])

  const handleUnarchive = async (chat: ArchivedThreadSummary): Promise<void> => {
    setBusyChatId(chat.appChatId)
    setError('')
    setNotice('')
    try {
      const result = await window.api.unarchiveChat(chat.appChatId)
      if (!result.ok) {
        throw new Error(
          result.reason === 'not-found'
            ? 'That thread no longer exists.'
            : 'That thread is already active.'
        )
      }
      setArchivedChats((current) =>
        current.filter((candidate) => candidate.appChatId !== chat.appChatId)
      )
      setNotice(`Unarchived “${chat.title || 'Untitled thread'}”.`)
    } catch (unarchiveError) {
      setError(
        unarchiveError instanceof Error ? unarchiveError.message : 'Could not unarchive thread.'
      )
    } finally {
      setBusyChatId(null)
    }
  }

  const handleDelete = async (chat: ArchivedThreadSummary): Promise<void> => {
    if (
      !window.confirm(
        `Delete “${chat.title || 'Untitled thread'}” permanently? This can't be undone.`
      )
    ) {
      return
    }
    setBusyChatId(chat.appChatId)
    setError('')
    setNotice('')
    try {
      await window.api.deleteChat(chat.appChatId)
      setArchivedChats((current) =>
        current.filter((candidate) => candidate.appChatId !== chat.appChatId)
      )
      setNotice(`Deleted “${chat.title || 'Untitled thread'}”.`)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete thread.')
    } finally {
      setBusyChatId(null)
    }
  }

  const handleExport = async (
    chat: ArchivedThreadSummary,
    format: ArchivedChatExportFormat
  ): Promise<void> => {
    setBusyChatId(chat.appChatId)
    setError('')
    setNotice('')
    try {
      const result = await window.api.exportArchivedChat({ chatId: chat.appChatId, format })
      if (!result.ok) {
        throw new Error(result.error || 'Could not export thread.')
      }
      if (!result.canceled && result.path) {
        setNotice(`Exported to ${result.path}`)
      }
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Could not export thread.')
    } finally {
      setBusyChatId(null)
    }
  }

  const handleExternalImport = async (): Promise<void> => {
    setImporting(true)
    setError('')
    setNotice('')
    try {
      const result = await window.api.importExternalProviderThread({ provider: importProvider })
      if (!result.ok) throw new Error(result.error)
      if (result.canceled) return
      await loadArchivedChats()
      const suffix = result.truncated ? ' The bounded importer truncated the source.' : ''
      setNotice(
        result.duplicate
          ? `That ${externalProviderThreadImportLabel(importProvider)} transcript is already imported.`
          : `Imported ${result.importedMessageCount} messages into “${result.chat.title}”.${suffix}`
      )
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Could not import thread.')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="archived-threads-settings">
      <div className="settings-group archived-threads-intro">
        <span className="settings-label">Archived threads</span>
        <p className="settings-hint">
          Archived threads stay on this device with their full transcript and run history. They are
          hidden from the main sidebar until you unarchive them.
        </p>
        <button
          type="button"
          className="archived-threads-refresh"
          onClick={() => void loadArchivedChats()}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="settings-group archived-threads-import">
        <span className="settings-label">Import an external provider thread</span>
        <p className="settings-hint">
          Choose one local Codex, Claude, Cursor, or AntiGravity transcript file. TaskWraith never
          scans provider folders automatically. Imports are archived, untrusted, excluded from
          future provider prompts, and cannot resume the native provider session. Local chat history
          must be enabled.
        </p>
        <div className="archived-threads-import-controls">
          <select
            value={importProvider}
            onChange={(event) =>
              setImportProvider(event.target.value as ExternalProviderThreadImportProvider)
            }
            disabled={importing}
            aria-label="External transcript provider"
          >
            {EXTERNAL_PROVIDER_THREAD_IMPORT_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {externalProviderThreadImportLabel(provider)}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void handleExternalImport()} disabled={importing}>
            {importing ? 'Opening picker…' : 'Choose transcript file…'}
          </button>
        </div>
      </div>

      {error && <p className="settings-error archived-threads-feedback">{error}</p>}
      {notice && <p className="archived-threads-feedback archived-threads-notice">{notice}</p>}

      {!loading && archivedChats.length === 0 ? (
        <div className="settings-group archived-threads-empty">
          <span className="settings-label">Nothing archived</span>
          <p className="settings-hint">Threads you archive will appear here.</p>
        </div>
      ) : (
        <div className="archived-threads-list" aria-label="Archived threads">
          {archivedChats.map((chat) => {
            const busy = busyChatId === chat.appChatId
            return (
              <article className="archived-thread-row" key={chat.appChatId}>
                <div className="archived-thread-copy">
                  <h2>{chat.title || 'Untitled thread'}</h2>
                  <p>
                    {chatKindLabel(chat)} · {chat.messageCount} message
                    {chat.messageCount === 1 ? '' : 's'} · Updated {displayDate(chat.updatedAt)}
                  </p>
                </div>
                <div className="archived-thread-actions">
                  <button
                    type="button"
                    className="archived-thread-action"
                    onClick={() => void handleUnarchive(chat)}
                    disabled={busy}
                  >
                    {busy ? 'Working…' : 'Unarchive'}
                  </button>
                  <select
                    className="archived-thread-export"
                    aria-label={`Export ${chat.title || 'untitled thread'}`}
                    value=""
                    onChange={(event) => {
                      const format = event.target.value as ArchivedChatExportFormat
                      if (format) void handleExport(chat, format)
                    }}
                    disabled={busy}
                  >
                    <option value="">Export…</option>
                    {ARCHIVED_CHAT_EXPORT_FORMATS.map((entry) => (
                      <option key={entry.format} value={entry.format}>
                        {entry.label} (.{entry.extension})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="archived-thread-action archived-thread-delete"
                    onClick={() => void handleDelete(chat)}
                    disabled={busy}
                  >
                    Delete permanently
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
