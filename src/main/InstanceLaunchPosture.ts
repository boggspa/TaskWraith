import { randomBytes } from 'crypto'
import { basename, isAbsolute, join, parse, relative, resolve } from 'path'

/**
 * Private-profile bootstrap accepted by a packaged TaskWraith process.
 *
 * This is intentionally argv-only. In particular, a packaged app must never
 * derive a profile from TASKWRAITH_INSTANCE_ID: that variable is reserved for
 * unpackaged development instances and is ambient in many shell environments.
 */
export const PACKAGED_ISOLATED_INSTANCE_ARG = '--taskwraith-isolated-instance='
export const PACKAGED_ISOLATED_INSTANCE_SWITCH = '--taskwraith-isolated-instance'

export const PACKAGE_SMOKE_ARG = '--taskwraith-package-smoke'
export const PACKAGE_SMOKE_USER_DATA_ARG = '--taskwraith-package-smoke-user-data='
export const PACKAGE_SMOKE_USER_DATA_SWITCH = '--taskwraith-package-smoke-user-data'
export const PACKAGE_SMOKE_USER_DATA_BASENAME_PREFIX = 'taskwraith-tui-package-smoke-'

const PACKAGED_ISOLATED_INSTANCE_ID_PATTERN = /^[a-f0-9]{32,64}$/
export const PACKAGED_ISOLATED_INSTANCE_DIRECTORY_NAME = 'TaskWraith Instances'

export type InstanceLaunchPostureKind =
  | 'production'
  | 'development'
  | 'package-smoke'
  | 'packaged-isolated'
  | 'invalid'

export interface ProductionInstanceLaunchPosture {
  kind: 'production'
  isPackaged: true
  isPrivateProfile: false
}

export interface DevelopmentInstanceLaunchPosture {
  kind: 'development'
  isPackaged: false
  isPrivateProfile: true
  appName: string
  userDataPath: string
  devInstanceId: string
}

export interface PackageSmokeInstanceLaunchPosture {
  kind: 'package-smoke'
  isPackaged: true
  isPrivateProfile: true
  appName: 'TaskWraith Package Smoke'
  userDataPath: string
}

export interface PackagedIsolatedInstanceLaunchPosture {
  kind: 'packaged-isolated'
  isPackaged: true
  isPrivateProfile: true
  appName: string
  userDataPath: string
  instanceId: string
}

export interface InvalidInstanceLaunchPosture {
  kind: 'invalid'
  isPackaged: boolean
  isPrivateProfile: false
  reason:
    | 'conflicting-private-launch-arguments'
    | 'invalid-packaged-isolated-instance'
    | 'invalid-package-smoke-profile'
    | 'invalid-app-data-path'
}

export type InstanceLaunchPosture =
  | ProductionInstanceLaunchPosture
  | DevelopmentInstanceLaunchPosture
  | PackageSmokeInstanceLaunchPosture
  | PackagedIsolatedInstanceLaunchPosture
  | InvalidInstanceLaunchPosture

export type ValidInstanceLaunchPosture = Exclude<
  InstanceLaunchPosture,
  InvalidInstanceLaunchPosture
>

export interface ResolveInstanceLaunchPostureInput {
  isPackaged: boolean
  argv: readonly string[]
  /** Electron's appData path. Required for development and packaged isolation. */
  appDataPath?: string | null
  /** OS temp directory. Required only for the existing package-smoke posture. */
  temporaryDirectory?: string | null
  /**
   * The caller may pass TASKWRAITH_INSTANCE_ID here for unpackaged dev only.
   * It is deliberately ignored whenever isPackaged is true.
   */
  ambientDevInstanceId?: string | null
}

function invalid(
  isPackaged: boolean,
  reason: InvalidInstanceLaunchPosture['reason']
): InvalidInstanceLaunchPosture {
  return { kind: 'invalid', isPackaged, isPrivateProfile: false, reason }
}

function isUsableAbsoluteDirectory(value: string | null | undefined): value is string {
  if (!value || !isAbsolute(value)) return false
  const resolved = resolve(value)
  return resolved !== parse(resolved).root
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate)
  return (
    Boolean(relation) &&
    relation !== '..' &&
    !relation.startsWith('../') &&
    !relation.startsWith('..\\') &&
    !isAbsolute(relation)
  )
}

function sanitizeDevInstanceId(value: string | null | undefined): string {
  return (value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 16)
}

function privateIntentArguments(argv: readonly string[]): {
  isolated: string[]
  smoke: string[]
  smokeUserData: string[]
} {
  return {
    isolated: argv.filter(
      (argument) =>
        argument === PACKAGED_ISOLATED_INSTANCE_SWITCH ||
        argument.startsWith(PACKAGED_ISOLATED_INSTANCE_ARG)
    ),
    smoke: argv.filter((argument) => argument === PACKAGE_SMOKE_ARG),
    smokeUserData: argv.filter(
      (argument) =>
        argument === PACKAGE_SMOKE_USER_DATA_SWITCH ||
        argument.startsWith(PACKAGE_SMOKE_USER_DATA_ARG)
    )
  }
}

function resolvePackagedSmokeUserDataPath(
  smokeUserDataArguments: readonly string[],
  temporaryDirectory: string | null | undefined
): string | null {
  if (smokeUserDataArguments.length !== 1 || !isUsableAbsoluteDirectory(temporaryDirectory)) {
    return null
  }
  const rawArgument = smokeUserDataArguments[0]
  if (!rawArgument.startsWith(PACKAGE_SMOKE_USER_DATA_ARG)) return null
  const rawPath = rawArgument.slice(PACKAGE_SMOKE_USER_DATA_ARG.length)
  if (!rawPath || !isAbsolute(rawPath)) return null

  const temporaryRoot = resolve(temporaryDirectory)
  const candidate = resolve(rawPath)
  if (!isStrictDescendant(temporaryRoot, candidate)) return null
  if (!basename(candidate).startsWith(PACKAGE_SMOKE_USER_DATA_BASENAME_PREFIX)) return null
  return candidate
}

function resolvePackagedIsolatedUserDataPath(
  isolatedArguments: readonly string[],
  appDataPath: string | null | undefined
): { instanceId: string; userDataPath: string } | null {
  if (isolatedArguments.length !== 1 || !isUsableAbsoluteDirectory(appDataPath)) return null
  const rawArgument = isolatedArguments[0]
  if (!rawArgument.startsWith(PACKAGED_ISOLATED_INSTANCE_ARG)) return null
  const instanceId = rawArgument.slice(PACKAGED_ISOLATED_INSTANCE_ARG.length)
  if (!isValidPackagedIsolatedInstanceId(instanceId)) return null

  const appData = resolve(appDataPath)
  const userDataPath = resolve(appData, PACKAGED_ISOLATED_INSTANCE_DIRECTORY_NAME, instanceId)
  if (!isStrictDescendant(appData, userDataPath)) return null
  return { instanceId, userDataPath }
}

/** Generate the opaque, lowercase identifier carried only by a trusted self-launch. */
export function createPackagedIsolatedInstanceId(
  generate: () => string = () => randomBytes(24).toString('hex')
): string {
  const instanceId = generate()
  if (!isValidPackagedIsolatedInstanceId(instanceId)) {
    throw new TypeError('Generated packaged isolated instance id is invalid.')
  }
  return instanceId
}

export function isValidPackagedIsolatedInstanceId(value: unknown): value is string {
  return typeof value === 'string' && PACKAGED_ISOLATED_INSTANCE_ID_PATTERN.test(value)
}

/**
 * Resolve the one approved profile posture before Electron reads userData.
 * Invalid explicit private-launch intent is never downgraded to production.
 */
export function resolveInstanceLaunchPosture(
  input: ResolveInstanceLaunchPostureInput
): InstanceLaunchPosture {
  if (!input.isPackaged) {
    if (!isUsableAbsoluteDirectory(input.appDataPath)) {
      return invalid(false, 'invalid-app-data-path')
    }
    const devInstanceId = sanitizeDevInstanceId(input.ambientDevInstanceId)
    const appName = devInstanceId ? `TaskWraith Dev ${devInstanceId}` : 'TaskWraith Dev'
    return {
      kind: 'development',
      isPackaged: false,
      isPrivateProfile: true,
      appName,
      userDataPath: join(resolve(input.appDataPath), appName),
      devInstanceId
    }
  }

  const intent = privateIntentArguments(input.argv)
  const hasSmokeIntent = intent.smoke.length > 0 || intent.smokeUserData.length > 0
  const hasIsolatedIntent = intent.isolated.length > 0
  if (hasSmokeIntent && hasIsolatedIntent) {
    return invalid(true, 'conflicting-private-launch-arguments')
  }

  if (hasIsolatedIntent) {
    const isolated = resolvePackagedIsolatedUserDataPath(intent.isolated, input.appDataPath)
    if (!isolated) return invalid(true, 'invalid-packaged-isolated-instance')
    return {
      kind: 'packaged-isolated',
      isPackaged: true,
      isPrivateProfile: true,
      appName: `TaskWraith Instance ${isolated.instanceId}`,
      userDataPath: isolated.userDataPath,
      instanceId: isolated.instanceId
    }
  }

  if (hasSmokeIntent) {
    const userDataPath =
      intent.smoke.length === 1
        ? resolvePackagedSmokeUserDataPath(intent.smokeUserData, input.temporaryDirectory)
        : null
    if (!userDataPath) return invalid(true, 'invalid-package-smoke-profile')
    return {
      kind: 'package-smoke',
      isPackaged: true,
      isPrivateProfile: true,
      appName: 'TaskWraith Package Smoke',
      userDataPath
    }
  }

  // Do not inspect ambientDevInstanceId in this branch. A packaged production
  // launch must retain Electron's ordinary TaskWraith profile and lock.
  return { kind: 'production', isPackaged: true, isPrivateProfile: false }
}

export function isPrivateInstanceLaunchPosture(
  posture: InstanceLaunchPosture
): posture is Exclude<ValidInstanceLaunchPosture, ProductionInstanceLaunchPosture> {
  return (
    posture.kind === 'development' ||
    posture.kind === 'package-smoke' ||
    posture.kind === 'packaged-isolated'
  )
}

/**
 * Append these argv entries to a trusted helper-child spawn so it resolves the
 * exact same private profile before any userData-backed module initializes.
 */
export function buildInstanceLaunchBootstrapArgs(posture: InstanceLaunchPosture): string[] {
  switch (posture.kind) {
    case 'packaged-isolated':
      return [`${PACKAGED_ISOLATED_INSTANCE_ARG}${posture.instanceId}`]
    case 'package-smoke':
      return [PACKAGE_SMOKE_ARG, `${PACKAGE_SMOKE_USER_DATA_ARG}${posture.userDataPath}`]
    default:
      return []
  }
}
