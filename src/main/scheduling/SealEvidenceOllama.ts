import {
  OLLAMA_CHAT_TRANSPORT_RETRY_DELAYS_MS,
  OLLAMA_MAX_CONSECUTIVE_NON_PRODUCTIVE_TURNS,
  normalizeOllamaBaseUrl,
  ollamaModelSupportsNativeTools,
  type OllamaModelInfo
} from '../ollama/OllamaProvider'
import { ollamaHarnessEnforced } from '../ollama/OllamaHarnessGates'
import { resolveOllamaRunProfile, resolveOllamaThinkingLevel } from '../ollama/OllamaRunProfiles'
import { SCHEDULED_OCCURRENCE_OLLAMA_EFFECTIVE_BINARY_SENTINEL } from '../ScheduledOccurrenceSeal'
import type { ProviderLaunchAuthorityInputByProvider } from '../ProviderLaunchAuthorityDigest'
import type {
  AgenticNetworkPolicy,
  EffectiveRunPermissions,
  OllamaRunProfileId,
  TaskWraithMcpProfileId
} from '../store/types'
import {
  SealEvidenceError,
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
 * Scheduled-launch evidence for Ollama's local HTTP chat transport.
 *
 * The runtime identity is live server evidence, not file evidence: the
 * endpoint HMAC binds the normalized base URL; the server identity binds a
 * fresh GET /api/version response; the model manifest binds a fresh POST
 * /api/show response for the exact wire model. Both probes are performed
 * here (and again at verification) against the same endpoints dispatch
 * uses — an unreachable server fails seal derivation exactly as it would
 * fail the dispatch itself.
 */
export interface OllamaSealEvidenceFacts {
  readonly model: string
  readonly promptEnvelope: CommonLaunchFacts['promptEnvelope']
  /** settings.ollamaBaseUrl (pre-normalization). */
  readonly configuredBaseUrl: string | null
  /** Legacy per-chat run profile id, if the chat carries one. */
  readonly chatRunProfileId: OllamaRunProfileId | undefined
  readonly effectivePermissions: EffectiveRunPermissions
  /** settings.agenticServices at dispatch. */
  readonly agenticServices: Readonly<{
    mcpTools?: string
    networkAccess?: string
  }>
  /** Whether the dispatch tool loop is available (workspace-scoped run). */
  readonly workspaceScoped: boolean
  /** Normalized ollama session memory for this chat, or null. */
  readonly sessionMemory: CanonicalEvidenceValue | null
  readonly taskWraithMcpAdvertised: boolean
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  /** Advertised tool names after network/read-only stripping at dispatch. */
  readonly advertisedToolNames: readonly string[]
  readonly capabilityContract: CanonicalEvidenceValue
  readonly userMcpConfiguration: CanonicalEvidenceValue
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchJson?: (url: string, init?: RequestInit) => Promise<unknown>
}

export async function buildOllamaSealEvidence(
  deps: SealEvidenceDeps,
  facts: OllamaSealEvidenceFacts
): Promise<ProviderLaunchAuthorityInputByProvider['ollama']> {
  const baseUrl = normalizeOllamaBaseUrl(facts.configuredBaseUrl)
  const fetchJson = facts.fetchJson ?? defaultFetchJson
  const profile = requiredRunProfile(resolveOllamaRunProfile(facts.model, facts.chatRunProfileId))
  const readOnly = facts.effectivePermissions.readOnly === true
  const networkAccess: AgenticNetworkPolicy =
    facts.agenticServices.networkAccess === 'deny'
      ? 'deny'
      : facts.effectivePermissions.networkAccess ||
        (facts.agenticServices.networkAccess === 'allow' ? 'allow' : 'deny')
  const toolProtocolEnabled =
    facts.workspaceScoped && facts.agenticServices.mcpTools !== 'deny'
  if (facts.taskWraithMcpAdvertised !== toolProtocolEnabled) {
    throw new SealEvidenceError(
      'Ollama TaskWraith MCP advertisement does not match its tool protocol availability.'
    )
  }

  const serverVersion = await fetchJson(`${baseUrl}/api/version`)
  const modelShow = await fetchJson(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: facts.model })
  })
  const modelInfo = extractModelInfoForNativeTools(modelShow)
  const nativeToolsSupported = ollamaModelSupportsNativeTools(modelInfo)

  const common = buildCommonLaunchAuthority(deps, {
    provider: 'ollama',
    model: facts.model,
    promptEnvelope: facts.promptEnvelope,
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
      }
    },
    capabilityContract: facts.capabilityContract
  })

  const tools = buildToolSurfaceAuthority({
    taskWraithMcpAdvertised: facts.taskWraithMcpAdvertised,
    taskWraithMcpProfileId: facts.taskWraithMcpProfileId,
    providerMcpConfiguration: {
      attachment: toolProtocolEnabled ? 'local-tool-loop' : 'none',
      advertisedToolNames: [...facts.advertisedToolNames]
    },
    userMcpConfiguration: facts.userMcpConfiguration,
    nativeToolPolicy: {
      kind: 'ollama-local-tool-loop',
      nativeToolsSupported,
      readOnly,
      networkAccess
    },
    brokerPolicy: {
      kind: toolProtocolEnabled ? 'taskwraith-local-tool-broker' : 'none',
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
        kind: 'ollama-api-show',
        model: facts.model,
        response: toCanonicalJson(modelShow)
      })
    },
    tools,
    controls: {
      transport: 'http-chat',
      reasoningLevel:
        resolveOllamaThinkingLevel(facts.model, { reasoningLevel: profile.reasoningLevel }) ??
        null,
      contextCapTokens: profile.contextCapTokens,
      protocolMode: profile.protocolMode,
      compactToolSchemas: profile.compactToolSchemas,
      oneToolAtATime: profile.oneToolAtATime,
      numPredictTool: profile.numPredictTool,
      numPredictFinal: profile.numPredictFinal,
      keepAlive: profile.keepAlive,
      // runOllamaChatTurn applies this default when no explicit temperature
      // is provided; scheduled dispatch provides none.
      temperature: 0.2,
      toolProtocolEnabled,
      nativeToolsSupported,
      readOnly,
      networkAccess,
      harnessEnabled: toolProtocolEnabled && ollamaHarnessEnforced(facts.model),
      maxConsecutiveNonProductiveTurns: OLLAMA_MAX_CONSECUTIVE_NON_PRODUCTIVE_TURNS,
      retryPolicySha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        transportRetryDelaysMs: [...OLLAMA_CHAT_TRANSPORT_RETRY_DELAYS_MS],
        maxAttempts: OLLAMA_CHAT_TRANSPORT_RETRY_DELAYS_MS.length + 1
      }),
      memorySnapshotSha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        memory: facts.sessionMemory
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
function requiredRunProfile(
  profile: ReturnType<typeof resolveOllamaRunProfile>
): RequiredOllamaRunProfile {
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

function extractModelInfoForNativeTools(showResponse: unknown): OllamaModelInfo | null {
  if (!showResponse || typeof showResponse !== 'object') return null
  const record = showResponse as Record<string, unknown>
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter((entry): entry is string => typeof entry === 'string')
    : undefined
  if (!capabilities) return null
  return { name: 'seal-evidence', capabilities } as unknown as OllamaModelInfo
}
