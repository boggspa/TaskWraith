import { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { terminalLaunchBus, terminalSidebarStore } from '../lib/TerminalSidebarStore'
import emptyGhostSvg from '../assets/taskwraith-ghost-monoline.svg?raw'

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

interface ActiveSession {
  sessionId: string
  workspacePath: string
}

export function TerminalWorkbench({ 
  workspaceSidebarWidth,
  currentWorkspacePath
}: { 
  workspaceSidebarWidth: number
  currentWorkspacePath?: string
}) {
  const [sessions, setSessions] = useState<ActiveSession[]>([])
  const sessionsRef = useRef<ActiveSession[]>([])

  const updateSessions = useCallback((next: ActiveSession[]) => {
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

  useEffect(() => {
    // Sync initial state
    window.api.terminal.list().then(list => {
      updateSessions(list.slice(0, 4))
    }).catch(() => {})

    const unsubscribeLaunch = terminalLaunchBus.subscribe((event) => {
      if (event.type === 'launch') {
        terminalSidebarStore.recordRecipe(event.workspacePath)
        const newSessionId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        window.api.terminal.create(event.workspacePath, newSessionId).then(() => {
          const oldestSession = sessionsRef.current.length >= 4 ? sessionsRef.current[0] : undefined
          const next = oldestSession
            ? [...sessionsRef.current.slice(1), { sessionId: newSessionId, workspacePath: event.workspacePath }]
            : [...sessionsRef.current, { sessionId: newSessionId, workspacePath: event.workspacePath }]

          updateSessions(next)

          if (oldestSession) {
            void window.api.terminal.kill(oldestSession.sessionId).catch((error) => {
              console.error('[TerminalWorkbench] terminal.kill failed while evicting pane', {
                sessionId: oldestSession.sessionId,
                error
              })
            })
          }
        }).catch((err) => {
          console.error('[TerminalWorkbench] terminal.create failed', { workspacePath: event.workspacePath, sessionId: newSessionId, error: err })
        })
      } else if (event.type === 'attach') {
        setSessions(prev => {
          if (prev.find(s => s.sessionId === event.sessionId)) return prev

          const oldestSession = prev.length >= 4 ? prev[0] : undefined
          const next = oldestSession
            ? [...prev.slice(1), { sessionId: event.sessionId, workspacePath: event.workspacePath }]
            : [...prev, { sessionId: event.sessionId, workspacePath: event.workspacePath }]

          sessionsRef.current = next
          return next
        })
      }
    })

    const unsubscribeExit = window.api.terminal.onExit((sessionId, _code) => {
      removeSession(sessionId)
    })

    return () => {
      unsubscribeLaunch()
      unsubscribeExit()
    }
  }, [updateSessions, removeSession])

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
      {sessions.length === 0 ? (
        <div className="terminal-workbench-empty">
          <div className="terminal-workbench-empty-icon" dangerouslySetInnerHTML={{ __html: emptyGhostSvg }} />
          <p>workspace-isolated environment</p>
          <button 
            className="terminal-workbench-new-btn"
            disabled={!currentWorkspacePath}
            onClick={() => { if (currentWorkspacePath) terminalLaunchBus.emit(currentWorkspacePath) }}
          >
            New Terminal Session&hellip;
          </button>
          {!currentWorkspacePath && (
            <p className="terminal-workbench-empty-hint">Open a workspace first</p>
          )}
        </div>
      ) : (
        <div className="terminal-workbench-grid" data-count={sessions.length}>
          {sessions.map(s => (
            <TerminalPane 
              key={s.sessionId} 
              sessionId={s.sessionId} 
              workspacePath={s.workspacePath} 
              onClose={() => handleClose(s.sessionId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function TerminalPane({ sessionId, workspacePath, onClose }: { sessionId: string, workspacePath: string, onClose: () => void }) {
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
