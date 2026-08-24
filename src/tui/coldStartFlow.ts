import type { HostCommandReceipt, HostResultRef } from '../shared/hostProtocol'
import type {
  HostPermissionPostureOffer,
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import type { ThreadConfigureOfferSelection } from './hostCommandFlow'

// eslint-disable-next-line no-control-regex -- Host locator ids reject C0 controls.
const HOST_LOCATOR_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export type ColdStartPendingCommand = {
  readonly commandId: string
  readonly idempotencyKey: string
  readonly name:
    | 'workspace.register'
    | 'thread.create'
    | 'thread.configure'
    | 'thread.archive'
    | 'provider.auth.begin'
    | 'provider.auth.cancel'
  readonly submittedAt: string
}

type ColdStartBase = {
  readonly pending?: ColdStartPendingCommand
}

export type ColdStartFlowState =
  | (ColdStartBase & { readonly kind: 'idle' })
  | (ColdStartBase & { readonly kind: 'workspace'; readonly workspaceId: string })
  | (ColdStartBase & {
      readonly kind: 'provider'
      readonly workspaceId?: string
      readonly provider: HostProviderStatusProjection
    })
  | (ColdStartBase & {
      readonly kind: 'auth'
      readonly workspaceId?: string
      readonly providerId: string
      readonly flows: readonly HostProviderAuthFlowProjection[]
      readonly operationId?: string
    })
  | (ColdStartBase & {
      readonly kind: 'offers'
      readonly workspaceId?: string
      readonly providerId: string
      readonly offers: HostProviderOffersProjection
    })
  | (ColdStartBase & {
      readonly kind: 'thread'
      readonly workspaceId?: string
      readonly providerId: string
      readonly offers: HostProviderOffersProjection
      readonly threadId: string
    })
  | (ColdStartBase & {
      readonly kind: 'configure'
      readonly workspaceId?: string
      readonly providerId: string
      readonly offers: HostProviderOffersProjection
      readonly threadId: string
      readonly acknowledgedPostureIds: readonly string[]
      readonly selection?: ThreadConfigureOfferSelection
    })
  | (ColdStartBase & {
      readonly kind: 'ready'
      readonly workspaceId?: string
      readonly providerId: string
      readonly threadId: string
    })
  | (ColdStartBase & {
      readonly kind: 'legacy'
      readonly reason:
        | 'terminal_failure'
        | 'indeterminate'
        | 'invalid_result_ref'
        | 'setup_unavailable'
    })

export function coldStartIdle(): ColdStartFlowState {
  return { kind: 'idle' }
}

export function coldStartWorkspaceRegistered(workspaceId: string): ColdStartFlowState {
  return { kind: 'workspace', workspaceId: requireId(workspaceId, 'Workspace id') }
}

export function coldStartSelectProvider(
  state: ColdStartFlowState,
  provider: HostProviderStatusProjection
): ColdStartFlowState {
  if (provider.status !== 'ready' && provider.status !== 'auth_required') {
    throw new Error('Selected provider is not currently available.')
  }
  return {
    kind: 'provider',
    ...(workspaceIdOf(state) ? { workspaceId: workspaceIdOf(state) } : {}),
    provider
  }
}

export function coldStartAuthFlows(
  state: ColdStartFlowState,
  status: HostProviderAuthStatusProjection,
  flows: readonly HostProviderAuthFlowProjection[]
): ColdStartFlowState {
  const providerId = providerIdOf(state)
  if (!providerId || status.providerId !== providerId)
    throw new Error('Provider auth status does not match selection.')
  if (status.state === 'authenticated') return state
  return {
    kind: 'auth',
    ...(workspaceIdOf(state) ? { workspaceId: workspaceIdOf(state) } : {}),
    providerId,
    flows: flows.filter((flow) => flow.available)
  }
}

export function coldStartOffers(
  state: ColdStartFlowState,
  offers: HostProviderOffersProjection
): ColdStartFlowState {
  const providerId = providerIdOf(state)
  if (!providerId || offers.providerId !== providerId)
    throw new Error('Provider offers do not match selection.')
  return {
    kind: 'offers',
    ...(workspaceIdOf(state) ? { workspaceId: workspaceIdOf(state) } : {}),
    providerId,
    offers
  }
}

export function coldStartThreadCreated(
  state: ColdStartFlowState,
  threadId: string
): ColdStartFlowState {
  if (state.kind !== 'offers') throw new Error('Thread creation requires current provider offers.')
  return {
    kind: 'thread',
    ...(state.workspaceId ? { workspaceId: state.workspaceId } : {}),
    providerId: state.providerId,
    offers: state.offers,
    threadId: requireId(threadId, 'Thread id')
  }
}

export function coldStartConfigure(state: ColdStartFlowState): ColdStartFlowState {
  if (state.kind !== 'thread') throw new Error('Thread configuration requires a created thread.')
  return { ...state, kind: 'configure', acknowledgedPostureIds: [] }
}

export function acknowledgeColdStartPosture(
  state: ColdStartFlowState,
  postureId: string
): ColdStartFlowState {
  if (state.kind !== 'configure')
    throw new Error('Posture acknowledgement requires configure state.')
  const posture = requireAvailablePosture(state.offers, postureId)
  if (!posture.requiresExplicitConsent)
    throw new Error('Selected posture does not require acknowledgement.')
  if (state.acknowledgedPostureIds.includes(postureId)) return state
  return { ...state, acknowledgedPostureIds: [...state.acknowledgedPostureIds, postureId] }
}

export function selectColdStartConfiguration(
  state: ColdStartFlowState,
  selection: Omit<ThreadConfigureOfferSelection, 'threadId'>
): ColdStartFlowState {
  if (state.kind !== 'configure')
    throw new Error('Configuration selection requires configure state.')
  if (
    selection.providerId !== state.providerId ||
    selection.offerRevision !== state.offers.offerRevision
  ) {
    throw new Error('Configuration selection does not match current Host offers.')
  }
  const model = state.offers.models.find(
    (candidate) => candidate.modelId === selection.modelId && candidate.available
  )
  if (!model) throw new Error('Selected model is not currently offered.')
  if (
    selection.reasoningId &&
    !model.reasoning.some(
      (candidate) => candidate.reasoningId === selection.reasoningId && candidate.available
    )
  ) {
    throw new Error('Selected reasoning option is not currently offered.')
  }
  const posture = requireAvailablePosture(state.offers, selection.postureId)
  if (posture.requiresExplicitConsent) {
    if (
      selection.postureConsent !== true ||
      !state.acknowledgedPostureIds.includes(posture.postureId)
    ) {
      throw new Error('Selected posture requires explicit acknowledgement.')
    }
  } else if (selection.postureConsent === true) {
    throw new Error('Posture consent may be supplied only for a consent-required posture.')
  }
  return { ...state, selection: { ...selection, threadId: state.threadId } }
}

export function coldStartPending(
  state: ColdStartFlowState,
  pending: ColdStartPendingCommand
): ColdStartFlowState {
  if (!pending.commandId || !pending.idempotencyKey)
    throw new Error('Pending Host command identity is required.')
  return { ...state, pending }
}

/** Validates an exact current auth-flow id before retaining the begin receipt identity. */
export function beginColdStartProviderAuth(
  state: ColdStartFlowState,
  flowId: string,
  pending: ColdStartPendingCommand
): ColdStartFlowState {
  if (state.kind !== 'auth') throw new Error('Provider auth begin requires auth state.')
  if (pending.name !== 'provider.auth.begin')
    throw new Error('Provider auth begin requires its exact command.')
  if (!state.flows.some((flow) => flow.flowId === flowId && flow.available)) {
    throw new Error('Selected provider auth flow is not currently offered.')
  }
  return coldStartPending(state, pending)
}

/** Reconnect retains the exact pending identity; it never remints/replays a command. */
export function reconnectColdStart(state: ColdStartFlowState): ColdStartFlowState {
  return state
}

export function coldStartMayAutoRetry(state: ColdStartFlowState): boolean {
  // Setup commands are receipt-recovered, never replayed. Provider auth begin
  // is especially non-idempotent from the user's perspective, so it can only
  // be resumed by receipt/result-ref observation or an explicit fresh action.
  void state
  return false
}

export function applyColdStartReceipt(
  state: ColdStartFlowState,
  receipt: HostCommandReceipt
): ColdStartFlowState {
  if (!state.pending || receipt.commandId !== state.pending.commandId) return state
  if (receipt.status === 'pending') return state
  if (receipt.status === 'indeterminate')
    return { ...state, kind: 'legacy', reason: 'indeterminate' }
  if (receipt.status !== 'succeeded' || !receipt.resultRef) {
    return { ...state, kind: 'legacy', reason: 'terminal_failure' }
  }
  return applyColdStartResultRef(state, receipt.resultRef)
}

export function applyColdStartResultRef(
  state: ColdStartFlowState,
  resultRef: HostResultRef
): ColdStartFlowState {
  if (resultRef.kind === 'workspace') {
    if (state.pending?.name !== 'workspace.register') return invalidResultRef(state)
    const workspaceId = canonicalId(resultRef.workspaceId)
    return workspaceId ? coldStartWorkspaceRegistered(workspaceId) : invalidResultRef(state)
  }
  if (resultRef.kind === 'thread') {
    const providerId = providerIdOf(state)
    const threadId = canonicalId(resultRef.threadId)
    if (!providerId || !threadId) return invalidResultRef(state)
    if (state.pending?.name === 'thread.create' && state.kind === 'offers') {
      return coldStartThreadCreated(state, threadId)
    }
    if (state.pending?.name === 'thread.configure' && state.kind === 'configure') {
      if (threadId !== state.threadId) return invalidResultRef(state)
      return {
        kind: 'ready',
        ...(state.workspaceId ? { workspaceId: state.workspaceId } : {}),
        providerId,
        threadId
      }
    }
    return invalidResultRef(state)
  }
  if (
    resultRef.kind === 'provider-auth' &&
    state.kind === 'auth' &&
    state.pending?.name === 'provider.auth.begin'
  ) {
    const providerId = canonicalId(resultRef.providerId)
    const operationId = canonicalId(resultRef.operationId)
    if (!providerId || !operationId || providerId !== state.providerId)
      return invalidResultRef(state)
    return { ...state, operationId, pending: undefined }
  }
  return invalidResultRef(state)
}

function providerIdOf(state: ColdStartFlowState): string | undefined {
  return state.kind === 'provider'
    ? state.provider.providerId
    : 'providerId' in state
      ? state.providerId
      : undefined
}

function workspaceIdOf(state: ColdStartFlowState): string | undefined {
  return 'workspaceId' in state ? state.workspaceId : undefined
}

function requireAvailablePosture(
  offers: HostProviderOffersProjection,
  postureId: string
): HostPermissionPostureOffer {
  const posture = offers.postures.find(
    (candidate) => candidate.postureId === postureId && candidate.available
  )
  if (!posture) throw new Error('Selected posture is not currently offered.')
  return posture
}

function requireId(value: string, label: string): string {
  if (!canonicalId(value)) throw new Error(`${label} is required.`)
  return value
}

function canonicalId(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    HOST_LOCATOR_CONTROL_CHARACTERS.test(value)
  ) {
    return null
  }
  return value
}

function invalidResultRef(state: ColdStartFlowState): ColdStartFlowState {
  return { ...state, kind: 'legacy', reason: 'invalid_result_ref' }
}
