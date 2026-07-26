import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type {
  CliRuntimeIdentityAuthority,
  ProviderLaunchCommonAuthority,
  ProviderToolSurfaceAuthority
} from '../ProviderLaunchAuthorityDigest'
import { isAntigravityGeminiApiModelCandidate } from '../antigravity/AntigravityCombinedModeDispatch'
import type { AgyBinarySource } from '../antigravity/AntigravityCli'
import {
  GOOGLE_DEVELOPER_TEAM_ID,
  type AgyProvenanceState
} from '../antigravity/AntigravityBinaryProvenance'
import { canonicalEvidenceEncode } from './SealEvidenceCore'

const PROVIDER_LAUNCH_DOMAIN = 'taskwraith:provider-launch-authority:v1\0'
const LOWER_HEX_256 = /^[a-f0-9]{64}$/
const EXACT_GEMINI_API_MODEL = /^gemini-api:(gemini-[a-z0-9][a-z0-9._-]{0,127})$/

export interface AntigravityInProcessSdkRuntimeIdentityAuthority {
  readonly kind: 'in-process-sdk'
  readonly hostExecutableRealPath: string
  readonly hostExecutableSha256: string
  readonly hostRuntimeVersionSha256: string
  readonly sdkPackageJsonRealPath: string
  readonly sdkPackageJsonSha256: string
  readonly sdkEntrypointRealPath: string
  readonly sdkEntrypointSha256: string
}

export interface AntigravityOfficialAgyLaunchControls {
  readonly transport: 'official-agy-cli'
  readonly riskConsentAcceptedAt: number
  readonly binarySource: Exclude<AgyBinarySource, 'missing'>
  readonly binaryProvenanceState: AgyProvenanceState
  readonly binaryProvenanceTeamId: string | null
  readonly binarySigningAuthoritySha256: string | null
  readonly binaryProvenanceDetailSha256: string | null
  readonly permissionMode: 'plan' | 'accept-edits'
  readonly sandboxed: true
  readonly printTimeout: string
  readonly selectedModel: string | null
  readonly reasoningEffort: string | null
  readonly conversationMode: 'fresh' | 'resume'
  readonly credentialEnvironmentPolicy: 'google-selectors-stripped'
  readonly taskWraithMcpAttachmentMode: 'none'
  readonly fallbackPolicy: 'forbid'
}

export interface AntigravityGeminiApiLaunchControls {
  readonly transport: 'gemini-api-sdk'
  readonly disclosureAcceptedAt: number
  /** Bare model id passed to `models.generateContentStream`. */
  readonly apiModel: string
  /** Main-keyed HMAC of the exact dedicated safeStorage key used for the request. */
  readonly apiKeyHmac: string
  readonly historyMode: 'host-history-replay' | 'ensemble-context-only'
  readonly imageTransport: 'none'
  readonly taskWraithFunctionCalling: boolean
  readonly functionDeclarationsSha256: string
  readonly maxToolRounds: 20
  readonly requestConfigurationSha256: string
  readonly taskWraithMcpAttachmentMode: 'in-process-function-calls' | 'none'
  readonly fallbackPolicy: 'forbid'
}

export type AntigravityLaunchAuthorityInput =
  | Readonly<{
      schemaVersion: 1
      provider: 'antigravity'
      common: ProviderLaunchCommonAuthority
      runtime: CliRuntimeIdentityAuthority
      tools: ProviderToolSurfaceAuthority
      controls: AntigravityOfficialAgyLaunchControls
    }>
  | Readonly<{
      schemaVersion: 1
      provider: 'antigravity'
      common: ProviderLaunchCommonAuthority
      runtime: AntigravityInProcessSdkRuntimeIdentityAuthority
      tools: ProviderToolSurfaceAuthority
      controls: AntigravityGeminiApiLaunchControls
    }>

export type CanonicalAntigravityLaunchAuthority = AntigravityLaunchAuthorityInput

const COMMON_FIELDS = {
  adapterRevision: true,
  model: true,
  modelCapabilitySha256: true,
  promptEnvelopeSha256: true,
  sessionMode: true,
  resumeSessionHmac: true,
  providerSessionGenerationSha256: true,
  launchEnvironmentHmac: true,
  credentialStateHmac: true,
  providerConfigurationSha256: true,
  capabilityContractSha256: true
} as const satisfies Record<keyof ProviderLaunchCommonAuthority, true>

const TOOL_FIELDS = {
  taskWraithMcpAdvertised: true,
  taskWraithMcpProfileId: true,
  taskWraithMcpCatalogSha256: true,
  providerMcpConfigurationSha256: true,
  userMcpConfigurationSha256: true,
  nativeToolPolicySha256: true,
  brokerPolicySha256: true
} as const satisfies Record<keyof ProviderToolSurfaceAuthority, true>

const CLI_RUNTIME_FIELDS = {
  kind: true,
  executableRealPath: true,
  executableSha256: true,
  runtimeBundleSha256: true,
  interpreterRuntimeAttestationSha256: true,
  executableVersion: true,
  launchArgsTemplateSha256: true
} as const satisfies Record<keyof CliRuntimeIdentityAuthority, true>

const SDK_RUNTIME_FIELDS = {
  kind: true,
  hostExecutableRealPath: true,
  hostExecutableSha256: true,
  hostRuntimeVersionSha256: true,
  sdkPackageJsonRealPath: true,
  sdkPackageJsonSha256: true,
  sdkEntrypointRealPath: true,
  sdkEntrypointSha256: true
} as const satisfies Record<keyof AntigravityInProcessSdkRuntimeIdentityAuthority, true>

const AGY_CONTROL_FIELDS = {
  transport: true,
  riskConsentAcceptedAt: true,
  binarySource: true,
  binaryProvenanceState: true,
  binaryProvenanceTeamId: true,
  binarySigningAuthoritySha256: true,
  binaryProvenanceDetailSha256: true,
  permissionMode: true,
  sandboxed: true,
  printTimeout: true,
  selectedModel: true,
  reasoningEffort: true,
  conversationMode: true,
  credentialEnvironmentPolicy: true,
  taskWraithMcpAttachmentMode: true,
  fallbackPolicy: true
} as const satisfies Record<keyof AntigravityOfficialAgyLaunchControls, true>

const API_CONTROL_FIELDS = {
  transport: true,
  disclosureAcceptedAt: true,
  apiModel: true,
  apiKeyHmac: true,
  historyMode: true,
  imageTransport: true,
  taskWraithFunctionCalling: true,
  functionDeclarationsSha256: true,
  maxToolRounds: true,
  requestConfigurationSha256: true,
  taskWraithMcpAttachmentMode: true,
  fallbackPolicy: true
} as const satisfies Record<keyof AntigravityGeminiApiLaunchControls, true>

/**
 * Strict provider-local normalizer consumed by the central provider-authority
 * union. It deliberately models both real transports under the one user-facing
 * provider id; a transport change is therefore a launch authority change,
 * never an implicit fallback.
 */
export function buildAntigravityLaunchAuthority(
  input: AntigravityLaunchAuthorityInput
): CanonicalAntigravityLaunchAuthority {
  const root = exactRecord(
    input,
    ['schemaVersion', 'provider', 'common', 'runtime', 'tools', 'controls'],
    'AntiGravity launch authority'
  )
  if (root.schemaVersion !== 1 || root.provider !== 'antigravity') {
    throw new TypeError('Invalid AntiGravity launch authority identity.')
  }
  const common = normalizeCommon(root.common)
  const tools = normalizeTools(root.tools)
  const controlsRecord = record(root.controls, 'AntiGravity launch controls')

  let authority: AntigravityLaunchAuthorityInput
  if (controlsRecord.transport === 'official-agy-cli') {
    const controls = normalizeAgyControls(controlsRecord)
    const runtime = normalizeCliRuntime(root.runtime)
    if (isAntigravityGeminiApiModelCandidate(common.model)) {
      throw new TypeError('A Gemini API namespace candidate cannot carry official-agy authority.')
    }
    if (controls.conversationMode !== common.sessionMode) {
      throw new TypeError('AntiGravity agy conversation mode must match session authority.')
    }
    const expectedSelectedModel = /^(?:cli-default|default|auto)$/i.test(common.model)
      ? null
      : common.model
    if (controls.selectedModel !== expectedSelectedModel) {
      throw new TypeError(
        'AntiGravity agy selected model must match production normalization of the common model.'
      )
    }
    assertAgyProvenanceAuthority(controls)
    if (tools.taskWraithMcpAdvertised) {
      throw new TypeError('The official agy transport cannot advertise TaskWraith MCP tools.')
    }
    authority = {
      schemaVersion: 1,
      provider: 'antigravity',
      common,
      runtime,
      tools,
      controls
    }
  } else if (controlsRecord.transport === 'gemini-api-sdk') {
    const controls = normalizeApiControls(controlsRecord)
    const runtime = normalizeSdkRuntime(root.runtime)
    const exactModel = EXACT_GEMINI_API_MODEL.exec(common.model)
    if (!exactModel || exactModel[1] !== controls.apiModel) {
      throw new TypeError('Gemini API authority must bind the exact namespaced and bare model.')
    }
    if (
      common.sessionMode !== 'fresh' ||
      common.resumeSessionHmac !== null ||
      common.providerSessionGenerationSha256 !== null
    ) {
      throw new TypeError('The stateless Gemini API request must carry fresh session authority.')
    }
    const attached = controls.taskWraithMcpAttachmentMode === 'in-process-function-calls'
    if (
      attached !== controls.taskWraithFunctionCalling ||
      attached !== tools.taskWraithMcpAdvertised
    ) {
      throw new TypeError(
        'Gemini API function declarations must match its advertised tool surface.'
      )
    }
    authority = {
      schemaVersion: 1,
      provider: 'antigravity',
      common,
      runtime,
      tools,
      controls
    }
  } else {
    throw new TypeError('Unknown AntiGravity launch transport.')
  }

  return JSON.parse(canonicalEvidenceEncode(authority)) as CanonicalAntigravityLaunchAuthority
}

export function antigravityLaunchAuthorityDigest(input: AntigravityLaunchAuthorityInput): string {
  const authority = buildAntigravityLaunchAuthority(input)
  return createHash('sha256')
    .update(PROVIDER_LAUNCH_DOMAIN)
    .update(canonicalEvidenceEncode(authority))
    .digest('hex')
}

function normalizeCommon(value: unknown): ProviderLaunchCommonAuthority {
  const input = exactRecord(
    value,
    Object.keys(COMMON_FIELDS),
    'AntiGravity common authority'
  )
  const sessionMode = oneOf(input.sessionMode, ['fresh', 'resume'], 'session mode')
  const resumeSessionHmac = nullableSha256(input.resumeSessionHmac, 'resume session HMAC')
  const providerSessionGenerationSha256 = nullableSha256(
    input.providerSessionGenerationSha256,
    'provider session generation'
  )
  if (
    sessionMode === 'fresh'
      ? resumeSessionHmac !== null || providerSessionGenerationSha256 !== null
      : resumeSessionHmac === null || providerSessionGenerationSha256 === null
  ) {
    throw new TypeError('AntiGravity session identity and generation authority are inconsistent.')
  }
  return {
    adapterRevision: text(input.adapterRevision, 'adapter revision'),
    model: text(input.model, 'model'),
    modelCapabilitySha256: sha256(input.modelCapabilitySha256, 'model capability'),
    promptEnvelopeSha256: sha256(input.promptEnvelopeSha256, 'prompt envelope'),
    sessionMode,
    resumeSessionHmac,
    providerSessionGenerationSha256,
    launchEnvironmentHmac: sha256(input.launchEnvironmentHmac, 'launch environment'),
    credentialStateHmac: sha256(input.credentialStateHmac, 'credential state'),
    providerConfigurationSha256: sha256(
      input.providerConfigurationSha256,
      'provider configuration'
    ),
    capabilityContractSha256: sha256(input.capabilityContractSha256, 'capability contract')
  }
}

function normalizeTools(value: unknown): ProviderToolSurfaceAuthority {
  const input = exactRecord(value, Object.keys(TOOL_FIELDS), 'AntiGravity tool authority')
  const advertised = bool(input.taskWraithMcpAdvertised, 'TaskWraith MCP advertisement')
  const profileId =
    input.taskWraithMcpProfileId === null
      ? null
      : text(input.taskWraithMcpProfileId, 'TaskWraith MCP profile')
  if (advertised !== (profileId !== null)) {
    throw new TypeError('TaskWraith MCP profile presence must match advertisement.')
  }
  return {
    taskWraithMcpAdvertised: advertised,
    taskWraithMcpProfileId: profileId as ProviderToolSurfaceAuthority['taskWraithMcpProfileId'],
    taskWraithMcpCatalogSha256: sha256(input.taskWraithMcpCatalogSha256, 'MCP catalog'),
    providerMcpConfigurationSha256: sha256(
      input.providerMcpConfigurationSha256,
      'provider MCP configuration'
    ),
    userMcpConfigurationSha256: sha256(input.userMcpConfigurationSha256, 'user MCP configuration'),
    nativeToolPolicySha256: sha256(input.nativeToolPolicySha256, 'native tool policy'),
    brokerPolicySha256: sha256(input.brokerPolicySha256, 'broker policy')
  }
}

function normalizeCliRuntime(value: unknown): CliRuntimeIdentityAuthority {
  const input = exactRecord(
    value,
    Object.keys(CLI_RUNTIME_FIELDS),
    'AntiGravity agy runtime'
  )
  if (input.kind !== 'cli') throw new TypeError('The official agy runtime kind must be cli.')
  return {
    kind: 'cli',
    executableRealPath: absolutePath(input.executableRealPath, 'agy executable'),
    executableSha256: sha256(input.executableSha256, 'agy executable'),
    runtimeBundleSha256: sha256(input.runtimeBundleSha256, 'agy runtime bundle'),
    interpreterRuntimeAttestationSha256: sha256(
      input.interpreterRuntimeAttestationSha256,
      'agy interpreter runtime'
    ),
    executableVersion:
      input.executableVersion === null ? null : text(input.executableVersion, 'agy version'),
    launchArgsTemplateSha256: sha256(input.launchArgsTemplateSha256, 'agy argv template')
  }
}

function normalizeSdkRuntime(value: unknown): AntigravityInProcessSdkRuntimeIdentityAuthority {
  const input = exactRecord(
    value,
    Object.keys(SDK_RUNTIME_FIELDS),
    'AntiGravity Gemini API runtime'
  )
  if (input.kind !== 'in-process-sdk') {
    throw new TypeError('The Gemini API runtime kind must be in-process-sdk.')
  }
  return {
    kind: 'in-process-sdk',
    hostExecutableRealPath: absolutePath(input.hostExecutableRealPath, 'host executable'),
    hostExecutableSha256: sha256(input.hostExecutableSha256, 'host executable'),
    hostRuntimeVersionSha256: sha256(input.hostRuntimeVersionSha256, 'host runtime version'),
    sdkPackageJsonRealPath: absolutePath(input.sdkPackageJsonRealPath, 'SDK package manifest'),
    sdkPackageJsonSha256: sha256(input.sdkPackageJsonSha256, 'SDK package manifest'),
    sdkEntrypointRealPath: absolutePath(input.sdkEntrypointRealPath, 'SDK entrypoint'),
    sdkEntrypointSha256: sha256(input.sdkEntrypointSha256, 'SDK entrypoint')
  }
}

function normalizeAgyControls(value: unknown): AntigravityOfficialAgyLaunchControls {
  const input = exactRecord(value, Object.keys(AGY_CONTROL_FIELDS), 'official agy controls')
  if (input.transport !== 'official-agy-cli') throw new TypeError('Invalid agy transport.')
  return {
    transport: 'official-agy-cli',
    riskConsentAcceptedAt: positiveFinite(input.riskConsentAcceptedAt, 'agy risk consent'),
    binarySource: oneOf(input.binarySource, ['path', 'common'], 'agy binary source'),
    binaryProvenanceState: oneOf(
      input.binaryProvenanceState,
      ['verified', 'unverified', 'mismatch'],
      'agy binary provenance'
    ),
    binaryProvenanceTeamId: nullableText(input.binaryProvenanceTeamId, 'agy team id'),
    binarySigningAuthoritySha256: nullableSha256(
      input.binarySigningAuthoritySha256,
      'agy signing authority'
    ),
    binaryProvenanceDetailSha256: nullableSha256(
      input.binaryProvenanceDetailSha256,
      'agy provenance detail'
    ),
    permissionMode: oneOf(input.permissionMode, ['plan', 'accept-edits'], 'agy permission mode'),
    sandboxed: literal(input.sandboxed, true, 'agy sandbox'),
    printTimeout: text(input.printTimeout, 'agy print timeout'),
    selectedModel: nullableText(input.selectedModel, 'agy selected model'),
    reasoningEffort: nullableText(input.reasoningEffort, 'agy reasoning effort'),
    conversationMode: oneOf(input.conversationMode, ['fresh', 'resume'], 'agy conversation mode'),
    credentialEnvironmentPolicy: literal(
      input.credentialEnvironmentPolicy,
      'google-selectors-stripped',
      'agy credential environment policy'
    ),
    taskWraithMcpAttachmentMode: literal(
      input.taskWraithMcpAttachmentMode,
      'none',
      'agy MCP attachment'
    ),
    fallbackPolicy: literal(input.fallbackPolicy, 'forbid', 'agy fallback policy')
  }
}

function normalizeApiControls(value: unknown): AntigravityGeminiApiLaunchControls {
  const input = exactRecord(value, Object.keys(API_CONTROL_FIELDS), 'Gemini API controls')
  if (input.transport !== 'gemini-api-sdk') throw new TypeError('Invalid Gemini API transport.')
  return {
    transport: 'gemini-api-sdk',
    disclosureAcceptedAt: positiveFinite(input.disclosureAcceptedAt, 'Gemini API disclosure'),
    apiModel: text(input.apiModel, 'Gemini API model'),
    apiKeyHmac: sha256(input.apiKeyHmac, 'Gemini API key HMAC'),
    historyMode: oneOf(
      input.historyMode,
      ['host-history-replay', 'ensemble-context-only'],
      'Gemini API history mode'
    ),
    imageTransport: literal(input.imageTransport, 'none', 'Gemini API image transport'),
    taskWraithFunctionCalling: bool(input.taskWraithFunctionCalling, 'Gemini API function calling'),
    functionDeclarationsSha256: sha256(
      input.functionDeclarationsSha256,
      'Gemini API function declarations'
    ),
    maxToolRounds: literal(input.maxToolRounds, 20, 'Gemini API tool-round ceiling'),
    requestConfigurationSha256: sha256(
      input.requestConfigurationSha256,
      'Gemini API request configuration'
    ),
    taskWraithMcpAttachmentMode: oneOf(
      input.taskWraithMcpAttachmentMode,
      ['in-process-function-calls', 'none'],
      'Gemini API MCP attachment'
    ),
    fallbackPolicy: literal(input.fallbackPolicy, 'forbid', 'Gemini API fallback policy')
  }
}

function assertAgyProvenanceAuthority(controls: AntigravityOfficialAgyLaunchControls): void {
  const {
    binaryProvenanceState: state,
    binaryProvenanceTeamId: teamId,
    binarySigningAuthoritySha256: authority,
    binaryProvenanceDetailSha256: detail
  } = controls
  if (state === 'verified') {
    if (teamId !== GOOGLE_DEVELOPER_TEAM_ID || authority === null || detail !== null) {
      throw new TypeError(
        'Verified agy provenance requires the Google team, signing authority, and no warning detail.'
      )
    }
    return
  }
  if (state === 'unverified') {
    if (teamId !== null || authority !== null || detail === null) {
      throw new TypeError(
        'Unverified agy provenance requires no claimed signer and a diagnostic detail.'
      )
    }
    return
  }
  if (teamId === GOOGLE_DEVELOPER_TEAM_ID || detail === null) {
    throw new TypeError(
      'Mismatched agy provenance requires a non-Google signer state and diagnostic detail.'
    )
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string
): Record<string, unknown> {
  const input = record(value, label)
  const actual = Object.keys(input).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unknown or missing fields.`)
  }
  return input
}

function record(value: unknown, label: string): Record<string, unknown> {
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
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypeError(`${label}.${key} cannot be an accessor.`)
    }
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.includes('\0') ||
    value.length > 4_096
  ) {
    throw new TypeError(`${label} must be non-empty bounded text.`)
  }
  return value
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label)
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !LOWER_HEX_256.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 value.`)
  }
  return value
}

function nullableSha256(value: unknown, label: string): string | null {
  return value === null ? null : sha256(value, label)
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean.`)
  return value
}

function positiveFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number.`)
  }
  return value
}

function oneOf<const T extends readonly (string | number | boolean)[]>(
  value: unknown,
  values: T,
  label: string
): T[number] {
  if (!values.includes(value as T[number])) throw new TypeError(`${label} is invalid.`)
  return value as T[number]
}

function literal<const T extends string | number | boolean>(
  value: unknown,
  expected: T,
  label: string
): T {
  if (value !== expected) throw new TypeError(`${label} is invalid.`)
  return expected
}

function absolutePath(value: unknown, label: string): string {
  const path = text(value, label)
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(`${label} must be a canonical absolute path.`)
  }
  return path
}
