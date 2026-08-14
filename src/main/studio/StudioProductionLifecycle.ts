import { existsSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as nodePath from 'node:path'
import { TRANSCRIPT_MEDIA_ASSET_DIR } from '../services/TranscriptMediaAssetStore'
import {
  StudioCompanionSupervisor,
  spawnStudioCompanionProcess,
  type StudioCompanionChild,
  type StudioHostOpenMediaOutcome,
  type StudioHostSetEffectPreviewOutcome,
  type StudioHostSetTranscriptOutcome,
  type StudioSupervisorEvent,
  type StudioSupervisorStatus
} from './StudioCompanionSupervisor'
import { StudioEffectPreviewError, loadStudioEffectPreview } from './StudioEffectPreviewSource'
import {
  resolveStudioCompanionShouldRun,
  type StudioCompanionResolution
} from './StudioCompanionSettings'
import type { StudioMediaAsset, StudioTranscript } from './StudioProtocol'
import { StudioRevisionStore } from './StudioRevisionStore'

export const STUDIO_PRODUCTION_STATE_DIR = 'studio-companion'
/** Subdirectory of the Studio state directory holding imported effect-preview LUTs. */
export const STUDIO_EFFECT_PREVIEW_DIR = 'effect-previews'
export const STUDIO_COMPANION_BUNDLE_DIR = 'TaskWraith Studio.app'
export const STUDIO_COMPANION_EXECUTABLE = 'TaskWraithStudioCompanion'

export interface StudioProductionPaths {
  stateDirectory: string
  allowedMediaRoot: string
  /**
   * Studio-owned jail for imported effect-preview LUTs.
   *
   * Deliberately NOT `allowedMediaRoot`. That root is the chat-owned, ledgered
   * `transcript-media` CAS: every legitimate entry is `<sha[0:2]>/<sha>.<ext>`
   * with `ext` drawn from a closed media-MIME allowlist, so a `.cube` can never
   * live there. Jailing effect previews to it left `setEffectPreview` with an
   * EMPTY satisfiable input set — every operator-chosen file was refused
   * `path_outside_allowed_roots`, and only the null-clear branch was reachable.
   *
   * It is also the wrong place to import INTO: that root is erasure-governed,
   * and a global media purge enumerates it and fails closed on any surviving
   * entry, so a LUT import racing a purge would break "erase all media".
   */
  effectPreviewRoot: string
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
    // Studio-owned and purge-neutral: nothing else enumerates or erases it, so
    // an imported LUT survives independently of chat media lifetime.
    effectPreviewRoot: nodePath.join(
      options.userDataPath,
      STUDIO_PRODUCTION_STATE_DIR,
      STUDIO_EFFECT_PREVIEW_DIR
    ),
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

  openMedia(asset: StudioMediaAsset): Promise<StudioHostOpenMediaOutcome> {
    if (this.disposed) throw new Error('StudioProductionLifecycle is disposed')
    return this.supervisor.openMedia(asset)
  }

  setTranscript(transcript: StudioTranscript): Promise<StudioHostSetTranscriptOutcome> {
    if (this.disposed) throw new Error('StudioProductionLifecycle is disposed')
    return this.supervisor.setTranscript(transcript)
  }

  /**
   * Apply an operator-chosen external `.cube` as the effect preview, or clear
   * it with null.
   *
   * This is the host-owned seam, and the path stops HERE: the file is validated
   * and read against this lifecycle's own owned media root, and only the
   * verified inline payload continues to the store and the companion. A refusal
   * is returned as a typed outcome carrying the exact rejection code rather than
   * throwing, because a bad LUT is an ordinary operator mistake.
   */
  async setEffectPreview(cubePath: string | null): Promise<StudioHostSetEffectPreviewOutcome> {
    if (this.disposed) throw new Error('StudioProductionLifecycle is disposed')
    if (cubePath === null) return this.supervisor.setEffectPreview(null)

    let preview
    try {
      preview = loadStudioEffectPreview({
        path: cubePath,
        // The Studio-owned import root, NOT allowedMediaRoot. See
        // StudioProductionPaths.effectPreviewRoot: a `.cube` cannot exist under
        // the transcript-media CAS, so jailing here to allowedMediaRoot made
        // this method unsatisfiable for every possible input.
        allowedMediaRoots: [this.paths.effectPreviewRoot]
      })
    } catch (error) {
      if (error instanceof StudioEffectPreviewError) {
        return {
          ok: false,
          code: 'invalid_params',
          message: `${error.code}: ${error.message}`,
          currentRevision: this.store.revision
        }
      }
      throw error
    }
    return this.supervisor.setEffectPreview(preview)
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
  await fsPromises.mkdir(paths.effectPreviewRoot, { recursive: true })
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
