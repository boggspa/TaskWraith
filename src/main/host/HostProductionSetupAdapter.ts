/**
 * Production Host setup adapter.
 *
 * This is a main-process composition adapter, but remains Electron-free: it
 * accepts narrow Workspace/Chat/terminal ports and exposes only bounded Host
 * setup projections plus the closed setup executor. It never reads secrets,
 * terminal command lines, URLs, or effective permission bodies.
 */

import { createHash } from 'node:crypto'

import { ANTIGRAVITY_PROVIDER_ID, isLiveSelectableProvider } from '../../shared/retiredProviders'
import type { ProviderId } from '../store/types'
import type {
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../../shared/hostSetupProtocol'
import { buildProviderManualSetupFlow } from '../providers/ProviderManualSetupFlowCatalog'
import {
  HostSetupCommandExecutor,
  type HostSetupCommandExecutorPorts
} from '../../host-runtime/HostSetupCommandExecutor'

export interface HostProductionSetupWorkspacePort {
  registerWorkspace(input: {
    readonly selectedPath: string
    readonly displayName?: string
    readonly pinned?: boolean
  }): Promise<{ readonly id: string }> | { readonly id: string }
  getWorkspaces(): readonly {
    readonly id: string
    readonly path: string
    readonly realPath?: string
  }[]
}

export interface HostProductionSetupChatPort {
  createSingleThread(
    input:
      | { readonly scope: 'global'; readonly title?: string }
      | {
          readonly scope: 'workspace'
          readonly workspaceId: string
          readonly workspacePath: string
          readonly title?: string
        }
  ): { readonly appChatId: string } | Promise<{ readonly appChatId: string }>
  configureThread(input: {
    readonly chatId: string
    readonly provider?: ProviderId
    readonly selectedModelType?: string
    readonly reasoningId?: string
    readonly postureId?: 'read_only' | 'plan' | 'default' | 'workspace_write'
    readonly title?: string
  }): { readonly appChatId: string } | Promise<{ readonly appChatId: string }>
  archiveThread(input: {
    readonly chatId: string
    readonly archived: boolean
  }): { readonly appChatId: string } | Promise<{ readonly appChatId: string }>
}

export interface HostProductionSetupTerminalPort {
  begin(input: {
    readonly provider: ProviderId
    readonly flowId: string
    readonly operationId: string
  }):
    | { readonly provider: ProviderId; readonly operationId: string }
    | Promise<{ readonly provider: ProviderId; readonly operationId: string }>
  cancel(input: {
    readonly provider: ProviderId
    readonly operationId: string
  }):
    | { readonly outcome: 'cancelled' | 'not_found' | 'not_cancellable' }
    | Promise<{ readonly outcome: 'cancelled' | 'not_found' | 'not_cancellable' }>
}

export interface HostProductionStaticReasoningInput {
  readonly reasoningId: string
  readonly label: string
  readonly available?: boolean
}

export interface HostProductionStaticModelInput {
  readonly modelId: string
  readonly label: string
  readonly available?: boolean
  readonly default?: boolean
  readonly reasoning?: readonly HostProductionStaticReasoningInput[]
}

export interface HostProductionProviderSetupInput {
  readonly providerId: ProviderId
  readonly label: string
  readonly status: 'ready' | 'auth_required' | 'unavailable' | 'degraded'
  readonly detail?: string
  readonly models: readonly HostProductionStaticModelInput[]
}

/**
 * Thin composition-root source: raw provider-adapter status + static picker
 * rows. The Host adapter owns all projection/revision/reasoning conversion.
 */
export interface HostProductionProviderAdapterStatus {
  readonly status: 'ready' | 'auth_required' | 'unavailable' | 'degraded'
  readonly detail?: string
}

export interface HostProductionProviderStaticModelRow {
  readonly id: string
  readonly label: string
  readonly supportedReasoningEfforts?: readonly (
    | string
    | { readonly id: string; readonly label?: string }
    | {
        readonly reasoningEffort: string
        readonly label?: string
        readonly disabled?: boolean
        readonly disabledReason?: string
      }
  )[]
  readonly defaultReasoningEffort?: string
  readonly isDefault?: boolean
}

export interface HostProductionSetupProviderSource {
  listProviderIds(): readonly ProviderId[] | Promise<readonly ProviderId[]>
  /** Real ProviderAdapter.getStatus() is deliberately opaque at this seam. */
  getStatus(providerId: ProviderId): unknown | Promise<unknown>
  getModels(
    providerId: ProviderId
  ):
    | readonly HostProductionProviderStaticModelRow[]
    | Promise<readonly HostProductionProviderStaticModelRow[]>
  getLabel(providerId: ProviderId): string | Promise<string>
}

export interface HostProductionSetupAdapterOptions {
  readonly workspace: HostProductionSetupWorkspacePort
  readonly chat: HostProductionSetupChatPort
  readonly terminal: HostProductionSetupTerminalPort
  /** Current provider read; this adapter does not invent availability. */
  readonly providers?:
    | (() =>
        | readonly HostProductionProviderSetupInput[]
        | Promise<readonly HostProductionProviderSetupInput[]>)
    | undefined
  /** Preferred thin source for production composition roots. */
  readonly providerSource?: HostProductionSetupProviderSource
  /** Dynamic AntiGravity admission supplied by its existing consent/key wall. */
  readonly isConditionallyAdmitted?: (providerId: ProviderId) => boolean
}

export interface HostProductionSetupAdapter {
  readonly setupExecutor: HostSetupCommandExecutor
  providerStatuses(): Promise<readonly HostProviderStatusProjection[]>
  providerOffers(providerId: string): Promise<HostProviderOffersProjection>
  providerAuthFlows(providerId: string): Promise<readonly HostProviderAuthFlowProjection[]>
  providerAuthStatus(providerId: string): Promise<HostProviderAuthStatusProjection>
}

type SetupPosture = {
  readonly postureId: 'read_only' | 'plan' | 'default' | 'workspace_write'
  readonly label: string
  readonly requiresExplicitConsent: boolean
  readonly ceiling: 'read' | 'workspace_write'
}

const POSTURES: readonly SetupPosture[] = [
  { postureId: 'read_only', label: 'Read only', requiresExplicitConsent: false, ceiling: 'read' },
  { postureId: 'plan', label: 'Plan', requiresExplicitConsent: false, ceiling: 'read' },
  {
    postureId: 'default',
    label: 'Default',
    requiresExplicitConsent: false,
    ceiling: 'workspace_write'
  },
  {
    postureId: 'workspace_write',
    label: 'Workspace write',
    requiresExplicitConsent: true,
    ceiling: 'workspace_write'
  }
]

function usableId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- setup IDs cannot include terminal controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function requirePort(options: HostProductionSetupAdapterOptions): void {
  if (
    !options ||
    !options.workspace ||
    typeof options.workspace.registerWorkspace !== 'function' ||
    typeof options.workspace.getWorkspaces !== 'function' ||
    !options.chat ||
    typeof options.chat.createSingleThread !== 'function' ||
    typeof options.chat.configureThread !== 'function' ||
    typeof options.chat.archiveThread !== 'function' ||
    !options.terminal ||
    typeof options.terminal.begin !== 'function' ||
    typeof options.terminal.cancel !== 'function' ||
    (typeof options.providers !== 'function' &&
      (!options.providerSource ||
        typeof options.providerSource.listProviderIds !== 'function' ||
        typeof options.providerSource.getStatus !== 'function' ||
        typeof options.providerSource.getModels !== 'function' ||
        typeof options.providerSource.getLabel !== 'function'))
  ) {
    throw new Error('HostProductionSetupAdapter requires complete injected setup ports')
  }
}

function admitted(
  providerId: ProviderId,
  isConditionallyAdmitted: HostProductionSetupAdapterOptions['isConditionallyAdmitted']
): boolean {
  return (
    isLiveSelectableProvider(providerId) ||
    (providerId === ANTIGRAVITY_PROVIDER_ID && isConditionallyAdmitted?.(providerId) === true)
  )
}

function revision(input: HostProductionProviderSetupInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        providerId: input.providerId,
        status: input.status,
        models: input.models.map((model) => ({
          modelId: model.modelId,
          available: model.available !== false,
          reasoning: model.reasoning?.map((reasoning) => ({
            reasoningId: reasoning.reasoningId,
            available: reasoning.available !== false
          }))
        })),
        postures: POSTURES
      })
    )
    .digest('hex')
}

function normalizeReasoning(
  model: HostProductionProviderStaticModelRow
): readonly HostProductionStaticReasoningInput[] {
  return (model.supportedReasoningEfforts ?? []).map((effort) => {
    if (typeof effort === 'string') return { reasoningId: effort, label: effort }
    if ('reasoningEffort' in effort) {
      return {
        reasoningId: effort.reasoningEffort,
        label: effort.label ?? effort.reasoningEffort,
        ...(effort.disabled === true ? { available: false } : {})
      }
    }
    return { reasoningId: effort.id, label: effort.label ?? effort.id }
  })
}

function normalizeProviderStatus(value: unknown): HostProductionProviderAdapterStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'degraded', detail: 'Provider status is unavailable.' }
  }
  const record = value as Record<string, unknown>
  if (
    record.status === 'ready' ||
    record.status === 'auth_required' ||
    record.status === 'unavailable' ||
    record.status === 'degraded'
  ) {
    return { status: record.status }
  }
  if (record.available === false)
    return { status: 'unavailable', detail: 'Provider is unavailable.' }
  const auth = typeof record.authState === 'string' ? record.authState.toLowerCase() : ''
  const needsAuth =
    record.setupRequired === true ||
    auth === 'unauthenticated' ||
    auth === 'not authenticated' ||
    auth === 'missing' ||
    auth === 'expired'
  if (needsAuth && record.available === true) {
    return { status: 'auth_required', detail: 'Provider sign-in is required.' }
  }
  const affirmativelyReady =
    record.authenticated === true ||
    record.setupRequired === false ||
    auth === 'authenticated' ||
    auth === 'chatgpt' ||
    auth === 'oauth' ||
    auth === 'api-key' ||
    auth === 'apikey' ||
    auth === 'not-required'
  if (record.available === true && affirmativelyReady) {
    return { status: 'ready' }
  }
  return { status: 'degraded', detail: 'Provider status is degraded.' }
}

async function providerInputs(
  options: HostProductionSetupAdapterOptions
): Promise<readonly HostProductionProviderSetupInput[]> {
  if (options.providers) return options.providers()
  const source = options.providerSource
  if (!source) throw new Error('Provider source is unavailable')
  const ids = await source.listProviderIds()
  if (!Array.isArray(ids)) throw new Error('Provider source ids are invalid')
  return Promise.all(
    ids.map(async (providerId) => {
      const [status, models, label] = await Promise.all([
        source.getStatus(providerId),
        source.getModels(providerId),
        source.getLabel(providerId)
      ])
      if (!Array.isArray(models) || !usableId(label)) {
        throw new Error('Provider source row is invalid')
      }
      const normalizedStatus = normalizeProviderStatus(status)
      return {
        providerId,
        label,
        status: normalizedStatus.status,
        ...(normalizedStatus.detail ? { detail: normalizedStatus.detail } : {}),
        models: models.map((model) => ({
          modelId: model.id,
          label: model.label,
          default: model.isDefault === true,
          reasoning: normalizeReasoning(model)
        }))
      }
    })
  )
}

async function findProvider(
  options: HostProductionSetupAdapterOptions,
  providerId: string
): Promise<HostProductionProviderSetupInput> {
  if (!usableId(providerId)) throw new Error('Provider is unavailable')
  const candidates = (await providerInputs(options)).filter(
    (candidate) => candidate.providerId === providerId
  )
  if (candidates.length !== 1) throw new Error('Provider identity is ambiguous')
  const input = candidates[0]
  if (!input || !admitted(input.providerId, options.isConditionallyAdmitted)) {
    throw new Error('Provider is unavailable')
  }
  return input
}

async function offersFor(
  options: HostProductionSetupAdapterOptions,
  providerId: string
): Promise<HostProviderOffersProjection> {
  const input = await findProvider(options, providerId)
  assertOfferIdentity(input)
  const ready = input.status === 'ready'
  return {
    providerId: input.providerId,
    offerRevision: revision(input),
    models: input.models
      .filter((model) => usableId(model.modelId) && usableId(model.label))
      .slice(0, 128)
      .map((model) => ({
        modelId: model.modelId,
        label: model.label,
        available: model.available !== false && ready,
        ...(model.default === true ? { default: true } : {}),
        reasoning: (model.reasoning ?? [])
          .filter((reasoning) => usableId(reasoning.reasoningId) && usableId(reasoning.label))
          .slice(0, 24)
          .map((reasoning) => ({
            reasoningId: reasoning.reasoningId,
            label: reasoning.label,
            available: reasoning.available !== false && ready
          }))
      })),
    postures: POSTURES.map((posture) => ({
      postureId: posture.postureId,
      label: posture.label,
      available: ready,
      requiresExplicitConsent: posture.requiresExplicitConsent,
      ceiling: posture.ceiling
    }))
  }
}

function assertOfferIdentity(input: HostProductionProviderSetupInput): void {
  const modelIds = new Set<string>()
  for (const model of input.models) {
    if (!usableId(model.modelId) || modelIds.has(model.modelId)) {
      throw new Error('Provider offer model identity is invalid')
    }
    modelIds.add(model.modelId)
    const reasoningIds = new Set<string>()
    for (const reasoning of model.reasoning ?? []) {
      if (!usableId(reasoning.reasoningId) || reasoningIds.has(reasoning.reasoningId)) {
        throw new Error('Provider offer reasoning identity is invalid')
      }
      reasoningIds.add(reasoning.reasoningId)
    }
  }
}

function statusFor(input: HostProductionProviderSetupInput): HostProviderStatusProjection {
  return {
    providerId: input.providerId,
    status: input.status,
    label: input.label,
    ...(input.detail ? { detail: input.detail } : {})
  }
}

function flowFor(provider: ProviderId): HostProviderAuthFlowProjection[] {
  const flow = buildProviderManualSetupFlow(provider, 'login')
  if (!flow) return []
  return [{ flowId: `${provider}:login`, kind: 'manual', label: 'Sign in', available: true }]
}

/** Build the setup adapter and a revalidating HostSetupCommandExecutor over it. */
export function createHostProductionSetupAdapter(
  options: HostProductionSetupAdapterOptions
): HostProductionSetupAdapter {
  requirePort(options)

  const executorPorts: HostSetupCommandExecutorPorts = {
    workspace: {
      register: async (input) => {
        const workspace = await options.workspace.registerWorkspace({
          selectedPath: input.path,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.pinned !== undefined ? { pinned: input.pinned } : {})
        })
        if (!usableId(workspace?.id)) throw new Error('Workspace registration did not return an id')
        return { workspaceId: workspace.id }
      }
    },
    thread: {
      create: async (input) => {
        if (input.scope === 'global') {
          const chat = await options.chat.createSingleThread({
            scope: 'global',
            ...(input.title !== undefined ? { title: input.title } : {})
          })
          if (!usableId(chat?.appChatId)) throw new Error('Thread creation did not return an id')
          return { threadId: chat.appChatId }
        }
        const workspace = options.workspace
          .getWorkspaces()
          .find((candidate) => candidate.id === input.workspaceId)
        const workspacePath = workspace?.realPath ?? workspace?.path
        if (!workspace || !usableId(workspacePath)) throw new Error('Workspace is unavailable')
        const chat = await options.chat.createSingleThread({
          scope: 'workspace',
          workspaceId: workspace.id,
          workspacePath,
          ...(input.title !== undefined ? { title: input.title } : {})
        })
        if (!usableId(chat?.appChatId)) throw new Error('Thread creation did not return an id')
        return { threadId: chat.appChatId }
      },
      configure: async (input) => {
        const chat = await options.chat.configureThread({
          chatId: input.threadId,
          ...(input.providerId !== undefined ? { provider: input.providerId as ProviderId } : {}),
          ...(input.modelId !== undefined ? { selectedModelType: input.modelId } : {}),
          ...(input.reasoningId !== undefined ? { reasoningId: input.reasoningId } : {}),
          ...(input.postureId !== undefined
            ? { postureId: input.postureId as SetupPosture['postureId'] }
            : {}),
          ...(input.title !== undefined ? { title: input.title } : {})
        })
        if (!usableId(chat?.appChatId)) throw new Error('Thread configuration did not return an id')
        return { threadId: chat.appChatId }
      },
      archive: async (input) => {
        const chat = await options.chat.archiveThread({
          chatId: input.threadId,
          archived: input.archived
        })
        if (!usableId(chat?.appChatId)) throw new Error('Thread archive did not return an id')
        return { threadId: chat.appChatId }
      }
    },
    providerAuth: {
      begin: async (input) => {
        const provider = await findProvider(options, input.providerId)
        if (input.flowId !== `${provider.providerId}:login`)
          throw new Error('Auth flow is unavailable')
        const begun = await options.terminal.begin({
          provider: provider.providerId,
          flowId: input.flowId,
          operationId: input.operationId
        })
        if (begun.provider !== provider.providerId || begun.operationId !== input.operationId) {
          throw new Error('Auth operation identity mismatch')
        }
        return { providerId: begun.provider, operationId: begun.operationId }
      },
      cancel: async (input) => {
        const provider = await findProvider(options, input.providerId)
        const result = await options.terminal.cancel({
          provider: provider.providerId,
          operationId: input.operationId
        })
        return {
          providerId: provider.providerId,
          operationId: input.operationId,
          outcome: result.outcome
        }
      }
    },
    currentOffers: { read: (providerId) => offersFor(options, providerId) },
    currentAuthFlows: {
      read: async (providerId) => flowFor((await findProvider(options, providerId)).providerId)
    }
  }

  return {
    setupExecutor: new HostSetupCommandExecutor(executorPorts),
    providerStatuses: async () => {
      const seen = new Set<string>()
      const statuses: HostProviderStatusProjection[] = []
      for (const input of await providerInputs(options)) {
        if (!admitted(input.providerId, options.isConditionallyAdmitted)) continue
        if (!usableId(input.providerId) || seen.has(input.providerId)) {
          throw new Error('Provider status identity is invalid')
        }
        seen.add(input.providerId)
        statuses.push(statusFor(input))
        if (statuses.length >= 64) break
      }
      return statuses
    },
    providerOffers: (providerId) => offersFor(options, providerId),
    providerAuthFlows: async (providerId) =>
      flowFor((await findProvider(options, providerId)).providerId),
    providerAuthStatus: async (providerId) => {
      const input = await findProvider(options, providerId)
      return {
        providerId: input.providerId,
        state:
          input.status === 'ready'
            ? 'authenticated'
            : input.status === 'auth_required'
              ? 'unauthenticated'
              : input.status === 'unavailable'
                ? 'unavailable'
                : 'unknown'
      }
    }
  }
}
