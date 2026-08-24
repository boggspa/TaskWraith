import * as pty from 'node-pty'
import os from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { mkdirSync } from 'fs'
import crypto from 'crypto'

export interface TerminalSession {
  sessionId: string
  workspacePath: string
  ptyProcess: pty.IPty
  scrollback: string[]
  scrollbackBytes: number
}

const MAX_SCROLLBACK_LINES = 1000
const MAX_SCROLLBACK_BYTES = 256 * 1024

export class TerminalSessionManager extends EventEmitter {
  private sessions = new Map<string, TerminalSession>()
  private userDataPath: string

  constructor(userDataPath: string) {
    super()
    this.userDataPath = userDataPath
  }

  private getWorkspaceHome(workspacePath: string): string {
    const hash = crypto.createHash('sha256').update(workspacePath).digest('hex')
    return join(this.userDataPath, 'terminal-home', hash)
  }

  create(workspacePath: string, sessionId: string): TerminalSession {
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!
    }

    const home = this.getWorkspaceHome(workspacePath)
    mkdirSync(home, { recursive: true })
    mkdirSync(join(home, 'tmp'), { recursive: true })

    const env = { ...process.env }
    env.HOME = home
    env.TMPDIR = join(home, 'tmp')
    env.XDG_CONFIG_HOME = join(home, '.config')
    env.XDG_DATA_HOME = join(home, '.local', 'share')
    env.XDG_CACHE_HOME = join(home, '.cache')

    const shellCommand = os.platform() === 'win32' ? 'powershell.exe' : env.SHELL || 'bash'

    const ptyProcess = pty.spawn(shellCommand, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: workspacePath,
      env: env as Record<string, string>
    })

    const session: TerminalSession = {
      sessionId,
      workspacePath,
      ptyProcess,
      scrollback: [],
      scrollbackBytes: 0
    }

    ptyProcess.onData((data) => {
      session.scrollback.push(data)
      session.scrollbackBytes += Buffer.byteLength(data, 'utf8')
      while (session.scrollback.length > MAX_SCROLLBACK_LINES || session.scrollbackBytes > MAX_SCROLLBACK_BYTES) {
        const removed = session.scrollback.shift()
        if (removed) {
          session.scrollbackBytes -= Buffer.byteLength(removed, 'utf8')
        }
      }
      this.emit('data', sessionId, data)
    })

    ptyProcess.onExit((e) => {
      this.emit('exit', sessionId, e.exitCode)
      this.sessions.delete(sessionId)
    })

    this.sessions.set(sessionId, session)
    return session
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.ptyProcess.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.ptyProcess.resize(cols, rows)
  }

  detach(_sessionId: string): void {
    // Detach keeps process + scrollback; it is just unmounting the view.
    // So there is nothing to do here on the backend.
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.ptyProcess.kill()
      this.sessions.delete(sessionId)
    }
  }

  list(): { sessionId: string; workspacePath: string }[] {
    return Array.from(this.sessions.values()).map(s => ({
      sessionId: s.sessionId,
      workspacePath: s.workspacePath
    }))
  }

  getScrollback(sessionId: string): string {
    const session = this.sessions.get(sessionId)
    return session ? session.scrollback.join('') : ''
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      session.ptyProcess.kill()
    }
    this.sessions.clear()
  }
}
