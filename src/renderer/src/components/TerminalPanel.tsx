import { useEffect, useId, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface TerminalPanelProps {
  workspacePath: string
  onClose?: () => void
}

export function TerminalPanel({ workspacePath, onClose }: TerminalPanelProps) {
  const terminalRef = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fitAddon = useRef<FitAddon | null>(null)
  const sessionId = useId().replace(/:/g, '')

  useEffect(() => {
    if (!terminalRef.current) return
    let disposed = false
    const ptySessionId = `setup-${sessionId}`

    term.current = new Terminal({
      cursorBlink: true,
      fontFamily: 'var(--font-mono)',
      fontSize: 14,
      theme: {
        background: '#080808'
      }
    })

    fitAddon.current = new FitAddon()
    term.current.loadAddon(fitAddon.current)
    term.current.open(terminalRef.current)
    fitAddon.current.fit()

    term.current.onData((data) => {
      window.api.ptyWrite(data, ptySessionId)
    })

    window.api.onPtyData((data, eventSessionId) => {
      if (eventSessionId && eventSessionId !== ptySessionId) return
      term.current?.write(data)
    })

    window.api.onPtyExit((code, eventSessionId) => {
      if (eventSessionId && eventSessionId !== ptySessionId) return
      term.current?.write(`\r\n\x1b[33mProcess exited with code ${code}\x1b[0m\r\n`)
    })

    window.api.startPty(workspacePath, ptySessionId).catch((error) => {
      if (disposed) return
      term.current?.write(`\r\n\x1b[31m${String(error)}\x1b[0m\r\n`)
    })

    const handleResize = () => {
      if (fitAddon.current && term.current) {
        fitAddon.current.fit()
        window.api.ptyResize(term.current.cols, term.current.rows, ptySessionId)
      }
    }
    window.addEventListener('resize', handleResize)

    return () => {
      disposed = true
      window.api.stopPty(ptySessionId).catch(() => {})
      window.api.removePtyListeners()
      term.current?.dispose()
      window.removeEventListener('resize', handleResize)
    }
  }, [sessionId, workspacePath])

  useEffect(() => {
    if (!onClose) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="terminal-panel">
      <div className="terminal-panel-header">
        <span>Terminal: {workspacePath}</span>
        {onClose && (
          <button
            className="terminal-panel-close"
            type="button"
            onClick={onClose}
            aria-label="Close terminal"
          >
            Close
          </button>
        )}
      </div>
      <div ref={terminalRef} className="terminal-panel-body" />
    </div>
  )
}
