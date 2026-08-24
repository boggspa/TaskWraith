import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import {
  HostProjectionClient,
  HostProjectionIncompatibleProtocolError
} from '../../host-client/HostProjectionClient'
import type { HostCapability, HostBootstrapWelcome } from '../../shared/hostProtocol'
import type { HostExternalLaunchCommand } from './HostExternalLaunchResolver'

const FLOOR: readonly HostCapability[] = [
  'commands',
  'receipts',
  'setup',
  'provider-catalog',
  'provider-auth',
  'history',
  'health'
]

export type HostExternalSupervisorStatus =
  | 'idle'
  | 'probing'
  | 'launching'
  | 'attached-existing'
  | 'attached-launched'
  | 'failed'
  | 'closed'
export type HostExternalEnsureResult =
  | { readonly kind: 'existing'; readonly welcome: HostBootstrapWelcome }
  | {
      readonly kind: 'launched'
      readonly pid: number | null
      readonly welcome: HostBootstrapWelcome
    }

export class HostExternalProductionModeError extends HostProjectionIncompatibleProtocolError {
  constructor() {
    super('External Host is App-mode, diagnostic, or missing production capabilities.')
    this.name = 'HostExternalProductionModeError'
  }
}

export interface HostExternalSupervisorOptions {
  readonly profilePath: string
  readonly probe?: (timeoutMs: number) => Promise<HostBootstrapWelcome>
  readonly resolveLaunch: () => Promise<HostExternalLaunchCommand | null>
  readonly spawn?: (
    executable: string,
    args: readonly string[],
    options: SpawnOptions
  ) => ChildProcess
  readonly now?: () => number
  readonly delay?: (milliseconds: number) => Promise<void>
  readonly timeoutMs?: number
  readonly pollMs?: number
  readonly probeTimeoutMs?: number
}

function assertProduction(welcome: HostBootstrapWelcome): void {
  if (
    welcome.hostVersion !== 'node-host-v1' ||
    !FLOOR.every((item) => welcome.capabilities.includes(item))
  ) {
    throw new HostExternalProductionModeError()
  }
}

async function defaultProbe(profilePath: string, timeoutMs: number): Promise<HostBootstrapWelcome> {
  const client = new HostProjectionClient({
    userDataPath: profilePath,
    client: {
      clientId: `desktop-external-${randomUUID()}`,
      clientClass: 'desktop',
      clientVersion: 'external-host-v1'
    },
    capabilities: ['bootstrap', ...FLOOR],
    connectTimeoutMs: timeoutMs,
    requestTimeoutMs: timeoutMs
  })
  try {
    return await client.connect()
  } finally {
    client.close()
  }
}

export class HostExternalSupervisor {
  private statusValue: HostExternalSupervisorStatus = 'idle'
  private operation: Promise<HostExternalEnsureResult> | null = null
  private closed = false
  private generation = 0
  private readonly closeSignal: Promise<void>
  private signalClose!: () => void

  constructor(private readonly options: HostExternalSupervisorOptions) {
    if (
      !options.profilePath ||
      options.profilePath.trim() !== options.profilePath ||
      !isAbsolute(options.profilePath) ||
      resolve(options.profilePath) !== options.profilePath ||
      typeof options.resolveLaunch !== 'function'
    )
      throw new Error('External Host options are invalid.')
    for (const value of [options.timeoutMs, options.pollMs, options.probeTimeoutMs])
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        throw new Error('External Host timing option is invalid.')
    this.closeSignal = new Promise((resolve) => {
      this.signalClose = resolve
    })
  }

  get status(): HostExternalSupervisorStatus {
    return this.statusValue
  }

  ensureAvailable(): Promise<HostExternalEnsureResult> {
    if (this.closed) return Promise.reject(new Error('External Host supervisor is closed.'))
    if (!this.operation)
      this.operation = this.ensure().finally(() => {
        this.operation = null
      })
    return this.operation
  }

  close(): void {
    if (!this.closed) {
      this.closed = true
      this.generation += 1
      this.statusValue = 'closed'
      this.signalClose()
    }
  }

  private async ensure(): Promise<HostExternalEnsureResult> {
    const generation = this.generation
    const assertOpen = () => {
      if (this.closed || generation !== this.generation)
        throw new Error('External Host supervisor is closed.')
    }
    const probe =
      this.options.probe ?? ((timeout: number) => defaultProbe(this.options.profilePath, timeout))
    const probeTimeout = this.options.probeTimeoutMs ?? 1_500
    this.statusValue = 'probing'
    try {
      const welcome = await probe(probeTimeout)
      assertProduction(welcome)
      assertOpen()
      this.statusValue = 'attached-existing'
      return { kind: 'existing', welcome }
    } catch (error) {
      if (error instanceof HostProjectionIncompatibleProtocolError) {
        this.statusValue = 'failed'
        throw error
      }
    }
    let command: HostExternalLaunchCommand | null
    try {
      command = await this.options.resolveLaunch()
    } catch (error) {
      if (!this.closed) this.statusValue = 'failed'
      throw error
    }
    assertOpen()
    if (!command) {
      this.statusValue = 'failed'
      throw new Error('External Host launch command is unavailable.')
    }
    this.statusValue = 'launching'
    const spawn = this.options.spawn ?? ((exe, args, opts) => nodeSpawn(exe, [...args], opts))
    let child: ChildProcess
    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: command.env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
    } catch (error) {
      if (!this.closed) this.statusValue = 'failed'
      throw error
    }
    let childError: Error | null = null
    let childExit: number | null = null
    let childExited = false
    child.once('error', (error) => {
      childError = error
    })
    child.once('exit', (code) => {
      childExited = true
      childExit = code
    })
    child.unref()
    const now = this.options.now ?? (() => Date.now())
    const delay =
      this.options.delay ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const deadline = now() + (this.options.timeoutMs ?? 120_000)
    while (now() < deadline) {
      await Promise.race([delay(this.options.pollMs ?? 250), this.closeSignal])
      assertOpen()
      if (childError) {
        this.statusValue = 'failed'
        throw childError
      }
      if (childExited) {
        this.statusValue = 'failed'
        throw new Error(`External Host exited ${childExit ?? 'without a code'} before readiness.`)
      }
      try {
        const welcome = await probe(probeTimeout)
        assertProduction(welcome)
        assertOpen()
        this.statusValue = 'attached-launched'
        return { kind: 'launched', pid: child.pid ?? null, welcome }
      } catch (error) {
        if (error instanceof HostProjectionIncompatibleProtocolError) {
          this.statusValue = 'failed'
          throw error
        }
      }
    }
    this.statusValue = 'failed'
    throw new Error('Timed out waiting for external Host production readiness.')
  }
}
