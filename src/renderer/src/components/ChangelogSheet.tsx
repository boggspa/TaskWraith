import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import bundledChangelog from '../../../../CHANGELOG.md?raw'
import type {
  ProductChangelogSnapshot,
  ProductUpdateChangelog,
  ProductUpdateReleaseNotes
} from '../../../main/store/types'
import type { UpdateStateSnapshot } from '../../../main/UpdateService'

interface ChangelogSheetProps {
  open: boolean
  onDismiss: () => void
  changelogSnapshot: ProductChangelogSnapshot | null
  updateSnapshot: UpdateStateSnapshot | null
  busy?: boolean
  onCheckForUpdates?: () => Promise<unknown> | unknown
  onDownloadUpdate?: () => Promise<unknown> | unknown
  onInstallUpdateNow?: () => Promise<unknown> | unknown
}

const SHEET_TITLE_ID = 'changelog-sheet-title'

export function ChangelogSheet({
  open,
  onDismiss,
  changelogSnapshot,
  updateSnapshot,
  busy = false,
  onCheckForUpdates,
  onDownloadUpdate,
  onInstallUpdateNow
}: ChangelogSheetProps): React.JSX.Element | null {
  const dismissRef = useRef(onDismiss)
  useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        dismissRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  const entry = useMemo(
    () => resolveChangelogEntry(changelogSnapshot, updateSnapshot),
    [changelogSnapshot, updateSnapshot]
  )
  const releaseNotes = formatReleaseNotes(entry.releaseNotes)
  const displayNotes = releaseNotes || bundledChangelog.trim() || 'No changelog is available yet.'
  const notesSource = releaseNotes ? 'Release notes' : 'Bundled changelog'
  const releasePageUrl = updateSnapshot?.releasePageUrl
  const updateStatus = updateSnapshot?.status || 'idle'
  const canAct = !busy && updateStatus !== 'checking' && updateStatus !== 'downloading'
  // Phase-by-phase signpost for the update flow (check → download → ready →
  // installs on restart), so the user is guided through it rather than guessing
  // what each button does.
  const downloadPercent = Math.round(updateSnapshot?.downloadProgress?.percent ?? 0)
  const statusCaption =
    updateStatus === 'checking'
      ? 'Checking for updates…'
      : updateStatus === 'available'
        ? `Update ${entry.version} available — download to continue.`
        : updateStatus === 'downloading'
          ? `Downloading update… ${downloadPercent}%`
          : updateStatus === 'downloaded'
            ? `Update ${entry.version} downloaded — it installs when you restart.`
            : updateStatus === 'not-available'
              ? "You're on the latest version."
              : null

  const handleInstall = useCallback(() => {
    if (!onInstallUpdateNow) return
    if (!confirm('Install update and restart TaskWraith now?')) return
    void onInstallUpdateNow()
  }, [onInstallUpdateNow])

  const handleOpenRelease = useCallback(() => {
    if (!releasePageUrl || typeof window.api.openExternalOrPath !== 'function') return
    void window.api.openExternalOrPath(releasePageUrl)
  }, [releasePageUrl])

  if (!open) return null

  return (
    <div
      className="changelog-sheet-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <section
        className="changelog-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={SHEET_TITLE_ID}
      >
        <header className="changelog-sheet-header">
          <div className="changelog-sheet-header-text">
            <span className="changelog-sheet-glyph" aria-hidden="true">
              i
            </span>
            <div>
              <h2 id={SHEET_TITLE_ID}>{entry.releaseName || `TaskWraith ${entry.version}`}</h2>
              <p className="changelog-sheet-subtitle">
                v{entry.version}
                {entry.releaseDate ? ` - ${formatDate(entry.releaseDate)}` : ''} - {notesSource}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="changelog-sheet-close"
            onClick={onDismiss}
            aria-label="Close changelog sheet"
          >
            x
          </button>
        </header>

        {statusCaption && (
          <div
            className={`changelog-sheet-status changelog-sheet-status-${updateStatus}`}
            role="status"
          >
            {statusCaption}
          </div>
        )}

        {updateStatus === 'downloading' && updateSnapshot?.downloadProgress && (
          <div className="changelog-sheet-progress" role="status">
            <div
              className="changelog-sheet-progress-fill"
              style={{
                width: `${Math.max(0, Math.min(100, updateSnapshot.downloadProgress.percent))}%`
              }}
            />
            <span>{updateSnapshot.downloadProgress.percent.toFixed(1)}%</span>
          </div>
        )}

        {updateStatus === 'error' && updateSnapshot?.errorMessage && (
          <div className="changelog-sheet-error" role="alert">
            {updateSnapshot.errorMessage}
          </div>
        )}

        <div className="changelog-sheet-notes">
          <pre>{displayNotes}</pre>
        </div>

        <footer className="changelog-sheet-actions">
          {releasePageUrl && (
            <button
              type="button"
              className="segmented-control-action segmented-control-action--compact"
              onClick={handleOpenRelease}
            >
              Open release
            </button>
          )}
          {updateStatus === 'available' && onDownloadUpdate && (
            <button
              type="button"
              className="segmented-control-action segmented-control-action--compact segmented-control-action--primary"
              disabled={!canAct}
              onClick={() => void onDownloadUpdate()}
            >
              Download update
            </button>
          )}
          {updateStatus === 'downloaded' && onInstallUpdateNow && (
            <button
              type="button"
              className="segmented-control-action segmented-control-action--compact segmented-control-action--primary"
              disabled={busy}
              onClick={handleInstall}
            >
              Restart to install
            </button>
          )}
          {(updateStatus === 'error' ||
            updateStatus === 'idle' ||
            updateStatus === 'not-available' ||
            updateStatus === 'disabled') &&
            onCheckForUpdates && (
              <button
                type="button"
                className="segmented-control-action segmented-control-action--compact segmented-control-action--primary"
                disabled={busy || updateStatus === 'disabled'}
                onClick={() => void onCheckForUpdates()}
              >
                {updateStatus === 'error' ? 'Check again' : 'Check for updates'}
              </button>
            )}
          <button
            type="button"
            className="segmented-control-action segmented-control-action--compact"
            onClick={onDismiss}
          >
            Close
          </button>
        </footer>
      </section>
    </div>
  )
}

export function resolveChangelogEntry(
  changelogSnapshot: ProductChangelogSnapshot | null,
  updateSnapshot: UpdateStateSnapshot | null,
  bundledMarkdown: string = bundledChangelog
): ProductUpdateChangelog {
  if (updateSnapshot?.latestVersion) {
    return {
      version: updateSnapshot.latestVersion,
      ...(updateSnapshot.releaseName ? { releaseName: updateSnapshot.releaseName } : {}),
      ...(updateSnapshot.releaseDate ? { releaseDate: updateSnapshot.releaseDate } : {}),
      ...(updateSnapshot.releaseNotes ? { releaseNotes: updateSnapshot.releaseNotes } : {})
    }
  }
  if (changelogSnapshot?.latestUpdateChangelog) return changelogSnapshot.latestUpdateChangelog
  if (
    changelogSnapshot?.pendingUpdateChangelog &&
    shouldShowPendingChangelog(
      changelogSnapshot.pendingUpdateChangelog.version,
      changelogSnapshot.currentVersion
    )
  ) {
    return changelogSnapshot.pendingUpdateChangelog
  }
  const bundledEntry = resolveBundledChangelogEntry(
    bundledMarkdown,
    changelogSnapshot?.currentVersion
  )
  if (bundledEntry) return bundledEntry
  return {
    version: changelogSnapshot?.currentVersion || 'unknown'
  }
}

export function resolveBundledChangelogEntry(
  markdown: string,
  currentVersion?: string
): ProductUpdateChangelog | undefined {
  const sections = parseBundledChangelogSections(markdown)
  if (sections.length === 0) return undefined
  const normalizedCurrent = normalizeVersion(currentVersion)
  if (normalizedCurrent) {
    const currentEntry = sections.find(
      (section) => normalizeVersion(section.version) === normalizedCurrent
    )
    if (currentEntry) return currentEntry
  }
  return sections[0]
}

function parseBundledChangelogSections(markdown: string): ProductUpdateChangelog[] {
  const headings = Array.from(markdown.matchAll(/^##\s+(.+)$/gm))
  return headings
    .map((match, index): ProductUpdateChangelog | undefined => {
      const title = match[1]?.trim()
      if (!title) return undefined
      const start = (match.index ?? 0) + match[0].length
      const nextHeadingIndex = headings[index + 1]?.index
      const end = nextHeadingIndex ?? markdown.length
      const body = markdown.slice(start, end).trim()
      const [versionPart, releaseDatePart] = title.split(/\s+[—-]\s+/, 2)
      const version = normalizeVersion(versionPart)
      if (!version) return undefined
      return {
        version,
        releaseName: `TaskWraith ${version}`,
        ...(releaseDatePart?.trim() ? { releaseDate: releaseDatePart.trim() } : {}),
        ...(body ? { releaseNotes: body } : {})
      }
    })
    .filter((entry): entry is ProductUpdateChangelog => Boolean(entry))
}

function shouldShowPendingChangelog(pendingVersion: string, currentVersion: string | undefined): boolean {
  const normalizedPending = normalizeVersion(pendingVersion)
  const normalizedCurrent = normalizeVersion(currentVersion)
  if (!normalizedPending) return false
  if (!normalizedCurrent) return true
  if (normalizedPending === normalizedCurrent) return true
  const comparison = compareSemverishVersions(normalizedPending, normalizedCurrent)
  return comparison !== null && comparison > 0
}

function normalizeVersion(value: string | undefined): string {
  return value?.trim().replace(/^v/i, '') || ''
}

function compareSemverishVersions(a: string, b: string): number | null {
  const aParts = a.split('.').map((part) => Number(part))
  const bParts = b.split('.').map((part) => Number(part))
  if (
    aParts.length === 0 ||
    bParts.length === 0 ||
    aParts.some((part) => !Number.isInteger(part)) ||
    bParts.some((part) => !Number.isInteger(part))
  ) {
    return null
  }
  const length = Math.max(aParts.length, bParts.length)
  for (let index = 0; index < length; index += 1) {
    const aPart = aParts[index] ?? 0
    const bPart = bParts[index] ?? 0
    if (aPart !== bPart) return aPart > bPart ? 1 : -1
  }
  return 0
}

// GitHub's release feed (what electron-updater returns for an available update)
// is HTML; the bundled CHANGELOG.md is Markdown. The sheet renders notes in a
// <pre>, so raw HTML tags showed literally. Convert HTML to readable text
// (headings → blank line, <li> → bullets, entities decoded); Markdown — which
// has no tags — passes through untouched.
function htmlNotesToText(input: string): string {
  if (!/<\/?[a-z][\s\S]*>/i.test(input)) return input
  return input
    .replace(/\r/g, '')
    .replace(/<\s*(?:h[1-6])[^>]*>/gi, '\n')
    .replace(/<\s*\/\s*h[1-6]\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\s*\/\s*li\s*>/gi, '')
    .replace(/<\s*\/\s*(?:p|ul|ol|div|tr|blockquote)\s*>/gi, '\n')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*hr\s*\/?\s*>/gi, '\n———\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function formatReleaseNotes(notes: ProductUpdateReleaseNotes | undefined): string {
  if (typeof notes === 'string') return htmlNotesToText(notes.trim())
  if (!Array.isArray(notes)) return ''
  return notes
    .map((note) => {
      const body = note.note?.trim()
      return body ? `## ${note.version}\n${htmlNotesToText(body)}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function formatDate(value: string): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value
  return new Date(time).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  })
}
