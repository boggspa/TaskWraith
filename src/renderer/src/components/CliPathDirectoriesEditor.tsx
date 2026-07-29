import { useCallback, useMemo, useState, type ReactElement } from 'react'
import {
  MAX_CLI_PATH_DIRECTORIES,
  cliPathDirectoryRejection,
  normalizeCliPathDirectories,
  splitPastedCliPath
} from '../../../shared/cliPathDirectories'
import { PillButton } from './PillButton'

/**
 * Editor for `AppSettings.cliPathDirectories` — the user-owned directories
 * searched first when TaskWraith resolves ANY external CLI.
 *
 * Shared verbatim by Settings → Providers and the first-launch sheet. The
 * setting is global (it changes provider CLIs, `gh`, `git`, and the optional
 * host tools alike), so both surfaces must present exactly one control with one
 * set of validation rules; two editors would be two chances to disagree about
 * what a valid directory is.
 *
 * Validation is `shared/cliPathDirectories.ts`, the same module the main-process
 * sanitizer uses — so a row this editor accepts is a row that survives persist.
 */

export interface CliPathDirectoriesEditorProps {
  value: readonly string[]
  onChange: (next: string[]) => void
  /** Compact chrome for the onboarding sheet. */
  dense?: boolean
}

export function CliPathDirectoriesEditor({
  value,
  onChange,
  dense = false
}: CliPathDirectoriesEditorProps): ReactElement {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const entries = useMemo(() => normalizeCliPathDirectories([...value]), [value])
  const atCapacity = entries.length >= MAX_CLI_PATH_DIRECTORIES

  const add = useCallback(() => {
    const trimmed = draft.trim()
    if (!trimmed) return
    // A pasted whole PATH is the single most likely input here, so split it
    // rather than rejecting it and making the user do it by hand.
    const candidates = splitPastedCliPath(trimmed)
    const rejected: string[] = []
    const accepted: string[] = []
    for (const candidate of candidates) {
      if (cliPathDirectoryRejection(candidate)) rejected.push(candidate)
      else accepted.push(candidate)
    }
    if (accepted.length === 0) {
      setError(cliPathDirectoryRejection(candidates[0] ?? trimmed) || 'Not a usable directory.')
      return
    }
    const next = normalizeCliPathDirectories([...entries, ...accepted])
    onChange(next)
    setDraft('')
    setError(
      rejected.length > 0
        ? `Added ${accepted.length}; skipped ${rejected.length} entry that isn't an absolute directory.`
        : null
    )
  }, [draft, entries, onChange])

  const remove = useCallback(
    (entry: string) => {
      onChange(entries.filter((candidate) => candidate !== entry))
      setError(null)
    },
    [entries, onChange]
  )

  const move = useCallback(
    (index: number, delta: number) => {
      const target = index + delta
      if (target < 0 || target >= entries.length) return
      const next = [...entries]
      const [moved] = next.splice(index, 1)
      next.splice(target, 0, moved)
      onChange(next)
    },
    [entries, onChange]
  )

  return (
    <div className={`cli-path-editor${dense ? ' is-dense' : ''}`}>
      {entries.length > 0 && (
        <ul className="cli-path-editor-list" aria-label="Extra CLI directories">
          {entries.map((entry, index) => (
            <li key={entry} className="cli-path-editor-row">
              <code className="cli-path-editor-value">{entry}</code>
              <div className="cli-path-editor-row-actions">
                <PillButton
                  size="compact"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={`Move ${entry} earlier in the search order`}
                  title="Search this directory earlier"
                >
                  ↑
                </PillButton>
                <PillButton
                  size="compact"
                  onClick={() => move(index, 1)}
                  disabled={index === entries.length - 1}
                  aria-label={`Move ${entry} later in the search order`}
                  title="Search this directory later"
                >
                  ↓
                </PillButton>
                <PillButton
                  size="compact"
                  variant="danger"
                  onClick={() => remove(entry)}
                  aria-label={`Remove ${entry}`}
                  title="Remove this directory"
                >
                  Remove
                </PillButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="cli-path-editor-add">
        <input
          className="settings-select cli-path-editor-input"
          type="text"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder="/opt/homebrew/bin"
          aria-label="Add a CLI directory"
          disabled={atCapacity}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <PillButton
          size="compact"
          variant="primary"
          onClick={add}
          disabled={atCapacity || !draft.trim()}
        >
          Add
        </PillButton>
      </div>
      {error && <p className="cli-path-editor-error">{error}</p>}
      {atCapacity && (
        <p className="cli-path-editor-error">
          Maximum of {MAX_CLI_PATH_DIRECTORIES} directories. Remove one to add another.
        </p>
      )}
    </div>
  )
}
