import { app } from 'electron'
import { tmpdir } from 'os'
import {
  buildInstanceLaunchBootstrapArgs,
  PACKAGED_ISOLATED_INSTANCE_ARG,
  resolveInstanceLaunchPosture,
  type InstanceLaunchPosture
} from './InstanceLaunchPosture'
import { admitPackagedIsolatedProfileRootSync } from './InstanceProfileAdmission'
import {
  createInstanceResourceIdentity,
  type InstanceResourceIdentity
} from './InstanceResourceIdentity'
import {
  isDevStaticMcpBridgeProcessArgv,
  MCP_BRIDGE_ROUTE_FROM_ENV_ARG,
  isStaticMcpBridgeRegistrationArgv,
  parseMcpBridgeRouteFromEnv
} from './mcp/McpBridgeRoute'

// Dev (electron-vite, unpackaged) runs under the package.json name "taskwraith",
// which on macOS's case-INSENSITIVE filesystem resolves to the SAME userData
// directory as the packaged "TaskWraith" build. So a dev build and a release
// build on one Mac would otherwise share one userData — the remote identity key,
// the single-instance lock, and the relay/pairing state — making them
// indistinguishable to a paired phone (and the second instance exits on the
// shared `requestSingleInstanceLock`).
//
// This module MUST be imported FIRST in src/main/index.ts. Electron caches the
// userData path after its first read, so all packaged-private posture parsing,
// profile admission, app naming, and userData selection occur here before any
// transitive main import can resolve it.

interface EarlyAppConfigurationTarget {
  readonly isPackaged: boolean
  getPath(name: 'appData' | 'userData'): string
  setName(name: string): void
  setPath(name: 'userData', path: string): void
  exit(code?: number): void
}

export interface ResolveDevAppNamePostureInput {
  isPackaged: boolean
  argv: readonly string[]
  appDataPath: string
  temporaryDirectory: string
  env?: Readonly<Record<string, string | undefined>>
}

export interface ConfiguredEarlyInstancePosture {
  posture: Exclude<InstanceLaunchPosture, { kind: 'invalid' }>
  resourceIdentity: InstanceResourceIdentity
  bootstrapArgs: string[]
}

/**
 * A globally persisted MCP registration has exactly these two bridge switches.
 * It cannot carry a profile argument; only this narrow helper shape is allowed
 * to obtain its profile identity from the dedicated route endpoint environment.
 */
export function isStaticMcpBridgeRouteLaunch(argv: readonly string[]): boolean {
  return isStaticMcpBridgeRegistrationArgv(argv.slice(1))
}

function invalidStaticMcpBridgeRoutePosture(isPackaged: boolean): InstanceLaunchPosture {
  // Reuse the existing generic invalid-posture result rather than placing a
  // route-derived value in startup diagnostics. This is evaluated before any
  // userData profile or resource can be selected.
  return {
    kind: 'invalid',
    isPackaged,
    isPrivateProfile: false,
    reason: 'invalid-packaged-isolated-instance'
  }
}

function staticRouteMatchesPrivateProfile(
  posture: InstanceLaunchPosture,
  endpoint: { socketPath: string; isolatedInstanceId?: string }
): boolean {
  if (posture.kind !== 'development' && posture.kind !== 'packaged-isolated') return true
  const expectedSocketPath = createInstanceResourceIdentity({
    posture,
    userDataPath: posture.userDataPath
  }).geminiMcpSocketPath
  return endpoint.socketPath === expectedSocketPath
}

/**
 * Pure posture seam used before Electron userData access and by focused tests.
 * Ordinary launches never inspect the endpoint environment. An exact static
 * route bridge helper gets exactly one synthetic argv selector when its route
 * explicitly names an isolated packaged profile. An explicit empty selector
 * retains the ordinary profile; missing or malformed route authority resolves
 * as invalid before profile selection.
 */
export function resolveDevAppNamePosture(
  input: ResolveDevAppNamePostureInput
): InstanceLaunchPosture {
  const env = input.env || {}
  const launchArgs = input.argv.slice(1)
  const hasRouteSelector = launchArgs.includes(MCP_BRIDGE_ROUTE_FROM_ENV_ARG)
  const isPackagedStaticRoute = isStaticMcpBridgeRegistrationArgv(launchArgs)
  const isDevStaticRoute = isDevStaticMcpBridgeProcessArgv(input.argv)
  if (hasRouteSelector) {
    const exactRouteGrammar = input.isPackaged ? isPackagedStaticRoute : isDevStaticRoute
    if (!exactRouteGrammar) return invalidStaticMcpBridgeRoutePosture(input.isPackaged)
    // Validate the complete endpoint, full profile receipt, and isolated socket
    // identity before an empty selector could fall back to the primary profile.
    const parsedRoute = parseMcpBridgeRouteFromEnv(env)
    if (!parsedRoute.ok) return invalidStaticMcpBridgeRoutePosture(input.isPackaged)
    const routeInstanceId = input.isPackaged
      ? parsedRoute.value.endpoint.isolatedInstanceId
      : undefined
    const argv = routeInstanceId
      ? [...input.argv, `${PACKAGED_ISOLATED_INSTANCE_ARG}${routeInstanceId}`]
      : input.argv
    const posture = resolveInstanceLaunchPosture({
      isPackaged: input.isPackaged,
      argv,
      appDataPath: input.appDataPath,
      temporaryDirectory: input.temporaryDirectory,
      // This value is intentionally ignored by resolveInstanceLaunchPosture for
      // every packaged posture, including the narrow helper posture above.
      ambientDevInstanceId: env.TASKWRAITH_INSTANCE_ID
    })
    if (
      posture.kind === 'invalid' ||
      !staticRouteMatchesPrivateProfile(posture, parsedRoute.value.endpoint)
    ) {
      return invalidStaticMcpBridgeRoutePosture(input.isPackaged)
    }
    return posture
  }
  return resolveInstanceLaunchPosture({
    isPackaged: input.isPackaged,
    argv: input.argv,
    appDataPath: input.appDataPath,
    temporaryDirectory: input.temporaryDirectory,
    // This value is intentionally ignored by resolveInstanceLaunchPosture for
    // every packaged posture, including the narrow helper posture above.
    ambientDevInstanceId: env.TASKWRAITH_INSTANCE_ID
  })
}

function configureEarlyInstancePosture(
  target: EarlyAppConfigurationTarget,
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): ConfiguredEarlyInstancePosture {
  const appDataPath = target.getPath('appData')
  const posture = resolveDevAppNamePosture({
    isPackaged: target.isPackaged,
    argv,
    appDataPath,
    temporaryDirectory: tmpdir(),
    env
  })
  if (posture.kind === 'invalid') {
    throw new Error('TaskWraith refused an invalid private launch posture.')
  }

  if (posture.kind === 'packaged-isolated') {
    const admission = admitPackagedIsolatedProfileRootSync({
      appDataPath,
      instanceId: posture.instanceId
    })
    if (admission.profileRootPath !== posture.userDataPath) {
      throw new Error('TaskWraith refused an inconsistent isolated profile admission.')
    }
  }

  if (posture.kind !== 'production') {
    target.setName(posture.appName)
    target.setPath('userData', posture.userDataPath)
  }

  if (posture.kind === 'package-smoke') {
    installPackageSmokeFailureHandlers(target)
  }

  return {
    posture,
    resourceIdentity: createInstanceResourceIdentity({
      posture,
      // Private postures carry their selected path explicitly. Reading the
      // normal production path here is safe because no relocation occurs.
      userDataPath:
        posture.kind === 'production' ? target.getPath('userData') : posture.userDataPath
    }),
    bootstrapArgs: buildInstanceLaunchBootstrapArgs(posture)
  }
}

function installPackageSmokeFailureHandlers(
  target: Pick<EarlyAppConfigurationTarget, 'exit'>
): void {
  const failPackageSmoke = (kind: string, error: unknown) => {
    console.error(
      `[package-smoke] ${kind}:`,
      error instanceof Error ? error.stack || error.message : String(error)
    )
    target.exit(1)
  }
  process.once('uncaughtException', (error) => failPackageSmoke('uncaught exception', error))
  process.once('unhandledRejection', (error) => failPackageSmoke('unhandled rejection', error))
}

function failClosedStartup(error: unknown): never {
  // Do not include argv or endpoint environment values: a static route helper
  // carries endpoint credentials there. The posture/admission helpers already
  // return generic errors, but startup logs stay generic as a second boundary.
  console.error('[instance-posture] startup refused.')
  app.exit(1)
  throw error instanceof Error ? error : new Error('TaskWraith startup was refused.')
}

const configuredEarlyInstancePosture = (() => {
  try {
    return configureEarlyInstancePosture(app, process.argv, process.env)
  } catch (error) {
    return failClosedStartup(error)
  }
})()

/** Resolved once, before any other main import can read Electron userData. */
export const instanceLaunchPosture = configuredEarlyInstancePosture.posture
/** Alias kept explicit for call sites that need to emphasize startup ordering. */
export const resolvedInstanceLaunchPosture = instanceLaunchPosture
export const instanceResourceIdentity = configuredEarlyInstancePosture.resourceIdentity
export const instanceLaunchBootstrapArgs = configuredEarlyInstancePosture.bootstrapArgs

/** Existing dev-only public surface; packaged launches always expose an empty id. */
export const devInstanceId =
  instanceLaunchPosture.kind === 'development' ? instanceLaunchPosture.devInstanceId : ''

function stableOffset(value: string, modulo: number): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % modulo
  }
  return hash
}

/**
 * Port shift for this instance's embedded relay. Development retains its old
 * predictable 1..99 mapping. Packaged isolated profiles occupy a separate,
 * deterministic range so they cannot reuse ordinary/dev relay ports.
 */
export function instanceRelayPortOffset(posture: InstanceLaunchPosture): number {
  if (posture.kind === 'development') {
    if (!posture.devInstanceId) return 0
    const numeric = Number(posture.devInstanceId)
    if (Number.isInteger(numeric) && numeric > 0 && numeric <= 99) return numeric
    return stableOffset(posture.devInstanceId, 99) + 1
  }
  if (posture.kind === 'packaged-isolated') {
    // Avoid production (0) and dev's 1..99 range. This remains below both
    // default relay and HTTPS-port ceilings while making the identity stable.
    return stableOffset(posture.instanceId, 10_000) + 1_000
  }
  return 0
}

/** Compatibility export consumed by index.ts's existing relay-port setup. */
export function devInstanceRelayPortOffset(): number {
  return instanceRelayPortOffset(instanceLaunchPosture)
}
