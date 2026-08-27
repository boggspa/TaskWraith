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
  const rootRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fitAddon = useRef<FitAddon | null>(null)
  const sessionId = useId().replace(/:/g, '')
  const isPane = variant === 'pane'

  const theme = useMemo(() => (isPane ? TUI_TERMINAL_THEME : INSPECTOR_TERMINAL_THEME), [isPane])

  // The PTY this panel owns, derived during render rather than inside the
  // setup effect.
  //
  // It used to be computed from `propPtySessionId` *inside* that effect while
  // the dependency list named only [sessionId, workspacePath, theme]. So
  // switching between two chats in the SAME workspace changed the id without
  // re-running the effect: the panel kept writing to — and reading from — the
  // previous chat's shell, and the new chat's shell was never started. Naming
  // the id here is what makes it a real dependency below.
  const effectivePtySessionId = propPtySessionId || `setup-${sessionId}`

  // `onTerminalReady` is deliberately kept out of the setup effect's deps via
  // a ref. The composer's callback closes over its pending-command map and
  // clears that map when it fires, so its identity changes on every flush —
  // depending on it directly would tear the PTY down and respawn it the moment
  // the terminal reported ready, in a loop. A ref keeps exhaustive-deps honest
  // instead of silencing it, and seeding it with the first value means an
  // early `startPty` resolve cannot miss the callback.
  const onTerminalReadyRef = useRef(onTerminalReady)
  useEffect(() => {
    onTerminalReadyRef.current = onTerminalReady
  }, [onTerminalReady])

  useEffect(() => {
    const host = terminalRef.current
    if (!host) return
    let disposed = false

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
        onTerminalReadyRef.current?.()
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

    let pendingFrame: number | null = null
    const coalescedResize = () => {
      if (pendingFrame !== null) return
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = null
        if (!disposed) handleResize()
      })
    }

    window.addEventListener('resize', coalescedResize)

    // The workspace pane is drag-resizable (`--workspace-terminal-height`),
    // which fires no window resize — without this the grid keeps the row count
    // it was opened at, so the shell wraps and scrolls against a stale height.
    // rAF-coalesced because a drag emits observations at pointer rate.
    const hostObserver = new ResizeObserver(coalescedResize)
    hostObserver.observe(host)

    return () => {
      disposed = true
      window.api.stopPty(effectivePtySessionId).catch(() => {})
      unsubscribePtyData()
      unsubscribePtyExit()
      term.current?.dispose()
      window.removeEventListener('resize', coalescedResize)
      hostObserver.disconnect()
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame)
    }
    // `effectivePtySessionId` replaces the old `sessionId` entry: it already
    // folds in the generated fallback, and it is the value every start/write/
    // resize/stop call routes on. The cleanup closes over the OUTGOING id, so
    // a chat switch stops exactly the shell it started.
  }, [effectivePtySessionId, workspacePath, theme])

  // Escape-to-close is scoped to THIS panel, not the document.
  //
  // A document listener meant any Escape anywhere in the app closed the
  // terminal — dismissing a picker, a popover or a modal took the shell down
  // with it. Listening on the panel root instead means the key only counts
  // when it was pressed inside the panel (the close button, the header, or
  // the terminal itself), which is what "Escape closes the focused terminal"
  // was always supposed to mean.
  //
  // The pane variant additionally leaves Escape to the shell: it is a
  // long-lived terminal where Escape belongs to whatever is running (vim,
  // less, fzf), so closing the whole pane on it would be data loss. Panes
  // have a visible × instead. The inspector's setup terminal keeps its
  // modal-style Escape-to-dismiss unchanged.
  useEffect(() => {
    if (!onClose) return
    const root = rootRef.current
    if (!root) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (isPane && terminalRef.current?.contains(event.target as Node)) return
      onClose()
    }
    root.addEventListener('keydown', onKeyDown)
    return () => root.removeEventListener('keydown', onKeyDown)
  }, [onClose, isPane])

  const rootClass = [className ?? 'terminal-panel', isPane ? 'terminal-panel--pane' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass} ref={rootRef}>
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
