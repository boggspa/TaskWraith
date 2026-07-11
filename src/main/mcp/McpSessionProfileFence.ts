import type {
  ProviderId,
  ProviderRunReroute,
  TaskWraithMcpProfileId,
  TaskWraithMcpProfileReceipt
} from '../store/types'

// Each v1 id maps to a literal membership snapshot in McpToolProfiles. Never
// mutate an existing mapping: mint a new id for any membership/schema change so
// a resumable native provider session retains the surface it observed at birth.
export const TASKWRAITH_FULL_MCP_PROFILE_ID: TaskWraithMcpProfileId = 'taskwraith-full-v1'
export const TASKWRAITH_CORE_MCP_PROFILE_ID: TaskWraithMcpProfileId = 'taskwraith-core-v1'
export const TASKWRAITH_GATEWAY_MCP_PROFILE_ID: TaskWraithMcpProfileId =
  'taskwraith-gateway-v1'

export type TaskWraithMcpProfileResolutionSource =
  | 'pinned_receipt'
  | 'fresh_gateway_default'
  | 'legacy_claude_full'
  | 'default_full'

export interface TaskWraithMcpProfileResolution {
  profileId: TaskWraithMcpProfileId
  source: TaskWraithMcpProfileResolutionSource
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

const PROVIDER_IDS: ReadonlySet<string> = new Set([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama'
])

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDER_IDS.has(value)
}

export function isTaskWraithMcpProfileId(value: unknown): value is TaskWraithMcpProfileId {
  return (
    value === TASKWRAITH_FULL_MCP_PROFILE_ID ||
    value === TASKWRAITH_CORE_MCP_PROFILE_ID ||
    value === TASKWRAITH_GATEWAY_MCP_PROFILE_ID
  )
}

export function isTaskWraithMcpProfileReceipt(
  value: unknown
): value is TaskWraithMcpProfileReceipt {
  if (!value || typeof value !== 'object') return false
  const receipt = value as Partial<TaskWraithMcpProfileReceipt>
  return (
    receipt.schemaVersion === 1 &&
    isTaskWraithMcpProfileId(receipt.profileId) &&
    isProviderId(receipt.provider) &&
    nonEmptyString(receipt.providerSessionId) !== null &&
    nonEmptyString(receipt.pinnedAt) !== null
  )
}

export function isTaskWraithMcpProfileReceiptForSession(
  value: unknown,
  expected: {
    provider: ProviderId
    providerSessionId: string | null | undefined
  }
): value is TaskWraithMcpProfileReceipt {
  const providerSessionId = nonEmptyString(expected.providerSessionId)
  return (
    providerSessionId !== null &&
    isTaskWraithMcpProfileReceipt(value) &&
    value.provider === expected.provider &&
    value.providerSessionId === providerSessionId
  )
}

export function taskWraithMcpProfileReceiptFingerprint(value: unknown): string | null {
  if (!isTaskWraithMcpProfileReceipt(value)) return null
  return JSON.stringify([
    value.schemaVersion,
    value.profileId,
    value.provider,
    value.providerSessionId,
    value.pinnedAt
  ])
}

export function taskWraithCoreMcpProfileOptInEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  return ['1', 'true', 'yes'].includes(
    String(env.TASKWRAITH_CORE_MCP_PROFILE || '')
      .trim()
      .toLowerCase()
  )
}

/**
 * Resolve the exact TaskWraith MCP catalog for a run.
 *
 * Claude is birth-pinned: an exact full/core/gateway receipt always wins. A
 * resumed session without an exact receipt is grandfathered to full because it
 * may already have observed that catalog. Every fresh, tool-capable session
 * defaults to gateway without a user flag; a fresh Claude session only does so
 * when its birth receipt can be persisted authoritatively.
 */
export function resolveTaskWraithMcpProfile(input: {
  provider: ProviderId
  modelId?: string | null
  providerSessionId?: string | null
  /** Current main-owned store session, which may outlive a stale null payload. */
  storeProviderSessionId?: string | null
  receipt?: unknown
  /** @deprecated Gateway is the unconditional fresh-session default. */
  coreProfileOptIn?: boolean
  /** False when no canonical chat exists to persist a Claude birth receipt. */
  profileReceiptCanPersist?: boolean
  /** Exact ACP session/new eligibility; false for headless or toolless Grok. */
  grokMcpAdvertised?: boolean
}): TaskWraithMcpProfileResolution {
  const providerSessionId = nonEmptyString(input.providerSessionId)
  const storeProviderSessionId = nonEmptyString(input.storeProviderSessionId)

  if (input.provider === 'claude') {
    if (
      providerSessionId &&
      isTaskWraithMcpProfileReceiptForSession(input.receipt, {
        provider: 'claude',
        providerSessionId
      })
    ) {
      return { profileId: input.receipt.profileId, source: 'pinned_receipt' }
    }
    if (
      !providerSessionId &&
      storeProviderSessionId &&
      isTaskWraithMcpProfileReceiptForSession(input.receipt, {
        provider: 'claude',
        providerSessionId: storeProviderSessionId
      })
    ) {
      return { profileId: input.receipt.profileId, source: 'pinned_receipt' }
    }
    if (providerSessionId) {
      return { profileId: TASKWRAITH_FULL_MCP_PROFILE_ID, source: 'legacy_claude_full' }
    }
    if (input.profileReceiptCanPersist !== false) {
      return {
        profileId: TASKWRAITH_GATEWAY_MCP_PROFILE_ID,
        source: 'fresh_gateway_default'
      }
    }
    return { profileId: TASKWRAITH_FULL_MCP_PROFILE_ID, source: 'default_full' }
  }

  if (input.provider === 'grok' && input.grokMcpAdvertised !== true) {
    return { profileId: TASKWRAITH_FULL_MCP_PROFILE_ID, source: 'default_full' }
  }

  return {
    profileId: TASKWRAITH_GATEWAY_MCP_PROFILE_ID,
    source: 'fresh_gateway_default'
  }
}

/** A receipted Claude store identity is authoritative over a stale run payload. */
export function shouldRejectTaskWraithMcpStaleDispatch(input: {
  provider: ProviderId
  requestedProviderSessionId?: string | null
  storeProviderSessionId?: string | null
  storeIdentityKnown?: boolean
}): boolean {
  const requestedProviderSessionId = nonEmptyString(input.requestedProviderSessionId)
  if (input.provider !== 'claude') return false
  if (input.storeIdentityKnown === false) return requestedProviderSessionId !== null
  return requestedProviderSessionId !== nonEmptyString(input.storeProviderSessionId)
}

export function isTaskWraithMcpRouteProviderMatch(input: {
  payloadProvider: ProviderId
  ownerProvider?: ProviderId | null
}): boolean {
  return input.ownerProvider === input.payloadProvider
}

export function isTaskWraithMcpEnsembleLanePresent(input: {
  chatIsEnsemble: boolean
  participantId?: string | null
  participantFound: boolean
}): boolean {
  return input.participantId
    ? input.chatIsEnsemble && input.participantFound
    : !input.chatIsEnsemble
}

/**
 * A facade-validated reroute is ephemeral independent of the stored owner: the
 * renderer save may still show `from`, may already show `to`, or a later
 * failover hop may leave the original owner in place.
 */
export function isTaskWraithMcpAuthorizedEphemeralReroute(input: {
  payloadProvider: ProviderId
  providerReroute?: ProviderRunReroute | null
}): boolean {
  const reroute = input.providerReroute
  return Boolean(
    reroute && reroute.to === input.payloadProvider && reroute.from !== reroute.to
  )
}

export function createTaskWraithMcpProfileReceipt(input: {
  profileId: TaskWraithMcpProfileId
  provider: ProviderId
  providerSessionId: string
  pinnedAt?: string
}): TaskWraithMcpProfileReceipt {
  const providerSessionId = nonEmptyString(input.providerSessionId)
  if (!providerSessionId) throw new Error('A provider session id is required to pin an MCP profile.')
  return {
    schemaVersion: 1,
    profileId: input.profileId,
    provider: input.provider,
    providerSessionId,
    pinnedAt: nonEmptyString(input.pinnedAt) || new Date().toISOString()
  }
}

export interface TaskWraithMcpProfileStoreIdentity {
  providerSessionId: string | null
  receiptFingerprint: string | null
}

export function taskWraithMcpProfileStoreIdentity(input: {
  providerSessionId?: string | null
  receipt?: unknown
}): TaskWraithMcpProfileStoreIdentity {
  return {
    providerSessionId: nonEmptyString(input.providerSessionId),
    receiptFingerprint: taskWraithMcpProfileReceiptFingerprint(input.receipt)
  }
}

export type TaskWraithMcpProfileReceiptTransition =
  | { accepted: true; receipt?: TaskWraithMcpProfileReceipt }
  | {
      accepted: false
      reason: 'stale_store_identity' | 'stale_run_session' | 'invalid_next_session'
    }

/**
 * Compare-and-set a birth/rotation receipt against the store identity observed
 * when the run profile was resolved. This rejects late A→B events after another
 * run has already advanced the record to C, and lets an intentionally fresh run
 * replace an old stored session only when that exact old identity is still live.
 */
export function transitionTaskWraithMcpProfileReceipt(input: {
  provider: ProviderId
  profileId: TaskWraithMcpProfileId
  mcpAdvertised?: boolean
  nextProviderSessionId: string
  /** Session id held by this run before the new event; null means a birth event. */
  previousRunProviderSessionId?: string | null
  expectedStoreIdentity: TaskWraithMcpProfileStoreIdentity
  currentStoreSessionId?: string | null
  currentReceipt?: unknown
  pinnedAt?: string
}): TaskWraithMcpProfileReceiptTransition {
  const nextProviderSessionId = nonEmptyString(input.nextProviderSessionId)
  if (!nextProviderSessionId) return { accepted: false, reason: 'invalid_next_session' }
  const currentIdentity = taskWraithMcpProfileStoreIdentity({
    providerSessionId: input.currentStoreSessionId,
    receipt: input.currentReceipt
  })
  if (
    currentIdentity.providerSessionId !== input.expectedStoreIdentity.providerSessionId ||
    currentIdentity.receiptFingerprint !== input.expectedStoreIdentity.receiptFingerprint
  ) {
    return { accepted: false, reason: 'stale_store_identity' }
  }

  const previousRunProviderSessionId = nonEmptyString(input.previousRunProviderSessionId)
  if (
    previousRunProviderSessionId &&
    (previousRunProviderSessionId !== input.expectedStoreIdentity.providerSessionId ||
      previousRunProviderSessionId !== currentIdentity.providerSessionId)
  ) {
    return { accepted: false, reason: 'stale_run_session' }
  }
  const validCurrentReceipt = isTaskWraithMcpProfileReceiptForSession(input.currentReceipt, {
    provider: input.provider,
    providerSessionId: currentIdentity.providerSessionId
  })
    ? input.currentReceipt
    : null
  const preserveCurrentReceipt =
    (previousRunProviderSessionId === currentIdentity.providerSessionId &&
      previousRunProviderSessionId !== null) ||
    nextProviderSessionId === currentIdentity.providerSessionId
  const currentReceipt = preserveCurrentReceipt ? validCurrentReceipt : null
  if (input.mcpAdvertised === false) {
    return currentReceipt
      ? {
          accepted: true,
          receipt: createTaskWraithMcpProfileReceipt({
            provider: input.provider,
            profileId: currentReceipt.profileId,
            providerSessionId: nextProviderSessionId,
            pinnedAt: currentReceipt.pinnedAt
          })
        }
      : { accepted: true }
  }
  return {
    accepted: true,
    receipt: createTaskWraithMcpProfileReceipt({
      provider: input.provider,
      profileId: currentReceipt?.profileId ?? input.profileId,
      providerSessionId: nextProviderSessionId,
      pinnedAt: currentReceipt?.pinnedAt ?? input.pinnedAt
    })
  }
}

/**
 * Provider streams may replay an older session-id frame. Once a run has
 * advanced away from an id, that id can never be a legitimate later rotation.
 */
export function shouldAcceptTaskWraithMcpSessionId(input: {
  nextProviderSessionId: string
  currentProviderSessionId?: string | null
  seenProviderSessionIds?: ReadonlySet<string>
}): boolean {
  const nextProviderSessionId = nonEmptyString(input.nextProviderSessionId)
  if (!nextProviderSessionId) return false
  const currentProviderSessionId = nonEmptyString(input.currentProviderSessionId)
  if (nextProviderSessionId === currentProviderSessionId) return true
  return !input.seenProviderSessionIds?.has(nextProviderSessionId)
}

/**
 * Decide whether a Claude fallback must preserve the MCP attachment chosen at
 * run start. The evolving CAS identity is deliberately absent: an SDK A→B
 * rotation must not make a later CLI fallback look like an unpinned fresh run.
 */
export function taskWraithMcpRunStartedWithPinnedReceipt(input: {
  providerSessionId?: string | null
  fence?: {
    runStartedProviderSessionId: string | null
    runStartedReceiptFingerprint: string | null
    storeWritable: boolean
  } | null
}): boolean {
  const providerSessionId = nonEmptyString(input.providerSessionId)
  const fence = input.fence
  return Boolean(
    providerSessionId &&
      fence?.storeWritable &&
      nonEmptyString(fence.runStartedProviderSessionId) === providerSessionId &&
      nonEmptyString(fence.runStartedReceiptFingerprint)
  )
}

export function isCoreTaskWraithMcpProfile(
  profileId: TaskWraithMcpProfileId | null | undefined
): boolean {
  return profileId === TASKWRAITH_CORE_MCP_PROFILE_ID
}

export function isGatewayTaskWraithMcpProfile(
  profileId: TaskWraithMcpProfileId | null | undefined
): boolean {
  return profileId === TASKWRAITH_GATEWAY_MCP_PROFILE_ID
}
