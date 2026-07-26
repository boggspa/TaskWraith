import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, sep } from 'node:path'
import { getStaticProviderModels } from '../providers/StaticProviderModels'
import { resolveContextWindow } from '../../shared/contextWindows'
import { isAntigravityOptInEnabled } from '../../shared/retiredProviders'
import {
  AGY_READ_ONLY_PRINT_TIMEOUT,
  AGY_STRIPPED_CREDENTIAL_ENV_KEYS,
  type ResolvedAgyCliBinary
} from '../antigravity/AntigravityCli'
import {
  prepareAntigravityProviderLaunch,
  type AntigravityProviderRuntimeDependencies
} from '../antigravity/AntigravityProviderRuntime'
import {
  verifyAgyBinaryProvenance,
  type AgyBinaryProvenance
} from '../antigravity/AntigravityBinaryProvenance'
import { isAntigravityGeminiApiModelCandidate } from '../antigravity/AntigravityCombinedModeDispatch'
import type { AntigravityGeminiApiSecretStore } from '../antigravity/AntigravityGeminiApiSecretStore'
import { buildGeminiFunctionDeclarations } from '../GeminiApiToolDeclarations'
import { buildGeminiTurnContents, type GeminiContent } from '../GeminiApiHistoryAdapter'
import type {
  AppSettings,
  ChatRecord,
  EffectiveRunPermissions,
  TaskWraithMcpProfileId
} from '../store/types'
import type {
  CliRuntimeIdentityAuthority,
  ProviderLaunchCommonAuthority,
  ProviderToolSurfaceAuthority
} from '../ProviderLaunchAuthorityDigest'
import type { ScheduledOccurrenceAuthorityRoot } from '../ScheduledOccurrenceAuthorityRootStore'
import {
  buildAntigravityLaunchAuthority,
  type AntigravityInProcessSdkRuntimeIdentityAuthority,
  type AntigravityLaunchAuthorityInput
} from './AntigravityLaunchAuthority'
import {
  SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER,
  SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
  SealEvidenceError,
  canonicalEvidenceEncode,
  interpreterRuntimeAttestationSha256,
  launchArgsTemplateSha256,
  nearestPackageManifestPath,
  sha256HexOfCanonicalJson,
  sha256HexOfUtf8,
  type CanonicalEvidenceValue,
  type SealEvidenceFileHasher
} from './SealEvidenceCore'

const EXACT_GEMINI_API_MODEL = /^gemini-api:(gemini-[a-z0-9][a-z0-9._-]{0,127})$/
export const ANTIGRAVITY_GEMINI_API_MAX_TOOL_ROUNDS = 20 as const

export interface AntigravitySealEvidenceDeps {
  readonly appVersion: string
  readonly hasher: SealEvidenceFileHasher
  /**
   * Evidence supplies the literal `antigravity` provider domain internally.
   * Callers cannot inject pre-bound canonical/secret HMAC callbacks.
   */
  readonly authorityRoot: Pick<ScheduledOccurrenceAuthorityRoot, 'providerLaunchHmac'>
}

interface AntigravitySealEvidenceCommonFacts {
  readonly model: string
  readonly promptEnvelope: Readonly<{
    readonly contextualPrompt: string
    readonly finalPrompt: string
    readonly runtimePreambleVersion: string | null
  }>
  readonly capabilityContract: CanonicalEvidenceValue
  readonly userMcpConfiguration: CanonicalEvidenceValue
}

export interface AntigravityOfficialAgySealEvidenceFacts extends AntigravitySealEvidenceCommonFacts {
  readonly lane: 'official-agy'
  readonly settings:
    | Pick<AppSettings, 'antigravityEnabled' | 'antigravityOptInAcceptedAt' | 'agenticServices'>
    | null
    | undefined
  readonly reasoningEffort: string | null
  readonly approvalMode: string
  readonly effectivePermissions: Pick<EffectiveRunPermissions, 'readOnly'>
  readonly conversationId: string | null
  readonly inheritedEnv: Readonly<Record<string, string | undefined>>
  readonly resolveBinary?: () => Promise<ResolvedAgyCliBinary>
  readonly createEnv?: AntigravityProviderRuntimeDependencies['createEnv']
  readonly verifyBinaryProvenance?: (binaryPath: string) => Promise<AgyBinaryProvenance>
}

export interface AntigravityGeminiApiSealEvidenceFacts extends AntigravitySealEvidenceCommonFacts {
  readonly lane: 'gemini-api'
  readonly settings:
    | Pick<AppSettings, 'antigravityGeminiApiDisclosureAcceptedAt'>
    | null
    | undefined
  readonly secretStore: Pick<AntigravityGeminiApiSecretStore, 'loadApiKey'>
  /** Exact current Electron/Node process environment inherited by the SDK. */
  readonly resolvedHostEnv: Readonly<Record<string, string>>
  readonly hostExecutablePath: string
  readonly hostRuntimeVersion: CanonicalEvidenceValue
  /** Resolved package.json and runtime entrypoint for the loaded @google/genai package. */
  readonly sdkPackageJsonPath: string
  readonly sdkEntrypointPath: string
  readonly priorChat: ChatRecord | null
  readonly ensembleSeatTurn: boolean
  readonly imageCount: number
  readonly mcpToolDefinitions: ReadonlyArray<{
    readonly name?: string
    readonly description?: string
    readonly inputSchema?: unknown
  }>
  readonly taskWraithMcpAdvertised: boolean
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
}

export type AntigravitySealEvidenceFacts =
  | AntigravityOfficialAgySealEvidenceFacts
  | AntigravityGeminiApiSealEvidenceFacts

export type AntigravityScheduledEvidenceRoute =
  | Readonly<{ kind: 'official-agy' }>
  | Readonly<{ kind: 'gemini-api'; apiModel: string }>
  | Readonly<{ kind: 'skipped'; reason: string }>

export type AntigravitySealEvidenceOutcome =
  | Readonly<{
      ok: true
      evidence: AntigravityLaunchAuthorityInput
      effectiveBinary: string
      effectivePersistence: 'ephemeral' | 'reusable'
      resolvedEnv: Readonly<Record<string, string>>
    }>
  | Readonly<{ ok: 'skipped'; reason: string }>

/**
 * Route exactly like dispatchAntigravityCombinedMode, then narrow the API
 * namespace to the committed wire id accepted by the live agentic runtime.
 * Image-bearing API requests stay explicitly unsealed until the upload/inline
 * file authority can be re-derived from durable attachment snapshots.
 */
export function antigravityScheduledEvidenceRoute(input: {
  model: unknown
  imageCount?: number
}): AntigravityScheduledEvidenceRoute {
  if (!isAntigravityGeminiApiModelCandidate(input.model)) {
    return { kind: 'official-agy' }
  }
  const model = typeof input.model === 'string' ? input.model.trim() : ''
  const matched = EXACT_GEMINI_API_MODEL.exec(model)
  if (!matched) {
    return {
      kind: 'skipped',
      reason:
        'The AntiGravity model is routed to the Gemini API namespace but is not an exact gemini-api:gemini-* wire id; dispatch will report the existing invalid-model result.'
    }
  }
  if (
    input.imageCount !== undefined &&
    (!Number.isSafeInteger(input.imageCount) || input.imageCount < 0)
  ) {
    return {
      kind: 'skipped',
      reason:
        'AntiGravity Gemini API attachment evidence is malformed; dispatching under the existing signed posture without claiming exact image transport evidence.'
    }
  }
  if (typeof input.imageCount === 'number' && input.imageCount > 0) {
    return {
      kind: 'skipped',
      reason:
        'AntiGravity Gemini API image uploads are not seal-wired yet; dispatching under the existing signed posture without claiming exact image transport evidence.'
    }
  }
  return { kind: 'gemini-api', apiModel: matched[1] }
}

export async function buildAntigravitySealEvidence(
  deps: AntigravitySealEvidenceDeps,
  facts: AntigravitySealEvidenceFacts
): Promise<AntigravitySealEvidenceOutcome> {
  const route = antigravityScheduledEvidenceRoute({
    model: facts.model,
    imageCount: facts.lane === 'gemini-api' ? facts.imageCount : 0
  })
  if (route.kind === 'skipped') return { ok: 'skipped', reason: route.reason }
  if (route.kind !== facts.lane) {
    throw new SealEvidenceError(
      `AntiGravity evidence lane '${facts.lane}' contradicts model route '${route.kind}'.`
    )
  }
  return route.kind === 'official-agy'
    ? buildOfficialAgyEvidence(deps, facts as AntigravityOfficialAgySealEvidenceFacts)
    : buildGeminiApiEvidence(deps, facts as AntigravityGeminiApiSealEvidenceFacts, route.apiModel)
}

async function buildOfficialAgyEvidence(
  deps: AntigravitySealEvidenceDeps,
  facts: AntigravityOfficialAgySealEvidenceFacts
): Promise<Extract<AntigravitySealEvidenceOutcome, { ok: true }>> {
  if (!isAntigravityOptInEnabled(facts.settings)) {
    throw new SealEvidenceError(
      'AntiGravity official-agy evidence requires the existing enabled + informed-risk opt-in.'
    )
  }
  const riskConsentAcceptedAt = facts.settings?.antigravityOptInAcceptedAt
  if (
    typeof riskConsentAcceptedAt !== 'number' ||
    !Number.isFinite(riskConsentAcceptedAt) ||
    riskConsentAcceptedAt <= 0
  ) {
    throw new SealEvidenceError('AntiGravity official-agy risk consent is missing.')
  }

  const launch = await prepareAntigravityProviderLaunch(
    {
      settings: facts.settings,
      prompt: facts.promptEnvelope.contextualPrompt,
      model: facts.model,
      reasoningEffort: facts.reasoningEffort,
      approvalMode: facts.approvalMode,
      effectivePermissions: facts.effectivePermissions,
      agenticServices: facts.settings?.agenticServices,
      inheritedEnv: facts.inheritedEnv,
      conversationId: facts.conversationId
    },
    {
      ...(facts.resolveBinary ? { resolveBinary: facts.resolveBinary } : {}),
      ...(facts.createEnv ? { createEnv: facts.createEnv } : {})
    }
  )
  const binaryPath = launch.binary.binaryPath
  if (!binaryPath || launch.binary.source === 'missing') {
    throw new SealEvidenceError('The official agy executable could not be resolved.')
  }
  const provenance = await (facts.verifyBinaryProvenance ?? verifyAgyBinaryProvenance)(binaryPath)
  const argvTemplate = placeholdAgyArgv(launch.args)
  const runtime = await buildAgyRuntimeIdentity(deps, binaryPath, launch.env.PATH, argvTemplate)
  const session = launch.resumedConversationId
    ? {
        sessionMode: 'resume' as const,
        providerSessionId: launch.resumedConversationId
      }
    : { sessionMode: 'fresh' as const, providerSessionId: null }
  const common = buildCommonAuthority(deps, {
    model: facts.model,
    promptEnvelope: facts.promptEnvelope,
    session,
    resolvedEnv: launch.env,
    credentialState: {
      mode: 'official-agy-owned-session',
      credentialEnvironmentPolicy: 'google-selectors-stripped'
    },
    providerConfiguration: {
      kind: 'official-agy-cli',
      riskConsentAcceptedAt,
      binarySource: launch.binary.source,
      strippedCredentialEnvironmentKeys: [...AGY_STRIPPED_CREDENTIAL_ENV_KEYS],
      binaryProvenance: provenanceEvidence(provenance)
    },
    capabilityContract: facts.capabilityContract
  })
  const tools = buildToolSurface({
    advertised: false,
    profileId: null,
    catalog: { kind: 'none', tools: [] },
    providerConfiguration: { attachment: 'none' },
    userMcpConfiguration: facts.userMcpConfiguration,
    nativeToolPolicy: {
      kind: 'official-agy-native-sandbox',
      sandboxed: true,
      permissionMode: launch.mode
    },
    brokerPolicy: { kind: 'none' }
  })
  const controls = {
    transport: 'official-agy-cli' as const,
    riskConsentAcceptedAt,
    binarySource: launch.binary.source,
    binaryProvenanceState: provenance.state,
    binaryProvenanceTeamId: provenance.teamId,
    binarySigningAuthoritySha256: provenance.authority
      ? sha256HexOfUtf8(provenance.authority)
      : null,
    binaryProvenanceDetailSha256: provenance.detail ? sha256HexOfUtf8(provenance.detail) : null,
    permissionMode: launch.mode,
    sandboxed: true as const,
    printTimeout: AGY_READ_ONLY_PRINT_TIMEOUT,
    selectedModel: flagValue(launch.args, '--model'),
    reasoningEffort: flagValue(launch.args, '--effort'),
    conversationMode: launch.resumedConversationId ? ('resume' as const) : ('fresh' as const),
    credentialEnvironmentPolicy: 'google-selectors-stripped' as const,
    taskWraithMcpAttachmentMode: 'none' as const,
    fallbackPolicy: 'forbid' as const
  }
  const evidence = buildAntigravityLaunchAuthority({
    schemaVersion: 1,
    provider: 'antigravity',
    common,
    runtime,
    tools,
    controls
  })
  return {
    ok: true,
    evidence,
    effectiveBinary: runtime.executableRealPath,
    effectivePersistence: 'ephemeral',
    resolvedEnv: launch.env
  }
}

async function buildGeminiApiEvidence(
  deps: AntigravitySealEvidenceDeps,
  facts: AntigravityGeminiApiSealEvidenceFacts,
  apiModel: string
): Promise<Extract<AntigravitySealEvidenceOutcome, { ok: true }>> {
  const wireModel = `gemini-api:${apiModel}`
  const disclosureAcceptedAt = facts.settings?.antigravityGeminiApiDisclosureAcceptedAt
  if (
    typeof disclosureAcceptedAt !== 'number' ||
    !Number.isFinite(disclosureAcceptedAt) ||
    disclosureAcceptedAt <= 0
  ) {
    throw new SealEvidenceError(
      'AntiGravity Gemini API evidence requires the existing data-use disclosure acceptance.'
    )
  }
  let loadedKey: ReturnType<AntigravityGeminiApiSecretStore['loadApiKey']>
  try {
    loadedKey = facts.secretStore.loadApiKey()
  } catch (error) {
    throw new SealEvidenceError('The dedicated AntiGravity Gemini API key is unavailable.', {
      cause: error
    })
  }
  if (loadedKey.status !== 'ok' || typeof loadedKey.value !== 'string' || !loadedKey.value) {
    throw new SealEvidenceError('The dedicated AntiGravity Gemini API key is unavailable.')
  }
  const apiKeyHmac = hmacAntigravityBytes(deps, Buffer.from(loadedKey.value, 'utf8'))
  const runtime = await buildGeminiApiRuntimeIdentity(deps, facts)
  const historyMode = facts.ensembleSeatTurn
    ? ('ensemble-context-only' as const)
    : ('host-history-replay' as const)
  const requestContents: GeminiContent[] = buildGeminiTurnContents(
    facts.ensembleSeatTurn ? null : facts.priorChat,
    facts.promptEnvelope.contextualPrompt
  )
  const functionDeclarations = buildGeminiFunctionDeclarations(facts.mcpToolDefinitions)
  const canonicalFunctionDeclarations = toCanonicalJson(functionDeclarations)
  const functionCalling = functionDeclarations.length > 0
  if (
    functionCalling !== facts.taskWraithMcpAdvertised ||
    functionCalling !== (facts.taskWraithMcpProfileId !== null)
  ) {
    throw new SealEvidenceError(
      'AntiGravity Gemini API function declarations diverge from the composed TaskWraith MCP profile.'
    )
  }
  const functionDeclarationsSha256 = sha256HexOfCanonicalJson({
    schemaVersion: 1,
    functionDeclarations
  })
  const requestConfiguration = {
    schemaVersion: 1,
    providerTag: 'antigravity',
    runtimeLabel: 'gemini-api',
    wireModel,
    model: apiModel,
    contents: requestContents,
    config: functionCalling ? { tools: [{ functionDeclarations }] } : null,
    imageTransport: 'none',
    maxToolRounds: ANTIGRAVITY_GEMINI_API_MAX_TOOL_ROUNDS,
    fallback: false
  } as const
  const common = buildCommonAuthority(deps, {
    model: wireModel,
    promptEnvelope: facts.promptEnvelope,
    session: { sessionMode: 'fresh', providerSessionId: null },
    resolvedEnv: facts.resolvedHostEnv,
    credentialState: {
      mode: 'dedicated-safe-storage-api-key',
      apiKeyHmac
    },
    providerConfiguration: {
      kind: 'antigravity-gemini-api-sdk',
      disclosureAcceptedAt,
      providerTag: 'antigravity',
      runtimeLabel: 'gemini-api',
      authProfileSystemBypassed: true
    },
    capabilityContract: facts.capabilityContract
  })
  const tools = buildToolSurface({
    advertised: functionCalling,
    profileId: functionCalling ? facts.taskWraithMcpProfileId : null,
    catalog: {
      kind: 'gemini-function-declarations',
      functionDeclarations: canonicalFunctionDeclarations
    },
    providerConfiguration: {
      attachment: functionCalling ? 'in-process-function-calls' : 'none',
      functionDeclarations: canonicalFunctionDeclarations
    },
    userMcpConfiguration: facts.userMcpConfiguration,
    nativeToolPolicy: {
      kind: 'gemini-api-agentic-loop',
      maxToolRounds: ANTIGRAVITY_GEMINI_API_MAX_TOOL_ROUNDS,
      historyMode,
      imageTransport: 'none'
    },
    brokerPolicy: {
      kind: functionCalling ? 'taskwraith-host-executor' : 'none',
      approvalGate: functionCalling ? 'signed-run-posture' : null
    }
  })
  const evidence = buildAntigravityLaunchAuthority({
    schemaVersion: 1,
    provider: 'antigravity',
    common,
    runtime,
    tools,
    controls: {
      transport: 'gemini-api-sdk',
      disclosureAcceptedAt,
      apiModel,
      apiKeyHmac,
      historyMode,
      imageTransport: 'none',
      taskWraithFunctionCalling: functionCalling,
      functionDeclarationsSha256,
      maxToolRounds: ANTIGRAVITY_GEMINI_API_MAX_TOOL_ROUNDS,
      requestConfigurationSha256: sha256HexOfCanonicalJson(requestConfiguration),
      taskWraithMcpAttachmentMode: functionCalling ? 'in-process-function-calls' : 'none',
      fallbackPolicy: 'forbid'
    }
  })
  return {
    ok: true,
    evidence,
    effectiveBinary: runtime.hostExecutableRealPath,
    effectivePersistence: 'reusable',
    resolvedEnv: facts.resolvedHostEnv
  }
}

async function buildAgyRuntimeIdentity(
  deps: AntigravitySealEvidenceDeps,
  binaryPath: string,
  spawnEnvPath: string | undefined,
  argvTemplate: readonly string[]
): Promise<CliRuntimeIdentityAuthority> {
  const executable = await deps.hasher.digestFile(binaryPath)
  const interpreter = await interpreterRuntimeAttestationSha256(
    executable.realPath,
    spawnEnvPath,
    deps.hasher
  )
  const manifestPath = await nearestPackageManifestPath(executable.realPath)
  return {
    kind: 'cli',
    executableRealPath: executable.realPath,
    executableSha256: executable.sha256,
    runtimeBundleSha256: manifestPath
      ? (await deps.hasher.digestFile(manifestPath)).sha256
      : executable.sha256,
    interpreterRuntimeAttestationSha256: interpreter.sha256,
    // Deliberately do not execute agy merely to collect a version. The launch
    // does not consult `--version`; executable, bundle, interpreter and
    // signature evidence bind the actual file without an extra pre-launch run.
    executableVersion: null,
    launchArgsTemplateSha256: launchArgsTemplateSha256(argvTemplate)
  }
}

async function buildGeminiApiRuntimeIdentity(
  deps: AntigravitySealEvidenceDeps,
  facts: AntigravityGeminiApiSealEvidenceFacts
): Promise<AntigravityInProcessSdkRuntimeIdentityAuthority> {
  const [hostExecutable, sdkPackageJson, sdkEntrypoint] = await Promise.all([
    deps.hasher.digestFile(facts.hostExecutablePath),
    deps.hasher.digestFile(facts.sdkPackageJsonPath),
    deps.hasher.digestFile(facts.sdkEntrypointPath)
  ])
  // Reading the manifest proves it is valid JSON at evidence time without
  // persisting its contents or relying on a caller-authored version string.
  try {
    const manifest = JSON.parse(await readFile(sdkPackageJson.realPath, 'utf8')) as unknown
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      Array.isArray(manifest) ||
      (manifest as { name?: unknown }).name !== '@google/genai'
    ) {
      throw new Error('unexpected package identity')
    }
  } catch (error) {
    throw new SealEvidenceError('The @google/genai package manifest is invalid or unreadable.', {
      cause: error
    })
  }
  const entrypointWithinPackage = relative(dirname(sdkPackageJson.realPath), sdkEntrypoint.realPath)
  if (
    !entrypointWithinPackage ||
    isAbsolute(entrypointWithinPackage) ||
    entrypointWithinPackage === '..' ||
    entrypointWithinPackage.startsWith(`..${sep}`)
  ) {
    throw new SealEvidenceError(
      'The resolved @google/genai runtime entrypoint is outside its package directory.'
    )
  }
  return {
    kind: 'in-process-sdk',
    hostExecutableRealPath: hostExecutable.realPath,
    hostExecutableSha256: hostExecutable.sha256,
    hostRuntimeVersionSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      versions: facts.hostRuntimeVersion
    }),
    sdkPackageJsonRealPath: sdkPackageJson.realPath,
    sdkPackageJsonSha256: sdkPackageJson.sha256,
    sdkEntrypointRealPath: sdkEntrypoint.realPath,
    sdkEntrypointSha256: sdkEntrypoint.sha256
  }
}

function buildCommonAuthority(
  deps: AntigravitySealEvidenceDeps,
  facts: {
    model: string
    promptEnvelope: AntigravitySealEvidenceCommonFacts['promptEnvelope']
    session:
      | { sessionMode: 'fresh'; providerSessionId: null }
      | { sessionMode: 'resume'; providerSessionId: string }
    resolvedEnv: Readonly<Record<string, string>>
    credentialState: CanonicalEvidenceValue
    providerConfiguration: CanonicalEvidenceValue
    capabilityContract: CanonicalEvidenceValue
  }
): ProviderLaunchCommonAuthority {
  const resumeSessionHmac =
    facts.session.sessionMode === 'resume'
      ? hmacAntigravityCanonical(deps, {
          schemaVersion: 1,
          kind: 'provider-session-id',
          sessionId: facts.session.providerSessionId
        })
      : null
  return {
    adapterRevision: `taskwraith-antigravity-adapter@${deps.appVersion}`,
    model: facts.model,
    modelCapabilitySha256: antigravityModelCapabilitySha256(facts.model),
    promptEnvelopeSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      contextualPrompt: facts.promptEnvelope.contextualPrompt,
      finalPrompt: facts.promptEnvelope.finalPrompt,
      runtimePreambleVersion: facts.promptEnvelope.runtimePreambleVersion
    }),
    sessionMode: facts.session.sessionMode,
    resumeSessionHmac,
    providerSessionGenerationSha256:
      facts.session.sessionMode === 'resume'
        ? sha256HexOfCanonicalJson({
            schemaVersion: 1,
            kind: 'agy-conversation-receipt-generation',
            receiptSource: 'last_conversations.json',
            resumeSessionHmac
          })
        : null,
    launchEnvironmentHmac: hmacAntigravityCanonical(deps, {
      schemaVersion: 1,
      kind: 'resolved-launch-environment',
      env: facts.resolvedEnv
    }),
    credentialStateHmac: hmacAntigravityCanonical(deps, {
      schemaVersion: 1,
      kind: 'credential-state',
      state: facts.credentialState
    }),
    providerConfigurationSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      configuration: facts.providerConfiguration
    }),
    capabilityContractSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      contract: facts.capabilityContract
    })
  }
}

function hmacAntigravityCanonical(
  deps: AntigravitySealEvidenceDeps,
  value: CanonicalEvidenceValue
): string {
  return hmacAntigravityBytes(deps, Buffer.from(canonicalEvidenceEncode(value), 'utf8'))
}

function hmacAntigravityBytes(deps: AntigravitySealEvidenceDeps, value: Buffer): string {
  return deps.authorityRoot.providerLaunchHmac('antigravity', value)
}

function buildToolSurface(facts: {
  advertised: boolean
  profileId: TaskWraithMcpProfileId | null
  catalog: CanonicalEvidenceValue
  providerConfiguration: CanonicalEvidenceValue
  userMcpConfiguration: CanonicalEvidenceValue
  nativeToolPolicy: CanonicalEvidenceValue
  brokerPolicy: CanonicalEvidenceValue
}): ProviderToolSurfaceAuthority {
  if (facts.advertised !== (facts.profileId !== null)) {
    throw new SealEvidenceError('TaskWraith MCP profile presence must match advertisement.')
  }
  return {
    taskWraithMcpAdvertised: facts.advertised,
    taskWraithMcpProfileId: facts.profileId,
    taskWraithMcpCatalogSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      catalog: facts.catalog
    }),
    providerMcpConfigurationSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      configuration: facts.providerConfiguration
    }),
    userMcpConfigurationSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      configuration: facts.userMcpConfiguration
    }),
    nativeToolPolicySha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      policy: facts.nativeToolPolicy
    }),
    brokerPolicySha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      policy: facts.brokerPolicy
    })
  }
}

function antigravityModelCapabilitySha256(model: string): string {
  const rows = getStaticProviderModels('antigravity', {
    includePreviewModels: true
  }) as ReadonlyArray<Record<string, unknown>>
  const key = model.trim().toLowerCase()
  const row =
    rows.find((candidate) => {
      for (const field of ['type', 'id', 'model', 'value']) {
        const value = candidate[field]
        if (typeof value === 'string' && value.trim().toLowerCase() === key) return true
      }
      return false
    }) ?? null
  let contextWindow: number | null = null
  try {
    const resolved = resolveContextWindow('antigravity', model)
    contextWindow = typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : null
  } catch {
    contextWindow = null
  }
  return sha256HexOfCanonicalJson({
    schemaVersion: 1,
    provider: 'antigravity',
    model,
    catalogRow: row ? toCanonicalJson(row) : null,
    contextWindow
  })
}

function placeholdAgyArgv(args: readonly string[]): string[] {
  const output = [...args]
  const promptIndex = uniqueFlagValueIndex(output, '-p')
  output[promptIndex] = SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER
  const conversationIndex = optionalUniqueFlagValueIndex(output, '--conversation')
  if (conversationIndex !== null) {
    output[conversationIndex] = SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER
  }
  return output
}

function flagValue(args: readonly string[], flag: string): string | null {
  const index = optionalUniqueFlagValueIndex(args, flag)
  return index === null ? null : args[index]
}

function uniqueFlagValueIndex(args: readonly string[], flag: string): number {
  const index = optionalUniqueFlagValueIndex(args, flag)
  if (index === null) throw new SealEvidenceError(`AntiGravity argv is missing ${flag}.`)
  return index
}

function optionalUniqueFlagValueIndex(args: readonly string[], flag: string): number | null {
  let valueIndex: number | null = null
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue
    if (valueIndex !== null || index + 1 >= args.length) {
      throw new SealEvidenceError(`AntiGravity argv has malformed or duplicate ${flag}.`)
    }
    valueIndex = index + 1
  }
  return valueIndex
}

function provenanceEvidence(provenance: AgyBinaryProvenance): CanonicalEvidenceValue {
  return {
    state: provenance.state,
    teamId: provenance.teamId,
    signingAuthoritySha256: provenance.authority ? sha256HexOfUtf8(provenance.authority) : null,
    detailSha256: provenance.detail ? sha256HexOfUtf8(provenance.detail) : null
  }
}

function toCanonicalJson(value: unknown): CanonicalEvidenceValue {
  return JSON.parse(canonicalEvidenceEncode(value)) as CanonicalEvidenceValue
}
