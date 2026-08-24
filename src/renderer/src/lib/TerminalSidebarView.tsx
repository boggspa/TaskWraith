import { useEffect, useState } from 'react'
import { useTerminalRecipes, terminalLaunchBus } from './TerminalSidebarStore'
import type { WorkspaceRecord } from '../../../main/store/types'

interface TerminalSidebarViewProps {
  workspaces: readonly WorkspaceRecord[]
}

export function TerminalSidebarView({ workspaces }: TerminalSidebarViewProps) {
  const recipes = useTerminalRecipes()
  const [runningSessions, setRunningSessions] = useState<{ sessionId: string; workspacePath: string }[]>([])
  const [filter, setFilter] = useState<'recents' | 'pinned' | 'workspaces'>('recents')

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

  const handleLaunch = (workspacePath: string) => {
    terminalLaunchBus.emit(workspacePath)
  }

  const pinned = recipes.filter((r) => r.pinned)
  const recents = recipes.filter((r) => !r.pinned).sort((a, b) => b.lastUsedAt - a.lastUsedAt)

  return (
    <div className="sidebar-terminal-panel">
      <div className="sidebar-section-header">
        <div className="segmented-control">
          {(['recents', 'pinned', 'workspaces'] as const).map((f) => (
            <button
              key={f}
              className={`segmented-control-segment ${filter === f ? 'is-active' : ''}`}
              onClick={() => setFilter(f)}
              style={{ textTransform: 'capitalize' }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {runningSessions.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-header">
            <span className="sidebar-section-title">Running</span>
          </div>
          <div className="sidebar-section-list">
            {runningSessions.map((session) => {
              const ws = workspaces.find((w) => w.path === session.workspacePath)
              return (
                <div key={session.sessionId} className="sidebar-item" onClick={() => handleLaunch(session.workspacePath)}>
                  <div className="sidebar-item-title">{ws?.displayName || session.workspacePath}</div>
                  <div className="sidebar-item-subtitle">Running</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-title">
            {filter === 'recents' ? 'Recent' : filter === 'pinned' ? 'Pinned' : 'Workspaces'}
          </span>
        </div>
        <div className="sidebar-section-list">
          {filter === 'recents' &&
            recents.map((r) => {
              const ws = workspaces.find((w) => w.path === r.workspacePath)
              return (
                <div key={r.id} className="sidebar-item" onClick={() => handleLaunch(r.workspacePath)}>
                  <div className="sidebar-item-title">{ws?.displayName || r.workspacePath}</div>
                  {r.command && <div className="sidebar-item-subtitle">{r.command}</div>}
                </div>
              )
            })}
          {filter === 'pinned' &&
            pinned.map((r) => {
              const ws = workspaces.find((w) => w.path === r.workspacePath)
              return (
                <div key={r.id} className="sidebar-item" onClick={() => handleLaunch(r.workspacePath)}>
                  <div className="sidebar-item-title">{ws?.displayName || r.workspacePath}</div>
                  {r.command && <div className="sidebar-item-subtitle">{r.command}</div>}
                </div>
              )
            })}
          {filter === 'workspaces' &&
            workspaces.map((w) => (
              <div key={w.id} className="sidebar-item" onClick={() => handleLaunch(w.path)}>
                <div className="sidebar-item-title">{w.displayName}</div>
                <div className="sidebar-item-subtitle">{w.path}</div>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}
