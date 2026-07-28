import { createHash, randomBytes } from 'crypto'
import { isAbsolute, parse, relative, resolve } from 'path'
import type { InstanceLaunchPosture, ValidInstanceLaunchPosture } from './InstanceLaunchPosture'

const INSTANCE_RESOURCE_EPOCH_PATTERN = /^[a-f0-9]{32,64}$/

/**
 * A profile-local address book for resources that must never cross instance
 * boundaries. The runtime still owns creating these files and advancing the
 * numeric diagnostic epoch; this identity only makes their namespace explicit.
 */
export interface InstanceResourceIdentity {
  postureKind: ValidInstanceLaunchPosture['kind']
  isPrivateProfile: boolean
  userDataPath: string
  /** Opaque, stable fingerprint for logs/telemetry; it never embeds a local path. */
  scopeId: string
  geminiMcpSocketPath: string
  bridgeLogDirectory: string
  bridgeLogPath: string
  /** The durable numeric epoch file for this profile's bridge log. */
  bridgeLogEpochPath: string
  /** Stable namespace to pair with a numeric bridge-log epoch in diagnostics. */
  bridgeLogEpochNamespace: string
}

export interface CreateInstanceResourceIdentityInput {
  posture: InstanceLaunchPosture
  /** The Electron userData path after the launch posture has been applied. */
  userDataPath: string
}

/** Opaque per-process value used to bind a bridge child's live endpoint to its owner. */
export function isValidInstanceResourceEpoch(value: unknown): value is string {
  return typeof value === 'string' && INSTANCE_RESOURCE_EPOCH_PATTERN.test(value)
}

export function createInstanceResourceEpoch(
  generate: () => string = () => randomBytes(24).toString('hex')
): string {
  const epoch = generate()
  if (!isValidInstanceResourceEpoch(epoch)) {
    throw new TypeError('Generated instance resource epoch is invalid.')
  }
  return epoch
}

function isUsableAbsoluteDirectory(value: string): boolean {
  if (!isAbsolute(value)) return false
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

function resolveChildPath(parent: string, ...segments: string[]): string {
  const child = resolve(parent, ...segments)
  if (!isStrictDescendant(parent, child)) {
    throw new TypeError('Instance resource path escapes its userData directory.')
  }
  return child
}

function scopeIdForUserDataPath(userDataPath: string): string {
  const digest = createHash('sha256')
    .update('taskwraith-instance-resource-v1\u0000')
    .update(userDataPath)
    .digest('hex')
  return `tw-instance-${digest.slice(0, 32)}`
}

/**
 * Derive resource locations without reading, creating, or deleting anything.
 * A private posture must agree with Electron's already-selected userData path;
 * otherwise callers get an error instead of accidentally addressing primary
 * resources from a secondary process.
 */
export function createInstanceResourceIdentity(
  input: CreateInstanceResourceIdentityInput
): InstanceResourceIdentity {
  const posture = input.posture
  if (posture.kind === 'invalid') {
    throw new TypeError('Invalid launch posture cannot own instance resources.')
  }
  if (!isUsableAbsoluteDirectory(input.userDataPath)) {
    throw new TypeError('Instance userData path must be an absolute non-root directory.')
  }

  const userDataPath = resolve(input.userDataPath)
  const expectedPrivatePath =
    posture.kind === 'production' ? undefined : resolve(posture.userDataPath)
  if (expectedPrivatePath && expectedPrivatePath !== userDataPath) {
    throw new TypeError('Private launch posture does not match the selected userData path.')
  }

  const bridgeLogDirectory = resolveChildPath(userDataPath, 'bridge-logs')
  const bridgeLogPath = resolveChildPath(bridgeLogDirectory, 'bridge-subprocess.log')
  const bridgeLogEpochPath = resolveChildPath(bridgeLogDirectory, 'bridge-subprocess.log.epoch')
  const scopeId = scopeIdForUserDataPath(userDataPath)

  return {
    postureKind: posture.kind,
    isPrivateProfile: posture.isPrivateProfile,
    userDataPath,
    scopeId,
    geminiMcpSocketPath: resolveChildPath(userDataPath, 'taskwraith-gemini-mcp.sock'),
    bridgeLogDirectory,
    bridgeLogPath,
    bridgeLogEpochPath,
    bridgeLogEpochNamespace: `bridge-log:${scopeId}`
  }
}
