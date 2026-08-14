import type { KillController } from '../localServers/killer'

export interface HostCommandProcessTreeJoinOptions {
  signal: (signal: 'SIGTERM' | 'SIGKILL') => void
  isAlive: () => boolean
  wait?: (ms: number) => Promise<void>
  killGraceMs?: number
  pollMs?: number
}

export interface HostCommandProcessTreeJoinFactoryOptions {
  platform?: NodeJS.Platform
  wait?: (ms: number) => Promise<void>
  killGraceMs?: number
  pollMs?: number
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function processTargetExists(target: number): boolean {
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function posixProcessGroupController(processGroupId: number): KillController {
  const target = -processGroupId
  return {
    signal: (signal) => process.kill(target, signal),
    isAlive: () => processTargetExists(target)
  }
}

/**
 * Joins the complete process tree behind a host command after its root child
 * closes. Root close alone is not settlement: a shell can leave ffmpeg, npm,
 * or another mutating descendant alive. The join therefore terminates any
 * survivors and remains pending until the exact tree target is observably gone.
 */
export class HostCommandProcessTreeJoin {
  private readonly wait: (ms: number) => Promise<void>
  private readonly killGraceMs: number
  private readonly pollMs: number
  private joinPromise: Promise<void> | null = null

  constructor(private readonly options: HostCommandProcessTreeJoinOptions) {
    this.wait = options.wait ?? wait
    this.killGraceMs = options.killGraceMs ?? 4_000
    this.pollMs = options.pollMs ?? 50
    if (!Number.isFinite(this.killGraceMs) || this.killGraceMs < 0) {
      throw new Error('Host command process-tree kill grace must be finite and non-negative.')
    }
    if (!Number.isFinite(this.pollMs) || this.pollMs <= 0) {
      throw new Error('Host command process-tree poll interval must be finite and positive.')
    }
  }

  joinAfterRootClose(): Promise<void> {
    this.joinPromise ??= this.join()
    return this.joinPromise
  }

  private async join(): Promise<void> {
    if (!this.options.isAlive()) return
    this.trySignal('SIGTERM')
    await this.wait(this.killGraceMs)
    if (this.options.isAlive()) this.trySignal('SIGKILL')
    while (this.options.isAlive()) {
      await this.wait(this.pollMs)
    }
  }

  private trySignal(signal: 'SIGTERM' | 'SIGKILL'): void {
    try {
      this.options.signal(signal)
    } catch {
      // Signal acknowledgement is not death evidence. The observation loop is
      // authoritative and deliberately stays pending while the tree is live.
    }
  }
}

/**
 * A brokered command is spawned as a fresh POSIX process group, making this
 * controller an exact tree target rather than a best-effort walk of mutable
 * descendant PIDs. Windows returns no proof until the host owns a Job Object.
 */
export function createHostCommandProcessTreeJoin(
  pid: number,
  options: HostCommandProcessTreeJoinFactoryOptions = {}
): HostCommandProcessTreeJoin | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error('Host command process-tree join requires an exact child PID.')
  }
  const platform = options.platform ?? process.platform
  // A Windows PID is not an exact post-parent-close tree identity. taskkill /T
  // can request termination while the root is live, but once it closes a PID
  // probe cannot prove that reparented descendants are gone. Do not mint false
  // quiescence evidence without a Job Object.
  if (platform === 'win32') return null
  const controller = posixProcessGroupController(pid)
  return new HostCommandProcessTreeJoin({
    signal: (signal) => controller.signal(signal),
    isAlive: () => controller.isAlive(),
    ...(options.wait ? { wait: options.wait } : {}),
    ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {})
  })
}
