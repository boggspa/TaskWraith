/**
 * Capability-gated read projections for cold-start provider setup.
 *
 * These are display/admission metadata only. They never carry credentials,
 * auth URLs/device codes, filesystem paths, provider process details, or a
 * mutation request.
 */

export const HOST_SETUP_MAX_PROVIDERS = 64
export const HOST_SETUP_MAX_MODELS = 128
export const HOST_SETUP_MAX_REASONING_OFFERS = 24
export const HOST_SETUP_MAX_POSTURES = 16
export const HOST_SETUP_MAX_AUTH_FLOWS = 12

export type HostSetupDecodeResult<T> = { ok: true; value: T } | { ok: false; error: string }

export type HostProviderStatusKind = 'ready' | 'auth_required' | 'unavailable' | 'degraded'
export type HostProviderAuthState = 'authenticated' | 'unauthenticated' | 'unavailable' | 'unknown'
export type HostProviderAuthFlowKind = 'browser' | 'device_code' | 'api_key' | 'manual'

export interface HostProviderStatusProjection {
  readonly providerId: string
  readonly status: HostProviderStatusKind
  readonly label: string
  readonly detail?: string
}

export interface HostProviderReasoningOffer {
  readonly reasoningId: string
  readonly label: string
  readonly available: boolean
  readonly detail?: string
}

export interface HostProviderModelOffer {
  readonly modelId: string
  readonly label: string
  readonly available: boolean
  readonly default?: boolean
  readonly reasoning: readonly HostProviderReasoningOffer[]
  readonly detail?: string
}

export interface HostPermissionPostureOffer {
  readonly postureId: string
  readonly label: string
  readonly available: boolean
  /** The UI must require a deliberate user acknowledgement before selecting this posture. */
  readonly requiresExplicitConsent: boolean
  /** Non-secret authority ceiling; full permission bodies never cross this read protocol. */
  readonly ceiling: 'read' | 'workspace_write' | 'full_access'
  readonly detail?: string
}

export interface HostProviderOffersProjection {
  readonly providerId: string
  /** Opaque bounded revision for a future exact configure/revalidation request. */
  readonly offerRevision: string
  readonly models: readonly HostProviderModelOffer[]
  readonly postures: readonly HostPermissionPostureOffer[]
}

export interface HostProviderAuthFlowProjection {
  readonly flowId: string
  readonly kind: HostProviderAuthFlowKind
  readonly label: string
  readonly available: boolean
  readonly detail?: string
}

export interface HostProviderAuthStatusProjection {
  readonly providerId: string
  readonly state: HostProviderAuthState
  readonly detail?: string
}

const MAX_ID = 512
const MAX_LABEL = 200
const MAX_DETAIL = 1_000

function fail<T>(error: string): HostSetupDecodeResult<T> {
  return { ok: false, error }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isCanonicalString(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- setup metadata rejects C0 controls on the wire.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function optionalDetail(value: unknown, label: string): HostSetupDecodeResult<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!isCanonicalString(value, MAX_DETAIL)) return fail(`${label} is invalid`)
  return { ok: true, value }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function decodeReasoningOffer(value: unknown): HostSetupDecodeResult<HostProviderReasoningOffer> {
  if (!isRecord(value) || !exactKeys(value, ['reasoningId', 'label', 'available', 'detail'])) {
    return fail('reasoning offer has unknown fields')
  }
  if (!isCanonicalString(value.reasoningId, MAX_ID) || !isCanonicalString(value.label, MAX_LABEL)) {
    return fail('reasoning offer id or label is invalid')
  }
  if (typeof value.available !== 'boolean') return fail('reasoning offer availability is invalid')
  const detail = optionalDetail(value.detail, 'reasoning offer detail')
  if (!detail.ok) return detail
  return {
    ok: true,
    value: {
      reasoningId: value.reasoningId,
      label: value.label,
      available: value.available,
      ...(detail.value ? { detail: detail.value } : {})
    }
  }
}

function decodeModelOffer(value: unknown): HostSetupDecodeResult<HostProviderModelOffer> {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['modelId', 'label', 'available', 'default', 'reasoning', 'detail'])
  ) {
    return fail('model offer has unknown fields')
  }
  if (!isCanonicalString(value.modelId, MAX_ID) || !isCanonicalString(value.label, MAX_LABEL)) {
    return fail('model offer id or label is invalid')
  }
  if (typeof value.available !== 'boolean') return fail('model offer availability is invalid')
  if (value.default !== undefined && typeof value.default !== 'boolean')
    return fail('model offer default is invalid')
  if (!Array.isArray(value.reasoning) || value.reasoning.length > HOST_SETUP_MAX_REASONING_OFFERS) {
    return fail('model offer reasoning is invalid')
  }
  const reasoning: HostProviderReasoningOffer[] = []
  const ids = new Set<string>()
  for (const entry of value.reasoning) {
    const decoded = decodeReasoningOffer(entry)
    if (!decoded.ok || ids.has(decoded.value.reasoningId))
      return fail('model offer reasoning is invalid')
    ids.add(decoded.value.reasoningId)
    reasoning.push(decoded.value)
  }
  const detail = optionalDetail(value.detail, 'model offer detail')
  if (!detail.ok) return detail
  return {
    ok: true,
    value: {
      modelId: value.modelId,
      label: value.label,
      available: value.available,
      ...(value.default === true ? { default: true } : {}),
      reasoning,
      ...(detail.value ? { detail: detail.value } : {})
    }
  }
}

function decodePostureOffer(value: unknown): HostSetupDecodeResult<HostPermissionPostureOffer> {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'postureId',
      'label',
      'available',
      'requiresExplicitConsent',
      'ceiling',
      'detail'
    ])
  ) {
    return fail('posture offer has unknown fields')
  }
  if (!isCanonicalString(value.postureId, MAX_ID) || !isCanonicalString(value.label, MAX_LABEL)) {
    return fail('posture offer id or label is invalid')
  }
  if (typeof value.available !== 'boolean') return fail('posture offer availability is invalid')
  if (typeof value.requiresExplicitConsent !== 'boolean') {
    return fail('posture offer consent requirement is invalid')
  }
  if (!['read', 'workspace_write', 'full_access'].includes(String(value.ceiling))) {
    return fail('posture offer ceiling is invalid')
  }
  const detail = optionalDetail(value.detail, 'posture offer detail')
  if (!detail.ok) return detail
  return {
    ok: true,
    value: {
      postureId: value.postureId,
      label: value.label,
      available: value.available,
      requiresExplicitConsent: value.requiresExplicitConsent,
      ceiling: value.ceiling as HostPermissionPostureOffer['ceiling'],
      ...(detail.value ? { detail: detail.value } : {})
    }
  }
}

export function decodeHostProviderStatusProjection(
  value: unknown
): HostSetupDecodeResult<HostProviderStatusProjection> {
  if (!isRecord(value) || !exactKeys(value, ['providerId', 'status', 'label', 'detail'])) {
    return fail('provider status has unknown fields')
  }
  if (!isCanonicalString(value.providerId, MAX_ID) || !isCanonicalString(value.label, MAX_LABEL)) {
    return fail('provider status id or label is invalid')
  }
  if (!['ready', 'auth_required', 'unavailable', 'degraded'].includes(String(value.status))) {
    return fail('provider status kind is invalid')
  }
  const detail = optionalDetail(value.detail, 'provider status detail')
  if (!detail.ok) return detail
  return {
    ok: true,
    value: {
      providerId: value.providerId,
      status: value.status as HostProviderStatusKind,
      label: value.label,
      ...(detail.value ? { detail: detail.value } : {})
    }
  }
}

export function decodeHostProviderStatuses(
  value: unknown
): HostSetupDecodeResult<readonly HostProviderStatusProjection[]> {
  if (!Array.isArray(value) || value.length > HOST_SETUP_MAX_PROVIDERS)
    return fail('provider statuses are invalid')
  const statuses: HostProviderStatusProjection[] = []
  const ids = new Set<string>()
  for (const entry of value) {
    const decoded = decodeHostProviderStatusProjection(entry)
    if (!decoded.ok || ids.has(decoded.value.providerId))
      return fail('provider statuses are invalid')
    ids.add(decoded.value.providerId)
    statuses.push(decoded.value)
  }
  return { ok: true, value: statuses }
}

export function decodeHostProviderOffersProjection(
  value: unknown
): HostSetupDecodeResult<HostProviderOffersProjection> {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['providerId', 'offerRevision', 'models', 'postures'])
  ) {
    return fail('provider offers have unknown fields')
  }
  if (!isCanonicalString(value.providerId, MAX_ID))
    return fail('provider offers providerId is invalid')
  if (!isCanonicalString(value.offerRevision, MAX_ID)) {
    return fail('provider offers offerRevision is invalid')
  }
  if (!Array.isArray(value.models) || value.models.length > HOST_SETUP_MAX_MODELS) {
    return fail('provider offers models are invalid')
  }
  if (!Array.isArray(value.postures) || value.postures.length > HOST_SETUP_MAX_POSTURES) {
    return fail('provider offers postures are invalid')
  }
  const models: HostProviderModelOffer[] = []
  const modelIds = new Set<string>()
  for (const entry of value.models) {
    const decoded = decodeModelOffer(entry)
    if (!decoded.ok || modelIds.has(decoded.value.modelId))
      return fail('provider offers models are invalid')
    modelIds.add(decoded.value.modelId)
    models.push(decoded.value)
  }
  const postures: HostPermissionPostureOffer[] = []
  const postureIds = new Set<string>()
  for (const entry of value.postures) {
    const decoded = decodePostureOffer(entry)
    if (!decoded.ok || postureIds.has(decoded.value.postureId))
      return fail('provider offers postures are invalid')
    postureIds.add(decoded.value.postureId)
    postures.push(decoded.value)
  }
  return {
    ok: true,
    value: { providerId: value.providerId, offerRevision: value.offerRevision, models, postures }
  }
}

export function decodeHostProviderAuthFlows(
  value: unknown
): HostSetupDecodeResult<readonly HostProviderAuthFlowProjection[]> {
  if (!Array.isArray(value) || value.length > HOST_SETUP_MAX_AUTH_FLOWS)
    return fail('provider auth flows are invalid')
  const flows: HostProviderAuthFlowProjection[] = []
  const ids = new Set<string>()
  for (const entry of value) {
    if (!isRecord(entry) || !exactKeys(entry, ['flowId', 'kind', 'label', 'available', 'detail'])) {
      return fail('provider auth flows are invalid')
    }
    if (!isCanonicalString(entry.flowId, MAX_ID) || !isCanonicalString(entry.label, MAX_LABEL)) {
      return fail('provider auth flows are invalid')
    }
    if (!['browser', 'device_code', 'api_key', 'manual'].includes(String(entry.kind))) {
      return fail('provider auth flows are invalid')
    }
    if (typeof entry.available !== 'boolean' || ids.has(entry.flowId)) {
      return fail('provider auth flows are invalid')
    }
    const detail = optionalDetail(entry.detail, 'provider auth flow detail')
    if (!detail.ok) return detail
    ids.add(entry.flowId)
    flows.push({
      flowId: entry.flowId,
      kind: entry.kind as HostProviderAuthFlowKind,
      label: entry.label,
      available: entry.available,
      ...(detail.value ? { detail: detail.value } : {})
    })
  }
  return { ok: true, value: flows }
}

export function decodeHostProviderAuthStatusProjection(
  value: unknown
): HostSetupDecodeResult<HostProviderAuthStatusProjection> {
  if (!isRecord(value) || !exactKeys(value, ['providerId', 'state', 'detail'])) {
    return fail('provider auth status has unknown fields')
  }
  if (!isCanonicalString(value.providerId, MAX_ID))
    return fail('provider auth status providerId is invalid')
  if (
    !['authenticated', 'unauthenticated', 'unavailable', 'unknown'].includes(String(value.state))
  ) {
    return fail('provider auth status state is invalid')
  }
  const detail = optionalDetail(value.detail, 'provider auth status detail')
  if (!detail.ok) return detail
  return {
    ok: true,
    value: {
      providerId: value.providerId,
      state: value.state as HostProviderAuthState,
      ...(detail.value ? { detail: detail.value } : {})
    }
  }
}
