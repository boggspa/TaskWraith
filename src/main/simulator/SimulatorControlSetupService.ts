import { execFile } from 'child_process'
import { accessSync, constants } from 'fs'
import { join } from 'path'
import type {
  SimulatorControlSetupResult,
  SimulatorControlSetupStatus
} from '../../shared/simulatorControlSetup'
import { findExecutableOnHost } from '../HostToolResolver'

const SETUP_TIMEOUT_MS = 5 * 60_000

export type SimulatorControlCommandRunner = (
  executable: string,
  args: readonly string[]
) => Promise<void>

export interface SimulatorControlSetupServiceDeps {
  platform?: NodeJS.Platform
  getUserDataPath: () => string
  findHostExecutable?: (name: string) => string | null
  isExecutable?: (filePath: string) => boolean
  run?: SimulatorControlCommandRunner
}

function defaultIsExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function defaultRun(executable: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        timeout: SETUP_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
      },
      (error) => {
        if (error) reject(error)
        else resolve()
      }
    )
  })
}

/**
 * Installs the two strictly allowlisted pieces of Simulator control support.
 *
 * The app-owned Python environment keeps this feature self-contained instead
 * of putting a global package on the user's PATH. Calls use execFile argv
 * arrays only; no renderer-supplied command reaches a shell.
 */
export class SimulatorControlSetupService {
  private readonly platform: NodeJS.Platform
  private readonly getUserDataPath: () => string
  private readonly findHostExecutable: (name: string) => string | null
  private readonly isExecutable: (filePath: string) => boolean
  private readonly run: SimulatorControlCommandRunner
  private setupInFlight: Promise<SimulatorControlSetupResult> | null = null

  constructor(deps: SimulatorControlSetupServiceDeps) {
    this.platform = deps.platform ?? process.platform
    this.getUserDataPath = deps.getUserDataPath
    this.findHostExecutable = deps.findHostExecutable ?? findExecutableOnHost
    this.isExecutable = deps.isExecutable ?? defaultIsExecutable
    this.run = deps.run ?? defaultRun
  }

  private managedVenvDirectory(): string {
    return join(this.getUserDataPath(), 'simulator-control', 'python')
  }

  private managedPythonPath(): string {
    return join(this.managedVenvDirectory(), 'bin', 'python')
  }

  private managedIdbPath(): string {
    return join(this.managedVenvDirectory(), 'bin', 'idb')
  }

  /** Resolve the managed client before falling back to a user-installed copy. */
  resolveBinary(name: string): string | null {
    if (this.platform !== 'darwin') return null
    if (name === 'idb') {
      const managed = this.managedIdbPath()
      if (this.isExecutable(managed)) return managed
    }
    return this.findHostExecutable(name)
  }

  status(enabled: boolean): SimulatorControlSetupStatus {
    const supported = this.platform === 'darwin'
    const ready =
      supported &&
      Boolean(this.resolveBinary('idb')) &&
      Boolean(this.resolveBinary('idb_companion'))

    if (!supported) {
      return {
        enabled,
        supported: false,
        ready: false,
        state: 'unsupported',
        message: 'Simulator control is available on macOS.'
      }
    }
    if (!enabled) {
      return {
        enabled: false,
        supported: true,
        ready,
        state: 'disabled',
        message: ready
          ? 'Simulator control is set up and turned off.'
          : 'Simulator control is turned off.'
      }
    }
    if (!ready) {
      return {
        enabled,
        supported: true,
        ready: false,
        state: 'setup_required',
        message: 'Set up Simulator control to use apps directly from Canvas.'
      }
    }
    return {
      enabled: true,
      supported: true,
      ready: true,
      state: 'ready',
      message: 'Ready to use in Canvas.'
    }
  }

  setup(enabled: boolean): Promise<SimulatorControlSetupResult> {
    if (this.setupInFlight) return this.setupInFlight
    this.setupInFlight = this.install(enabled).finally(() => {
      this.setupInFlight = null
    })
    return this.setupInFlight
  }

  private async install(enabled: boolean): Promise<SimulatorControlSetupResult> {
    const initial = this.status(enabled)
    if (!initial.supported) return { ok: false, ...initial, error: initial.message }
    if (initial.ready) return { ok: true, ...initial }

    try {
      if (!this.resolveBinary('idb_companion')) {
        const brew = this.findHostExecutable('brew')
        if (!brew) {
          return this.failed(
            enabled,
            'Simulator control needs Homebrew to finish setup. Try again after Homebrew is installed.'
          )
        }
        await this.run(brew, ['tap', 'facebook/fb'])
        await this.run(brew, ['install', 'idb-companion'])
      }

      if (!this.resolveBinary('idb')) {
        const python = this.findHostExecutable('python3')
        if (!python) {
          return this.failed(
            enabled,
            'Simulator control needs Python 3 to finish setup. Try again after Python is installed.'
          )
        }
        await this.run(python, ['-m', 'venv', this.managedVenvDirectory()])
        await this.run(this.managedPythonPath(), [
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          '--upgrade',
          'fb-idb'
        ])
      }

      const complete = this.status(enabled)
      if (!complete.ready) {
        return this.failed(enabled, 'Simulator control could not finish setup. Please try again.')
      }
      return { ok: true, ...complete }
    } catch {
      return this.failed(enabled, 'Simulator control could not finish setup. Please try again.')
    }
  }

  private failed(enabled: boolean, error: string): SimulatorControlSetupResult {
    return { ok: false, ...this.status(enabled), error }
  }
}
