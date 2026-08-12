import { existsSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as nodePath from 'node:path'
import { TRANSCRIPT_MEDIA_ASSET_DIR } from '../services/TranscriptMediaAssetStore'
import {
  StudioCompanionSupervisor,
  spawnStudioCompanionProcess,
  type StudioCompanionChild,
  type StudioSupervisorEvent,
  type StudioSupervisorStatus
} from './StudioCompanionSupervisor'
import {
  resolveStudioCompanionShouldRun,
  type StudioCompanionResolution
} from './StudioCompanionSettings'
import { StudioRevisionStore } from './StudioRevisionStore'

export const STUDIO_PRODUCTION_STATE_DIR = 'studio-companion'
export const STUDIO_COMPANION_BUNDLE_DIR = 'TaskWraith Studio.app'
export const STUDIO_COMPANION_EXECUTABLE = 'TaskWraithStudioCompanion'

export interface StudioProductionPaths {
  stateDirectory: string
  allowedMediaRoot: string
  binaryPath: string
}

export interface StudioProductionLifecycleOptions {
  userDataPath: string
  resourcesPath?: string | undefined
  /** Repo root override for tests. Defaults to the main bundle's repo-relative root. */
  developmentRoot?: string | undefined
  binaryPath?: string | undefined
  settingEnabled?: boolean | undefined
  envValue?: string | undefined
  platform?: NodeJS.Platform | undefined
  onEvent?: ((event: StudioSupervisorEvent) => void) | undefined
  /** Test seam; production uses existsSync. */
  pathExists?: ((path: string) => boolean) | undefined
  /** Test seam; production uses the real piped child process launcher. */
  spawnProcess?: ((command: string, args: readonly string[]) => StudioCompanionChild) | undefined
}

export interface StudioProductionStartResult {
  resolution: StudioCompanionResolution
  paths: StudioProductionPaths
  lifecycle: StudioProductionLifecycle | null
}

export class StudioProductionError extends Error {
  readonly code: 'binary_missing'
  readonly path: string

  constructor(code: 'binary_missing', path: string) {
    super(`Studio companion binary not found at ${path}`)
    this.name = 'StudioProductionError'
    this.code = code
    this.path = path
  }
}

function defaultDevelopmentRoot(): string {
  return nodePath.join(__dirname, '..', '..')
}

export function resolveStudioCompanionBinaryPath(options: {
  resourcesPath?: string | undefined
  developmentRoot?: string | undefined
  binaryPath?: string | undefined
  pathExists?: ((path: string) => boolean) | undefined
}): string {
  if (options.binaryPath) return options.binaryPath
  const pathExists = options.pathExists ?? existsSync
  if (options.resourcesPath) {
    const bundled = nodePath.join(
      options.resourcesPath,
      'studio',
      STUDIO_COMPANION_BUNDLE_DIR,
      'Contents',
      'MacOS',
      STUDIO_COMPANION_EXECUTABLE
    )
    if (pathExists(bundled)) return bundled
  }

  const developmentRoot = options.developmentRoot ?? defaultDevelopmentRoot()
  const debug = nodePath.join(
    developmentRoot,
    'swift',
    'TaskWraithBridge',
    '.build',
    'debug',
    STUDIO_COMPANION_EXECUTABLE
  )
  if (pathExists(debug)) return debug
  return nodePath.join(
    developmentRoot,
    'swift',
    'TaskWraithBridge',
    '.build',
    'release',
    STUDIO_COMPANION_EXECUTABLE
  )
}

export function resolveStudioProductionPaths(
  options: Pick<
    StudioProductionLifecycleOptions,
    'userDataPath' | 'resourcesPath' | 'developmentRoot' | 'binaryPath' | 'pathExists'
  >
): StudioProductionPaths {
  return {
    stateDirectory: nodePath.join(options.userDataPath, STUDIO_PRODUCTION_STATE_DIR),
    // This is intentionally the exact content-addressed root already owned and
    // jailed by twmedia://. Do not widen it to userData or duplicate the scheme
    // resolver inside the companion.
    allowedMediaRoot: nodePath.join(options.userDataPath, TRANSCRIPT_MEDIA_ASSET_DIR),
    binaryPath: resolveStudioCompanionBinaryPath(options)
  }
}

/**
 * Main-process owner for one durable Studio store and one supervised companion.
 * A clean window close leaves the lifecycle restartable; dispose() is the app
 * shutdown boundary and closes both the child and its journal handle.
 */
export class StudioProductionLifecycle {
  readonly store: StudioRevisionStore
  readonly supervisor: StudioCompanionSupervisor
  readonly paths: StudioProductionPaths
  private disposed = false

  constructor(init: {
    store: StudioRevisionStore
    supervisor: StudioCompanionSupervisor
    paths: StudioProductionPaths
  }) {
    this.store = init.store
    this.supervisor = init.supervisor
    this.paths = init.paths
  }

  status(): StudioSupervisorStatus {
    return this.supervisor.status()
  }

  start(): void {
    if (this.disposed) throw new Error('StudioProductionLifecycle is disposed')
    this.supervisor.start()
  }

  stopCompanion(): Promise<void> {
    return this.supervisor.stop()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.supervisor.stop()
    await this.store.close()
  }
}

/**
 * Build and launch the production Studio companion. Disabled/unsupported
 * resolutions are side-effect free; enabled startup creates the exact media
 * root before StudioRevisionStore realpaths it, then starts one supervisor.
 */
export async function startStudioProductionLifecycle(
  options: StudioProductionLifecycleOptions
): Promise<StudioProductionStartResult> {
  const resolution = resolveStudioCompanionShouldRun(
    options.settingEnabled,
    options.envValue,
    options.platform
  )
  const paths = resolveStudioProductionPaths(options)
  if (!resolution.shouldRun) return { resolution, paths, lifecycle: null }

  const pathExists = options.pathExists ?? existsSync
  if (!pathExists(paths.binaryPath)) {
    throw new StudioProductionError('binary_missing', paths.binaryPath)
  }

  await fsPromises.mkdir(paths.allowedMediaRoot, { recursive: true })
  const store = await StudioRevisionStore.open(paths.stateDirectory, {
    allowedMediaRoots: [paths.allowedMediaRoot]
  })
  const spawnProcess = options.spawnProcess ?? spawnStudioCompanionProcess
  const supervisor = new StudioCompanionSupervisor({
    store,
    spawn: () => spawnProcess(paths.binaryPath, ['--viewer']),
    onEvent: options.onEvent
  })
  const lifecycle = new StudioProductionLifecycle({ store, supervisor, paths })
  try {
    lifecycle.start()
  } catch (error) {
    await lifecycle.dispose()
    throw error
  }
  return { resolution, paths, lifecycle }
}
