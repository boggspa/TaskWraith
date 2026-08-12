import { randomUUID } from 'crypto'
import os from 'os'
import * as pty from 'node-pty'

/*
 * Remote workspace terminal — the PTY registry behind the paired-device
 * terminal verbs. A phone drives a REAL shell in a registered workspace's
 * cwd, so the trust story is deliberately triple-gated at the call sites
 * (workspace remote fileWrite capability + the standard shellCommands
 * approval — Mac-authoritative, phone-answerable, ledger-recorded — + the
 * phone's own per-device toggle and elevation sheet); this module only
 * manages sessions.
 *
 * Output is a polled ring buffer rather than a push stream: the phone reads
 * `(afterSeq)` while its terminal view is open, which keeps the wire surface
 * to five plain request/ack verbs and makes disconnects harmless — a ring of
 * recent chunks survives a missed poll, and an abandoned session reaps on
 * the idle sweep. The workspace arrives as a REGISTERED PATH resolved by the
 * caller from the workspace id — a phone can never supply a path (the git
 * write-actions contract).
 */

export interface RemoteTerminalChunk {
  seq: number
  dataBase64: string
}

interface RemoteTerminalSession {
  terminalId: string
  workspaceId: string
  workspacePath: string
  process: pty.IPty
  chunks: RemoteTerminalChunk[]
  nextSeq: number
  bufferedBytes: number
  lastActivityMs: number
  exited: boolean
  exitCode: number | null
}

const MAX_SESSIONS = 3
const MAX_BUFFER_BYTES = 512 * 1024
const IDLE_TIMEOUT_MS = 10 * 60 * 1000
const MAX_INPUT_BYTES = 8 * 1024

export class RemoteTerminalService {
  private readonly sessions = new Map<string, RemoteTerminalSession>()
  private readonly now: () => number
  private readonly spawn: typeof pty.spawn

  constructor(options: { now?: () => number; spawn?: typeof pty.spawn } = {}) {
    this.now = options.now ?? Date.now
    this.spawn = options.spawn ?? pty.spawn
  }

  open(input: {
    workspaceId: string
    workspacePath: string
    cols?: number
    rows?: number
  }): { ok: true; terminalId: string } | { ok: false; reason: string } {
    this.sweep()
    if (this.sessions.size >= MAX_SESSIONS) {
      return { ok: false, reason: `At most ${MAX_SESSIONS} remote terminals may be open.` }
    }
    const cols = boundedDim(input.cols, 20, 400, 80)
    const rows = boundedDim(input.rows, 5, 200, 24)
    const shellCommand = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash'
    let processHandle: pty.IPty
    try {
      processHandle = this.spawn(shellCommand, [], {
        name: 'xterm-color',
        cols,
        rows,
        cwd: input.workspacePath,
        env: process.env as Record<string, string>
      })
    } catch (error) {
      return {
        ok: false,
        reason: `Shell could not start: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    const terminalId = `terminal-${randomUUID()}`
    const session: RemoteTerminalSession = {
      terminalId,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      process: processHandle,
      chunks: [],
      nextSeq: 1,
      bufferedBytes: 0,
      lastActivityMs: this.now(),
      exited: false,
      exitCode: null
    }
    processHandle.onData((data) => this.append(session, Buffer.from(data, 'utf8')))
    processHandle.onExit(({ exitCode }) => {
      session.exited = true
      session.exitCode = exitCode
      this.append(session, Buffer.from(`\r\n[shell exited: ${exitCode}]\r\n`, 'utf8'))
    })
    this.sessions.set(terminalId, session)
    return { ok: true, terminalId }
  }

  input(terminalId: string, dataBase64: string): { ok: boolean; reason?: string } {
    const session = this.sessions.get(terminalId)
    if (!session) return { ok: false, reason: 'Terminal session not found' }
    if (session.exited) return { ok: false, reason: 'Shell has exited' }
    // Node's base64 decoder is LENIENT (it never throws — it decodes the
    // subset it can), so validity is a shape check, not a try/catch.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataBase64) || dataBase64.length % 4 !== 0) {
      return { ok: false, reason: 'Input was not valid base64' }
    }
    const data = Buffer.from(dataBase64, 'base64')
    if (data.length === 0 || data.length > MAX_INPUT_BYTES) {
      return { ok: false, reason: 'Input size out of bounds' }
    }
    session.lastActivityMs = this.now()
    session.process.write(data.toString('utf8'))
    return { ok: true }
  }

  resize(terminalId: string, cols?: number, rows?: number): { ok: boolean; reason?: string } {
    const session = this.sessions.get(terminalId)
    if (!session) return { ok: false, reason: 'Terminal session not found' }
    session.lastActivityMs = this.now()
    session.process.resize(boundedDim(cols, 20, 400, 80), boundedDim(rows, 5, 200, 24))
    return { ok: true }
  }

  read(
    terminalId: string,
    afterSeq: number
  ):
    | { ok: true; chunks: RemoteTerminalChunk[]; latestSeq: number; exited: boolean }
    | { ok: false; reason: string } {
    const session = this.sessions.get(terminalId)
    if (!session) return { ok: false, reason: 'Terminal session not found' }
    session.lastActivityMs = this.now()
    const from = Number.isFinite(afterSeq) ? afterSeq : 0
    return {
      ok: true,
      chunks: session.chunks.filter((chunk) => chunk.seq > from),
      latestSeq: session.nextSeq - 1,
      exited: session.exited
    }
  }

  close(terminalId: string): { ok: boolean } {
    const session = this.sessions.get(terminalId)
    if (!session) return { ok: true }
    try {
      session.process.kill()
    } catch {
      // Already dead is fine — reap regardless.
    }
    this.sessions.delete(terminalId)
    return { ok: true }
  }

  closeAll(): void {
    for (const terminalId of [...this.sessions.keys()]) this.close(terminalId)
  }

  sessionCount(): number {
    this.sweep()
    return this.sessions.size
  }

  private append(session: RemoteTerminalSession, data: Buffer): void {
    session.chunks.push({ seq: session.nextSeq, dataBase64: data.toString('base64') })
    session.nextSeq += 1
    session.bufferedBytes += data.length
    // Ring: drop oldest once over budget. A phone that missed them scrolled
    // past anyway; the shell's live state is what matters.
    while (session.bufferedBytes > MAX_BUFFER_BYTES && session.chunks.length > 1) {
      const dropped = session.chunks.shift()
      if (dropped) {
        session.bufferedBytes -= Buffer.from(dropped.dataBase64, 'base64').length
      }
    }
  }

  private sweep(): void {
    const cutoff = this.now() - IDLE_TIMEOUT_MS
    for (const [terminalId, session] of this.sessions) {
      if (session.lastActivityMs < cutoff || (session.exited && session.chunks.length === 0)) {
        this.close(terminalId)
      }
    }
  }
}

function boundedDim(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(value)))
}
