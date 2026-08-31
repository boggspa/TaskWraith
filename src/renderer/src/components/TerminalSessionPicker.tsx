import { useMemo, useState } from 'react'
import type { WorkspaceRecord } from '../../../main/store/types'
import type { TerminalCliId } from '../../../shared/terminalCli'
import { AppleTerminalIcon, PlusSymbolIcon } from './AppChromeSymbols'

export interface TerminalCliOption {
  id: TerminalCliId
  label: string
  description?: string
}

/** One renderer catalogue for every user-created persistent terminal surface. */
export const TERMINAL_CLI_OPTIONS: readonly TerminalCliOption[] = [
  { id: 'default', label: 'Default', description: 'Normal Terminal in Workspace' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'claude', label: 'Claude Code CLI' },
  { id: 'kimi', label: 'Kimi Code CLI' },
  { id: 'cursor', label: 'Cursor-Agent CLI' },
  { id: 'grok', label: 'Grok Build CLI' },
  { id: 'ollama', label: 'Ollama CLI' },
  { id: 'mistral', label: 'Mistral Vibe CLI' },
  { id: 'agy', label: 'AntiGravity (AGY) CLI' },
  { id: 'pi', label: 'Pi (Pi CLI)' },
  { id: 'muse', label: 'Muse Code CLI (Meta)' },
  { id: 'github', label: 'GitHub CLI' }
]

export interface TerminalSessionPickerProps {
  workspaces: readonly WorkspaceRecord[]
  busyWorkspacePath?: string | null
  preferredWorkspacePath?: string | null
  onSelect: (workspace: WorkspaceRecord, cliId: TerminalCliId) => void
}

/** Shared workspace + native-CLI picker used by Thread Home and the Terminal tab. */
export function TerminalSessionPicker({
  workspaces,
  busyWorkspacePath,
  preferredWorkspacePath,
  onSelect
}: TerminalSessionPickerProps) {
  const [showMore, setShowMore] = useState(false)
  const [selectedCli, setSelectedCli] = useState<TerminalCliId>('default')
  const orderedWorkspaces = useMemo(() => {
    if (!preferredWorkspacePath) return workspaces
    const preferred = workspaces.find((workspace) => workspace.path === preferredWorkspacePath)
    return preferred
      ? [preferred, ...workspaces.filter((workspace) => workspace.id !== preferred.id)]
      : workspaces
  }, [preferredWorkspacePath, workspaces])
  const visibleWorkspaces = showMore ? orderedWorkspaces : orderedWorkspaces.slice(0, 12)

  return (
    <section className="thread-home-terminal-picker" aria-label="Choose a terminal workspace">
      <div className="thread-home-terminal-picker-column">
        <div className="thread-home-terminal-picker-heading">
          <AppleTerminalIcon />
          <span>
            <strong>Choose a workspace</strong>
            <small>The terminal starts with that workspace as its current directory.</small>
          </span>
        </div>
        {orderedWorkspaces.length === 0 ? (
          <div className="thread-home-surface-empty">
            Add a workspace in the sidebar before opening a terminal.
          </div>
        ) : (
          <div className={`thread-home-terminal-workspace-list ${showMore ? 'is-scrollable' : ''}`}>
            {visibleWorkspaces.map((workspace) => {
              const busy = busyWorkspacePath === workspace.path
              return (
                <button
                  type="button"
                  key={workspace.id}
                  className="thread-home-thread-row"
                  disabled={Boolean(busyWorkspacePath)}
                  onClick={() => onSelect(workspace, selectedCli)}
                  aria-label={`Open terminal in ${workspace.displayName}, ${workspace.path}`}
                >
                  <span className="thread-home-thread-provider" aria-hidden>
                    <AppleTerminalIcon />
                  </span>
                  <span className="thread-home-thread-copy">
                    <strong>{workspace.displayName}</strong>
                    <span className="thread-home-thread-subline">
                      <small>{workspace.path}</small>
                    </span>
                  </span>
                  <span className="thread-home-thread-provider-label">
                    {busy ? 'Opening…' : 'Open'}
                  </span>
                </button>
              )
            })}
            {!showMore && orderedWorkspaces.length > 12 && (
              <button
                type="button"
                className="thread-home-thread-row"
                onClick={() => setShowMore(true)}
              >
                <span className="thread-home-thread-provider" aria-hidden>
                  <PlusSymbolIcon />
                </span>
                <span className="thread-home-thread-copy">
                  <strong>Show more workspaces</strong>
                </span>
              </button>
            )}
          </div>
        )}
      </div>

      <div className="thread-home-terminal-picker-column">
        <div className="thread-home-terminal-picker-heading">
          <span className="thread-home-thread-provider terminal-session-picker-heading-spacer" />
          <span>
            <strong>Native CLI Quickload</strong>
            <small>Select a CLI to load in the workspace-isolated terminal.</small>
          </span>
        </div>
        <div className="thread-home-terminal-workspace-list is-scrollable">
          {TERMINAL_CLI_OPTIONS.map((cli) => (
            <button
              type="button"
              key={cli.id}
              className={`thread-home-thread-row ${selectedCli === cli.id ? 'is-selected' : ''}`}
              onClick={() => setSelectedCli(cli.id)}
            >
              <span className="thread-home-thread-provider" aria-hidden>
                <AppleTerminalIcon />
              </span>
              <span className="thread-home-thread-copy">
                <strong>{cli.label}</strong>
                {cli.description && (
                  <span className="thread-home-thread-subline">
                    <small>{cli.description}</small>
                  </span>
                )}
              </span>
              {selectedCli === cli.id && (
                <span className="thread-home-thread-provider-label">Active</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
