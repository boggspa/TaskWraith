import { useEffect, useId, useRef, useMemo } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export type TerminalPanelVariant = 'inspector' | 'pane'

interface TerminalPanelProps {
  workspacePath: string
  onClose?: () => void
  className?: string
  variant?: TerminalPanelVariant
  onTerminalReady?: () => void
  ptySessionId?: string
}

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

const INSPECTOR_TERMINAL_THEME = {
  background: '#080808'
}

function workspaceBasename(path: string): string {
  // Normalize both POSIX and Windows separators.
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path
}

export function TerminalPanel({
  workspacePath,
  onClose,
  className,
  variant = 'inspector',
  onTerminalReady,
  ptySessionId: propPtySessionId
}: TerminalPanelProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fitAddon = useRef<FitAddon | null>(null)
  const sessionId = useId().replace(/:/g, '')
  const isPane = variant === 'pane'

  const theme = useMemo(() => (isPane ? TUI_TERMINAL_THEME : INSPECTOR_TERMINAL_THEME), [isPane])

  useEffect(() => {
    const host = terminalRef.current
    if (!host) return
    let disposed = false
    // Use provided sessionId, or generate one
    const effectivePtySessionId = propPtySessionId || `setup-${sessionId}`

    term.current = new Terminal({
      cursorBlink: true,
      fontFamily: 'var(--font-mono)',
      fontSize: 14,
      theme
    })

    fitAddon.current = new FitAddon()
    term.current.loadAddon(fitAddon.current)
    term.current.open(host)
    fitAddon.current.fit()

    term.current.onData((data) => {
      window.api.ptyWrite(data, effectivePtySessionId)
    })

    const unsubscribePtyData = window.api.onPtyData((data, eventSessionId) => {
      if (eventSessionId && eventSessionId !== effectivePtySessionId && eventSessionId !== 'default') return
      term.current?.write(data)
    })

    const unsubscribePtyExit = window.api.onPtyExit((code, eventSessionId) => {
      if (eventSessionId && eventSessionId !== effectivePtySessionId && eventSessionId !== 'default') return
      term.current?.write(`\r\n\x1b[33mProcess exited with code ${code}\x1b[0m\r\n`)
    })

    window.api.startPty(workspacePath, effectivePtySessionId)
      .then(() => {
        if (disposed) return
        onTerminalReady?.()
      })
      .catch((error) => {
        if (disposed) return
        term.current?.write(`\r\n\x1b[31m${String(error)}\x1b[0m\r\n`)
      })

    const handleResize = () => {
      if (fitAddon.current && term.current) {
        fitAddon.current.fit()
        window.api.ptyResize(term.current.cols, term.current.rows, effectivePtySessionId)
      }
    }
    window.addEventListener('resize', handleResize)

    // The workspace pane is drag-resizable (`--workspace-terminal-height`),
    // which fires no window resize — without this the grid keeps the row count
    // it was opened at, so the shell wraps and scrolls against a stale height.
    // rAF-coalesced because a drag emits observations at pointer rate.
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
      window.api.stopPty(effectivePtySessionId).catch(() => {})
      unsubscribePtyData()
      unsubscribePtyExit()
      term.current?.dispose()
      window.removeEventListener('resize', handleResize)
      hostObserver.disconnect()
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame)
    }
  }, [sessionId, workspacePath, theme])

  useEffect(() => {
    if (!onClose) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const rootClass = [className ?? 'terminal-panel', isPane ? 'terminal-panel--pane' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass}>
      <div className="terminal-panel-header">
        {isPane ? (
          <span>Terminal · {workspaceBasename(workspacePath)}</span>
        ) : (
          <span>Terminal: {workspacePath}</span>
        )}
        {onClose && (
          <button
            className="terminal-panel-close"
            type="button"
            onClick={onClose}
            aria-label="Close terminal"
          >
            {isPane ? '×' : 'Close'}
          </button>
        )}
      </div>
      <div ref={terminalRef} className="terminal-panel-body" />
    </div>
  )
}
