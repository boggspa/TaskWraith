import * as path from 'node:path'
import {
  CanvasEmulatorDriver,
  type CanvasEmulatorRuntimeBridge
} from '../canvas/CanvasEmulatorDriver'
import type { CanvasHostSurface, CanvasSurfaceOptions } from '../canvas/CanvasHostSurface'
import type { CanvasEmulatorGameId } from '../canvas/canvasTypes'
import {
  createEmulatorAssetRegistry,
  emulatorAssetRoot,
  loadEmulatorAssetBundle,
  type EmulatorAssetBundle,
  type EmulatorAssetRegistry
} from './EmulatorAssetManifest'
import {
  loadEmulatorPackageManifest,
  validateTwgbHomebrewDemoPackage
} from './EmulatorPackageManifest'
import type {
  EmulatorPackageManifest,
  EmulatorPackageManifestV2,
  EmulatorStateAdapterManifestV2
} from '../../shared/emulatorCanvas'
import {
  ElectronEmulatorRuntimeBridge,
  type ElectronEmulatorRuntimeBridgeDeps
} from './ElectronEmulatorRuntimeBridge'

export const BUILT_IN_EMULATOR_GAME_ID: CanvasEmulatorGameId = 'homebrew-demo'

export interface EmulatorCanvasDriverFactoryDeps {
  readonly appPath: string
  readonly resourcesPath: string
  readonly isPackaged: boolean
  readonly createSurface: (
    sessionId: string,
    surfaceHostId: number | undefined
  ) => (options: CanvasSurfaceOptions) => CanvasHostSurface
  readonly loadBundle?: (rootPath: string) => EmulatorAssetBundle
  readonly loadPackage?: (rootPath: string) => EmulatorPackageManifest
  readonly createRuntime?: (deps: ElectronEmulatorRuntimeBridgeDeps) => CanvasEmulatorRuntimeBridge
  readonly logger?: Pick<Console, 'warn'>
}

export interface CreateEmulatorCanvasDriverInput {
  readonly sessionId: string
  readonly embedded: boolean
  readonly surfaceHostId?: number
  readonly gameId?: CanvasEmulatorGameId
  readonly onSurfaceClosed?: () => void
}

interface ReviewedRuntimePackage {
  readonly registry: EmulatorAssetRegistry
  /** Deep-frozen descriptor stays cached with its verified browser asset registry. */
  readonly packageManifest: EmulatorPackageManifestV2
  /** Factory admission proves this is the exact non-null v2 adapter for the fixed game. */
  readonly stateAdapter: EmulatorStateAdapterManifestV2
}

/**
 * Build the one product-owned emulator driver factory.
 *
 * Asset loading is lazy so a damaged optional emulator bundle cannot prevent
 * the rest of TaskWraith from starting. A failed load is not cached; repairing
 * the package during development lets the next explicit open retry.
 */
export function createEmulatorCanvasDriverFactory(
  deps: EmulatorCanvasDriverFactoryDeps
): (input: CreateEmulatorCanvasDriverInput) => CanvasEmulatorDriver {
  let reviewedPackage: ReviewedRuntimePackage | null = null

  const packageForOpen = (): ReviewedRuntimePackage => {
    if (reviewedPackage) return reviewedPackage
    const root = path.join(
      emulatorAssetRoot({
        appPath: deps.appPath,
        resourcesPath: deps.resourcesPath,
        isPackaged: deps.isPackaged
      }),
      BUILT_IN_EMULATOR_GAME_ID
    )
    const bundle = (deps.loadBundle ?? loadEmulatorAssetBundle)(root)
    if (bundle.manifest.gameId !== BUILT_IN_EMULATOR_GAME_ID) {
      throw new Error('Packaged emulator bundle does not match the built-in game id.')
    }
    const descriptor = (deps.loadPackage ?? loadEmulatorPackageManifest)(root)
    const packageManifest = validateTwgbHomebrewDemoPackage(descriptor, bundle)
    const stateAdapter = packageManifest.stateAdapter
    if (stateAdapter === null) {
      throw new Error('Packaged TWGB emulator descriptor must include its reviewed state adapter.')
    }
    reviewedPackage = Object.freeze({
      registry: createEmulatorAssetRegistry([bundle]),
      packageManifest,
      stateAdapter
    })
    return reviewedPackage
  }

  return (input): CanvasEmulatorDriver => {
    if (!input.embedded) {
      throw new Error('The built-in emulator requires an embedded Canvas surface.')
    }
    const gameId = input.gameId ?? BUILT_IN_EMULATOR_GAME_ID
    if (gameId !== BUILT_IN_EMULATOR_GAME_ID) {
      throw new Error('The emulator factory refused an unreviewed game id.')
    }
    let retired = false
    const retire = (): void => {
      if (retired) return
      retired = true
      input.onSurfaceClosed?.()
    }
    const reviewed = packageForOpen()
    const runtimeDeps: ElectronEmulatorRuntimeBridgeDeps = {
      registry: reviewed.registry,
      // The bridge receives only the validated bounded adapter, never a
      // filesystem root or broader package descriptor.
      stateAdapter: reviewed.stateAdapter,
      onFatal: ({ reason }) => {
        deps.logger?.warn?.(`Emulator surface retired after a runtime failure: ${reason.message}`)
        retire()
      }
    }
    const runtime = deps.createRuntime
      ? deps.createRuntime(runtimeDeps)
      : new ElectronEmulatorRuntimeBridge(runtimeDeps)
    return new CanvasEmulatorDriver(input.sessionId, {
      gameId,
      createSurface: deps.createSurface(input.sessionId, input.surfaceHostId),
      runtime,
      onSurfaceClosed: retire
    })
  }
}
