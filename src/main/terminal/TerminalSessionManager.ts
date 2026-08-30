import * as pty from 'node-pty'
import os from 'os'
import { join } from 'path'
import { EventEmitter } from 'events'
import { mkdirSync } from 'fs'
import crypto from 'crypto'
import { createInteractiveTerminalEnvironment } from './InteractiveTerminalEnvironment'
import { resolveInteractiveTerminalCli } from './TerminalCliResolver'

export interface TerminalSession {
  sessionId: string
  workspacePath: string
  ptyProcess: pty.IPty
  scrollback: string[]
  scrollbackBytes: number
}

const MAX_SCROLLBACK_LINES = 1000
const MAX_SCROLLBACK_BYTES = 256 * 1024
const TERMINAL_READINESS_FALLBACK_MS = 5_000

export interface TerminalSessionManagerOptions {
  spawn?: typeof pty.spawn
  inheritedEnv?: Readonly<Record<string, string | undefined>>
  resolveCli?: typeof resolveInteractiveTerminalCli
}

export class TerminalSessionManager extends EventEmitter {
  private sessions = new Map<string, TerminalSession>()
  private readiness = new Map<string, Promise<void>>()
  private userDataPath: string
  private spawnPty: typeof pty.spawn
  private inheritedEnv: Readonly<Record<string, string | undefined>>
  private resolveCli: typeof resolveInteractiveTerminalCli

  constructor(userDataPath: string, options: TerminalSessionManagerOptions = {}) {
    super()
    this.userDataPath = userDataPath
    this.spawnPty = options.spawn ?? pty.spawn
    this.inheritedEnv = options.inheritedEnv ?? process.env
    this.resolveCli = options.resolveCli ?? resolveInteractiveTerminalCli
  }

  private getWorkspaceHome(workspacePath: string): string {
    const hash = crypto.createHash('sha256').update(workspacePath).digest('hex')
    return join(this.userDataPath, 'terminal-home', hash)
  }

  async create(
    workspacePath: string,
    sessionId: string,
    cliId: string = 'default'
  ): Promise<TerminalSession> {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      await this.readiness.get(sessionId)
      return existing
    }

    const home = this.getWorkspaceHome(workspacePath)
    mkdirSync(home, { recursive: true })
    mkdirSync(join(home, 'tmp'), { recursive: true })

    const env = createInteractiveTerminalEnvironment({
      home,
      tmpDir: join(home, 'tmp'),
      inheritedEnv: this.inheritedEnv
    })

    const shellCommand = os.platform() === 'win32' ? 'powershell.exe' : env.SHELL || 'bash'

    const ptyProcess = this.spawnPty(shellCommand, [], {
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

    let resolveReady: () => void = () => undefined
    let rejectReady: (reason?: unknown) => void = () => undefined
    let readySettled = false
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const markReady = (): void => {
      if (readySettled) return
      readySettled = true
      if (readyTimer !== undefined) clearTimeout(readyTimer)
      resolveReady()
      this.emit('ready', sessionId)
    }
    const readyTimer = setTimeout(markReady, TERMINAL_READINESS_FALLBACK_MS)
    readyTimer.unref?.()

    ptyProcess.onData((data) => {
      markReady()
      this.appendScrollback(session, data)
      this.emit('data', sessionId, data)
    })

    ptyProcess.onExit((e) => {
      if (!readySettled) {
        readySettled = true
        if (readyTimer !== undefined) clearTimeout(readyTimer)
        rejectReady(new Error(`Terminal exited before becoming ready (code ${e.exitCode}).`))
      }
      this.emit('exit', sessionId, e.exitCode)
      this.sessions.delete(sessionId)
      this.readiness.delete(sessionId)
    })

    this.sessions.set(sessionId, session)
    this.readiness.set(sessionId, ready)

    await ready
    if (cliId && cliId !== 'default') await this.launchCli(sessionId, cliId)
    return session
  }

  private appendScrollback(session: TerminalSession, data: string): void {
    session.scrollback.push(data)
    session.scrollbackBytes += Buffer.byteLength(data, 'utf8')
    while (
      session.scrollback.length > MAX_SCROLLBACK_LINES ||
      session.scrollbackBytes > MAX_SCROLLBACK_BYTES
    ) {
      const removed = session.scrollback.shift()
      if (removed) session.scrollbackBytes -= Buffer.byteLength(removed, 'utf8')
    }
  }

  private writeDiagnostic(sessionId: string, message: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const data = `\r\n\x1b[31m[TaskWraith] ${message}\x1b[0m\r\n`
    this.appendScrollback(session, data)
    this.emit('data', sessionId, data)
  }

  /** Resolve and launch a picker-selected CLI after the shell is ready. */
  private async launchCli(sessionId: string, cliId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    try {
      const resolved = await this.resolveCli(cliId)
      if (this.sessions.get(sessionId) !== session) return
      this.write(sessionId, `${resolved.launchCommand}\r`)
    } catch (error) {
      this.writeDiagnostic(sessionId, error instanceof Error ? error.message : String(error))
    }
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
      this.readiness.delete(sessionId)
    }
  }

  list(): { sessionId: string; workspacePath: string }[] {
    return Array.from(this.sessions.values()).map((s) => ({
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
    this.readiness.clear()
  }
}
