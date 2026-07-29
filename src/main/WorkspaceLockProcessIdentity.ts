import { execFile as nodeExecFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { BridgeDaemonClient } from './BridgeDaemonClient'
import { createNativeProcessStartedAtResolver } from './nativeWindow/NativeProcessIdentityResolver'
import type { WorkspaceLockProcessObservation } from './workLocks/WorkspaceLockTypes'

const execFileAsync = promisify(nodeExecFile)

interface PrivateDarwinIdentityDaemon {
  start(): Promise<unknown>
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>
  dispose(): void
}

export interface WorkspaceLockProcessIdentityDependencies {
  readFile(path: string, encoding: BufferEncoding): Promise<string>
  execFile(
    executable: string,
    args: readonly string[],
    options: { windowsHide: boolean; timeout: number }
  ): Promise<{ stdout: string }>
  processKill(pid: number, signal: 0): void
  createDarwinDaemon(): PrivateDarwinIdentityDaemon
}

export interface WorkspaceLockProcessIdentityServiceOptions {
  platform?: NodeJS.Platform
  selfPid?: number
  windowsRoot?: string
  dependencies?: Partial<WorkspaceLockProcessIdentityDependencies>
}

const NODE_DEPENDENCIES: WorkspaceLockProcessIdentityDependencies = {
  readFile: (path, encoding) => nodeFs.readFile(path, encoding),
  execFile: async (executable, args, options) => {
    const result = await execFileAsync(executable, [...args], options)
    return { stdout: String(result.stdout || '') }
  },
  processKill: (pid, signal) => process.kill(pid, signal),
  createDarwinDaemon: () =>
    new BridgeDaemonClient({
      requestTimeoutMs: 2_000,
      // This private process is an identity oracle only. It has no inbound
      // action router and therefore cannot become a second Screen Watch host.
      onRequest: () => {
        throw new Error('Workspace-lock identity daemon does not accept inbound actions.')
      }
    })
}

/**
 * Main-owned exact process-birth observer for the durable lock authority.
 *
 * Darwin uses a private copy of the bundled Swift bridge solely for
 * proc_bsdinfo. Linux binds PID to boot-id + /proc start ticks. Windows uses
 * the fixed system PowerShell to read the process creation timestamp. An
 * unavailable identity never degrades to PID-only liveness.
 */
export class WorkspaceLockProcessIdentityService {
  private readonly platform: NodeJS.Platform
  private readonly selfPid: number
  private readonly windowsRoot: string
  private readonly dependencies: WorkspaceLockProcessIdentityDependencies
  private darwinDaemon: PrivateDarwinIdentityDaemon | null = null
  private darwinResolver: ((pid: number) => Promise<string | null>) | null = null
  private selfIdentity: string | null = null
  private linuxBootId: string | null | undefined

  constructor(options: WorkspaceLockProcessIdentityServiceOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.selfPid = options.selfPid ?? process.pid
    this.windowsRoot = options.windowsRoot || process.env.SystemRoot || 'C:\\Windows'
    this.dependencies = { ...NODE_DEPENDENCIES, ...(options.dependencies || {}) }
  }

  async initialize(): Promise<string> {
    if (this.selfIdentity) return this.selfIdentity
    if (this.platform === 'darwin') {
      const daemon = this.dependencies.createDarwinDaemon()
      await daemon.start()
      this.darwinDaemon = daemon
      this.darwinResolver = createNativeProcessStartedAtResolver({
        daemon,
        platform: 'darwin',
        timeoutMs: 2_000
      })
    }
    const observation = await this.observeUncached(this.selfPid)
    if (observation.state !== 'live') {
      this.dispose()
      throw new Error(
        `Workspace-lock process identity is unavailable for the main process (${observation.state}).`
      )
    }
    this.selfIdentity = observation.processBirthIdentity
    return observation.processBirthIdentity
  }

  currentProcessIdentity(): string {
    if (!this.selfIdentity) {
      throw new Error('Workspace-lock process identity service has not initialized.')
    }
    return this.selfIdentity
  }

  async observe(pid: number): Promise<WorkspaceLockProcessObservation> {
    if (!Number.isSafeInteger(pid) || pid <= 1) return { state: 'identity_unavailable' }
    if (pid === this.selfPid && this.selfIdentity) {
      return { state: 'live', processBirthIdentity: this.selfIdentity }
    }
    return this.observeUncached(pid)
  }

  dispose(): void {
    this.darwinDaemon?.dispose()
    this.darwinDaemon = null
    this.darwinResolver = null
  }

  private async observeUncached(pid: number): Promise<WorkspaceLockProcessObservation> {
    if (!Number.isSafeInteger(pid) || pid <= 1) return { state: 'identity_unavailable' }
    try {
      const rawIdentity =
        this.platform === 'darwin'
          ? await this.observeDarwin(pid)
          : this.platform === 'linux'
            ? await this.observeLinux(pid)
            : this.platform === 'win32'
              ? await this.observeWindows(pid)
              : null
      if (rawIdentity) {
        return {
          state: 'live',
          processBirthIdentity: digestProcessIdentity(this.platform, pid, rawIdentity)
        }
      }
    } catch (error) {
      if (definitelyMissingProcess(error)) return { state: 'dead' }
    }
    return this.definiteDeadObservation(pid)
  }

  private async observeDarwin(pid: number): Promise<string | null> {
    return this.darwinResolver?.(pid) ?? null
  }

  private async observeLinux(pid: number): Promise<string | null> {
    if (this.linuxBootId === undefined) {
      try {
        this.linuxBootId = (
          await this.dependencies.readFile('/proc/sys/kernel/random/boot_id', 'utf8')
        ).trim()
      } catch {
        this.linuxBootId = null
      }
    }
    if (!this.linuxBootId) return null
    const stat = await this.dependencies.readFile(`/proc/${pid}/stat`, 'utf8')
    const endName = stat.lastIndexOf(')')
    if (endName < 0) return null
    const fieldsAfterName = stat
      .slice(endName + 2)
      .trim()
      .split(/\s+/)
    // proc(5): field 22 (starttime), with field 3 at index zero here.
    const startTicks = fieldsAfterName[19]
    return /^\d+$/.test(startTicks || '') ? `${this.linuxBootId}:${startTicks}` : null
  }

  private async observeWindows(pid: number): Promise<string | null> {
    const powershell = join(
      this.windowsRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
    const script = [
      '$ErrorActionPreference = "Stop"',
      `$p = Get-Process -Id ${pid}`,
      '[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)'
    ].join('; ')
    const { stdout } = await this.dependencies.execFile(
      powershell,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 2_000 }
    )
    const ticks = stdout.trim()
    return /^\d+$/.test(ticks) && ticks !== '0' ? ticks : null
  }

  private definiteDeadObservation(pid: number): WorkspaceLockProcessObservation {
    try {
      this.dependencies.processKill(pid, 0)
      return { state: 'identity_unavailable' }
    } catch (error) {
      return definitelyMissingProcess(error) ? { state: 'dead' } : { state: 'identity_unavailable' }
    }
  }
}

function digestProcessIdentity(platform: NodeJS.Platform, pid: number, identity: string): string {
  return createHash('sha256')
    .update(`taskwraith-work-lock-v1\0${platform}\0${pid}\0${identity}`, 'utf8')
    .digest('hex')
}

function definitelyMissingProcess(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ESRCH'
  )
}
