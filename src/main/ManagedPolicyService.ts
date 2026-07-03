import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto'
import type {
  AgenticServicesSettings,
  AppSettings
} from './store/types'
import {
  evaluateUserMcpLaunchPolicy,
  type BuildUserMcpLaunchServersOptions,
  type UserMcpLaunchAllowlistPolicy
} from './UserMcpServers'

export const MANAGED_POLICY_SETTING_KEYS = [
  'agenticServices',
  'agenticWorkspaceGrants',
  'approvalTimeouts',
  'autoUpdateEnabled',
  'codexSandboxFallback',
  'geminiMcpBridgeEnabled',
  'updateChannel',
  'userMcpServers'
] as const

export type ManagedPolicySettingKey = (typeof MANAGED_POLICY_SETTING_KEYS)[number]

type ManagedPolicySettings = Partial<
  Pick<
    AppSettings,
    | 'autoUpdateEnabled'
    | 'codexSandboxFallback'
    | 'geminiMcpBridgeEnabled'
    | 'updateChannel'
    | 'userMcpServers'
    | 'agenticWorkspaceGrants'
  >
> & {
  agenticServices?: Partial<AgenticServicesSettings>
  approvalTimeouts?: {
    enabled?: boolean
    perProviderMs?: Partial<AppSettings['approvalTimeouts']['perProviderMs']>
    mainAuthorityMs?: number
  }
}

export interface ManagedPolicyDocument {
  schemaVersion?: 1
  organizationName?: string
  lockedSettings?: ManagedPolicySettingKey[]
  settings?: ManagedPolicySettings
  userMcpLaunchAllowlist?: UserMcpLaunchAllowlistPolicy
}

export interface ManagedPolicySnapshot {
  active: boolean
  source: 'none' | 'env-json' | 'env-path' | 'signed-env-json' | 'signed-env-path'
  organizationName?: string
  lockedSettings: ManagedPolicySettingKey[]
  enforcedSettings: ManagedPolicySettingKey[]
  errors: string[]
  signature?: {
    required: boolean
    present: boolean
    valid: boolean
    keyId?: string
    payloadHash?: string
    reason?: string
  }
  userMcpLaunchAllowlist?: {
    active: boolean
    allowedTransportCount: number
    allowedCommandRootCount: number
    allowedCommandArgPrefixCount: number
    allowedRemoteSchemeCount: number
    allowedRemoteHostCount: number
    allowedRemotePortCount: number
    allowedRemotePathPrefixCount: number
    blockPrivateRemoteHosts: boolean
    allowedHeaderNameCount: number
    allowedEnvKeyCount: number
    requirePluginProvenance: boolean
    allowedPluginIdCount: number
  }
}

export interface ManagedPolicyLoadDeps {
  env?: NodeJS.ProcessEnv
  readFileSync?: (path: string, encoding: 'utf8') => string
  validateUserMcpPluginProvenance?: BuildUserMcpLaunchServersOptions['validatePluginProvenance']
}

interface ManagedPolicyRuntimeDeps {
  validateUserMcpPluginProvenance?: BuildUserMcpLaunchServersOptions['validatePluginProvenance']
}

interface ManagedPolicySignatureSnapshot {
  required: boolean
  present: boolean
  valid: boolean
  keyId?: string
  payloadHash?: string
  reason?: string
}

const settingKeySet = new Set<string>(MANAGED_POLICY_SETTING_KEYS)
const servicePolicies = new Set(['ask', 'workspace', 'allow', 'deny'])
const networkPolicies = new Set(['allow', 'deny'])
const managedPolicySignatureAlgorithms = new Set(['ed25519'])
const agenticServiceKeys = [
  'shellCommands',
  'fileChanges',
  'externalPublish',
  'mcpTools',
  'subThreadDelegation',
  'canvasInteraction',
  'canvasEval',
  'crossThreadRead',
  'mediaEditing',
  'mediaRecording',
  'networkAccess'
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : stableJson(item))).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`)
    .join(',')}}`
}

function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sanitizePositiveMs(value: unknown): number | undefined {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return undefined
  return Math.max(1_000, Math.min(10 * 60 * 1000, Math.round(numeric)))
}

function sanitizeAgenticServices(value: unknown): Partial<AgenticServicesSettings> | undefined {
  if (!isRecord(value)) return undefined
  const services: Partial<AgenticServicesSettings> = {}
  for (const key of agenticServiceKeys) {
    const raw = value[key]
    if (key === 'networkAccess') {
      if (networkPolicies.has(String(raw))) {
        services.networkAccess = raw as AgenticServicesSettings['networkAccess']
      }
    } else if (servicePolicies.has(String(raw))) {
      services[key] = raw as NonNullable<AgenticServicesSettings[typeof key]>
    }
  }
  return Object.keys(services).length > 0 ? services : undefined
}

function sanitizeApprovalTimeouts(value: unknown): ManagedPolicySettings['approvalTimeouts'] {
  if (!isRecord(value)) return undefined
  const perProvider = isRecord(value.perProviderMs) ? value.perProviderMs : {}
  const perProviderMs: Partial<AppSettings['approvalTimeouts']['perProviderMs']> = {}
  for (const provider of ['gemini', 'codex', 'claude', 'kimi'] as const) {
    const sanitized = sanitizePositiveMs(perProvider[provider])
    if (sanitized !== undefined) perProviderMs[provider] = sanitized
  }
  const mainAuthorityMs = sanitizePositiveMs(value.mainAuthorityMs)
  const output: ManagedPolicySettings['approvalTimeouts'] = {
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(Object.keys(perProviderMs).length > 0 ? { perProviderMs } : {}),
    ...(mainAuthorityMs !== undefined ? { mainAuthorityMs } : {})
  }
  return Object.keys(output).length > 0 ? output : undefined
}

function sanitizeManagedSettings(value: unknown): ManagedPolicySettings {
  if (!isRecord(value)) return {}
  const settings: ManagedPolicySettings = {}
  if (typeof value.autoUpdateEnabled === 'boolean') {
    settings.autoUpdateEnabled = value.autoUpdateEnabled
  }
  if (
    value.updateChannel === 'debug' ||
    value.updateChannel === 'stable' ||
    value.updateChannel === 'nightly'
  ) {
    settings.updateChannel = value.updateChannel
  }
  if (typeof value.geminiMcpBridgeEnabled === 'boolean') {
    settings.geminiMcpBridgeEnabled = value.geminiMcpBridgeEnabled
  }
  if (value.codexSandboxFallback === 'ask_rerun' || value.codexSandboxFallback === 'off') {
    settings.codexSandboxFallback = value.codexSandboxFallback
  }
  const agenticServices = sanitizeAgenticServices(value.agenticServices)
  if (agenticServices) settings.agenticServices = agenticServices
  const approvalTimeouts = sanitizeApprovalTimeouts(value.approvalTimeouts)
  if (approvalTimeouts) settings.approvalTimeouts = approvalTimeouts
  if (Array.isArray(value.userMcpServers)) {
    // First managed-policy slice only supports disabling local user MCP servers.
    settings.userMcpServers = []
  }
  if (Array.isArray(value.agenticWorkspaceGrants)) {
    // Managed installs should not inherit user/workspace grants unless a later
    // signed policy format explicitly models them.
    settings.agenticWorkspaceGrants = []
  }
  return settings
}

function sanitizeLockedSettings(value: unknown): ManagedPolicySettingKey[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(
      value
        .filter((entry): entry is ManagedPolicySettingKey => settingKeySet.has(String(entry)))
        .map((entry) => entry as ManagedPolicySettingKey)
    )
  )
}

function uniqueStrings(value: unknown, max = 128): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = Array.from(
    new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))
  ).slice(0, max)
  return strings.length > 0 ? strings : undefined
}

function uniquePositiveIntegers(
  value: unknown,
  max = 128,
  upperBound = Number.MAX_SAFE_INTEGER
): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const integers = Array.from(
    new Set(
      value
        .map((entry) => Number(entry))
        .filter((entry) => Number.isInteger(entry) && entry > 0 && entry <= upperBound)
    )
  ).slice(0, max)
  return integers.length > 0 ? integers : undefined
}

function sanitizeUserMcpLaunchAllowlist(value: unknown): UserMcpLaunchAllowlistPolicy | undefined {
  if (!isRecord(value)) return undefined
  const policy: UserMcpLaunchAllowlistPolicy = {}
  const transports = uniqueStrings(value.allowedTransports)?.filter(
    (transport): transport is 'stdio' | 'http' | 'sse' =>
      transport === 'stdio' || transport === 'http' || transport === 'sse'
  )
  if (transports && transports.length > 0) policy.allowedTransports = transports
  const commandRoots = uniqueStrings(value.allowedCommandRoots)
  if (commandRoots) policy.allowedCommandRoots = commandRoots
  const commandArgPrefixes = uniqueStrings(value.allowedCommandArgPrefixes)
  if (commandArgPrefixes) policy.allowedCommandArgPrefixes = commandArgPrefixes
  const schemes = uniqueStrings(value.allowedRemoteSchemes)?.filter(
    (scheme): scheme is 'http' | 'https' => scheme === 'http' || scheme === 'https'
  )
  if (schemes && schemes.length > 0) policy.allowedRemoteSchemes = schemes
  const remoteHosts = uniqueStrings(value.allowedRemoteHosts)
  if (remoteHosts) policy.allowedRemoteHosts = remoteHosts
  const remotePorts = uniquePositiveIntegers(value.allowedRemotePorts, 64, 65_535)
  if (remotePorts) policy.allowedRemotePorts = remotePorts
  const rawRemotePathPrefixes = uniqueStrings(value.allowedRemotePathPrefixes, 128)
  const remotePathPrefixes = rawRemotePathPrefixes
    ? Array.from(
        new Set(
          rawRemotePathPrefixes.map((prefix) => (prefix.startsWith('/') ? prefix : `/${prefix}`))
        )
      )
    : undefined
  if (remotePathPrefixes) policy.allowedRemotePathPrefixes = remotePathPrefixes
  if (typeof value.blockPrivateRemoteHosts === 'boolean') {
    policy.blockPrivateRemoteHosts = value.blockPrivateRemoteHosts
  }
  const headerNames = uniqueStrings(value.allowedHeaderNames)
  if (headerNames) policy.allowedHeaderNames = headerNames
  const envKeys = uniqueStrings(value.allowedEnvKeys)
  if (envKeys) policy.allowedEnvKeys = envKeys
  if (typeof value.requirePluginProvenance === 'boolean') {
    policy.requirePluginProvenance = value.requirePluginProvenance
  }
  const pluginIds = uniqueStrings(value.allowedPluginIds)
  if (pluginIds) policy.allowedPluginIds = pluginIds
  return Object.keys(policy).length > 0 ? policy : undefined
}

export function parseManagedPolicyDocument(raw: unknown): ManagedPolicyDocument {
  if (!isRecord(raw)) return {}
  const settings = sanitizeManagedSettings(raw.settings)
  const userMcpLaunchAllowlist = sanitizeUserMcpLaunchAllowlist(raw.userMcpLaunchAllowlist)
  const document: ManagedPolicyDocument = {
    ...(raw.schemaVersion === 1 ? { schemaVersion: 1 } : {}),
    ...(typeof raw.organizationName === 'string' && raw.organizationName.trim()
      ? { organizationName: raw.organizationName.trim().slice(0, 120) }
      : {}),
    lockedSettings: sanitizeLockedSettings(raw.lockedSettings),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    ...(userMcpLaunchAllowlist ? { userMcpLaunchAllowlist } : {})
  }
  return document
}

function isSignedManagedPolicyEnvelope(value: unknown): value is {
  payload: unknown
  signature: Record<string, unknown>
} {
  return (
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, 'payload') &&
    isRecord(value.signature)
  )
}

function loadManagedPolicyPublicKey(
  deps: ManagedPolicyLoadDeps
): { configured: boolean; key?: KeyObject; errors: string[] } {
  const env = deps.env || process.env
  const readFileSync = deps.readFileSync
  const inlineMaterial =
    env.TASKWRAITH_MANAGED_POLICY_PUBLIC_KEY ||
    env.TASKWRAITH_MANAGED_POLICY_PUBLIC_KEY_DER_BASE64
  const keyPath = env.TASKWRAITH_MANAGED_POLICY_PUBLIC_KEY_PATH
  const configured = Boolean(inlineMaterial?.trim() || keyPath?.trim())
  if (!configured) return { configured: false, errors: [] }
  try {
    const material = inlineMaterial?.trim()
      ? inlineMaterial.trim()
      : readFileSync
        ? readFileSync(keyPath!.trim(), 'utf8').trim()
        : ''
    if (!material) {
      return {
        configured: true,
        errors: ['Managed policy public key is configured but unavailable.']
      }
    }
    const key = material.includes('BEGIN PUBLIC KEY')
      ? createPublicKey(material)
      : createPublicKey({
          key: Buffer.from(material, 'base64'),
          format: 'der',
          type: 'spki'
        })
    return { configured: true, key, errors: [] }
  } catch (error) {
    return {
      configured: true,
      errors: [
        `Managed policy public key could not be loaded: ${
          error instanceof Error ? error.message : String(error)
        }`
      ]
    }
  }
}

function verifyManagedPolicyEnvelope(
  raw: unknown,
  publicKey: KeyObject | undefined,
  required: boolean
): { payload?: unknown; signature: ManagedPolicySignatureSnapshot; errors: string[] } {
  if (!isSignedManagedPolicyEnvelope(raw)) {
    return {
      payload: required ? undefined : raw,
      signature: {
        required,
        present: false,
        valid: !required,
        ...(required ? { reason: 'missing_signature' } : {})
      },
      errors: required ? ['Managed policy signature is required.'] : []
    }
  }

  const signature = raw.signature
  const algorithm = String(signature.algorithm || '')
  const keyId =
    typeof signature.keyId === 'string' && signature.keyId.trim()
      ? signature.keyId.trim().slice(0, 120)
      : undefined
  const signatureBase64 =
    typeof signature.signatureBase64 === 'string' ? signature.signatureBase64.trim() : ''
  const payload = stableJson(raw.payload)
  const payloadHash = sha256Utf8(payload)
  const declaredPayloadHash =
    typeof signature.payloadHash === 'string' ? signature.payloadHash.trim() : ''
  const base: ManagedPolicySignatureSnapshot = {
    required: true,
    present: true,
    valid: false,
    ...(keyId ? { keyId } : {}),
    payloadHash
  }
  if (!managedPolicySignatureAlgorithms.has(algorithm)) {
    return {
      signature: { ...base, reason: 'unsupported_algorithm' },
      errors: ['Managed policy signature algorithm is unsupported.']
    }
  }
  if (!publicKey) {
    return {
      signature: { ...base, reason: 'missing_public_key' },
      errors: ['Signed managed policy requires a configured public key.']
    }
  }
  if (!declaredPayloadHash || declaredPayloadHash !== payloadHash) {
    return {
      signature: { ...base, reason: 'payload_hash_mismatch' },
      errors: ['Managed policy payload hash does not match its signature envelope.']
    }
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureBase64)) {
    return {
      signature: { ...base, reason: 'malformed_signature' },
      errors: ['Managed policy signature material is malformed.']
    }
  }
  try {
    const valid = verifySignature(
      null,
      Buffer.from(payload, 'utf8'),
      publicKey,
      Buffer.from(signatureBase64, 'base64')
    )
    if (!valid) {
      return {
        signature: { ...base, reason: 'signature_verification_failed' },
        errors: ['Managed policy signature verification failed.']
      }
    }
    return {
      payload: raw.payload,
      signature: { ...base, valid: true },
      errors: []
    }
  } catch {
    return {
      signature: { ...base, reason: 'signature_verification_failed' },
      errors: ['Managed policy signature verification failed.']
    }
  }
}

function settingKeysFromSettings(settings: ManagedPolicySettings | undefined): ManagedPolicySettingKey[] {
  if (!settings) return []
  return Object.keys(settings).filter((key): key is ManagedPolicySettingKey =>
    settingKeySet.has(key)
  )
}

export class ManagedPolicyService {
  constructor(
    private readonly source: ManagedPolicySnapshot['source'] = 'none',
    private readonly document: ManagedPolicyDocument = {},
    private readonly errors: string[] = [],
    private readonly runtimeDeps: ManagedPolicyRuntimeDeps = {},
    private readonly signature?: ManagedPolicySignatureSnapshot
  ) {}

  static none(): ManagedPolicyService {
    return new ManagedPolicyService('none')
  }

  snapshot(): ManagedPolicySnapshot {
    const enforcedSettings = settingKeysFromSettings(this.document.settings)
    const lockedSettings = Array.from(
      new Set([...(this.document.lockedSettings || []), ...enforcedSettings])
    )
    const userMcpLaunchAllowlist = this.document.userMcpLaunchAllowlist
    return {
      active:
        this.source !== 'none' &&
        (lockedSettings.length > 0 ||
          this.errors.length > 0 ||
          Boolean(userMcpLaunchAllowlist)),
      source: this.source,
      ...(this.document.organizationName ? { organizationName: this.document.organizationName } : {}),
      lockedSettings,
      enforcedSettings,
      errors: [...this.errors],
      ...(this.signature ? { signature: { ...this.signature } } : {}),
      ...(userMcpLaunchAllowlist
        ? {
            userMcpLaunchAllowlist: {
              active: true,
              allowedTransportCount: userMcpLaunchAllowlist.allowedTransports?.length || 0,
              allowedCommandRootCount: userMcpLaunchAllowlist.allowedCommandRoots?.length || 0,
              allowedCommandArgPrefixCount:
                userMcpLaunchAllowlist.allowedCommandArgPrefixes?.length || 0,
              allowedRemoteSchemeCount: userMcpLaunchAllowlist.allowedRemoteSchemes?.length || 0,
              allowedRemoteHostCount: userMcpLaunchAllowlist.allowedRemoteHosts?.length || 0,
              allowedRemotePortCount: userMcpLaunchAllowlist.allowedRemotePorts?.length || 0,
              allowedRemotePathPrefixCount:
                userMcpLaunchAllowlist.allowedRemotePathPrefixes?.length || 0,
              blockPrivateRemoteHosts: userMcpLaunchAllowlist.blockPrivateRemoteHosts === true,
              allowedHeaderNameCount: userMcpLaunchAllowlist.allowedHeaderNames?.length || 0,
              allowedEnvKeyCount: userMcpLaunchAllowlist.allowedEnvKeys?.length || 0,
              requirePluginProvenance:
                userMcpLaunchAllowlist.requirePluginProvenance === true,
              allowedPluginIdCount: userMcpLaunchAllowlist.allowedPluginIds?.length || 0
            }
          }
        : {})
    }
  }

  userMcpLaunchAllowlistPolicy(): UserMcpLaunchAllowlistPolicy | undefined {
    return this.document.userMcpLaunchAllowlist
      ? {
          ...this.document.userMcpLaunchAllowlist,
          ...(this.document.userMcpLaunchAllowlist.allowedTransports
            ? { allowedTransports: [...this.document.userMcpLaunchAllowlist.allowedTransports] }
            : {}),
          ...(this.document.userMcpLaunchAllowlist.allowedCommandRoots
            ? { allowedCommandRoots: [...this.document.userMcpLaunchAllowlist.allowedCommandRoots] }
            : {}),
          ...(this.document.userMcpLaunchAllowlist.allowedCommandArgPrefixes
            ? {
                allowedCommandArgPrefixes: [
                  ...this.document.userMcpLaunchAllowlist.allowedCommandArgPrefixes
                ]
              }
            : {}),
          ...(this.document.userMcpLaunchAllowlist.allowedRemoteSchemes
            ? { allowedRemoteSchemes: [...this.document.userMcpLaunchAllowlist.allowedRemoteSchemes] }
            : {}),
          ...(this.document.userMcpLaunchAllowlist.allowedRemoteHosts
            ? { allowedRemoteHosts: [...this.document.userMcpLaunchAllowlist.allowedRemoteHosts] }
            : {}),
          ...(this.document.userMcpLaunchAllowlist.allowedRemotePorts
            ? { allowedRemotePorts: [...this.document.userMcpLaunchAllowlist.allowedRemotePorts] }
            : {}),
          ...(this.document.userMcpLaunchAllowlist.allowedRemotePathPrefixes
            ? {
                allowedRemotePathPrefixes: [
                  ...this.document.userMcpLaunchAllowlist.allowedRemotePathPrefixes
                ]
              }
            : {}),
          ...(this.document.userMcpLaunchAllowlist.allowedHeaderNames
            ? { allowedHeaderNames: [...this.document.userMcpLaunchAllowlist.allowedHeaderNames] }
            : {}),
          ...(this.document.userMcpLaunchAllowlist.allowedEnvKeys
            ? { allowedEnvKeys: [...this.document.userMcpLaunchAllowlist.allowedEnvKeys] }
            : {}),
          ...(this.document.userMcpLaunchAllowlist.allowedPluginIds
            ? { allowedPluginIds: [...this.document.userMcpLaunchAllowlist.allowedPluginIds] }
            : {})
        }
      : undefined
  }

  filterSettingsPatch(patch: Partial<AppSettings>): Partial<AppSettings> {
    const locked = new Set(this.snapshot().lockedSettings)
    const filtered: Partial<AppSettings> = { ...patch }
    for (const key of locked) {
      delete filtered[key]
    }
    const allowlist = this.document.userMcpLaunchAllowlist
    if (allowlist && Array.isArray(filtered.userMcpServers)) {
      filtered.userMcpServers = filtered.userMcpServers.map((server) => {
        if (!server.enabled) return server
        const decision = evaluateUserMcpLaunchPolicy(server, allowlist)
        if (!decision.allowed) return { ...server, enabled: false }
        const pluginProvenanceError =
          this.runtimeDeps.validateUserMcpPluginProvenance?.(server)
        return pluginProvenanceError ? { ...server, enabled: false } : server
      })
    }
    return filtered
  }

  enforcedSettingsPatch(settings: AppSettings): Partial<AppSettings> {
    const policy = this.document.settings
    if (!policy) return {}
    const patch: Partial<AppSettings> = {}
    if (
      policy.autoUpdateEnabled !== undefined &&
      policy.autoUpdateEnabled !== settings.autoUpdateEnabled
    ) {
      patch.autoUpdateEnabled = policy.autoUpdateEnabled
    }
    if (policy.updateChannel && policy.updateChannel !== settings.updateChannel) {
      patch.updateChannel = policy.updateChannel
    }
    if (
      policy.geminiMcpBridgeEnabled !== undefined &&
      policy.geminiMcpBridgeEnabled !== settings.geminiMcpBridgeEnabled
    ) {
      patch.geminiMcpBridgeEnabled = policy.geminiMcpBridgeEnabled
    }
    if (
      policy.codexSandboxFallback &&
      policy.codexSandboxFallback !== settings.codexSandboxFallback
    ) {
      patch.codexSandboxFallback = policy.codexSandboxFallback
    }
    if (policy.agenticServices) {
      const nextServices = { ...settings.agenticServices, ...policy.agenticServices }
      if (!jsonEqual(nextServices, settings.agenticServices)) patch.agenticServices = nextServices
    }
    if (policy.approvalTimeouts) {
      const nextTimeouts = {
        ...settings.approvalTimeouts,
        ...(policy.approvalTimeouts.enabled !== undefined
          ? { enabled: policy.approvalTimeouts.enabled }
          : {}),
        perProviderMs: {
          ...settings.approvalTimeouts.perProviderMs,
          ...(policy.approvalTimeouts.perProviderMs || {})
        },
        ...(policy.approvalTimeouts.mainAuthorityMs !== undefined
          ? { mainAuthorityMs: policy.approvalTimeouts.mainAuthorityMs }
          : {})
      }
      if (!jsonEqual(nextTimeouts, settings.approvalTimeouts)) patch.approvalTimeouts = nextTimeouts
    }
    if (policy.userMcpServers && !jsonEqual(policy.userMcpServers, settings.userMcpServers || [])) {
      patch.userMcpServers = policy.userMcpServers
    }
    if (
      policy.agenticWorkspaceGrants &&
      !jsonEqual(policy.agenticWorkspaceGrants, settings.agenticWorkspaceGrants || [])
    ) {
      patch.agenticWorkspaceGrants = policy.agenticWorkspaceGrants
    }
    return patch
  }

  effectiveSettings(settings: AppSettings): AppSettings {
    const patch = this.enforcedSettingsPatch(settings)
    return Object.keys(patch).length === 0 ? settings : ({ ...settings, ...patch } as AppSettings)
  }
}

export function loadManagedPolicyFromEnvironment(
  deps: ManagedPolicyLoadDeps = {}
): ManagedPolicyService {
  const env = deps.env || process.env
  const readFileSync = deps.readFileSync
  const rawJson = env.TASKWRAITH_MANAGED_POLICY_JSON
  const policyPath = env.TASKWRAITH_MANAGED_POLICY_PATH
  const runtimeDeps: ManagedPolicyRuntimeDeps = {
    validateUserMcpPluginProvenance: deps.validateUserMcpPluginProvenance
  }
  const publicKey = loadManagedPolicyPublicKey(deps)
  const serviceFromRaw = (
    source: 'env-json' | 'env-path',
    raw: unknown,
    preErrors: string[] = []
  ): ManagedPolicyService => {
    const verified = verifyManagedPolicyEnvelope(raw, publicKey.key, publicKey.configured)
    const signedSource: ManagedPolicySnapshot['source'] = verified.signature.present
      ? source === 'env-json'
        ? 'signed-env-json'
        : 'signed-env-path'
      : source
    if (publicKey.errors.length > 0 || verified.errors.length > 0 || verified.payload === undefined) {
      return new ManagedPolicyService(
        signedSource,
        {},
        [...preErrors, ...publicKey.errors, ...verified.errors],
        runtimeDeps,
        verified.signature
      )
    }
    return new ManagedPolicyService(
      signedSource,
      parseManagedPolicyDocument(verified.payload),
      preErrors,
      runtimeDeps,
      verified.signature.present || verified.signature.required ? verified.signature : undefined
    )
  }
  if (rawJson && rawJson.trim()) {
    try {
      return serviceFromRaw('env-json', JSON.parse(rawJson))
    } catch (error) {
      return new ManagedPolicyService(
        'env-json',
        {},
        [error instanceof Error ? error.message : String(error)],
        runtimeDeps
      )
    }
  }
  if (policyPath && policyPath.trim() && readFileSync) {
    try {
      return serviceFromRaw('env-path', JSON.parse(readFileSync(policyPath.trim(), 'utf8')))
    } catch (error) {
      return new ManagedPolicyService(
        'env-path',
        {},
        [error instanceof Error ? error.message : String(error)],
        runtimeDeps
      )
    }
  }
  return ManagedPolicyService.none()
}
