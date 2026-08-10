import type { ProviderId } from '../store/types'

/**
 * Stable provider/decode identities covered by run-management accounting.
 *
 * This is deliberately broader than any offer or dispatch set. Never use this
 * list, the matrix below, or an assurance status to decide whether a provider
 * is selectable. Offer state remains an independent product-policy axis.
 */
export const PROVIDER_RUN_MANAGEMENT_IDS = [
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  // Tail-appended to stay element-for-element equal to RUN_MANAGER_PROVIDERS
  // (index.constants.ts), which ProviderRunManagementBinding.test compares
  // directly. Inserting mid-list silently breaks that equality.
  'mistral',
  'muse'
] as const satisfies readonly ProviderId[]

export type ProviderRunManagementId = (typeof PROVIDER_RUN_MANAGEMENT_IDS)[number]

export type ProviderOfferState =
  | 'live-selectable'
  | 'conditionally-offered'
  | 'retired-history-only'
  /**
   * Decode + run-management identity registered, but not yet offered via
   * LIVE_SELECTABLE / conditionallyOffered intent. Used while an adapter boots
   * before the user-approved offer commit (Muse Phase 2).
   */
  | 'decode-ready-not-offered'

export type ProviderToolMediationMode =
  | 'taskwraith-approval-gateway'
  | 'taskwraith-broker-only'
  | 'hybrid-taskwraith-broker-and-provider-native'
  | 'provider-native-launch-allowlist'
  | 'route-dependent-taskwraith-or-provider-native'

export type ProviderBrokerObservability =
  | 'host-authoritative'
  | 'broker-calls-only'
  | 'broker-and-observable-native-events'
  | 'route-dependent'
  | 'none'

export type ProviderBinaryRuntimeProvenance =
  | 'observed-cli-path-and-version'
  | 'descriptor-bound-runtime-admission'
  | 'observed-http-server-and-model'
  | 'route-dependent-api-or-advisory-cli-publisher'

export interface ProviderRunManagementDeclaration {
  readonly offerState: ProviderOfferState
  readonly toolMediationMode: ProviderToolMediationMode
  readonly brokerObservability: ProviderBrokerObservability
  readonly binaryRuntimeProvenance: ProviderBinaryRuntimeProvenance
}

/**
 * Provider-parametric declarations for axes that are not simple membership in
 * a runtime registry. The values describe the current transport honestly; they
 * are not ordered tiers and intentionally cannot be reduced to a maturity
 * score.
 */
export const PROVIDER_RUN_MANAGEMENT_DECLARATIONS = {
  gemini: {
    offerState: 'retired-history-only',
    toolMediationMode: 'taskwraith-broker-only',
    brokerObservability: 'host-authoritative',
    binaryRuntimeProvenance: 'observed-cli-path-and-version'
  },
  codex: {
    offerState: 'live-selectable',
    toolMediationMode: 'taskwraith-approval-gateway',
    brokerObservability: 'host-authoritative',
    binaryRuntimeProvenance: 'observed-cli-path-and-version'
  },
  claude: {
    offerState: 'live-selectable',
    toolMediationMode: 'taskwraith-broker-only',
    brokerObservability: 'host-authoritative',
    binaryRuntimeProvenance: 'observed-cli-path-and-version'
  },
  kimi: {
    offerState: 'live-selectable',
    toolMediationMode: 'taskwraith-broker-only',
    brokerObservability: 'host-authoritative',
    binaryRuntimeProvenance: 'descriptor-bound-runtime-admission'
  },
  grok: {
    offerState: 'live-selectable',
    toolMediationMode: 'hybrid-taskwraith-broker-and-provider-native',
    brokerObservability: 'broker-and-observable-native-events',
    binaryRuntimeProvenance: 'observed-cli-path-and-version'
  },
  cursor: {
    offerState: 'live-selectable',
    toolMediationMode: 'hybrid-taskwraith-broker-and-provider-native',
    brokerObservability: 'broker-calls-only',
    binaryRuntimeProvenance: 'observed-cli-path-and-version'
  },
  ollama: {
    offerState: 'live-selectable',
    toolMediationMode: 'taskwraith-approval-gateway',
    brokerObservability: 'host-authoritative',
    binaryRuntimeProvenance: 'observed-http-server-and-model'
  },
  antigravity: {
    offerState: 'conditionally-offered',
    toolMediationMode: 'route-dependent-taskwraith-or-provider-native',
    brokerObservability: 'route-dependent',
    binaryRuntimeProvenance: 'route-dependent-api-or-advisory-cli-publisher'
  },
  pi: {
    offerState: 'live-selectable',
    toolMediationMode: 'provider-native-launch-allowlist',
    brokerObservability: 'none',
    binaryRuntimeProvenance: 'observed-cli-path-and-version'
  },
  mistral: {
    offerState: 'live-selectable',
    // Stronger than Grok's `hybrid-…`, and the difference is measured rather
    // than assumed. `vibe-acp` raises `session/request_permission` for EVERY
    // tool execution in both modes this seat selects (`plan` read-only,
    // `default` write) — native file/shell calls and brokered TaskWraith MCP
    // calls alike — so the host answers each one through the same approval
    // ledger. Nothing in this seat runs on a provider-native allowlist.
    //
    // This declaration is load-bearing, not descriptive: mistralGate's
    // `mistralMcpAdvertiseEnabled()` defaults ON *because* of it. If Vibe is
    // ever observed executing an advertised tool without a permission request,
    // this row and that default must change together.
    toolMediationMode: 'taskwraith-approval-gateway',
    // Every tool call is a host-answered permission request and every brokered
    // call is host-executed, so the host — not a provider-side event stream —
    // is the authority for what this seat did.
    brokerObservability: 'host-authoritative',
    // The seat resolves a real `vibe-acp` executable path and can read its
    // `--version`; there is no descriptor-bound admission step (Kimi) and no
    // HTTP-server probe (Ollama).
    binaryRuntimeProvenance: 'observed-cli-path-and-version'
  },
  muse: {
    // Flipped with W2F live / intent / iOS mirrors (COORDINATION.md).
    offerState: 'live-selectable',
    // Opaque muse exec --json; no TaskWraith MCP broker in v1 (wave1-F).
    toolMediationMode: 'provider-native-launch-allowlist',
    // stdout lifecycle + session.jsonl tooling events once the reducer lands.
    brokerObservability: 'none',
    binaryRuntimeProvenance: 'observed-cli-path-and-version'
  }
} as const satisfies Record<ProviderRunManagementId, ProviderRunManagementDeclaration>

export type ProviderAdapterRegistration = 'registered' | 'missing'
export type ProviderSharedLifecycle = 'run-manager' | 'outside-run-manager'
export type ProviderSignedPostureRetention = 'retained' | 'not-retained'
export type ProviderScheduledEvidenceProducer = 'implemented' | 'not-implemented'
export type ProviderProductionSealWiring = 'wired' | 'unwired'

export interface ProviderRunManagementRow extends ProviderRunManagementDeclaration {
  readonly provider: ProviderRunManagementId
  readonly adapterRegistration: ProviderAdapterRegistration
  readonly sharedLifecycle: ProviderSharedLifecycle
  readonly signedPostureRetention: ProviderSignedPostureRetention
  readonly scheduledEvidenceProducer: ProviderScheduledEvidenceProducer
  readonly productionSealWiring: ProviderProductionSealWiring
}

export type ProviderRunManagementMatrix = Readonly<
  Record<ProviderRunManagementId, ProviderRunManagementRow>
>

/**
 * Independently observed registry/evidence memberships used to build a matrix.
 * Callers should supply the declarations owned by each subsystem rather than
 * copying a combined "managed provider" list.
 */
export interface ProviderRunManagementCoverageInput {
  readonly registeredAdapterProviderIds: Iterable<ProviderId>
  readonly sharedLifecycleProviderIds: Iterable<ProviderId>
  readonly signedPostureRetentionProviderIds: Iterable<ProviderId>
  readonly scheduledEvidenceProducerProviderIds: Iterable<ProviderId>
  readonly productionSealWiredProviderIds: Iterable<ProviderId>
}

/**
 * Join independent evidence into provider rows. This function reports facts;
 * it does not compute a combined managed/unmanaged result and has no offer or
 * admission output.
 */
export function buildProviderRunManagementMatrix(
  input: ProviderRunManagementCoverageInput
): ProviderRunManagementMatrix {
  const adapters = new Set(input.registeredAdapterProviderIds)
  const lifecycle = new Set(input.sharedLifecycleProviderIds)
  const signedPosture = new Set(input.signedPostureRetentionProviderIds)
  const evidenceProducers = new Set(input.scheduledEvidenceProducerProviderIds)
  const sealWiring = new Set(input.productionSealWiredProviderIds)
  const rows = {} as Record<ProviderRunManagementId, ProviderRunManagementRow>

  for (const provider of PROVIDER_RUN_MANAGEMENT_IDS) {
    rows[provider] = {
      provider,
      ...PROVIDER_RUN_MANAGEMENT_DECLARATIONS[provider],
      adapterRegistration: adapters.has(provider) ? 'registered' : 'missing',
      sharedLifecycle: lifecycle.has(provider) ? 'run-manager' : 'outside-run-manager',
      signedPostureRetention: signedPosture.has(provider) ? 'retained' : 'not-retained',
      scheduledEvidenceProducer: evidenceProducers.has(provider)
        ? 'implemented'
        : 'not-implemented',
      productionSealWiring: sealWiring.has(provider) ? 'wired' : 'unwired'
    }
  }

  return rows
}

export type ProviderRunManagementBaselineAxis =
  | 'provider'
  | 'adapterRegistration'
  | 'sharedLifecycle'
  | 'signedPostureRetention'
  | 'productionSealWiring'

export interface ProviderRunManagementBaselineIssue {
  readonly provider: ProviderRunManagementId
  readonly axis: ProviderRunManagementBaselineAxis
  readonly message: string
}

/**
 * Validate only the universal run-management baseline and cross-axis
 * consistency. Missing stronger layers remain visible in the matrix without
 * failing this guard:
 *
 * - an unwired scheduled seal is allowed;
 * - a provider without an exact evidence producer is allowed;
 * - no offer state is privileged or penalized.
 */
export function providerRunManagementBaselineIssues(
  matrix: ProviderRunManagementMatrix
): ProviderRunManagementBaselineIssue[] {
  const issues: ProviderRunManagementBaselineIssue[] = []

  for (const provider of PROVIDER_RUN_MANAGEMENT_IDS) {
    const row = matrix[provider]
    if (!row || row.provider !== provider) {
      issues.push({
        provider,
        axis: 'provider',
        message: `Run-management row ${provider} is missing or carries the wrong provider id.`
      })
      continue
    }
    if (row.adapterRegistration !== 'registered') {
      issues.push({
        provider,
        axis: 'adapterRegistration',
        message: `${provider} is missing its provider adapter registration.`
      })
    }
    if (row.sharedLifecycle !== 'run-manager') {
      issues.push({
        provider,
        axis: 'sharedLifecycle',
        message: `${provider} is outside the shared RunManager lifecycle.`
      })
    }
    if (row.signedPostureRetention !== 'retained') {
      issues.push({
        provider,
        axis: 'signedPostureRetention',
        message: `${provider} does not retain the normalized signed posture in run state.`
      })
    }
    if (row.productionSealWiring === 'wired' && row.scheduledEvidenceProducer !== 'implemented') {
      issues.push({
        provider,
        axis: 'productionSealWiring',
        message: `${provider} is marked production seal-wired without an exact evidence producer.`
      })
    }
  }

  return issues
}

export function assertProviderRunManagementBaseline(matrix: ProviderRunManagementMatrix): void {
  const issues = providerRunManagementBaselineIssues(matrix)
  if (issues.length === 0) return
  throw new Error(issues.map((issue) => issue.message).join('\n'))
}
