import type {
  HostPermissionPostureOffer,
  HostProviderModelOffer,
  HostProviderOffersProjection,
  HostProviderReasoningOffer,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import type { TaskWraithControlWorkspace } from '../shared/taskWraithControlProtocol'

/**
 * Resolve a provider that can accept the first prompt immediately.
 *
 * Auth-required providers deliberately do not qualify: the caller keeps the
 * prompt intact and sends the user through guided setup instead.
 */
export function resolveStartupProvider(
  statuses: readonly HostProviderStatusProjection[],
  savedProviderId?: string
): HostProviderStatusProjection | undefined {
  const saved = statuses.find(
    (candidate) => candidate.providerId === savedProviderId && candidate.status === 'ready'
  )
  if (saved) return saved

  return (
    statuses.find(
      (candidate) => candidate.providerId === 'claude' && candidate.status === 'ready'
    ) ?? statuses.find((candidate) => candidate.status === 'ready')
  )
}

/** Pick a currently offered model, preferring profile memory over Host defaults. */
export function resolveStartupModel(
  offers: HostProviderOffersProjection,
  savedModelId?: string
): HostProviderModelOffer | undefined {
  const available = offers.models.filter((candidate) => candidate.available)
  return (
    available.find((candidate) => candidate.modelId === savedModelId) ??
    available.find((candidate) => candidate.default === true) ??
    available[0]
  )
}

/**
 * Lazy startup may select only the Host's exact standard edit posture.
 * Guided setup remains responsible for presenting any other available posture.
 */
export function resolveStartupPosture(
  offers: HostProviderOffersProjection
): HostPermissionPostureOffer | undefined {
  return offers.postures.find(
    (candidate) => candidate.postureId === 'default' && candidate.available
  )
}

/** Reasoning has no inferred fallback: retain it only while that exact offer is available. */
export function resolveStartupReasoning(
  model: HostProviderModelOffer | undefined,
  savedReasoningId?: string
): HostProviderReasoningOffer | undefined {
  if (!savedReasoningId) return undefined
  return model?.reasoning.find(
    (candidate) => candidate.reasoningId === savedReasoningId && candidate.available
  )
}

export interface StartupWorkspaceResolutionInput {
  readonly workspaces: readonly Pick<TaskWraithControlWorkspace, 'id' | 'updatedAt'>[]
  readonly savedWorkspaceId?: string
  readonly currentThreadWorkspaceId?: string | null
}

/** Resolve a registered workspace without trusting stale profile or thread ids. */
export function resolveStartupWorkspaceId(
  input: StartupWorkspaceResolutionInput
): string | undefined {
  const saved = input.workspaces.find((workspace) => workspace.id === input.savedWorkspaceId)
  if (saved) return saved.id

  const current = input.workspaces.find(
    (workspace) => workspace.id === input.currentThreadWorkspaceId
  )
  if (current) return current.id

  return input.workspaces.reduce<(typeof input.workspaces)[number] | undefined>(
    (latest, workspace) => (!latest || workspace.updatedAt > latest.updatedAt ? workspace : latest),
    undefined
  )?.id
}
