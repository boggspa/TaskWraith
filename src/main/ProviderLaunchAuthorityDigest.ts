import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { ProviderId, TaskWraithMcpProfileId } from './store/types'
import {
  assertPiLaunchAuthorityInvariants,
  normalizePiLaunchControls,
  type PiLaunchControls,
  type PiProviderLaunchAuthorityInput
} from './pi/PiLaunchAuthority'
import {
  buildAntigravityLaunchAuthority,
  type AntigravityGeminiApiLaunchControls,
  type AntigravityInProcessSdkRuntimeIdentityAuthority,
  type AntigravityLaunchAuthorityInput,
  type AntigravityOfficialAgyLaunchControls
} from './scheduling/AntigravityLaunchAuthority'

const PROVIDER_LAUNCH_DOMAIN = 'taskwraith:provider-launch-authority:v1\0'
const MAX_TEXT_LENGTH = 4_096

/**
 * The original six-provider union consumed by SealEvidenceCommon and the
 * production-wired scheduling service. Keep it narrow: Pi and conditional
 * AntiGravity now have strict evidence schemas, but neither is allowed to
 * become production seal-wired merely because the central digest can validate
 * its provider-local authority.
 */
export type LiveProviderLaunchId = Exclude<ProviderId, 'gemini' | 'antigravity' | 'pi'>

/** Every provider with a strict central launch-authority schema/producer. */
export type LaunchAuthorityProviderId = LiveProviderLaunchId | 'pi' | 'antigravity'

export interface ProviderLaunchCommonAuthority {
  readonly adapterRevision: string
  readonly model: string
  /** Digest of the normalized model capability/catalog row used by the adapter. */
  readonly modelCapabilitySha256: string
  /** Digest of the final provider-visible prompt/preamble/context envelope. */
  readonly promptEnvelopeSha256: string
  /** Fresh process/session, ordinary provider resume, or reusable host-owned seat. */
  readonly sessionMode: 'fresh' | 'resume' | 'reusable'
  /** Main-keyed HMAC of the resumed session id or reusable seat key. */
  readonly resumeSessionHmac: string | null
  /** Digest of the main-owned seat generation. Fresh seats must keep this null. */
  readonly providerSessionGenerationSha256: string | null
  /** Main-keyed HMAC of the complete resolved spawn/request environment. */
  readonly launchEnvironmentHmac: string
  /**
   * Main-keyed HMAC of the selected canonical credential/auth state, never the
   * credential itself. This is mandatory even for `{ mode: 'none' }` so an
   * omitted auth state cannot collide with an explicitly unauthenticated one.
   */
  readonly credentialStateHmac: string
  /** Provider-native config + feature-gate authority after secret redaction/HMAC. */
  readonly providerConfigurationSha256: string
  /** Digest of the live capability contract used to choose this launch path. */
  readonly capabilityContractSha256: string
}

export interface ProviderToolSurfaceAuthority {
  readonly taskWraithMcpAdvertised: boolean
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  readonly taskWraithMcpCatalogSha256: string
  /** Exact provider-facing MCP document after structural route placeholders. */
  readonly providerMcpConfigurationSha256: string
  readonly userMcpConfigurationSha256: string
  readonly nativeToolPolicySha256: string
  readonly brokerPolicySha256: string
}

export interface CliRuntimeIdentityAuthority {
  readonly kind: 'cli'
  /** Main must pass an already-realpathed executable path. */
  readonly executableRealPath: string
  readonly executableSha256: string
  /** Hash of the provider package/bundle reached by a launcher or wrapper. */
  readonly runtimeBundleSha256: string
  /** Hash of resolved shebang/interpreter/runtime path, content and version attestation. */
  readonly interpreterRuntimeAttestationSha256: string
  readonly executableVersion: string | null
  /** Digest of argv excluding prompt bytes and per-occurrence route ids. */
  readonly launchArgsTemplateSha256: string
}

export interface HttpRuntimeIdentityAuthority {
  readonly kind: 'http'
  /** Main-keyed endpoint HMAC because URLs may embed credentials. */
  readonly endpointHmac: string
  readonly serverIdentitySha256: string
  readonly modelManifestSha256: string
}

export interface CodexLaunchControls {
  readonly transport: 'app-server' | 'exec-json'
  readonly reasoningEffort: string | null
  readonly reasoningConfigurationSha256: string
  readonly serviceTier: string | null
  readonly approvalPolicy: 'untrusted' | 'on-failure' | 'on-request' | 'never'
  readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly sandboxPolicySha256: string
  readonly appServerConfigurationSha256: string
  readonly taskWraithMcpAttachmentMode: 'app-server-config' | 'none'
  readonly persistExtendedHistory: boolean
  readonly experimentalRawEvents: boolean
  /** Scheduled launches authorize one exact transport; fallback requires a new seal. */
  readonly fallbackPolicy: 'forbid'
}

export interface ClaudeLaunchControls {
  readonly transport: 'agent-sdk' | 'cli-print'
  readonly reasoningEffort: string | null
  readonly thinkingConfigurationSha256: string | null
  readonly fastMode: boolean
  readonly permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  /** Required for the SDK path; null for a CLI-only launch. */
  readonly sdkPackageSha256: string | null
  readonly builtinToolMode: 'disabled' | 'provider-native'
  readonly includePartialMessages: boolean
  readonly taskWraithMcpAttachmentMode: 'sdk-config' | 'temp-cli-config' | 'none'
  readonly imageTransport: 'sdk-images' | 'cli-image-args' | 'none'
  readonly fallbackPolicy: 'forbid'
}

/**
 * ACP production authority — the only signable Kimi launch shape. It expresses
 * the source-ahead composition that KimiRuntimeAdmission and
 * launchKimiProductionAcp enforce at spawn: roster-bound runtime admission, a
 * private synthetic cwd (never the workspace), no ACP client-fs capability, and
 * a mandatory authenticated loopback HTTP MCP gateway. The retired Wire and
 * `--print` transports are intentionally unrepresentable; nothing was ever
 * minted against the historical Wire shape, so it decodes nowhere.
 */
export interface KimiLaunchControls {
  readonly transport: 'acp'
  /**
   * Literal twin of KIMI_ACP_PRODUCTION_POSTURE_VERSION (shared/kimiAcpPosture).
   * Kept as a literal so a posture bump cannot silently re-mean schemaVersion 1;
   * ScheduledOccurrenceSeal compares against the shared constant and turns a
   * bump into a compile-time error there.
   */
  readonly acpPostureVersion: 'synthetic-cwd-gateway-v1'
  /** The provider cwd is a private, empty, 0700 directory — never the workspace. */
  readonly workspaceCwdExposure: 'private-synthetic'
  /** `initialize` omits `clientCapabilities.fs`; all workspace I/O rides the gateway. */
  readonly clientFsCapability: 'none'
  /** The governed TaskWraith HTTP MCP gateway is mandatory, not optional. */
  readonly taskWraithMcpAttachmentMode: 'authenticated-loopback-http-gateway'
  /** Digest of the embedded runtime qualification roster that admitted the binary. */
  readonly runtimeAdmissionRosterSha256: string
  /** admitKimiRuntime mode at mint; a verify-time re-admission must match. */
  readonly runtimeAdmissionMode: 'reviewed' | 'unattested-development'
  readonly thinking: boolean
  readonly fallbackPolicy: 'forbid'
}

export interface GrokLaunchControls {
  readonly transport: 'acp' | 'streaming-json'
  readonly reasoningEffort: string | null
  readonly permissionMode: 'plan' | 'acceptEdits' | 'host-gated'
  readonly readOnlySeat: boolean
  readonly taskWraithMcpAttachmentMode: 'acp-session' | 'none'
  readonly persistentSeatMode: 'fresh' | 'read-only-toolless-reuse'
  readonly webSearchEnabled: boolean
  readonly nativeDenyRulesSha256: string
  readonly promptPreambleSha256: string
  readonly fallbackPolicy: 'forbid'
}

export interface MistralLaunchControls {
  /** Mistral Vibe is ACP-only — `vibe-acp`. There is no second transport. */
  readonly transport: 'acp'
  /** The Vibe ACP session mode actually selected via session/set_mode. `plan`
   *  and `chat` are Vibe's read-only modes; `auto-approve` bypasses every tool
   *  gate, so which one ran is authority-relevant, not cosmetic. */
  readonly sessionMode: 'default' | 'plan' | 'accept-edits' | 'auto-approve' | 'chat'
  readonly readOnlySeat: boolean
  /** `initialize` never advertises `clientCapabilities.fs` — the ACP core never
   *  wires onInboundRequest, so an advertised fs capability would be answered
   *  -32601. Bound as a literal so re-advertising it is a seal-visible change. */
  readonly clientFsCapability: 'none'
  /** vibe-acp accepts stdio MCP servers directly in session/new, so this seat
   *  uses the Grok-style direct attachment and never a loopback HTTP gateway. */
  readonly taskWraithMcpAttachmentMode: 'acp-session' | 'none'
  /**
   * WHICH CREDENTIAL THE CHILD WAS SPAWNED WITH — the security fact this seat
   * exists to bind. Vibe resolves auth from MISTRAL_API_KEY FIRST and only then
   * falls back to the plan-backed browser sign-in. That same env var is Pi's
   * upstream key (PiModelPolicy.PI_UPSTREAM_KEY_ENV.mistral), so an unscrubbed
   * env silently moves the run onto the user's metered API billing line instead
   * of their subscription — a different credential, a different bill, no error.
   * `plan-oauth` is the only lane this seat is supposed to use.
   */
  readonly credentialLane: 'plan-oauth' | 'byok-api-key'
  /** True when MISTRAL_API_KEY was explicitly deleted from the child env. A seal
   *  showing `credentialLane: 'plan-oauth'` with this false is incoherent and
   *  must fail verification rather than be trusted. */
  readonly apiKeyEnvScrubbed: boolean
  readonly model: string
  readonly nativeDenyRulesSha256: string
  readonly promptPreambleSha256: string
  readonly fallbackPolicy: 'forbid'
}

export interface CursorLaunchControls {
  readonly transport: 'cursor-agent-stream-json'
  readonly reasoningEffort: string | null
  readonly fastMode: boolean
  /**
   * Exact Cursor CLI mode. `ask` is the native-only read-only argv; `plan` is
   * retained for strict decode of earlier authority fixtures, while bridged
   * read-only seats use `contained-default` because ask/plan executes no MCP.
   */
  readonly executionMode: 'ask' | 'plan' | 'contained-default'
  readonly bridgeMode: 'none' | 'safe-subset' | 'plan-subset' | 'full'
  readonly brokerRegistration: 'none' | 'workspace' | 'global'
  readonly forceMcpTools: boolean
  readonly approveMcpServers: boolean
  readonly nativeContainmentConfigurationSha256: string
  readonly fallbackPolicy: 'forbid'
}

export interface OllamaLaunchControls {
  readonly transport: 'http-chat'
  readonly reasoningLevel: 'low' | 'medium' | 'high' | null
  readonly contextCapTokens: number
  readonly protocolMode: 'native_first' | 'json_fallback' | 'json_only'
  readonly compactToolSchemas: boolean
  readonly oneToolAtATime: boolean
  readonly numPredictTool: number
  readonly numPredictFinal: number
  readonly keepAlive: string | null
  readonly temperature: number
  readonly toolProtocolEnabled: boolean
  readonly nativeToolsSupported: boolean
  readonly readOnly: boolean
  readonly networkAccess: 'allow' | 'deny'
  readonly harnessEnabled: boolean
  readonly maxConsecutiveNonProductiveTurns: number
  readonly retryPolicySha256: string
  readonly memorySnapshotSha256: string
}

export interface ProviderLaunchControlsByProvider {
  readonly codex: CodexLaunchControls
  readonly claude: ClaudeLaunchControls
  readonly kimi: KimiLaunchControls
  readonly grok: GrokLaunchControls
  readonly mistral: MistralLaunchControls
  readonly cursor: CursorLaunchControls
  readonly ollama: OllamaLaunchControls
  readonly pi: PiLaunchControls
  readonly antigravity: AntigravityOfficialAgyLaunchControls | AntigravityGeminiApiLaunchControls
}

export interface ProviderRuntimeIdentityByProvider {
  readonly codex: CliRuntimeIdentityAuthority
  readonly claude: CliRuntimeIdentityAuthority
  readonly kimi: CliRuntimeIdentityAuthority
  readonly grok: CliRuntimeIdentityAuthority
  readonly mistral: CliRuntimeIdentityAuthority
  readonly cursor: CliRuntimeIdentityAuthority
  readonly ollama: HttpRuntimeIdentityAuthority
  readonly pi: CliRuntimeIdentityAuthority
  readonly antigravity:
    | CliRuntimeIdentityAuthority
    | AntigravityInProcessSdkRuntimeIdentityAuthority
}

type CommonProviderLaunchAuthorityInputByProvider = {
  readonly [P in LiveProviderLaunchId]: Readonly<{
    schemaVersion: 1
    provider: P
    common: ProviderLaunchCommonAuthority
    runtime: ProviderRuntimeIdentityByProvider[P]
    tools: ProviderToolSurfaceAuthority
    controls: ProviderLaunchControlsByProvider[P]
  }>
}

export type ProviderLaunchAuthorityInputByProvider =
  CommonProviderLaunchAuthorityInputByProvider & {
    readonly pi: PiProviderLaunchAuthorityInput
    readonly antigravity: AntigravityLaunchAuthorityInput
  }

export type ProviderLaunchAuthorityInput =
  ProviderLaunchAuthorityInputByProvider[LaunchAuthorityProviderId]

export type CanonicalProviderLaunchAuthority = ProviderLaunchAuthorityInput

export const PROVIDER_LAUNCH_COMMON_FIELDS = {
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

export const PROVIDER_TOOL_SURFACE_FIELDS = {
  taskWraithMcpAdvertised: true,
  taskWraithMcpProfileId: true,
  taskWraithMcpCatalogSha256: true,
  providerMcpConfigurationSha256: true,
  userMcpConfigurationSha256: true,
  nativeToolPolicySha256: true,
  brokerPolicySha256: true
} as const satisfies Record<keyof ProviderToolSurfaceAuthority, true>

export const CLI_RUNTIME_IDENTITY_FIELDS = {
  kind: true,
  executableRealPath: true,
  executableSha256: true,
  runtimeBundleSha256: true,
  interpreterRuntimeAttestationSha256: true,
  executableVersion: true,
  launchArgsTemplateSha256: true
} as const satisfies Record<keyof CliRuntimeIdentityAuthority, true>

export const HTTP_RUNTIME_IDENTITY_FIELDS = {
  kind: true,
  endpointHmac: true,
  serverIdentitySha256: true,
  modelManifestSha256: true
} as const satisfies Record<keyof HttpRuntimeIdentityAuthority, true>

export const PROVIDER_LAUNCH_CONTROL_FIELDS = {
  codex: {
    transport: true,
    reasoningEffort: true,
    reasoningConfigurationSha256: true,
    serviceTier: true,
    approvalPolicy: true,
    sandboxMode: true,
    sandboxPolicySha256: true,
    appServerConfigurationSha256: true,
    taskWraithMcpAttachmentMode: true,
    persistExtendedHistory: true,
    experimentalRawEvents: true,
    fallbackPolicy: true
  } satisfies Record<keyof CodexLaunchControls, true>,
  claude: {
    transport: true,
    reasoningEffort: true,
    thinkingConfigurationSha256: true,
    fastMode: true,
    permissionMode: true,
    sdkPackageSha256: true,
    builtinToolMode: true,
    includePartialMessages: true,
    taskWraithMcpAttachmentMode: true,
    imageTransport: true,
    fallbackPolicy: true
  } satisfies Record<keyof ClaudeLaunchControls, true>,
  kimi: {
    transport: true,
    acpPostureVersion: true,
    workspaceCwdExposure: true,
    clientFsCapability: true,
    taskWraithMcpAttachmentMode: true,
    runtimeAdmissionRosterSha256: true,
    runtimeAdmissionMode: true,
    thinking: true,
    fallbackPolicy: true
  } satisfies Record<keyof KimiLaunchControls, true>,
  grok: {
    transport: true,
    reasoningEffort: true,
    permissionMode: true,
    readOnlySeat: true,
    taskWraithMcpAttachmentMode: true,
    persistentSeatMode: true,
    webSearchEnabled: true,
    nativeDenyRulesSha256: true,
    promptPreambleSha256: true,
    fallbackPolicy: true
  } satisfies Record<keyof GrokLaunchControls, true>,
  mistral: {
    transport: true,
    sessionMode: true,
    readOnlySeat: true,
    clientFsCapability: true,
    taskWraithMcpAttachmentMode: true,
    credentialLane: true,
    apiKeyEnvScrubbed: true,
    model: true,
    nativeDenyRulesSha256: true,
    promptPreambleSha256: true,
    fallbackPolicy: true
  } satisfies Record<keyof MistralLaunchControls, true>,
  cursor: {
    transport: true,
    reasoningEffort: true,
    fastMode: true,
    executionMode: true,
    bridgeMode: true,
    brokerRegistration: true,
    forceMcpTools: true,
    approveMcpServers: true,
    nativeContainmentConfigurationSha256: true,
    fallbackPolicy: true
  } satisfies Record<keyof CursorLaunchControls, true>,
  ollama: {
    transport: true,
    reasoningLevel: true,
    contextCapTokens: true,
    protocolMode: true,
    compactToolSchemas: true,
    oneToolAtATime: true,
    numPredictTool: true,
    numPredictFinal: true,
    keepAlive: true,
    temperature: true,
    toolProtocolEnabled: true,
    nativeToolsSupported: true,
    readOnly: true,
    networkAccess: true,
    harnessEnabled: true,
    maxConsecutiveNonProductiveTurns: true,
    retryPolicySha256: true,
    memorySnapshotSha256: true
  } satisfies Record<keyof OllamaLaunchControls, true>
} as const satisfies {
  readonly [P in LiveProviderLaunchId]: Record<keyof ProviderLaunchControlsByProvider[P], true>
}

/**
 * Strictly normalize a main-resolved launch plan. This module deliberately has
 * no AppStore, Electron, process.env, filesystem, or provider-runtime imports;
 * callers must resolve those mutable facts before crossing this boundary.
 *
 * Caller obligations are intentionally explicit:
 * - select one final transport (scheduled runs may not fall back after sealing);
 * - realpath + hash the executable, or hash the Ollama endpoint/server/model;
 * - pass the normalized wire model and every derived provider control below;
 * - hash the final provider-visible prompt, provider config, model capability,
 *   MCP documents/catalogs and native/broker tool policies;
 * - HMAC the complete resolved environment, credential state and resumed
 *   session id with main-owned key material. Raw secrets never enter this value.
 *
 * The digest is therefore only as complete as the impure resolver feeding it.
 * Integration must build this record immediately before occurrence sealing and
 * rebuild the same record immediately before the final-use lease is consumed.
 * `fallbackPolicy: 'forbid'` is signed intent, not self-enforcement: the
 * dispatcher must refuse every adapter fallback/reroute after lease validation.
 */
export function buildProviderLaunchAuthority(
  input: ProviderLaunchAuthorityInput
): CanonicalProviderLaunchAuthority {
  const root = exactObject(
    input,
    ['schemaVersion', 'provider', 'common', 'runtime', 'tools', 'controls'],
    'provider launch authority'
  )
  if (root.schemaVersion !== 1) throw new TypeError('Invalid provider launch schema version.')
  const provider = launchAuthorityProviderId(root.provider)

  // AntiGravity owns a two-transport discriminated validator (official agy CLI
  // versus the in-process Gemini API SDK). Run it first, then pass its shared
  // common/tool/CLI shapes through the central normalizers as a second,
  // deliberately stricter boundary.
  if (provider === 'antigravity') {
    const local = buildAntigravityLaunchAuthority(input as AntigravityLaunchAuthorityInput)
    const common = normalizeCommon(local.common)
    const tools = normalizeTools(local.tools)
    const runtime =
      local.runtime.kind === 'cli' ? normalizeCliRuntime(local.runtime) : local.runtime
    return canonicalClone({
      schemaVersion: 1,
      provider,
      common,
      runtime,
      tools,
      controls: local.controls
    }) as CanonicalProviderLaunchAuthority
  }

  const common = normalizeCommon(root.common)
  const tools = normalizeTools(root.tools)

  if (provider === 'pi') {
    const runtime = normalizeCliRuntime(root.runtime)
    const controls = normalizePiLaunchControls(root.controls)
    assertPiLaunchAuthorityInvariants({ common, runtime, tools, controls })
    return canonicalClone({
      schemaVersion: 1,
      provider,
      common,
      runtime,
      tools,
      controls
    }) as CanonicalProviderLaunchAuthority
  }

  const runtime = normalizeRuntime(provider, root.runtime)
  const controls = normalizeControls(provider, root.controls)
  assertCrossFieldInvariants(provider, common, tools, runtime, controls)
  return canonicalClone({
    schemaVersion: 1,
    provider,
    common,
    runtime,
    tools,
    controls
  }) as CanonicalProviderLaunchAuthority
}

export function providerLaunchAuthorityDigest(input: ProviderLaunchAuthorityInput): string {
  const authority = buildProviderLaunchAuthority(input)
  return createHash('sha256')
    .update(PROVIDER_LAUNCH_DOMAIN)
    .update(canonicalEncode(authority))
    .digest('hex')
}

function normalizeCommon(value: unknown): ProviderLaunchCommonAuthority {
  const record = exactObject(value, Object.keys(PROVIDER_LAUNCH_COMMON_FIELDS), 'launch common')
  return {
    adapterRevision: nonEmptyText(record.adapterRevision, 'adapter revision'),
    model: nonEmptyText(record.model, 'provider model'),
    modelCapabilitySha256: sha256(record.modelCapabilitySha256, 'model capability digest'),
    promptEnvelopeSha256: sha256(record.promptEnvelopeSha256, 'prompt envelope digest'),
    sessionMode: oneOf(
      record.sessionMode,
      ['fresh', 'resume', 'reusable'],
      'provider session mode'
    ),
    resumeSessionHmac: nullableSha256(record.resumeSessionHmac, 'resume session HMAC'),
    providerSessionGenerationSha256: nullableSha256(
      record.providerSessionGenerationSha256,
      'provider session generation digest'
    ),
    launchEnvironmentHmac: sha256(record.launchEnvironmentHmac, 'launch environment HMAC'),
    credentialStateHmac: sha256(record.credentialStateHmac, 'credential state HMAC'),
    providerConfigurationSha256: sha256(
      record.providerConfigurationSha256,
      'provider configuration digest'
    ),
    capabilityContractSha256: sha256(record.capabilityContractSha256, 'capability contract digest')
  }
}

function normalizeTools(value: unknown): ProviderToolSurfaceAuthority {
  const record = exactObject(value, Object.keys(PROVIDER_TOOL_SURFACE_FIELDS), 'tool surface')
  const advertised = boolean(record.taskWraithMcpAdvertised, 'TaskWraith MCP advertised')
  const profileId = nullableMcpProfileId(record.taskWraithMcpProfileId)
  if (advertised !== (profileId !== null)) {
    throw new TypeError('TaskWraith MCP profile presence must match advertised state.')
  }
  return {
    taskWraithMcpAdvertised: advertised,
    taskWraithMcpProfileId: profileId,
    taskWraithMcpCatalogSha256: sha256(
      record.taskWraithMcpCatalogSha256,
      'TaskWraith MCP catalog digest'
    ),
    providerMcpConfigurationSha256: sha256(
      record.providerMcpConfigurationSha256,
      'provider MCP configuration digest'
    ),
    userMcpConfigurationSha256: sha256(
      record.userMcpConfigurationSha256,
      'user MCP configuration digest'
    ),
    nativeToolPolicySha256: sha256(record.nativeToolPolicySha256, 'native tool policy digest'),
    brokerPolicySha256: sha256(record.brokerPolicySha256, 'broker policy digest')
  }
}

function normalizeRuntime(
  provider: LiveProviderLaunchId,
  value: unknown
): CliRuntimeIdentityAuthority | HttpRuntimeIdentityAuthority {
  if (provider === 'ollama') return normalizeHttpRuntime(value)
  return normalizeCliRuntime(value)
}

function normalizeCliRuntime(value: unknown): CliRuntimeIdentityAuthority {
  const record = exactObject(
    value,
    Object.keys(CLI_RUNTIME_IDENTITY_FIELDS),
    'CLI runtime identity'
  )
  if (record.kind !== 'cli') throw new TypeError('CLI provider runtime kind must be cli.')
  return {
    kind: 'cli',
    executableRealPath: canonicalAbsolutePath(record.executableRealPath),
    executableSha256: sha256(record.executableSha256, 'executable digest'),
    runtimeBundleSha256: sha256(record.runtimeBundleSha256, 'runtime bundle digest'),
    interpreterRuntimeAttestationSha256: sha256(
      record.interpreterRuntimeAttestationSha256,
      'interpreter/runtime attestation digest'
    ),
    executableVersion: nullableText(record.executableVersion, 'executable version'),
    launchArgsTemplateSha256: sha256(record.launchArgsTemplateSha256, 'launch argv template digest')
  }
}

function normalizeHttpRuntime(value: unknown): HttpRuntimeIdentityAuthority {
  const record = exactObject(
    value,
    Object.keys(HTTP_RUNTIME_IDENTITY_FIELDS),
    'HTTP runtime identity'
  )
  if (record.kind !== 'http') throw new TypeError('Ollama runtime kind must be http.')
  return {
    kind: 'http',
    endpointHmac: sha256(record.endpointHmac, 'endpoint HMAC'),
    serverIdentitySha256: sha256(record.serverIdentitySha256, 'server identity digest'),
    modelManifestSha256: sha256(record.modelManifestSha256, 'model manifest digest')
  }
}

function normalizeControls(
  provider: LiveProviderLaunchId,
  value: unknown
): ProviderLaunchControlsByProvider[LiveProviderLaunchId] {
  switch (provider) {
    case 'codex':
      return normalizeCodexControls(value)
    case 'claude':
      return normalizeClaudeControls(value)
    case 'kimi':
      return normalizeKimiControls(value)
    case 'grok':
      return normalizeGrokControls(value)
    case 'mistral':
      return normalizeMistralControls(value)
    case 'cursor':
      return normalizeCursorControls(value)
    case 'ollama':
      return normalizeOllamaControls(value)
    default:
      return assertNever(provider)
  }
}

function normalizeCodexControls(value: unknown): CodexLaunchControls {
  const record = exactObject(
    value,
    Object.keys(PROVIDER_LAUNCH_CONTROL_FIELDS.codex),
    'Codex controls'
  )
  return {
    transport: oneOf(record.transport, ['app-server', 'exec-json'], 'Codex transport'),
    reasoningEffort: nullableText(record.reasoningEffort, 'Codex reasoning effort'),
    reasoningConfigurationSha256: sha256(
      record.reasoningConfigurationSha256,
      'Codex reasoning configuration digest'
    ),
    serviceTier: nullableText(record.serviceTier, 'Codex service tier'),
    approvalPolicy: oneOf(
      record.approvalPolicy,
      ['untrusted', 'on-failure', 'on-request', 'never'],
      'Codex approval policy'
    ),
    sandboxMode: oneOf(
      record.sandboxMode,
      ['read-only', 'workspace-write', 'danger-full-access'],
      'Codex sandbox mode'
    ),
    sandboxPolicySha256: sha256(record.sandboxPolicySha256, 'Codex sandbox policy digest'),
    appServerConfigurationSha256: sha256(
      record.appServerConfigurationSha256,
      'Codex app-server configuration digest'
    ),
    taskWraithMcpAttachmentMode: oneOf(
      record.taskWraithMcpAttachmentMode,
      ['app-server-config', 'none'],
      'Codex TaskWraith MCP attachment mode'
    ),
    persistExtendedHistory: boolean(record.persistExtendedHistory, 'persist extended history'),
    experimentalRawEvents: boolean(record.experimentalRawEvents, 'experimental raw events'),
    fallbackPolicy: oneOf(record.fallbackPolicy, ['forbid'], 'Codex fallback policy')
  }
}

function normalizeClaudeControls(value: unknown): ClaudeLaunchControls {
  const record = exactObject(
    value,
    Object.keys(PROVIDER_LAUNCH_CONTROL_FIELDS.claude),
    'Claude controls'
  )
  return {
    transport: oneOf(record.transport, ['agent-sdk', 'cli-print'], 'Claude transport'),
    reasoningEffort: nullableText(record.reasoningEffort, 'Claude reasoning effort'),
    thinkingConfigurationSha256: nullableSha256(
      record.thinkingConfigurationSha256,
      'Claude thinking configuration digest'
    ),
    fastMode: boolean(record.fastMode, 'Claude fast mode'),
    permissionMode: oneOf(
      record.permissionMode,
      ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
      'Claude permission mode'
    ),
    sdkPackageSha256: nullableSha256(record.sdkPackageSha256, 'Claude SDK package digest'),
    builtinToolMode: oneOf(
      record.builtinToolMode,
      ['disabled', 'provider-native'],
      'Claude built-in tool mode'
    ),
    includePartialMessages: boolean(record.includePartialMessages, 'Claude partial messages'),
    taskWraithMcpAttachmentMode: oneOf(
      record.taskWraithMcpAttachmentMode,
      ['sdk-config', 'temp-cli-config', 'none'],
      'Claude TaskWraith MCP attachment mode'
    ),
    imageTransport: oneOf(
      record.imageTransport,
      ['sdk-images', 'cli-image-args', 'none'],
      'Claude image transport'
    ),
    fallbackPolicy: oneOf(record.fallbackPolicy, ['forbid'], 'Claude fallback policy')
  }
}

function normalizeKimiControls(value: unknown): KimiLaunchControls {
  const record = exactObject(
    value,
    Object.keys(PROVIDER_LAUNCH_CONTROL_FIELDS.kimi),
    'Kimi controls'
  )
  return {
    transport: oneOf(record.transport, ['acp'], 'Kimi transport'),
    acpPostureVersion: oneOf(
      record.acpPostureVersion,
      ['synthetic-cwd-gateway-v1'],
      'Kimi ACP posture version'
    ),
    workspaceCwdExposure: oneOf(
      record.workspaceCwdExposure,
      ['private-synthetic'],
      'Kimi workspace cwd exposure'
    ),
    clientFsCapability: oneOf(record.clientFsCapability, ['none'], 'Kimi client fs capability'),
    taskWraithMcpAttachmentMode: oneOf(
      record.taskWraithMcpAttachmentMode,
      ['authenticated-loopback-http-gateway'],
      'Kimi TaskWraith MCP attachment mode'
    ),
    runtimeAdmissionRosterSha256: sha256(
      record.runtimeAdmissionRosterSha256,
      'Kimi runtime admission roster digest'
    ),
    runtimeAdmissionMode: oneOf(
      record.runtimeAdmissionMode,
      ['reviewed', 'unattested-development'],
      'Kimi runtime admission mode'
    ),
    thinking: boolean(record.thinking, 'Kimi thinking'),
    fallbackPolicy: oneOf(record.fallbackPolicy, ['forbid'], 'Kimi fallback policy')
  }
}

function normalizeGrokControls(value: unknown): GrokLaunchControls {
  const record = exactObject(
    value,
    Object.keys(PROVIDER_LAUNCH_CONTROL_FIELDS.grok),
    'Grok controls'
  )
  return {
    transport: oneOf(record.transport, ['acp', 'streaming-json'], 'Grok transport'),
    reasoningEffort: nullableText(record.reasoningEffort, 'Grok reasoning effort'),
    permissionMode: oneOf(
      record.permissionMode,
      ['plan', 'acceptEdits', 'host-gated'],
      'Grok permission mode'
    ),
    readOnlySeat: boolean(record.readOnlySeat, 'Grok read-only seat'),
    taskWraithMcpAttachmentMode: oneOf(
      record.taskWraithMcpAttachmentMode,
      ['acp-session', 'none'],
      'Grok TaskWraith MCP attachment mode'
    ),
    persistentSeatMode: oneOf(
      record.persistentSeatMode,
      ['fresh', 'read-only-toolless-reuse'],
      'Grok persistent seat mode'
    ),
    webSearchEnabled: boolean(record.webSearchEnabled, 'Grok web search'),
    nativeDenyRulesSha256: sha256(record.nativeDenyRulesSha256, 'Grok deny rules digest'),
    promptPreambleSha256: sha256(record.promptPreambleSha256, 'Grok prompt preamble digest'),
    fallbackPolicy: oneOf(record.fallbackPolicy, ['forbid'], 'Grok fallback policy')
  }
}

function normalizeMistralControls(value: unknown): MistralLaunchControls {
  const record = exactObject(
    value,
    Object.keys(PROVIDER_LAUNCH_CONTROL_FIELDS.mistral),
    'Mistral controls'
  )
  const credentialLane = oneOf(
    record.credentialLane,
    ['plan-oauth', 'byok-api-key'],
    'Mistral credential lane'
  )
  const apiKeyEnvScrubbed = boolean(record.apiKeyEnvScrubbed, 'Mistral API key env scrub')
  // A seal claiming the subscription lane while admitting the API key was left
  // in the child env describes two different billing lanes at once. Vibe prefers
  // the env var, so the scrub is the ONLY thing that makes `plan-oauth` true.
  // Refuse the record rather than mint authority for an incoherent launch.
  if (credentialLane === 'plan-oauth' && !apiKeyEnvScrubbed) {
    throw new Error(
      'Mistral credential lane is plan-oauth but MISTRAL_API_KEY was not scrubbed from the child env: Vibe resolves the env key ahead of the plan sign-in, so this launch would have billed the API key.'
    )
  }
  return {
    transport: oneOf(record.transport, ['acp'], 'Mistral transport'),
    sessionMode: oneOf(
      record.sessionMode,
      ['default', 'plan', 'accept-edits', 'auto-approve', 'chat'],
      'Mistral session mode'
    ),
    readOnlySeat: boolean(record.readOnlySeat, 'Mistral read-only seat'),
    clientFsCapability: oneOf(record.clientFsCapability, ['none'], 'Mistral client fs capability'),
    taskWraithMcpAttachmentMode: oneOf(
      record.taskWraithMcpAttachmentMode,
      ['acp-session', 'none'],
      'Mistral TaskWraith MCP attachment mode'
    ),
    credentialLane,
    apiKeyEnvScrubbed,
    model: nonEmptyText(record.model, 'Mistral model'),
    nativeDenyRulesSha256: sha256(record.nativeDenyRulesSha256, 'Mistral deny rules digest'),
    promptPreambleSha256: sha256(record.promptPreambleSha256, 'Mistral prompt preamble digest'),
    fallbackPolicy: oneOf(record.fallbackPolicy, ['forbid'], 'Mistral fallback policy')
  }
}

function normalizeCursorControls(value: unknown): CursorLaunchControls {
  const record = exactObject(
    value,
    Object.keys(PROVIDER_LAUNCH_CONTROL_FIELDS.cursor),
    'Cursor controls'
  )
  return {
    transport: oneOf(record.transport, ['cursor-agent-stream-json'], 'Cursor transport'),
    reasoningEffort: nullableText(record.reasoningEffort, 'Cursor reasoning effort'),
    fastMode: boolean(record.fastMode, 'Cursor fast mode'),
    executionMode: oneOf(
      record.executionMode,
      ['ask', 'plan', 'contained-default'],
      'Cursor execution mode'
    ),
    bridgeMode: oneOf(
      record.bridgeMode,
      ['none', 'safe-subset', 'plan-subset', 'full'],
      'Cursor bridge mode'
    ),
    brokerRegistration: oneOf(
      record.brokerRegistration,
      ['none', 'workspace', 'global'],
      'Cursor broker registration'
    ),
    forceMcpTools: boolean(record.forceMcpTools, 'Cursor force MCP tools'),
    approveMcpServers: boolean(record.approveMcpServers, 'Cursor approve MCP servers'),
    nativeContainmentConfigurationSha256: sha256(
      record.nativeContainmentConfigurationSha256,
      'Cursor containment configuration digest'
    ),
    fallbackPolicy: oneOf(record.fallbackPolicy, ['forbid'], 'Cursor fallback policy')
  }
}

function normalizeOllamaControls(value: unknown): OllamaLaunchControls {
  const record = exactObject(
    value,
    Object.keys(PROVIDER_LAUNCH_CONTROL_FIELDS.ollama),
    'Ollama controls'
  )
  return {
    transport: oneOf(record.transport, ['http-chat'], 'Ollama transport'),
    reasoningLevel: nullableOneOf(
      record.reasoningLevel,
      ['low', 'medium', 'high'],
      'Ollama reasoning level'
    ),
    contextCapTokens: positiveInteger(record.contextCapTokens, 'Ollama context cap'),
    protocolMode: oneOf(
      record.protocolMode,
      ['native_first', 'json_fallback', 'json_only'],
      'Ollama protocol mode'
    ),
    compactToolSchemas: boolean(record.compactToolSchemas, 'Ollama compact tool schemas'),
    oneToolAtATime: boolean(record.oneToolAtATime, 'Ollama one tool at a time'),
    numPredictTool: positiveInteger(record.numPredictTool, 'Ollama tool prediction cap'),
    numPredictFinal: positiveInteger(record.numPredictFinal, 'Ollama final prediction cap'),
    keepAlive: nullableText(record.keepAlive, 'Ollama keep-alive'),
    temperature: finiteNumber(record.temperature, 'Ollama temperature', 0, 2),
    toolProtocolEnabled: boolean(record.toolProtocolEnabled, 'Ollama tool protocol'),
    nativeToolsSupported: boolean(record.nativeToolsSupported, 'Ollama native tools'),
    readOnly: boolean(record.readOnly, 'Ollama read-only posture'),
    networkAccess: oneOf(record.networkAccess, ['allow', 'deny'], 'Ollama network access'),
    harnessEnabled: boolean(record.harnessEnabled, 'Ollama harness'),
    maxConsecutiveNonProductiveTurns: positiveInteger(
      record.maxConsecutiveNonProductiveTurns,
      'Ollama non-productive turn ceiling'
    ),
    retryPolicySha256: sha256(record.retryPolicySha256, 'Ollama retry policy digest'),
    memorySnapshotSha256: sha256(record.memorySnapshotSha256, 'Ollama memory snapshot digest')
  }
}

function assertCrossFieldInvariants(
  provider: LiveProviderLaunchId,
  common: ProviderLaunchCommonAuthority,
  tools: ProviderToolSurfaceAuthority,
  runtime: CliRuntimeIdentityAuthority | HttpRuntimeIdentityAuthority,
  controls: ProviderLaunchControlsByProvider[LiveProviderLaunchId]
): void {
  const hasSessionIdentity = common.resumeSessionHmac !== null
  const hasSessionGeneration = common.providerSessionGenerationSha256 !== null
  if (common.sessionMode === 'fresh') {
    if (hasSessionIdentity || hasSessionGeneration) {
      throw new TypeError('Fresh provider sessions cannot carry resume or generation authority.')
    }
  } else if (!hasSessionIdentity || !hasSessionGeneration) {
    throw new TypeError(
      'Resumed and reusable provider sessions require identity and generation authority.'
    )
  }
  if (common.sessionMode === 'reusable' && provider !== 'grok') {
    throw new TypeError('Only a host-owned Grok seat may use reusable session mode.')
  }

  if (provider === 'ollama') {
    if (runtime.kind !== 'http') throw new TypeError('Ollama requires an HTTP runtime identity.')
    const ollama = controls as OllamaLaunchControls
    if (common.sessionMode !== 'fresh') {
      throw new TypeError(
        'Ollama HTTP launches use fresh session mode; memory is bound separately.'
      )
    }
    if (ollama.toolProtocolEnabled !== tools.taskWraithMcpAdvertised) {
      throw new TypeError('Ollama TaskWraith MCP advertisement must match its tool protocol.')
    }
    return
  }
  if (runtime.kind !== 'cli') throw new TypeError(`${provider} requires a CLI runtime identity.`)
  if (provider === 'codex') {
    const codex = controls as CodexLaunchControls
    const attached = codex.taskWraithMcpAttachmentMode !== 'none'
    if (attached !== tools.taskWraithMcpAdvertised) {
      throw new TypeError('Codex TaskWraith MCP advertisement must match its attachment mode.')
    }
    if (codex.transport === 'exec-json' && (attached || common.sessionMode !== 'fresh')) {
      throw new TypeError('Codex exec transport must be fresh and cannot attach TaskWraith MCP.')
    }
  } else if (provider === 'claude') {
    const claude = controls as ClaudeLaunchControls
    const attached = claude.taskWraithMcpAttachmentMode !== 'none'
    if (attached !== tools.taskWraithMcpAdvertised) {
      throw new TypeError('Claude TaskWraith MCP advertisement must match its attachment mode.')
    }
    if ((claude.transport === 'agent-sdk') !== (claude.sdkPackageSha256 !== null)) {
      throw new TypeError('Claude SDK package identity must be present only for the SDK transport.')
    }
    if (
      claude.transport === 'agent-sdk' &&
      (claude.taskWraithMcpAttachmentMode === 'temp-cli-config' ||
        claude.imageTransport === 'cli-image-args')
    ) {
      throw new TypeError('Claude SDK transport cannot use CLI-only launch controls.')
    }
    if (
      claude.transport === 'cli-print' &&
      (claude.taskWraithMcpAttachmentMode === 'sdk-config' ||
        claude.imageTransport === 'sdk-images')
    ) {
      throw new TypeError('Claude CLI transport cannot use SDK-only launch controls.')
    }
  } else if (provider === 'kimi') {
    // launchKimiProductionAcp refuses gateway-less seats, so a signable Kimi
    // authority cannot express one either; the attachment mode has no 'none'.
    if (!tools.taskWraithMcpAdvertised) {
      throw new TypeError('Kimi ACP requires the governed TaskWraith MCP gateway advertised.')
    }
    if (common.sessionMode === 'reusable') {
      throw new TypeError('Kimi ACP seats are fresh or posture-matched resume, never reusable.')
    }
  } else if (provider === 'grok') {
    const grok = controls as GrokLaunchControls
    const attached = grok.taskWraithMcpAttachmentMode !== 'none'
    if (attached !== tools.taskWraithMcpAdvertised) {
      throw new TypeError('Grok TaskWraith MCP advertisement must match its attachment mode.')
    }
    if ((grok.transport === 'acp') !== (grok.permissionMode === 'host-gated')) {
      throw new TypeError('Grok ACP transport must use host-gated permission mode.')
    }
    if (grok.taskWraithMcpAttachmentMode === 'acp-session' && grok.transport !== 'acp') {
      throw new TypeError('Grok MCP session attachment requires ACP transport.')
    }
    const reusable = grok.persistentSeatMode === 'read-only-toolless-reuse'
    if (reusable !== (common.sessionMode === 'reusable')) {
      throw new TypeError('Reusable Grok seat mode must match reusable session authority.')
    }
    if (
      reusable &&
      (grok.transport !== 'acp' || !grok.readOnlySeat || attached || tools.taskWraithMcpAdvertised)
    ) {
      throw new TypeError('Reusable Grok seats must use read-only, tool-less ACP transport.')
    }
    if (grok.transport === 'acp' && common.sessionMode === 'resume') {
      throw new TypeError('Grok ACP uses fresh or host-reusable seats, not provider resume mode.')
    }
  } else if (provider === 'cursor') {
    const cursor = controls as CursorLaunchControls
    const hasBridge = cursor.bridgeMode !== 'none'
    if (hasBridge !== tools.taskWraithMcpAdvertised) {
      throw new TypeError('Cursor TaskWraith MCP advertisement must match bridge presence.')
    }
    if (hasBridge !== cursor.approveMcpServers) {
      throw new TypeError('Cursor MCP approval must exactly match bridge presence.')
    }
    if (cursor.forceMcpTools && !hasBridge) {
      throw new TypeError('Cursor cannot force MCP tools without a contained bridge.')
    }
    if ((cursor.brokerRegistration !== 'none') !== hasBridge) {
      throw new TypeError('Cursor broker registration must exactly match bridge presence.')
    }
  }
}

function launchAuthorityProviderId(value: unknown): LaunchAuthorityProviderId {
  if (
    value === 'codex' ||
    value === 'claude' ||
    value === 'kimi' ||
    value === 'grok' ||
    value === 'cursor' ||
    value === 'ollama' ||
    value === 'pi' ||
    value === 'antigravity'
  ) {
    return value
  }
  throw new TypeError(
    'Provider launch authority requires a supported authority provider; Gemini is retired.'
  )
}

function nullableMcpProfileId(value: unknown): TaskWraithMcpProfileId | null {
  if (value === null) return null
  return oneOf(
    value,
    [
      'taskwraith-full-v1',
      'taskwraith-full-v2',
      'taskwraith-core-v1',
      'taskwraith-core-v2',
      'taskwraith-gateway-v1',
      'taskwraith-gateway-v2',
      'taskwraith-gateway-v3',
      'taskwraith-gateway-v4',
      'taskwraith-gateway-v5',
      'taskwraith-gateway-v6'
    ],
    'TaskWraith MCP profile'
  )
}

function canonicalAbsolutePath(value: unknown): string {
  const path = nonEmptyText(value, 'executable real path')
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError('Executable real path must be a canonical absolute path.')
  }
  return path
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
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`)
  if (value !== value.trim() || !value || value.length > MAX_TEXT_LENGTH || value.includes('\0')) {
    throw new TypeError(`${label} is invalid.`)
  }
  return value
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null
  return nonEmptyText(value, label)
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256/HMAC digest.`)
  }
  return value
}

function nullableSha256(value: unknown, label: string): string | null {
  return value === null ? null : sha256(value, label)
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean.`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`)
  }
  return value as number
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a finite number from ${minimum} to ${maximum}.`)
  }
  return Object.is(value, -0) ? 0 : value
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

function nullableOneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number] | null {
  return value === null ? null : oneOf(value, values, label)
}

function canonicalClone<T>(value: T): T {
  const clone = cloneCanonical(value, new Set()) as T
  deepFreeze(clone)
  return clone
}

function cloneCanonical(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Launch authority contains a non-finite number.')
    }
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== 'object') throw new TypeError('Launch authority contains unsupported data.')
  if (seen.has(value)) throw new TypeError('Launch authority contains a cycle.')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        throw new TypeError('Launch authority contains a sparse or decorated array.')
      }
      return value.map((item) => cloneCanonical(item, seen))
    }
    const record = exactObject(value, Object.keys(value), 'canonical authority object')
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      result[key] = cloneCanonical(record[key], seen)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

function canonicalEncode(value: unknown): string {
  return JSON.stringify(canonicalClone(value))
}

function deepFreeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
  for (const child of Object.values(value)) deepFreeze(child)
  Object.freeze(value)
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled live provider: ${String(value)}`)
}
