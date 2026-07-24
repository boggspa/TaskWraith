import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildGitHubIssueUrl } from '../lib/githubIssueUrl'
import { tildifyHomePath } from '../lib/ActivityPathDisplay'

/**
 * BugReportSheet — inline bug-report capture for TaskWraith testers.
 *
 * Built for early external tester passes: when a tester hits something
 * weird, they type a one-liner + description, pick a severity, and the
 * report appends to a single Markdown file under `<userData>/TaskWraith/`
 * for review at the end of the session. No context switch
 * to Slack / email / a separate notes app.
 *
 * The sheet sits alongside `FirstLaunchSheet.tsx` and uses the same
 * backdrop pattern (fixed-inset dim + blur). The internal panel uses
 * `var(--surface-1)` for an opaque solid fill — same pattern the
 * FirstLaunchSheet ended up with after the user iterated past the
 * frosted-overlay variant.
 *
 * Auto-captured context fields are shown read-only above the submit
 * button so the user can see exactly what's being attached to the
 * report before they hit save (no surprise telemetry — every field
 * is visible up-front).
 *
 * Submit flow:
 *   1. Validate (title required, severity always set)
 *   2. Call `onSubmit(payload)` — host wires this to
 *      `window.api.submitBugReport(...)`
 *   3. On success, show inline "Report saved — thanks!" confirmation
 *      for ~1.8s, then close the sheet
 *   4. On failure, surface the error inline and leave the sheet open
 *      so the tester can retry
 *
 * Dismiss surfaces (Esc, click-outside, Cancel button) all reset the
 * form so the next open is clean — the sheet has no persisted draft
 * state. This is deliberate: the form is small enough that a stale
 * draft would be more confusing than re-typing.
 */

/** Severity ladder. Default is "minor" — the most common case for an
 * exploratory tester pass. "blocking" is reserved for things that stop
 * the test session entirely; "info" is reserved for "this isn't a bug
 * but it caught my eye". */
export type BugReportSeverity = 'info' | 'minor' | 'major' | 'blocking'

export interface BugReportSubmission {
  title: string
  description: string
  expected: string
  severity: BugReportSeverity
  /** Auto-captured context — passed to the main process verbatim so the
   * appended Markdown file shows what the tester saw. */
  context: {
    timestamp: string
    version: string
    provider: string
    workspace: string
    shell: string
    surface?: string
    chatKind?: string
    settingsTab?: string
    inspectorTab?: string
    theme?: string
    promptBubble?: string
    ensemble?: string
  }
}

export interface BugReportSheetProps {
  /** Sheet visibility. Host owns the flag. */
  open: boolean
  /** Called when the user dismisses (Esc, click-outside, Cancel). */
  onDismiss: () => void
  /** Submit handler. Returns a promise that resolves on success or
   * rejects with an Error whose message we surface inline. */
  onSubmit: (payload: BugReportSubmission) => Promise<void>
  /** Read-only context: app version (from `app.getVersion()` via the
   * preload-exposed runtime versions, or `package.json` fallback). */
  appVersion: string
  /** Read-only context: currently selected provider (codex / claude / etc.). */
  currentProvider: string
  /** Read-only context: workspace path, or null when the chat is global. */
  currentWorkspacePath: string | null
  /** Read-only context: composer shell label (default / codex / claude / ...). */
  composerShell: string
  /** Inferred surface when the report opens; the tester can override it. */
  initialSurface?: string
  /** Read-only context: active chat kind (single provider / ensemble / global). */
  chatKind?: string
  /** Read-only context: current Settings tab, when relevant. */
  settingsTab?: string
  /** Read-only context: current inspector tab, when relevant. */
  inspectorTab?: string
  /** Read-only context: theme appearance setting. */
  theme?: string
  /** Read-only context: prompt/message bubble preference. */
  promptBubble?: string
  /** Read-only context: Ensemble participants/mode summary, when relevant. */
  ensembleSummary?: string
}

const SHEET_TITLE_ID = 'bug-report-sheet-title'
const SEVERITY_OPTIONS: ReadonlyArray<{
  value: BugReportSeverity
  label: string
  description: string
}> = [
  { value: 'info', label: 'Info', description: 'Notable but not broken.' },
  { value: 'minor', label: 'Minor', description: 'Annoying, works around.' },
  { value: 'major', label: 'Major', description: 'Breaks a feature.' },
  { value: 'blocking', label: 'Blocking', description: 'Stops the test session.' }
]

const SURFACE_OPTIONS = [
  'Transcript',
  'Composer',
  'Ensemble',
  // 1.0.4 — new surfaces shipped this release. Splitting them
  // out of the generic 'Ensemble' bucket so testers can target
  // bug reports at the specific subsurface they were using.
  'Parallel fan-out',
  'Screen Watch',
  'Inspector',
  'Settings',
  'Model Usage',
  'MCP',
  'Onboarding',
  'Bug Report',
  'Devices',
  'Other'
] as const

function formatTimestamp(date: Date): { iso: string; human: string } {
  const iso = date.toISOString()
  // "Sat 24 May 2026 18:58 +0100" — short enough to read in the read-only
  // preview row, precise enough for minute-level triage when someone
  // sweeps the file.
  const human = date.toLocaleString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
  return { iso, human }
}

export function BugReportSheet({
  open,
  onDismiss,
  onSubmit,
  appVersion,
  currentProvider,
  currentWorkspacePath,
  composerShell,
  initialSurface = 'Transcript',
  chatKind = '',
  settingsTab = '',
  inspectorTab = '',
  theme = '',
  promptBubble = '',
  ensembleSummary = ''
}: BugReportSheetProps): React.JSX.Element | null {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [expected, setExpected] = useState('')
  const [severity, setSeverity] = useState<BugReportSeverity>('minor')
  const [surface, setSurface] = useState<string>(initialSurface)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [titleTouched, setTitleTouched] = useState(false)
  const titleInputRef = useRef<HTMLInputElement | null>(null)
  const [stamp, setStamp] = useState<{ iso: string; human: string }>(() =>
    formatTimestamp(new Date())
  )

  // Reset form whenever the sheet transitions to closed — keeps the
  // next opening clean and avoids leaking a half-typed draft into the
  // "saved!" success state.
  useEffect(() => {
    if (open) return
    const frame = window.requestAnimationFrame(() => {
      setTitle('')
      setDescription('')
      setExpected('')
      setSeverity('minor')
      setSurface(initialSurface)
      setSubmitting(false)
      setSubmitError(null)
      setConfirmation(null)
      setTitleTouched(false)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, initialSurface])

  // Autofocus the title input on open — small UX win so the tester
  // can start typing without a Tab dance.
  useEffect(() => {
    if (!open) return
    const handle = window.requestAnimationFrame(() => {
      titleInputRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(handle)
  }, [open])

  // Esc-to-dismiss. Capture-phase so it beats any nested composer
  // shortcut handlers — when this sheet is open, Escape always closes
  // it first.
  const dismissRef = useRef(onDismiss)
  useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        dismissRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  // Stable timestamp captured at open — re-computing on every render
  // would mean the human-readable preview ticks forward while the user
  // is typing, which looks wrong. Re-stamp on open.
  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      setStamp(formatTimestamp(new Date()))
      setSurface(
        SURFACE_OPTIONS.includes(initialSurface as (typeof SURFACE_OPTIONS)[number])
          ? initialSurface
          : 'Transcript'
      )
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, initialSurface])

  // Home-abbreviate the workspace path (`/Users/<name>/…` → `~/…`) so a
  // reporter's OS username never lands in the read-only preview, the local
  // bug-reports.md, or the pre-filled PUBLIC GitHub issue. The project folder
  // stays visible for triage; only the home/user prefix is stripped.
  const workspaceLabel = useMemo(
    () => (currentWorkspacePath ? tildifyHomePath(currentWorkspacePath) : '(general chat)'),
    [currentWorkspacePath]
  )

  const trimmedTitle = title.trim()
  const titleInvalid = titleTouched && trimmedTitle.length === 0

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      setTitleTouched(true)
      if (trimmedTitle.length === 0) {
        // Don't submit — let the inline validation message do the work.
        titleInputRef.current?.focus()
        return
      }
      setSubmitting(true)
      setSubmitError(null)
      try {
        await onSubmit({
          title: trimmedTitle,
          description: description.trim(),
          expected: expected.trim(),
          severity,
          context: {
            timestamp: stamp.iso,
            version: appVersion,
            provider: currentProvider,
            workspace: workspaceLabel,
            shell: composerShell,
            surface,
            chatKind,
            settingsTab,
            inspectorTab,
            theme,
            promptBubble,
            ensemble: ensembleSummary
          }
        })
        setConfirmation('Report saved — thanks!')
        // Auto-dismiss after the confirmation has been visible long
        // enough to read (~1.8s). The cleanup in the open-effect resets
        // the form so the next open is clean.
        window.setTimeout(() => {
          dismissRef.current()
        }, 1800)
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : 'Failed to save report.')
        setSubmitting(false)
      }
    },
    [
      appVersion,
      chatKind,
      composerShell,
      currentProvider,
      description,
      ensembleSummary,
      expected,
      inspectorTab,
      onSubmit,
      promptBubble,
      severity,
      settingsTab,
      stamp.iso,
      surface,
      theme,
      trimmedTitle,
      workspaceLabel
    ]
  )

  // Open the same report as a pre-filled GitHub issue (the public bug channel
  // now that TaskWraith is open-source). Reuses the captured context; the local
  // Save report stays as an offline fallback.
  const handleOpenGitHubIssue = useCallback(() => {
    setTitleTouched(true)
    if (trimmedTitle.length === 0) {
      titleInputRef.current?.focus()
      return
    }
    const url = buildGitHubIssueUrl({
      title: trimmedTitle,
      description: description.trim(),
      expected: expected.trim(),
      severity,
      context: [
        ['Version', appVersion],
        ['Provider', currentProvider],
        ['Surface', surface],
        ['Chat kind', chatKind],
        ['Workspace', workspaceLabel],
        ['Composer shell', composerShell],
        ['Settings tab', settingsTab],
        ['Inspector tab', inspectorTab],
        ['Theme', theme],
        ['Bubble', promptBubble],
        ['Ensemble', ensembleSummary]
      ]
    })
    if (typeof window.api.openExternalOrPath === 'function') {
      void window.api.openExternalOrPath(url)
    }
  }, [
    appVersion,
    chatKind,
    composerShell,
    currentProvider,
    description,
    ensembleSummary,
    expected,
    inspectorTab,
    promptBubble,
    severity,
    settingsTab,
    surface,
    theme,
    trimmedTitle,
    workspaceLabel
  ])

  if (!open) return null

  return (
    <div
      className="bug-report-sheet-backdrop"
      role="presentation"
      onClick={(e) => {
        // Click-outside dismisses. Only when the click both started AND
        // ended on the backdrop — protects against a drag-out release
        // from inside the sheet body closing the form mid-type.
        if (e.target === e.currentTarget && !submitting) onDismiss()
      }}
    >
      <div
        className="bug-report-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={SHEET_TITLE_ID}
      >
        <header className="bug-report-sheet-header">
          <div className="bug-report-sheet-header-text">
            <span className="bug-report-sheet-glyph" aria-hidden>
              !
            </span>
            <div>
              <h2 id={SHEET_TITLE_ID}>Report a bug or issue</h2>
              <p className="bug-report-sheet-subtitle">
                Capture what you just saw — open it as a pre-filled GitHub issue, or save a local
                copy for later review.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="bug-report-sheet-close"
            onClick={onDismiss}
            aria-label="Close bug-report sheet"
            title="Close"
            disabled={submitting}
          >
            &times;
          </button>
        </header>

        <form className="bug-report-sheet-form" onSubmit={handleSubmit}>
          <div className="bug-report-sheet-field">
            <div className="bug-report-sheet-label-row">
              <label className="bug-report-sheet-label" htmlFor="bug-report-title">
                Title <span className="bug-report-sheet-required">*</span>
              </label>
              <span
                className={`bug-report-sheet-char-counter${
                  title.length > 120 ? ' bug-report-sheet-char-counter-warn' : ''
                }`}
                aria-hidden
              >
                {title.length}/140
              </span>
            </div>
            <input
              ref={titleInputRef}
              id="bug-report-title"
              type="text"
              className={`bug-report-sheet-input ${titleInvalid ? 'bug-report-sheet-input-invalid' : ''}`}
              placeholder="One-liner — e.g. 'Composer freezes after Cmd+K'"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => setTitleTouched(true)}
              aria-required
              aria-invalid={titleInvalid}
              maxLength={140}
              disabled={submitting}
            />
            {titleInvalid && (
              <span className="bug-report-sheet-validation" role="alert">
                Title is required.
              </span>
            )}
          </div>

          <div className="bug-report-sheet-field">
            <label className="bug-report-sheet-label" htmlFor="bug-report-description">
              What were you doing when this happened?
              <span className="bug-report-sheet-label-helper"> (recommended)</span>
            </label>
            <textarea
              id="bug-report-description"
              className="bug-report-sheet-textarea"
              placeholder="Walk through the steps — what you clicked, what you typed."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              disabled={submitting}
            />
          </div>

          <div className="bug-report-sheet-field">
            <label className="bug-report-sheet-label" htmlFor="bug-report-expected">
              What did you expect to happen?
              <span className="bug-report-sheet-label-helper"> (optional)</span>
            </label>
            <textarea
              id="bug-report-expected"
              className="bug-report-sheet-textarea"
              placeholder="What would the right behaviour have looked like?"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              rows={3}
              disabled={submitting}
            />
          </div>

          <div className="bug-report-sheet-field">
            <label className="bug-report-sheet-label" htmlFor="bug-report-surface">
              Where did it happen?
              <span className="bug-report-sheet-label-helper"> (helps triage)</span>
            </label>
            <select
              id="bug-report-surface"
              className="bug-report-sheet-input"
              value={surface}
              onChange={(e) => setSurface(e.target.value)}
              disabled={submitting}
            >
              {SURFACE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>

          <div className="bug-report-sheet-field">
            <span className="bug-report-sheet-label" id="bug-report-severity-label">
              Severity
            </span>
            <div
              className="bug-report-sheet-severity-row"
              role="radiogroup"
              aria-labelledby="bug-report-severity-label"
            >
              {SEVERITY_OPTIONS.map((option) => {
                const checked = severity === option.value
                return (
                  <label
                    key={option.value}
                    className={`bug-report-sheet-severity-chip bug-report-sheet-severity-chip-${option.value} ${checked ? 'bug-report-sheet-severity-chip-checked' : ''}`}
                    title={option.description}
                  >
                    <input
                      type="radio"
                      name="bug-report-severity"
                      value={option.value}
                      checked={checked}
                      onChange={() => setSeverity(option.value)}
                      disabled={submitting}
                    />
                    <span className="bug-report-sheet-severity-chip-label">{option.label}</span>
                    <span className="bug-report-sheet-severity-chip-description">
                      {option.description}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>

          <div className="bug-report-sheet-context" aria-label="Auto-captured context">
            <span className="bug-report-sheet-label bug-report-sheet-label-context">
              Auto-captured (saved with the report)
            </span>
            <ul className="bug-report-sheet-context-list">
              <li>
                <span className="bug-report-sheet-context-key">Timestamp</span>
                <span className="bug-report-sheet-context-value">{stamp.human}</span>
              </li>
              <li>
                <span className="bug-report-sheet-context-key">Version</span>
                <span className="bug-report-sheet-context-value">{appVersion}</span>
              </li>
              <li>
                <span className="bug-report-sheet-context-key">Provider</span>
                <span className="bug-report-sheet-context-value">{currentProvider}</span>
              </li>
              <li>
                <span className="bug-report-sheet-context-key">Surface</span>
                <span className="bug-report-sheet-context-value">{surface}</span>
              </li>
              {chatKind ? (
                <li>
                  <span className="bug-report-sheet-context-key">Chat kind</span>
                  <span className="bug-report-sheet-context-value">{chatKind}</span>
                </li>
              ) : null}
              <li>
                <span className="bug-report-sheet-context-key">Workspace</span>
                <span className="bug-report-sheet-context-value">{workspaceLabel}</span>
              </li>
              <li>
                <span className="bug-report-sheet-context-key">Composer shell</span>
                <span className="bug-report-sheet-context-value">{composerShell}</span>
              </li>
              {settingsTab ? (
                <li>
                  <span className="bug-report-sheet-context-key">Settings tab</span>
                  <span className="bug-report-sheet-context-value">{settingsTab}</span>
                </li>
              ) : null}
              {inspectorTab ? (
                <li>
                  <span className="bug-report-sheet-context-key">Inspector tab</span>
                  <span className="bug-report-sheet-context-value">{inspectorTab}</span>
                </li>
              ) : null}
              {theme ? (
                <li>
                  <span className="bug-report-sheet-context-key">Theme</span>
                  <span className="bug-report-sheet-context-value">{theme}</span>
                </li>
              ) : null}
              {promptBubble ? (
                <li>
                  <span className="bug-report-sheet-context-key">Bubble</span>
                  <span className="bug-report-sheet-context-value">{promptBubble}</span>
                </li>
              ) : null}
              {ensembleSummary ? (
                <li>
                  <span className="bug-report-sheet-context-key">Ensemble</span>
                  <span className="bug-report-sheet-context-value">{ensembleSummary}</span>
                </li>
              ) : null}
            </ul>
          </div>

          {submitError && (
            <div className="bug-report-sheet-error" role="alert">
              {submitError}
            </div>
          )}

          <footer className="bug-report-sheet-footer">
            {confirmation ? (
              <span className="bug-report-sheet-confirmation" role="status">
                <span className="bug-report-sheet-confirmation-check" aria-hidden>
                  ✓
                </span>
                {confirmation}
              </span>
            ) : (
              <span className="bug-report-sheet-footer-helper">
                Saved to <code>~/Library/Application Support/taskwraith/bug-reports.md</code>
              </span>
            )}
            <div className="bug-report-sheet-footer-actions">
              <button
                type="button"
                className="segmented-control-action"
                onClick={onDismiss}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="segmented-control-action segmented-control-action--primary"
                onClick={handleOpenGitHubIssue}
                disabled={submitting || trimmedTitle.length === 0}
                title="Open a pre-filled GitHub issue with this report and captured context"
              >
                Open GitHub issue
              </button>
              <button
                type="submit"
                className="segmented-control-action segmented-control-action--primary"
                disabled={submitting || trimmedTitle.length === 0}
              >
                {submitting ? 'Saving…' : 'Save report'}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  )
}
