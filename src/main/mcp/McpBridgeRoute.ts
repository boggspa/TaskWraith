import { basename, dirname, isAbsolute, parse, resolve } from 'path'
import {
  isValidPackagedIsolatedInstanceId,
  PACKAGED_ISOLATED_INSTANCE_DIRECTORY_NAME
} from '../InstanceLaunchPosture'
import { isValidInstanceResourceEpoch } from '../InstanceResourceIdentity'
import type { ProviderId } from '../store/types'

/**
 * An MCP registration may persist this static switch, but never a live broker
 * endpoint. A child that sees it must resolve all endpoint authority from its
 * current, complete environment and fail closed when any part is missing.
 */
export const MCP_BRIDGE_ROUTE_FROM_ENV_ARG = '--taskwraith-mcp-route-from-env'

// This module owns the canonical spelling; McpBridgeRuntime aliases it for
// legacy direct launches. It intentionally does not import the runtime:
// bridge children load this parser before userData-backed resources resolve.
export const MCP_BRIDGE_ENTRY_ARG = '--taskwraith-gemini-mcp-bridge'

export const MCP_BRIDGE_ROUTE_ENV_KEYS = {
  parentProvider: 'TASKWRAITH_PARENT_PROVIDER',
  runId: 'TASKWRAITH_RUN_ID',
  chatId: 'TASKWRAITH_CHAT_ID',
  workspacePath: 'TASKWRAITH_WORKSPACE_PATH'
} as const

export const MCP_BRIDGE_ENDPOINT_ENV_KEYS = {
  socketPath: 'TASKWRAITH_MCP_SOCKET_PATH',
  brokerToken: 'TASKWRAITH_MCP_BROKER_TOKEN',
  instanceEpoch: 'TASKWRAITH_MCP_INSTANCE_EPOCH',
  bridgeLogEpoch: 'TASKWRAITH_MCP_BRIDGE_LOG_EPOCH',
  /**
   * Empty for the primary profile. A non-empty value is an argv-validated
   * packaged isolated-profile id and is never written into a persisted MCP
   * registration.
   */
  isolatedInstanceId: 'TASKWRAITH_MCP_ISOLATED_INSTANCE_ID'
} as const

/** Existing MCP profile controls, made explicit to prevent inherited widening. */
export const MCP_BRIDGE_PROFILE_ENV_KEYS = {
  safeSubset: 'TASKWRAITH_MCP_SAFE_SUBSET',
  planSubset: 'TASKWRAITH_MCP_PLAN_SUBSET',
  coreSubset: 'TASKWRAITH_MCP_CORE_SUBSET',
  gatewaySubset: 'TASKWRAITH_MCP_GATEWAY_SUBSET',
  soloSubset: 'TASKWRAITH_MCP_SOLO_SUBSET',
  portableEnsembleControl: 'TASKWRAITH_MCP_PORTABLE_ENSEMBLE_CONTROL',
  meshDirect: 'TASKWRAITH_MCP_MESH_DIRECT',
  meshTopologyDirect: 'TASKWRAITH_MCP_MESH_TOPOLOGY_DIRECT',
  sketchDirect: 'TASKWRAITH_MCP_SKETCH_DIRECT',
  orchestrationDirect: 'TASKWRAITH_MCP_ORCHESTRATION_DIRECT',
  permissionOpportunityDirect: 'TASKWRAITH_MCP_PERMISSION_OPPORTUNITY_DIRECT',
  auditSubset: 'TASKWRAITH_MCP_AUDIT'
} as const

export interface McpBridgeRunRoute {
  appRunId?: string
  appChatId?: string
}

/**
 * Live authority that must come from the spawning instance, not a persisted
 * Gemini/Cursor registration. instanceEpoch is a process-owned opaque nonce
 * which the future broker seam compares before accepting a request.
 */
export interface McpBridgeEndpointAuthority {
  socketPath: string
  brokerToken: string
  instanceEpoch: string
  bridgeLogEpoch: number
  /** Omitted in parsed authority for the primary profile; env always carries an explicit empty value. */
  isolatedInstanceId?: string
}

export interface McpBridgeProfileEnvironment {
  safeSubset: boolean
  planSubset: boolean
  coreSubset: boolean
  gatewaySubset: boolean
  soloSubset: boolean
  portableEnsembleControl: boolean
  meshDirect: boolean
  meshTopologyDirect: boolean
  sketchDirect: boolean
  orchestrationDirect: boolean
  permissionOpportunityDirect: boolean
  auditSubset: boolean
}

export interface McpBridgeRouteEnvironment {
  route: McpBridgeRunRoute
  parentProvider: ProviderId
  workspacePath: string
  endpoint: McpBridgeEndpointAuthority
  profile: McpBridgeProfileEnvironment
}

export interface BuildMcpBridgeRouteEnvironmentInput {
  route?: McpBridgeRunRoute | null
  parentProvider?: unknown
  workspacePath?: unknown
  endpoint?: unknown
  profile?: unknown
}

export type McpBridgeRouteEnvironmentVariables = Record<string, string>

export type McpBridgeRouteEnvironmentResult =
  | { ok: true; value: McpBridgeRouteEnvironment }
  | {
      ok: false
      /** Intentionally generic: never include socket paths, tokens, or epochs. */
      reason:
        | 'missing-endpoint-authority'
        | 'invalid-endpoint-authority'
        | 'invalid-profile-environment'
    }

export type BuildMcpBridgeRouteEnvironmentResult =
  | { ok: true; env: McpBridgeRouteEnvironmentVariables }
  | Extract<McpBridgeRouteEnvironmentResult, { ok: false }>

const VALID_MCP_BRIDGE_PARENT_PROVIDERS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'pi',
  'antigravity',
  'mistral',
  'ollama',
  'muse'
])

const MAX_ROUTE_IDENTIFIER_LENGTH = 512
const MAX_WORKSPACE_PATH_LENGTH = 32_768
const MAX_SOCKET_PATH_LENGTH = 4_096
const MCP_BRIDGE_SOCKET_FILE_NAME = 'taskwraith-gemini-mcp.sock'
// eslint-disable-next-line no-control-regex -- reject control bytes in untrusted env routes.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const BROKER_TOKEN_PATTERN = /^[a-f0-9]{64}$/
const CANONICAL_EPOCH_PATTERN = /^(0|[1-9][0-9]{0,15})$/

type RouteEnvironmentSource = Readonly<Record<string, string | undefined>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readOpaqueRouteIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (
    !value ||
    value.length > MAX_ROUTE_IDENTIFIER_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return undefined
  }
  return value
}

function readWorkspacePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_WORKSPACE_PATH_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    return ''
  }
  return value
}

function readSocketPath(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_SOCKET_PATH_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !isAbsolute(value)
  ) {
    return undefined
  }
  const normalized = resolve(value)
  if (normalized !== value || normalized === parse(normalized).root) return undefined
  return normalized
}

function readBrokerToken(value: unknown): string | undefined {
  return typeof value === 'string' && BROKER_TOKEN_PATTERN.test(value) ? value : undefined
}

function readInstanceEpoch(value: unknown): string | undefined {
  return isValidInstanceResourceEpoch(value) ? value : undefined
}

function readBridgeLogEpoch(value: unknown): number | undefined {
  if (typeof value !== 'string' || !CANONICAL_EPOCH_PATTERN.test(value)) return undefined
  const epoch = Number(value)
  return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : undefined
}

function readIsolatedInstanceId(value: unknown): string | undefined | null {
  if (value === '') return undefined
  return isValidPackagedIsolatedInstanceId(value) ? value : null
}

/**
 * A packaged isolated profile owns this exact profile-local socket layout. The
 * static helper's environment is untrusted until its selector agrees with that
 * endpoint identity; otherwise an isolated route could make the helper boot
 * against the primary profile (or a different isolated profile).
 */
function isolatedInstanceIdFromSocketPath(socketPath: string): string | undefined | null {
  const profileRoot = dirname(socketPath)
  const profileParent = dirname(profileRoot)
  if (basename(profileParent) !== PACKAGED_ISOLATED_INSTANCE_DIRECTORY_NAME) {
    return undefined
  }
  if (basename(socketPath) !== MCP_BRIDGE_SOCKET_FILE_NAME) return null
  const instanceId = basename(profileRoot)
  return isValidPackagedIsolatedInstanceId(instanceId) ? instanceId : null
}

function hasBoundIsolatedEndpointIdentity(
  socketPath: string,
  isolatedInstanceId: string | undefined
): boolean {
  const socketInstanceId = isolatedInstanceIdFromSocketPath(socketPath)
  if (socketInstanceId === null) return false
  if (socketInstanceId === undefined) return isolatedInstanceId === undefined
  return socketInstanceId === isolatedInstanceId
}

function isValidBridgeLogEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function endpointFromUnknown(value: unknown): McpBridgeRouteEnvironmentResult {
  if (!isRecord(value)) return { ok: false, reason: 'missing-endpoint-authority' }
  const required = ['socketPath', 'brokerToken', 'instanceEpoch', 'bridgeLogEpoch'] as const
  if (required.some((field) => value[field] === undefined || value[field] === null)) {
    return { ok: false, reason: 'missing-endpoint-authority' }
  }
  const socketPath = readSocketPath(value.socketPath)
  const brokerToken = readBrokerToken(value.brokerToken)
  const instanceEpoch = readInstanceEpoch(value.instanceEpoch)
  const bridgeLogEpoch =
    typeof value.bridgeLogEpoch === 'number' && isValidBridgeLogEpoch(value.bridgeLogEpoch)
      ? value.bridgeLogEpoch
      : undefined
  const isolatedInstanceId =
    value.isolatedInstanceId === undefined || value.isolatedInstanceId === null
      ? undefined
      : readIsolatedInstanceId(value.isolatedInstanceId)
  if (
    !socketPath ||
    !brokerToken ||
    !instanceEpoch ||
    bridgeLogEpoch === undefined ||
    isolatedInstanceId === null ||
    !hasBoundIsolatedEndpointIdentity(socketPath, isolatedInstanceId || undefined)
  ) {
    return { ok: false, reason: 'invalid-endpoint-authority' }
  }
  return {
    ok: true,
    value: {
      route: {},
      parentProvider: 'gemini',
      workspacePath: '',
      endpoint: {
        socketPath,
        brokerToken,
        instanceEpoch,
        bridgeLogEpoch,
        ...(isolatedInstanceId ? { isolatedInstanceId } : {})
      },
      profile: emptyProfileEnvironment()
    }
  }
}

function endpointFromEnv(env: RouteEnvironmentSource): McpBridgeRouteEnvironmentResult {
  const endpoint = {
    socketPath: env[MCP_BRIDGE_ENDPOINT_ENV_KEYS.socketPath],
    brokerToken: env[MCP_BRIDGE_ENDPOINT_ENV_KEYS.brokerToken],
    instanceEpoch: env[MCP_BRIDGE_ENDPOINT_ENV_KEYS.instanceEpoch],
    bridgeLogEpoch: env[MCP_BRIDGE_ENDPOINT_ENV_KEYS.bridgeLogEpoch],
    isolatedInstanceId: env[MCP_BRIDGE_ENDPOINT_ENV_KEYS.isolatedInstanceId]
  }
  // The first four fields are endpoint authority. isolatedInstanceId is an
  // explicit profile selector: an empty string means the primary profile.
  const required = [
    endpoint.socketPath,
    endpoint.brokerToken,
    endpoint.instanceEpoch,
    endpoint.bridgeLogEpoch
  ]
  if (required.some((value) => value === undefined || value === '')) {
    return { ok: false, reason: 'missing-endpoint-authority' }
  }
  const socketPath = readSocketPath(endpoint.socketPath)
  const brokerToken = readBrokerToken(endpoint.brokerToken)
  const instanceEpoch = readInstanceEpoch(endpoint.instanceEpoch)
  const bridgeLogEpoch = readBridgeLogEpoch(endpoint.bridgeLogEpoch)
  const isolatedInstanceId = readIsolatedInstanceId(endpoint.isolatedInstanceId)
  if (
    !socketPath ||
    !brokerToken ||
    !instanceEpoch ||
    bridgeLogEpoch === undefined ||
    isolatedInstanceId === null ||
    !hasBoundIsolatedEndpointIdentity(socketPath, isolatedInstanceId || undefined)
  ) {
    return { ok: false, reason: 'invalid-endpoint-authority' }
  }
  return {
    ok: true,
    value: {
      route: {},
      parentProvider: 'gemini',
      workspacePath: '',
      endpoint: {
        socketPath,
        brokerToken,
        instanceEpoch,
        bridgeLogEpoch,
        ...(isolatedInstanceId ? { isolatedInstanceId } : {})
      },
      profile: emptyProfileEnvironment()
    }
  }
}

function emptyProfileEnvironment(): McpBridgeProfileEnvironment {
  return {
    safeSubset: false,
    planSubset: false,
    coreSubset: false,
    gatewaySubset: false,
    soloSubset: false,
    portableEnsembleControl: false,
    meshDirect: false,
    meshTopologyDirect: false,
    sketchDirect: false,
    orchestrationDirect: false,
    permissionOpportunityDirect: false,
    auditSubset: false
  }
}

function profileFromUnknown(value: unknown): McpBridgeProfileEnvironment | null {
  if (value === undefined || value === null) return emptyProfileEnvironment()
  if (!isRecord(value)) return null
  const profile = emptyProfileEnvironment()
  for (const key of Object.keys(profile) as Array<keyof McpBridgeProfileEnvironment>) {
    const candidate = value[key]
    if (candidate === undefined) continue
    if (typeof candidate !== 'boolean') return null
    profile[key] = candidate
  }
  return profile
}

function profileFromEnv(env: RouteEnvironmentSource): McpBridgeProfileEnvironment | null {
  const profile = emptyProfileEnvironment()
  for (const [key, envKey] of Object.entries(MCP_BRIDGE_PROFILE_ENV_KEYS) as Array<
    [keyof McpBridgeProfileEnvironment, string]
  >) {
    const candidate = env[envKey]
    if (candidate === '1') {
      profile[key] = true
    } else if (candidate !== '0') {
      return null
    }
  }
  return profile
}

export function isMcpBridgeParentProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && VALID_MCP_BRIDGE_PARENT_PROVIDERS.has(value as ProviderId)
}

/** Preserve the broker's historical fail-closed default for malformed stamps. */
export function normalizeMcpBridgeParentProvider(value: unknown): ProviderId {
  return isMcpBridgeParentProvider(value) ? value : 'gemini'
}

export function normalizeMcpBridgeRoute(route?: McpBridgeRunRoute | null): McpBridgeRunRoute {
  const appRunId = readOpaqueRouteIdentifier(route?.appRunId)
  const appChatId = readOpaqueRouteIdentifier(route?.appChatId)
  return {
    ...(appRunId ? { appRunId } : {}),
    ...(appChatId ? { appChatId } : {})
  }
}

/**
 * A narrow selector probe for migration/diagnostics only. It is not admission:
 * child bootstrap must call isStaticMcpBridgeRegistrationArgv (or the explicit
 * Electron development framing matcher) instead.
 */
export function hasMcpBridgeRouteFromEnvArg(argv: readonly string[]): boolean {
  return argv.filter((argument) => argument === MCP_BRIDGE_ROUTE_FROM_ENV_ARG).length === 1
}

/**
 * The persistable static registration grammar is deliberately closed: the
 * bridge entry is first and the route selector is second, with no other
 * switches, legacy bridge authority, or duplicate selector.
 */
export function isStaticMcpBridgeRegistrationArgv(argv: readonly string[]): boolean {
  return (
    argv.length === 2 &&
    argv[0] === MCP_BRIDGE_ENTRY_ARG &&
    argv[1] === MCP_BRIDGE_ROUTE_FROM_ENV_ARG
  )
}

/**
 * Electron development launches add exactly one normalized absolute app path
 * between the executable and the static bridge grammar. This is launcher
 * framing, not a bridge option: no other extra/reordered form is accepted.
 */
export function isDevStaticMcpBridgeProcessArgv(argv: readonly string[]): boolean {
  const launchArgs = argv.slice(1)
  if (launchArgs.length !== 3) return false
  const appPath = launchArgs[0]
  if (
    typeof appPath !== 'string' ||
    !isAbsolute(appPath) ||
    resolve(appPath) !== appPath ||
    appPath === parse(appPath).root
  ) {
    return false
  }
  return isStaticMcpBridgeRegistrationArgv(launchArgs.slice(1))
}

/**
 * Persistable argv for a global MCP registration. It deliberately carries no
 * socket path, broker token, instance/bridge epoch, or MCP profile control.
 */
export function buildStaticMcpBridgeRegistrationArgv(): string[] {
  return [MCP_BRIDGE_ENTRY_ARG, MCP_BRIDGE_ROUTE_FROM_ENV_ARG]
}

/**
 * Parse all live endpoint authority from the child environment. This function
 * never reads a profile selector, userData path, or TASKWRAITH_INSTANCE_ID.
 */
export function parseMcpBridgeRouteFromEnv(
  env: RouteEnvironmentSource
): McpBridgeRouteEnvironmentResult {
  const endpointResult = endpointFromEnv(env)
  if (!endpointResult.ok) return endpointResult
  const profile = profileFromEnv(env)
  if (!profile) return { ok: false, reason: 'invalid-profile-environment' }
  return {
    ok: true,
    value: {
      route: normalizeMcpBridgeRoute({
        appRunId: env[MCP_BRIDGE_ROUTE_ENV_KEYS.runId],
        appChatId: env[MCP_BRIDGE_ROUTE_ENV_KEYS.chatId]
      }),
      parentProvider: normalizeMcpBridgeParentProvider(
        env[MCP_BRIDGE_ROUTE_ENV_KEYS.parentProvider]
      ),
      workspacePath: readWorkspacePath(env[MCP_BRIDGE_ROUTE_ENV_KEYS.workspacePath]),
      endpoint: endpointResult.value.endpoint,
      profile
    }
  }
}

/**
 * Build a complete environment slice for one bridge child. Explicit zeroes
 * prevent a stale parent process from widening an MCP profile by inheritance.
 * Failures return only a classification, never endpoint values or credentials.
 */
export function buildMcpBridgeRouteEnv(
  input: BuildMcpBridgeRouteEnvironmentInput
): BuildMcpBridgeRouteEnvironmentResult {
  const endpointResult = endpointFromUnknown(input.endpoint)
  if (!endpointResult.ok) return endpointResult
  const profile = profileFromUnknown(input.profile)
  if (!profile) return { ok: false, reason: 'invalid-profile-environment' }
  const route = normalizeMcpBridgeRoute(input.route)
  const endpoint = endpointResult.value.endpoint
  return {
    ok: true,
    env: {
      [MCP_BRIDGE_ROUTE_ENV_KEYS.parentProvider]: normalizeMcpBridgeParentProvider(
        input.parentProvider
      ),
      [MCP_BRIDGE_ROUTE_ENV_KEYS.runId]: route.appRunId || '',
      [MCP_BRIDGE_ROUTE_ENV_KEYS.chatId]: route.appChatId || '',
      [MCP_BRIDGE_ROUTE_ENV_KEYS.workspacePath]: readWorkspacePath(input.workspacePath),
      [MCP_BRIDGE_ENDPOINT_ENV_KEYS.socketPath]: endpoint.socketPath,
      [MCP_BRIDGE_ENDPOINT_ENV_KEYS.brokerToken]: endpoint.brokerToken,
      [MCP_BRIDGE_ENDPOINT_ENV_KEYS.instanceEpoch]: endpoint.instanceEpoch,
      [MCP_BRIDGE_ENDPOINT_ENV_KEYS.bridgeLogEpoch]: String(endpoint.bridgeLogEpoch),
      [MCP_BRIDGE_ENDPOINT_ENV_KEYS.isolatedInstanceId]: endpoint.isolatedInstanceId || '',
      [MCP_BRIDGE_PROFILE_ENV_KEYS.safeSubset]: profile.safeSubset ? '1' : '0',
      [MCP_BRIDGE_PROFILE_ENV_KEYS.planSubset]: profile.planSubset ? '1' : '0',
      [MCP_BRIDGE_PROFILE_ENV_KEYS.coreSubset]: profile.coreSubset ? '1' : '0',
      [MCP_BRIDGE_PROFILE_ENV_KEYS.gatewaySubset]: profile.gatewaySubset ? '1' : '0',
      [MCP_BRIDGE_PROFILE_ENV_KEYS.soloSubset]: profile.soloSubset ? '1' : '0',
      [MCP_BRIDGE_PROFILE_ENV_KEYS.portableEnsembleControl]: profile.portableEnsembleControl
        ? '1'
        : '0',
      [MCP_BRIDGE_PROFILE_ENV_KEYS.meshDirect]: profile.meshDirect ? '1' : '0',
      [MCP_BRIDGE_PROFILE_ENV_KEYS.meshTopologyDirect]: profile.meshTopologyDirect ? '1' : '0',
      [MCP_BRIDGE_PROFILE_ENV_KEYS.sketchDirect]: profile.sketchDirect ? '1' : '0',
      [MCP_BRIDGE_PROFILE_ENV_KEYS.orchestrationDirect]: profile.orchestrationDirect ? '1' : '0',
      [MCP_BRIDGE_PROFILE_ENV_KEYS.permissionOpportunityDirect]: profile.permissionOpportunityDirect
        ? '1'
        : '0',
      [MCP_BRIDGE_PROFILE_ENV_KEYS.auditSubset]: profile.auditSubset ? '1' : '0'
    }
  }
}
