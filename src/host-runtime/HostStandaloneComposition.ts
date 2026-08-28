/**
 * Pure standalone Host authority composition.
 *
 * It owns one HostRuntimeBootstrap over the supplied runtime directory and no
 * deferred bridge/envelope/pipeline. All domain ports are already injected by
 * the caller after profile authority is established.
 */

import type { HostCapability } from '../shared/hostProtocol'
import {
  AppStoreHostAuthority,
  createHostStandaloneAuthorityActivationPermit,
  type AppStoreHostAuthorityEvaluator,
  type AppStoreHostAuthorityExecutor,
  type AppStoreHostAuthorityGitReadProvider,
  type AppStoreHostAuthorityHealthProvider,
  type AppStoreHostAuthorityHistorySinceProvider,
  type AppStoreHostAuthorityProviderAuthFlowsProvider,
  type AppStoreHostAuthorityProviderAuthStatusProvider,
  type AppStoreHostAuthorityProviderOffersProvider,
  type AppStoreHostAuthorityProviderStatusesProvider,
  type AppStoreHostAuthoritySetupExecutor,
  type AppStoreHostAuthoritySnapshotDonor,
  type AppStoreHostAuthorityThreadHistoryProvider,
  type AppStoreHostAuthorityThreadOffersProvider,
  type HostStandaloneAuthorityLeasePort
} from './AppStoreHostAuthority'
import type { HostAuthority, HostAuthorityCallContext } from './HostAuthority'
import { HostDomainDeltaPublisher } from './HostDomainDeltaPublisher'
import type { HostDeltaAppendListener } from './HostDeltaStore'
import {
  HostProjectionReconciler,
  type HostProjectionReconcileResult
} from './HostProjectionReconciler'
import { HostRuntimeBootstrap } from './HostRuntimeBootstrap'
import { HostSession, type HostSessionHostIdentity, type HostSessionIdFactory } from './HostSession'

export interface HostStandaloneCompositionInput {
  readonly runtimePath: string
  readonly lease: HostStandaloneAuthorityLeasePort
  readonly snapshotDonor: AppStoreHostAuthoritySnapshotDonor
  readonly authorityEvaluator: AppStoreHostAuthorityEvaluator
  readonly commandExecutor: AppStoreHostAuthorityExecutor
  readonly setupExecutor?: AppStoreHostAuthoritySetupExecutor
  readonly healthProvider: AppStoreHostAuthorityHealthProvider
  readonly threadOffersProvider?: AppStoreHostAuthorityThreadOffersProvider
  readonly gitReadProvider?: AppStoreHostAuthorityGitReadProvider
  readonly providerStatusesProvider?: AppStoreHostAuthorityProviderStatusesProvider
  readonly providerOffersProvider?: AppStoreHostAuthorityProviderOffersProvider
  readonly providerAuthFlowsProvider?: AppStoreHostAuthorityProviderAuthFlowsProvider
  readonly providerAuthStatusProvider?: AppStoreHostAuthorityProviderAuthStatusProvider
  readonly threadHistoryProvider?: AppStoreHostAuthorityThreadHistoryProvider
  readonly historySinceProvider?: AppStoreHostAuthorityHistorySinceProvider
  readonly host: HostSessionHostIdentity
  readonly hostCapabilityOffer: readonly HostCapability[]
  readonly onShutdown?: () => void | Promise<void>
  readonly sessionIdFactory?: HostSessionIdFactory
  readonly now?: () => string
}

export interface HostStandaloneComposition {
  readonly authority: HostAuthority
  readonly session: HostSession
  getPosition(): ReturnType<HostRuntimeBootstrap['getPosition']>
  subscribeDeltas(listener: HostDeltaAppendListener): () => void
  startProjectionReconciliation(): Promise<void>
  reconcileProjection(): Promise<HostProjectionReconcileResult>
  stopProjectionReconciliation(): Promise<void>
  shutdown(): Promise<void>
}

function requireFunction(value: unknown, label: string): void {
  if (typeof value !== 'function') throw new Error(`HostStandaloneComposition requires ${label}`)
}

export function createHostStandaloneComposition(
  input: HostStandaloneCompositionInput
): HostStandaloneComposition {
  if (!input || typeof input !== 'object')
    throw new Error('HostStandaloneComposition requires input')
  if (typeof input.runtimePath !== 'string' || input.runtimePath.length === 0) {
    throw new Error('HostStandaloneComposition requires runtimePath')
  }
  if (
    !input.host ||
    typeof input.host.hostId !== 'string' ||
    typeof input.host.hostVersion !== 'string'
  ) {
    throw new Error('HostStandaloneComposition requires host identity')
  }
  if (!Array.isArray(input.hostCapabilityOffer)) {
    throw new Error('HostStandaloneComposition requires hostCapabilityOffer')
  }
  requireFunction(input.snapshotDonor, 'snapshotDonor')
  requireFunction(input.authorityEvaluator, 'authorityEvaluator')
  requireFunction(input.commandExecutor, 'commandExecutor')
  requireFunction(input.healthProvider, 'healthProvider')
  requireFunction(input.onShutdown ?? (() => {}), 'onShutdown')

  // Must be first profile-affecting operation: permit factory synchronously
  // invokes lease.assertHeld before the runtime opens any files.
  const activationPermit = createHostStandaloneAuthorityActivationPermit(input.lease)
  const runtime = new HostRuntimeBootstrap({ hostDataDir: input.runtimePath })
  let stopped = false
  let reconciler: HostProjectionReconciler | null = null
  const shutdown = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await reconciler?.stop()
    runtime.flush()
    await input.onShutdown?.()
  }

  const authority = new AppStoreHostAuthority({
    mode: 'standalone',
    activationPermit,
    ...(input.now ? { now: input.now } : {}),
    ports: {
      runtime,
      snapshotDonor: input.snapshotDonor,
      authorityEvaluator: input.authorityEvaluator,
      commandExecutor: input.commandExecutor,
      ...(input.setupExecutor ? { setupExecutor: input.setupExecutor } : {}),
      healthProvider: input.healthProvider,
      ...(input.threadOffersProvider ? { threadOffersProvider: input.threadOffersProvider } : {}),
      ...(input.gitReadProvider ? { gitReadProvider: input.gitReadProvider } : {}),
      ...(input.providerStatusesProvider
        ? { providerStatusesProvider: input.providerStatusesProvider }
        : {}),
      ...(input.providerOffersProvider
        ? { providerOffersProvider: input.providerOffersProvider }
        : {}),
      ...(input.providerAuthFlowsProvider
        ? { providerAuthFlowsProvider: input.providerAuthFlowsProvider }
        : {}),
      ...(input.providerAuthStatusProvider
        ? { providerAuthStatusProvider: input.providerAuthStatusProvider }
        : {}),
      ...(input.threadHistoryProvider
        ? { threadHistoryProvider: input.threadHistoryProvider }
        : {}),
      ...(input.historySinceProvider ? { historySinceProvider: input.historySinceProvider } : {}),
      onShutdown: shutdown
    }
  })

  const publisher = new HostDomainDeltaPublisher({ store: runtime.deltaStore })
  const internalContext: HostAuthorityCallContext = {
    actor: { actorId: 'host-reconciler', clientId: 'host-reconciler', clientClass: 'desktop' },
    client: { clientId: 'host-reconciler', clientClass: 'desktop', clientVersion: '0.0.0' }
  }
  reconciler = new HostProjectionReconciler({
    captureSnapshot: async () => {
      const result = await authority.snapshot(internalContext)
      if (!result.ok) throw new Error(`standalone_snapshot_${result.error}`)
      return result.value
    },
    fetchDeltas: (position) => runtime.deltaStore.since(position),
    publishEffects: (effects) => publisher.publish(effects)
  })
  const session = new HostSession({
    host: input.host,
    runtime,
    hostCapabilityOffer: input.hostCapabilityOffer,
    ...(input.sessionIdFactory ? { sessionIdFactory: input.sessionIdFactory } : {})
  })
  return {
    authority,
    session,
    getPosition: () => runtime.getPosition(),
    subscribeDeltas: (listener) => runtime.deltaStore.subscribe(listener),
    startProjectionReconciliation: () => reconciler!.start(),
    reconcileProjection: () => reconciler!.reconcileNow(),
    stopProjectionReconciliation: () => reconciler!.stop(),
    shutdown
  }
}
