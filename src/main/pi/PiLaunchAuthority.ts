import type {
  CliRuntimeIdentityAuthority,
  ProviderLaunchCommonAuthority,
  ProviderToolSurfaceAuthority
} from '../ProviderLaunchAuthorityDigest'
import {
  isPiUpstreamAllowed,
  piModelPolicyVerdict,
  type PiUpstreamId
} from './PiModelPolicy'
import { splitPiWireModelId } from './PiModels'

const MAX_TEXT_LENGTH = 4_096
const LOWER_HEX_256 = /^[a-f0-9]{64}$/

/** Provider-id declaration consumed by scheduled evidence/matrix integration. */
export const PI_LAUNCH_AUTHORITY_PROVIDER = 'pi' as const

/**
 * Pi's signable production launch shape.
 *
 * Pi has no provider-side permission prompt and no TaskWraith MCP transport.
 * Its authority is therefore the exact RPC argv, native tool allowlist,
 * credential-firewalled environment, isolated per-run home, and deterministic
 * per-chat session route. Scheduled sealing must not be wired until dispatch
 * consumes the same resolved launch plan.
 */
export interface PiLaunchControls {
  readonly transport: 'rpc'
  readonly upstream: PiUpstreamId
  /** The id passed after `--model`, without the TaskWraith upstream prefix. */
  readonly modelId: string
  /** Production omits `--thinking`, leaving the selected model's default. */
  readonly thinkingMode: 'provider-default'
  /** Default mode after the signed read-only and shell/file deny clamps. */
  readonly writeCapable: boolean
  /** Must equal ProviderToolSurfaceAuthority.nativeToolPolicySha256. */
  readonly nativeToolPolicySha256: string
  /** Pi is launched with `--no-approve`; there is no per-call callback. */
  readonly providerApprovalMode: 'disabled'
  readonly taskWraithMcpAttachmentMode: 'none'
  readonly projectConfigurationDiscovery: 'disabled'
  readonly isolatedHomeMode: 'per-run-mkdtemp-verified-v1'
  /** Digest of the helper's real-directory, owner/mode, and inode attestation. */
  readonly isolatedHomeAuthoritySha256: string
  readonly sessionPersistence: 'durable-per-chat' | 'ephemeral-ensemble'
  /** HMAC of the exact durable session directory; null for `--no-session`. */
  readonly sessionDirectoryHmac: string | null
  readonly promptTransport: 'stdin-jsonl'
  readonly stdinCommandTemplateSha256: string
  readonly shutdownPolicySha256: string
  readonly credentialFirewallSha256: string
  /** `--offline`, PI_OFFLINE=1, and PI_SKIP_VERSION_CHECK=1 are all pinned. */
  readonly offlineStartup: true
  readonly telemetryEnabled: false
  readonly fallbackPolicy: 'forbid'
}

export interface PiProviderLaunchAuthorityInput {
  readonly schemaVersion: 1
  readonly provider: typeof PI_LAUNCH_AUTHORITY_PROVIDER
  readonly common: ProviderLaunchCommonAuthority
  readonly runtime: CliRuntimeIdentityAuthority
  readonly tools: ProviderToolSurfaceAuthority
  readonly controls: PiLaunchControls
}

export const PI_LAUNCH_CONTROL_FIELDS = {
  transport: true,
  upstream: true,
  modelId: true,
  thinkingMode: true,
  writeCapable: true,
  nativeToolPolicySha256: true,
  providerApprovalMode: true,
  taskWraithMcpAttachmentMode: true,
  projectConfigurationDiscovery: true,
  isolatedHomeMode: true,
  isolatedHomeAuthoritySha256: true,
  sessionPersistence: true,
  sessionDirectoryHmac: true,
  promptTransport: true,
  stdinCommandTemplateSha256: true,
  shutdownPolicySha256: true,
  credentialFirewallSha256: true,
  offlineStartup: true,
  telemetryEnabled: true,
  fallbackPolicy: true
} as const satisfies Record<keyof PiLaunchControls, true>

/**
 * Strict normalizer consumed by ProviderLaunchAuthorityDigest. It lives with
 * the Pi schema so central integration does not duplicate or weaken its field
 * validation.
 */
export function normalizePiLaunchControls(value: unknown): PiLaunchControls {
  const record = exactObject(value, Object.keys(PI_LAUNCH_CONTROL_FIELDS), 'Pi controls')
  if (record.transport !== 'rpc') throw new TypeError('Pi transport must be rpc.')
  if (typeof record.upstream !== 'string' || !isPiUpstreamAllowed(record.upstream)) {
    throw new TypeError('Pi upstream is not in the production allowlist.')
  }
  return {
    transport: 'rpc',
    upstream: record.upstream,
    modelId: nonEmptyText(record.modelId, 'Pi model id'),
    thinkingMode: exactLiteral(record.thinkingMode, 'provider-default', 'Pi thinking mode'),
    writeCapable: boolean(record.writeCapable, 'Pi write capability'),
    nativeToolPolicySha256: sha256(record.nativeToolPolicySha256, 'Pi native tool policy digest'),
    providerApprovalMode: exactLiteral(
      record.providerApprovalMode,
      'disabled',
      'Pi provider approval mode'
    ),
    taskWraithMcpAttachmentMode: exactLiteral(
      record.taskWraithMcpAttachmentMode,
      'none',
      'Pi TaskWraith MCP attachment mode'
    ),
    projectConfigurationDiscovery: exactLiteral(
      record.projectConfigurationDiscovery,
      'disabled',
      'Pi project configuration discovery'
    ),
    isolatedHomeMode: exactLiteral(
      record.isolatedHomeMode,
      'per-run-mkdtemp-verified-v1',
      'Pi isolated home mode'
    ),
    isolatedHomeAuthoritySha256: sha256(
      record.isolatedHomeAuthoritySha256,
      'Pi isolated home authority digest'
    ),
    sessionPersistence: oneOf(
      record.sessionPersistence,
      ['durable-per-chat', 'ephemeral-ensemble'],
      'Pi session persistence'
    ),
    sessionDirectoryHmac:
      record.sessionDirectoryHmac === null
        ? null
        : sha256(record.sessionDirectoryHmac, 'Pi session directory HMAC'),
    promptTransport: exactLiteral(record.promptTransport, 'stdin-jsonl', 'Pi prompt transport'),
    stdinCommandTemplateSha256: sha256(
      record.stdinCommandTemplateSha256,
      'Pi stdin command template digest'
    ),
    shutdownPolicySha256: sha256(record.shutdownPolicySha256, 'Pi shutdown policy digest'),
    credentialFirewallSha256: sha256(
      record.credentialFirewallSha256,
      'Pi credential firewall digest'
    ),
    offlineStartup: exactLiteral(record.offlineStartup, true, 'Pi offline startup'),
    telemetryEnabled: exactLiteral(record.telemetryEnabled, false, 'Pi telemetry'),
    fallbackPolicy: exactLiteral(record.fallbackPolicy, 'forbid', 'Pi fallback policy')
  }
}

/**
 * Cross-field checks for the central launch-authority validator.
 *
 * Durable Pi chats pass a deterministic `--session-id` that creates the
 * session when absent and resumes it thereafter. The authority calls that
 * `resume`: it authorizes the exact persistent identity, not a fresh process
 * with unbound storage. Ensemble lanes use `--no-session` and are fresh.
 */
export function assertPiLaunchAuthorityInvariants(input: {
  readonly common: ProviderLaunchCommonAuthority
  readonly runtime: CliRuntimeIdentityAuthority
  readonly tools: ProviderToolSurfaceAuthority
  readonly controls: PiLaunchControls
}): void {
  const { common, runtime, tools, controls } = input
  if (runtime.kind !== 'cli') throw new TypeError('Pi requires a CLI runtime identity.')
  const split = splitPiWireModelId(common.model)
  if (
    !split ||
    split.upstream !== controls.upstream ||
    split.modelId !== controls.modelId ||
    common.model !== `${controls.upstream}/${controls.modelId}`
  ) {
    throw new TypeError(
      'Pi common model must exactly match its normalized upstream/model launch controls.'
    )
  }
  const modelVerdict = piModelPolicyVerdict(controls.upstream, controls.modelId)
  if (!modelVerdict.allowed) {
    throw new TypeError(modelVerdict.reason ?? 'Pi model is not allowed by production policy.')
  }
  if (tools.taskWraithMcpAdvertised || tools.taskWraithMcpProfileId !== null) {
    throw new TypeError('Pi cannot advertise or attach TaskWraith MCP.')
  }
  if (controls.nativeToolPolicySha256 !== tools.nativeToolPolicySha256) {
    throw new TypeError('Pi control and tool-surface native policy digests must match.')
  }
  if (controls.sessionPersistence === 'durable-per-chat') {
    if (
      common.sessionMode !== 'resume' ||
      common.resumeSessionHmac === null ||
      common.providerSessionGenerationSha256 === null ||
      controls.sessionDirectoryHmac === null
    ) {
      throw new TypeError(
        'Durable Pi sessions require exact session identity, generation, and directory authority.'
      )
    }
    return
  }
  if (
    common.sessionMode !== 'fresh' ||
    common.resumeSessionHmac !== null ||
    common.providerSessionGenerationSha256 !== null ||
    controls.sessionDirectoryHmac !== null
  ) {
    throw new TypeError('Ephemeral Pi sessions must be fresh and carry no durable route authority.')
  }
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object.`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object.`)
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} cannot contain symbol fields.`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError(`${label}.${key} cannot be an accessor.`)
    }
  }
  const actual = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has an invalid field set.`)
  }
  return value as Record<string, unknown>
}

function nonEmptyText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    !value ||
    value.length > MAX_TEXT_LENGTH ||
    value.includes('\0')
  ) {
    throw new TypeError(`${label} is invalid.`)
  }
  return value
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !LOWER_HEX_256.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256/HMAC digest.`)
  }
  return value
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean.`)
  return value
}

function exactLiteral<const T extends string | boolean>(
  value: unknown,
  expected: T,
  label: string
): T {
  if (value !== expected) throw new TypeError(`${label} is invalid.`)
  return expected
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new TypeError(`${label} is invalid.`)
  }
  return value as T[number]
}
