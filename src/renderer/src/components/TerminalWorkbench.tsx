import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { WorkspaceRecord } from '../../../main/store/types'
import type { TerminalCliId } from '../../../shared/terminalCli'
import { terminalLaunchBus, terminalSidebarStore } from '../lib/TerminalSidebarStore'
import emptyGhostSvg from '../assets/taskwraith-ghost-monoline.svg?raw'
import { TerminalSessionPicker } from './TerminalSessionPicker'

const TUI_TERMINAL_THEME = {
  background: '#05080d',
  foreground: '#d8e6ff',
  cursor: '#d8e6ff',
  cursorAccent: '#05080d',
  selectionBackground: 'rgba(90, 140, 255, 0.25)',
  selectionForeground: '#ffffff',
  black: '#141414',
  red: '#D45B62',
  green: '#55B985',
  yellow: '#D49A47',
  blue: '#5a8cff',
  magenta: '#986781',
  cyan: '#41c7e5',
  white: '#d8e6ff',
  brightBlack: '#3a3a3a',
  brightRed: '#e54d4d',
  brightGreen: '#4cc38a',
  brightYellow: '#f5a623',
  brightBlue: '#7aaaff',
  brightMagenta: '#b07a9a',
  brightCyan: '#6fd6f0',
  brightWhite: '#ffffff'
}

function workspaceBasename(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path
}

export interface ActiveTerminalSession {
  sessionId: string
  workspacePath: string
}

export const MAX_VISIBLE_TERMINAL_SESSIONS = 4

/** Keep the workbench bounded without terminating a background PTY. */
export function keepVisibleTerminalSessions(
  current: readonly ActiveTerminalSession[],
  incoming: ActiveTerminalSession
): ActiveTerminalSession[] {
  return [
    ...current.filter((session) => session.sessionId !== incoming.sessionId),
    incoming
  ].slice(-MAX_VISIBLE_TERMINAL_SESSIONS)
}

export function TerminalWorkbench({
  workspaceSidebarWidth,
  currentWorkspacePath,
  workspaces
}: {
  workspaceSidebarWidth: number
  currentWorkspacePath?: string
  workspaces: readonly WorkspaceRecord[]
}) {
  const [sessions, setSessions] = useState<ActiveTerminalSession[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [preferredWorkspacePath, setPreferredWorkspacePath] = useState(currentWorkspacePath)
  const [busyWorkspacePath, setBusyWorkspacePath] = useState<string | null>(null)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const sessionsRef = useRef<ActiveTerminalSession[]>([])

  const updateSessions = useCallback((next: ActiveTerminalSession[]) => {
    sessionsRef.current = next
    setSessions(next)
  }, [])

  const removeSession = useCallback((sessionId: string) => {
    setSessions(prev => {
      const next = prev.filter(session => session.sessionId !== sessionId)
      if (next.length !== prev.length) {
        sessionsRef.current = next
        return next
      }
      return prev
    })
  }, [])

  const launchSession = useCallback(
    async (workspacePath: string, cliId: TerminalCliId): Promise<void> => {
      const sessionId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      setBusyWorkspacePath(workspacePath)
      setLaunchError(null)
      try {
        await window.api.terminal.create(workspacePath, sessionId, cliId)
        terminalSidebarStore.recordRecipe(
          workspacePath,
          cliId === 'default' ? undefined : cliId
        )
        updateSessions(
          keepVisibleTerminalSessions(sessionsRef.current, { sessionId, workspacePath })
        )
        setPickerOpen(false)
      } catch (error) {
        setLaunchError(error instanceof Error ? error.message : 'Could not open Terminal.')
      } finally {
        setBusyWorkspacePath((current) => (current === workspacePath ? null : current))
      }
    },
    [updateSessions]
  )

  useEffect(() => {
    window.api.terminal
      .list()
      .then((list) => {
        updateSessions(list.slice(-MAX_VISIBLE_TERMINAL_SESSIONS))
      })
      .catch(() => {})

    const unsubscribeLaunch = terminalLaunchBus.subscribe((event) => {
      if (event.type === 'launch') {
        void launchSession(event.workspacePath, event.cliId)
      } else if (event.type === 'request') {
        setPreferredWorkspacePath(event.preferredWorkspacePath)
        setLaunchError(null)
        setPickerOpen(true)
      } else if (event.type === 'attach') {
        updateSessions(
          keepVisibleTerminalSessions(sessionsRef.current, {
            sessionId: event.sessionId,
            workspacePath: event.workspacePath
          })
        )
      }
    })

    const unsubscribeExit = window.api.terminal.onExit((sessionId, _code) => {
      removeSession(sessionId)
    })

    return () => {
      unsubscribeLaunch()
      unsubscribeExit()
    }
  }, [launchSession, removeSession, updateSessions])

  const handleClose = (sessionId: string) => {
    removeSession(sessionId)
    void window.api.terminal.kill(sessionId).catch((error) => {
      console.error('[TerminalWorkbench] terminal.kill failed while closing pane', { sessionId, error })
    })
  }

  return (
    <div
      className="terminal-workbench-root"
      style={{ left: workspaceSidebarWidth }}
    >
      {pickerOpen ? (
        <section className="terminal-workbench-picker" aria-label="New Terminal Session">
          <header className="thread-home-surface-toolbar">
            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              aria-label="Back to terminal sessions"
            >
              ‹
            </button>
            <strong>New Terminal Session</strong>
            <span>Select a workspace and CLI</span>
          </header>
          <div className="terminal-workbench-picker-body">
            <TerminalSessionPicker
              workspaces={workspaces}
              preferredWorkspacePath={preferredWorkspacePath}
              busyWorkspacePath={busyWorkspacePath}
              onSelect={(workspace, cliId) => void launchSession(workspace.path, cliId)}
            />
          </div>
          {launchError && (
            <div className="terminal-workbench-picker-error" role="alert">
              {launchError}
            </div>
          )}
        </section>
      ) : sessions.length === 0 ? (
        <div className="terminal-workbench-empty">
          <div
            className="terminal-workbench-empty-icon"
            dangerouslySetInnerHTML={{ __html: emptyGhostSvg }}
          />
          <p>workspace-isolated environment</p>
          <button
            className="terminal-workbench-new-btn"
            disabled={workspaces.length === 0}
            onClick={() => {
              setPreferredWorkspacePath(currentWorkspacePath)
              setLaunchError(null)
              setPickerOpen(true)
            }}
          >
            New Terminal Session&hellip;
          </button>
          {workspaces.length === 0 && (
            <p className="terminal-workbench-empty-hint">Add a workspace first</p>
          )}
        </div>
      ) : (
        <div className="terminal-workbench-grid" data-count={sessions.length}>
          {sessions.map((session) => (
            <TerminalPane
              key={session.sessionId}
              sessionId={session.sessionId}
              workspacePath={session.workspacePath}
              onClose={() => handleClose(session.sessionId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export interface TerminalPaneProps {
  sessionId: string
  workspacePath: string
  onClose: () => void
}

export function TerminalPane({ sessionId, workspacePath, onClose }: TerminalPaneProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fitAddon = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = terminalRef.current
    if (!host) return
    let disposed = false

    term.current = new Terminal({
      cursorBlink: true,
      fontFamily: 'var(--font-mono)',
      fontSize: 14,
      theme: TUI_TERMINAL_THEME
    })

    fitAddon.current = new FitAddon()
    term.current.loadAddon(fitAddon.current)
    term.current.open(host)
    fitAddon.current.fit()

    // Restore scrollback
    window.api.terminal.getScrollback(sessionId).then(data => {
      if (!disposed && data) term.current?.write(data)
    }).catch(() => {})

    const disposableData = term.current.onData((data) => {
      window.api.terminal.write(sessionId, data)
    })

    const unsubscribeData = window.api.terminal.onData((evtSessionId, data) => {
      if (evtSessionId === sessionId) {
        term.current?.write(data)
      }
    })

    const handleResize = () => {
      if (fitAddon.current && term.current) {
        fitAddon.current.fit()
        window.api.terminal.resize(sessionId, term.current.cols, term.current.rows)
      }
    }
    window.addEventListener('resize', handleResize)

    let pendingFrame: number | null = null
    const hostObserver = new ResizeObserver(() => {
      if (pendingFrame !== null) return
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null
        if (!disposed) handleResize()
      })
    })
    hostObserver.observe(host)

    return () => {
      disposed = true
      window.api.terminal.detach(sessionId).catch(() => {})
      unsubscribeData()
      disposableData.dispose()
      term.current?.dispose()
      window.removeEventListener('resize', handleResize)
      hostObserver.disconnect()
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame)
    }
  }, [sessionId])

  return (
    <div className="terminal-panel--pane workspace-terminal-split terminal-workbench-pane-wrapper">
      <div className="terminal-panel-header">
        <span>Terminal &middot; {workspaceBasename(workspacePath)}</span>
        <button
          className="terminal-panel-close"
          type="button"
          onClick={onClose}
          aria-label="Close terminal"
        >
          &times;
        </button>
      </div>
      <div ref={terminalRef} className="terminal-panel-body" />
    </div>
  )
}
