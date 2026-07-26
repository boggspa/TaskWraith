import {
  OLLAMA_CHAT_TRANSPORT_RETRY_DELAYS_MS,
  OLLAMA_MAX_CONSECUTIVE_NON_PRODUCTIVE_TURNS
} from '../ollama/OllamaProvider'
import type { OllamaFinalLaunchPlan } from '../ollama/OllamaLaunchPlan'
import { SCHEDULED_OCCURRENCE_OLLAMA_EFFECTIVE_BINARY_SENTINEL } from '../ScheduledOccurrenceSeal'
import type { ProviderLaunchAuthorityInputByProvider } from '../ProviderLaunchAuthorityDigest'
import type {
  EffectiveRunPermissions,
  OllamaRunProfile,
  OllamaRunProfileId,
  TaskWraithMcpProfileId
} from '../store/types'
import {
  SealEvidenceError,
  canonicalEvidenceEncode,
  providerLaunchHmacOfCanonicalJson,
  sha256HexOfCanonicalJson,
  type CanonicalEvidenceValue
} from './SealEvidenceCore'
import {
  buildCommonLaunchAuthority,
  buildToolSurfaceAuthority,
  ollamaCredentialStateEvidence,
  type CommonLaunchFacts,
  type SealEvidenceDeps
} from './SealEvidenceCommon'

/**
 * Candidate scheduled-launch evidence for Ollama's local HTTP chat transport.
 *
 * The runtime identity is live server evidence, not file evidence: the
 * endpoint HMAC binds the normalized base URL and the server identity binds a
 * fresh GET /api/version response.
 *
 * Production and evidence now share one immutable OllamaFinalLaunchPlan. That
 * plan already contains the installed wire model, tag/show manifest, complete
 * native-or-JSON tool surface, keyed session memory, request options, and
 * opening messages consumed by the first `/api/chat` request. This producer is
 * deliberately not production-wired until scheduled dispatch carries that
 * exact plan through the seal/final-use boundary.
 */
export const OLLAMA_SCHEDULED_SEAL_READINESS = {
  provider: 'ollama',
  productionWiring: 'blocked',
  blockers: [
    'scheduled-dispatch-does-not-carry-final-launch-plan',
    'mcp-profile-required-for-sealing-not-enforced-at-dispatch',
    'model-manifest-not-revalidated-at-final-use'
  ]
} as const

export interface OllamaSealEvidenceFacts {
  /**
   * The exact immutable object production dispatch consumes. Required at
   * runtime; optional in the type only while the unwired scheduled service
   * still constructs legacy facts for this candidate producer.
   */
  readonly launchPlan?: OllamaFinalLaunchPlan
  /** @deprecated Replaced by launchPlan.model. */
  readonly model: string
  readonly promptEnvelope: CommonLaunchFacts['promptEnvelope']
  /** @deprecated Replaced by launchPlan.baseUrl. */
  /** settings.ollamaBaseUrl (pre-normalization). */
  readonly configuredBaseUrl: string | null
  /** @deprecated Replaced by launchPlan.runProfile. */
  /** Legacy per-chat run profile id, if the chat carries one. */
  readonly chatRunProfileId: OllamaRunProfileId | undefined
  /** @deprecated Replaced by launchPlan.readOnly/networkAccess. */
  readonly effectivePermissions: EffectiveRunPermissions
  /** @deprecated Replaced by launchPlan tool/network controls. */
  /** settings.agenticServices at dispatch. */
  readonly agenticServices: Readonly<{
    mcpTools?: string
    networkAccess?: string
  }>
  /** @deprecated Replaced by launchPlan.toolProtocolEnabled. */
  /** Whether the dispatch tool loop is available (workspace-scoped run). */
  readonly workspaceScoped: boolean
  /** @deprecated Replaced by launchPlan.sessionMemory. */
  /** Normalized ollama session memory for this chat, or null. */
  readonly sessionMemory: CanonicalEvidenceValue | null
  /** @deprecated Replaced by launchPlan.taskWraithMcpAdvertised. */
  readonly taskWraithMcpAdvertised: boolean
  /** @deprecated Replaced by launchPlan.taskWraithMcpProfileId. */
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  /** @deprecated Replaced by launchPlan.availableToolNames. */
  /** Advertised tool names after network/read-only stripping at dispatch. */
  readonly advertisedToolNames: readonly string[]
  readonly capabilityContract: CanonicalEvidenceValue
  /** @deprecated Ollama does not attach user-authored MCP configuration. */
  readonly userMcpConfiguration: CanonicalEvidenceValue
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchJson?: (url: string, init?: RequestInit) => Promise<unknown>
}

export async function buildOllamaSealEvidence(
  deps: SealEvidenceDeps,
  facts: OllamaSealEvidenceFacts
): Promise<ProviderLaunchAuthorityInputByProvider['ollama']> {
  const plan = facts.launchPlan
  if (!plan) {
    throw new SealEvidenceError(
      'Ollama scheduled evidence requires the exact immutable final launch plan consumed by production dispatch.'
    )
  }
  assertDeepFrozenLaunchPlan(plan)
  const baseUrl = plan.baseUrl
  const fetchJson = facts.fetchJson ?? defaultFetchJson
  const profile = requiredRunProfile(plan.runProfile)
  if (plan.taskWraithMcpAdvertised !== plan.toolProtocolEnabled) {
    throw new SealEvidenceError(
      'Ollama TaskWraith MCP advertisement does not match its tool protocol availability.'
    )
  }

  const serverVersion = await fetchJson(`${baseUrl}/api/version`)

  const common = buildCommonLaunchAuthority(deps, {
    provider: 'ollama',
    model: plan.model,
    promptEnvelope: {
      contextualPrompt: canonicalEvidenceEncode(plan.openingMessages),
      finalPrompt: plan.userPrompt,
      runtimePreambleVersion: facts.promptEnvelope.runtimePreambleVersion
    },
    // Ollama HTTP launches are always fresh; session memory binds separately.
    session: { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null },
    resolvedEnv: {},
    credentialState: ollamaCredentialStateEvidence(),
    providerConfiguration: {
      kind: 'ollama-http-chat',
      baseUrlHmacRef: providerLaunchHmacOfCanonicalJson(deps.authorityRoot, 'ollama', {
        kind: 'ollama-base-url',
        baseUrl
      }),
      runProfileId: profile.id,
      runProfile: {
        reasoningLevel: profile.reasoningLevel,
        contextCapTokens: profile.contextCapTokens,
        protocolMode: profile.protocolMode,
        compactToolSchemas: profile.compactToolSchemas,
        oneToolAtATime: profile.oneToolAtATime,
        numPredictTool: profile.numPredictTool,
        numPredictFinal: profile.numPredictFinal,
        keepAlive: profile.keepAlive
      },
      firstRequest: toCanonicalJson(plan.firstRequest)
    },
    capabilityContract: facts.capabilityContract
  })

  const tools = buildToolSurfaceAuthority({
    taskWraithMcpAdvertised: plan.taskWraithMcpAdvertised,
    taskWraithMcpProfileId: plan.taskWraithMcpProfileId,
    providerMcpConfiguration: {
      attachment: plan.toolProtocolEnabled ? 'local-tool-loop' : 'none',
      advertisedToolNames: [...plan.availableToolNames],
      formatToolNames: [...plan.formatToolNames]
    },
    userMcpConfiguration: { attachment: 'none' },
    nativeToolPolicy: {
      kind: 'ollama-local-tool-loop',
      nativeToolsSupported: plan.nativeToolsSupported,
      nativeToolDefinitions: toCanonicalJson(plan.nativeToolDefinitions),
      compactToolSchemas: plan.compactToolSchemas,
      readOnly: plan.readOnly,
      networkAccess: plan.networkAccess
    },
    brokerPolicy: {
      kind: plan.toolProtocolEnabled ? 'taskwraith-local-tool-broker' : 'none',
      approvalGate: 'signed-run-posture'
    }
  })

  return {
    schemaVersion: 1,
    provider: 'ollama',
    common,
    runtime: {
      kind: 'http',
      endpointHmac: providerLaunchHmacOfCanonicalJson(deps.authorityRoot, 'ollama', {
        kind: 'ollama-endpoint',
        baseUrl
      }),
      serverIdentitySha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        kind: 'ollama-api-version',
        response: toCanonicalJson(serverVersion)
      }),
      modelManifestSha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        kind: 'ollama-final-model-manifest',
        model: plan.model,
        manifest: toCanonicalJson(plan.modelManifest)
      })
    },
    tools,
    controls: {
      transport: 'http-chat',
      reasoningLevel: plan.thinkingLevel,
      contextCapTokens: profile.contextCapTokens,
      protocolMode: profile.protocolMode,
      compactToolSchemas: plan.compactToolSchemas,
      oneToolAtATime: plan.oneToolAtATime,
      numPredictTool: profile.numPredictTool,
      numPredictFinal: profile.numPredictFinal,
      keepAlive: profile.keepAlive,
      temperature: plan.temperature,
      toolProtocolEnabled: plan.toolProtocolEnabled,
      nativeToolsSupported: plan.nativeToolsSupported,
      readOnly: plan.readOnly,
      networkAccess: plan.networkAccess,
      harnessEnabled: plan.harnessEnabled,
      maxConsecutiveNonProductiveTurns: OLLAMA_MAX_CONSECUTIVE_NON_PRODUCTIVE_TURNS,
      retryPolicySha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        transportRetryDelaysMs: [...OLLAMA_CHAT_TRANSPORT_RETRY_DELAYS_MS],
        maxAttempts: OLLAMA_CHAT_TRANSPORT_RETRY_DELAYS_MS.length + 1
      }),
      memorySnapshotSha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        memoryKey: plan.memoryKey,
        memory: plan.sessionMemory
      })
    }
  }
}

export const OLLAMA_SEAL_EFFECTIVE_BINARY = SCHEDULED_OCCURRENCE_OLLAMA_EFFECTIVE_BINARY_SENTINEL

interface RequiredOllamaRunProfile {
  readonly id: string
  readonly reasoningLevel: 'low' | 'medium' | 'high'
  readonly contextCapTokens: number
  readonly protocolMode: 'native_first' | 'json_fallback' | 'json_only'
  readonly compactToolSchemas: boolean
  readonly oneToolAtATime: boolean
  readonly numPredictTool: number
  readonly numPredictFinal: number
  readonly keepAlive: string | null
}

/**
 * resolveOllamaRunProfile always spreads a fully-populated preset, but the
 * OllamaRunProfile type keeps the knobs optional. Refuse to seal a profile
 * with a missing knob rather than substituting a default the runtime never
 * chose.
 */
function requiredRunProfile(profile: OllamaRunProfile): RequiredOllamaRunProfile {
  const reasoningLevel = profile.reasoningLevel
  if (reasoningLevel !== 'low' && reasoningLevel !== 'medium' && reasoningLevel !== 'high') {
    throw new SealEvidenceError('Ollama run profile reasoning level is missing.')
  }
  const protocolMode = profile.protocolMode
  if (
    protocolMode !== 'native_first' &&
    protocolMode !== 'json_fallback' &&
    protocolMode !== 'json_only'
  ) {
    throw new SealEvidenceError('Ollama run profile protocol mode is missing.')
  }
  if (
    typeof profile.contextCapTokens !== 'number' ||
    !Number.isSafeInteger(profile.contextCapTokens) ||
    profile.contextCapTokens <= 0 ||
    typeof profile.numPredictTool !== 'number' ||
    typeof profile.numPredictFinal !== 'number' ||
    typeof profile.compactToolSchemas !== 'boolean' ||
    typeof profile.oneToolAtATime !== 'boolean'
  ) {
    throw new SealEvidenceError('Ollama run profile knobs are incomplete.')
  }
  if (typeof profile.id !== 'string' || !profile.id) {
    throw new SealEvidenceError('Ollama run profile id is missing.')
  }
  return {
    id: profile.id,
    reasoningLevel,
    contextCapTokens: profile.contextCapTokens,
    protocolMode,
    compactToolSchemas: profile.compactToolSchemas,
    oneToolAtATime: profile.oneToolAtATime,
    numPredictTool: profile.numPredictTool,
    numPredictFinal: profile.numPredictFinal,
    keepAlive: typeof profile.keepAlive === 'string' && profile.keepAlive ? profile.keepAlive : null
  }
}

async function defaultFetchJson(url: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    throw new SealEvidenceError(`Ollama server evidence probe failed: ${url}`, { cause: error })
  }
  if (!response.ok) {
    throw new SealEvidenceError(
      `Ollama server evidence probe returned ${response.status} for ${url}`
    )
  }
  try {
    return (await response.json()) as unknown
  } catch (error) {
    throw new SealEvidenceError(`Ollama server evidence was not JSON: ${url}`, { cause: error })
  }
}

function toCanonicalJson(value: unknown): CanonicalEvidenceValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as CanonicalEvidenceValue
  } catch (error) {
    throw new SealEvidenceError('Ollama server evidence could not be canonicalized.', {
      cause: error
    })
  }
}

function assertDeepFrozenLaunchPlan(
  value: unknown,
  path = 'launchPlan',
  seen = new Set<object>()
): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  if (!Object.isFrozen(value)) {
    throw new SealEvidenceError(`Ollama final launch plan is mutable at ${path}.`)
  }
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozenLaunchPlan(child, `${path}.${key}`, seen)
  }
}
