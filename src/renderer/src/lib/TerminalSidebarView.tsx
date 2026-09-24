import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { useTerminalRecipes, terminalLaunchBus, type TerminalRecipe } from './TerminalSidebarStore'
import type { WorkspaceRecord } from '../../../main/store/types'

interface TerminalSidebarViewProps {
  workspaces: readonly WorkspaceRecord[]
}

interface TerminalSession {
  sessionId: string
  workspacePath: string
}

interface TerminalSidebarContentProps extends TerminalSidebarViewProps {
  recipes: readonly TerminalRecipe[]
  runningSessions: readonly TerminalSession[]
  onLaunch: (workspacePath: string) => void
  onAttach: (workspacePath: string, sessionId: string) => void
  onKill: (event: MouseEvent, sessionId: string) => void
}

function TerminalSection({
  title,
  count,
  children
}: {
  title: string
  count: number
  children: ReactNode
}) {
  const [isExpanded, setIsExpanded] = useState(true)

  return (
    <section className="sidebar-hierarchy-section terminal-sidebar-section">
      <div className="sidebar-section-header">
        <button
          type="button"
          className="sidebar-section-header-toggle"
          onClick={() => setIsExpanded((current) => !current)}
          aria-expanded={isExpanded}
          title={`${isExpanded ? 'Collapse' : 'Expand'} ${title}`}
        >
          <span
            className={`sf-symbol-icon sidebar-tree-chevron ${isExpanded ? 'is-expanded' : ''}`}
            aria-hidden
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6.2 4.7 10 8.1 6.2 11.5" />
            </svg>
          </span>
          <h4 className="sidebar-section-title">{title}</h4>
          {count > 0 && <span className="sidebar-section-count">{count}</span>}
        </button>
      </div>
      {isExpanded && <div className="terminal-sidebar-list">{children}</div>}
    </section>
  )
}

function TerminalRowCopy({ title, detail }: { title: string; detail?: string }) {
  return (
    <span className="terminal-sidebar-row-copy">
      <span className="terminal-sidebar-row-title" title={title}>
        {title}
      </span>
      {detail && (
        <span className="terminal-sidebar-row-detail" title={detail}>
          {detail}
        </span>
      )}
    </span>
  )
}

export function TerminalSidebarContent({
  workspaces,
  recipes,
  runningSessions,
  onLaunch,
  onAttach,
  onKill
}: TerminalSidebarContentProps) {
  const workspaceByPath = new Map(workspaces.map((workspace) => [workspace.path, workspace]))
  const pinned = recipes.filter((recipe) => recipe.pinned)
  const recents = recipes
    .filter((recipe) => !recipe.pinned)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)

  const renderRecipe = (recipe: TerminalRecipe) => {
    const workspace = workspaceByPath.get(recipe.workspacePath)
    const title = workspace?.displayName || recipe.workspacePath
    return (
      <button
        key={recipe.id}
        type="button"
        className="sidebar-item terminal-sidebar-row"
        onClick={() => onLaunch(recipe.workspacePath)}
        aria-label={`Open terminal — ${title}`}
      >
        <TerminalRowCopy title={title} detail={recipe.command} />
      </button>
    )
  }

  return (
    <div className="sidebar-terminal-panel">
      {runningSessions.length > 0 && (
        <TerminalSection title="Running" count={runningSessions.length}>
          {runningSessions.map((session) => {
            const workspace = workspaceByPath.get(session.workspacePath)
            const sessionName = workspace?.displayName || session.workspacePath
            return (
              <div
                key={session.sessionId}
                className="sidebar-item terminal-sidebar-row terminal-sidebar-running-row"
                role="button"
                tabIndex={0}
                aria-label={`Open terminal session — ${sessionName}`}
                onClick={() => onAttach(session.workspacePath, session.sessionId)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onAttach(session.workspacePath, session.sessionId)
                  }
                }}
              >
                <span className="terminal-sidebar-running-dot" aria-hidden />
                <TerminalRowCopy title={sessionName} detail="Running terminal" />
                <button
                  type="button"
                  className="sidebar-item-action terminal-sidebar-row-action"
                  onClick={(event) => {
                    event.stopPropagation()
                    onAttach(session.workspacePath, session.sessionId)
                  }}
                  title="Attach to session"
                  aria-label={`Attach to terminal session — ${sessionName}`}
                >
                  ↗
                </button>
                <button
                  type="button"
                  className="sidebar-item-action terminal-sidebar-row-action terminal-sidebar-row-action-kill"
                  onClick={(event) => onKill(event, session.sessionId)}
                  title="Kill session"
                  aria-label={`Kill terminal session — ${sessionName}`}
                >
                  &times;
                </button>
              </div>
            )
          })}
        </TerminalSection>
      )}

      <TerminalSection title="Pinned" count={pinned.length}>
        {pinned.map(renderRecipe)}
      </TerminalSection>

      <TerminalSection title="Recents" count={recents.length}>
        {recents.map(renderRecipe)}
      </TerminalSection>

      <TerminalSection title="Workspaces" count={workspaces.length}>
        {workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            className="sidebar-item terminal-sidebar-row"
            onClick={() => onLaunch(workspace.path)}
            aria-label={`Open terminal — ${workspace.displayName}`}
          >
            <TerminalRowCopy title={workspace.displayName} detail={workspace.path} />
          </button>
        ))}
      </TerminalSection>
    </div>
  )
}

export function TerminalSidebarView({ workspaces }: TerminalSidebarViewProps) {
  const recipes = useTerminalRecipes()
  const [runningSessions, setRunningSessions] = useState<TerminalSession[]>([])

  useEffect(() => {
    let mounted = true
    const fetchList = async () => {
      try {
        const list = await window.api.terminal.list()
        if (mounted) setRunningSessions(list)
      } catch (err) {
        console.error(err)
      }
    }
    fetchList()
    const interval = setInterval(fetchList, 2000)
    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [])

  const handleKill = (event: MouseEvent, sessionId: string) => {
    event.stopPropagation()
    window.api.terminal
      .kill(sessionId)
      .then(() => {
        setRunningSessions((current) =>
          current.filter((session) => session.sessionId !== sessionId)
        )
      })
      .catch((err) => {
        console.error('[TerminalSidebarView] terminal.kill failed', err)
      })
  }

  return (
    <TerminalSidebarContent
      workspaces={workspaces}
      recipes={recipes}
      runningSessions={runningSessions}
      onLaunch={(workspacePath) => terminalLaunchBus.emit(workspacePath)}
      onAttach={(workspacePath, sessionId) =>
        terminalLaunchBus.emitAttach(workspacePath, sessionId)
      }
      onKill={handleKill}
    />
  )
}
