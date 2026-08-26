/**
 * Provider registry for the pure-Node Host.
 *
 * The registry dispatches read operations to the correct provider instance,
 * computes aggregate status/auth projections, and exposes capability flags for
 * the production server. It rejects duplicate ids and can validate that the
 * composed set exactly matches the live static set before the listener opens.
 */

import { LIVE_SELECTABLE_PROVIDER_IDS, isLiveSelectableProvider } from '../shared/retiredProviders'
import type { HostProviderModelProjection } from '../shared/hostProtocol'
import type {
  HostProviderAuthFlowProjection,
  HostProviderAuthStatusProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import type { HostProviderRunPort } from '../host-runtime/HostProviderRunPort'
import type { HostNodeInteractionResolver } from './HostNodeInteractionRegistry'
import type { HostNodeProvider, HostNodeProviderInstance } from './HostNodeProvider'

export interface IHostNodeProviderRegistry {
  readonly providerIds: readonly string[]
  readonly supportsApprovals: boolean
  readonly supportsQuestions: boolean
  hasProvider(providerId: string): boolean
  getInstance(providerId: string): HostNodeProviderInstance | undefined
  getOffers(providerId: string): HostProviderOffersProjection | undefined
  providerStatuses(): Promise<readonly HostProviderStatusProjection[]>
  providerAuthStatus(providerId: string): Promise<HostProviderAuthStatusProjection | null>
  providerAuthFlows(providerId: string): Promise<readonly HostProviderAuthFlowProjection[] | null>
  shutdown(): Promise<void>
}

export interface HostNodeProviderRegistryOptions {
  readonly providers: readonly HostNodeProvider[]
  readonly runPort: HostProviderRunPort
  readonly interactions: HostNodeInteractionResolver
}

/** True when the composed set exactly equals the canonical live-selectable set. */
export function validateHostNodeProviderComposition(providerIds: readonly string[]): void {
  const composed = new Set(providerIds)
  if (
    composed.size !== LIVE_SELECTABLE_PROVIDER_IDS.length ||
    !LIVE_SELECTABLE_PROVIDER_IDS.every((id) => composed.has(id))
  ) {
    throw new Error(
      `HostNodeProviderRegistry requires the exact live provider set: ${LIVE_SELECTABLE_PROVIDER_IDS.join(', ')}`
    )
  }
}

export class HostNodeProviderRegistry implements IHostNodeProviderRegistry {
  private readonly factories = new Map<string, HostNodeProvider>()
  private readonly providers = new Map<string, HostNodeProviderInstance>()
  private readonly offers = new Map<string, HostProviderOffersProjection>()
  private readonly _providerIds: string[]
  private readonly _supportsApprovals: boolean
  private readonly _supportsQuestions: boolean

  constructor(options: HostNodeProviderRegistryOptions) {
    const ids: string[] = []
    let approvals = false
    let questions = false
    for (const factory of options.providers) {
      if (!isLiveSelectableProvider(factory.providerId)) {
        throw new Error(
          `HostNodeProviderRegistry rejected non-live provider: ${factory.providerId}`
        )
      }
      if (this.providers.has(factory.providerId)) {
        throw new Error(
          `HostNodeProviderRegistry rejected duplicate provider: ${factory.providerId}`
        )
      }
      const instance = factory.create({
        runPort: options.runPort,
        interactions: options.interactions
      })
      this.factories.set(factory.providerId, factory)
      this.providers.set(factory.providerId, instance)
      this.offers.set(factory.providerId, factory.offers)
      ids.push(factory.providerId)
      if (factory.supportsApprovals) approvals = true
      if (factory.supportsQuestions) questions = true
    }
    this._providerIds = ids
    this._supportsApprovals = approvals
    this._supportsQuestions = questions
  }

  get providerIds(): readonly string[] {
    return this._providerIds
  }

  get supportsApprovals(): boolean {
    return this._supportsApprovals
  }

  get supportsQuestions(): boolean {
    return this._supportsQuestions
  }

  providerInventory(): readonly HostProviderModelProjection[] {
    return this.providerIds.map((providerId) => {
      const factory = this.factories.get(providerId)!
      const offers = this.offers.get(providerId)!
      const defaultModel = offers.models.find((model) => model.default && model.available)
      const availableModel = offers.models.find((model) => model.available) ?? defaultModel
      return {
        providerId,
        displayProvider: factory.displayProvider,
        shortCode: factory.shortCode,
        available: true,
        ...(availableModel
          ? { modelId: availableModel.modelId, modelLabel: availableModel.label }
          : {})
      }
    })
  }

  hasProvider(providerId: string): boolean {
    return this.providers.has(providerId)
  }

  getInstance(providerId: string): HostNodeProviderInstance | undefined {
    return this.providers.get(providerId)
  }

  getOffers(providerId: string): HostProviderOffersProjection | undefined {
    return this.offers.get(providerId)
  }

  async providerStatuses(): Promise<readonly HostProviderStatusProjection[]> {
    const statuses = await Promise.all(
      [...this.providers.values()].map((instance) => instance.getStatus())
    )
    return statuses
  }

  async providerAuthStatus(providerId: string): Promise<HostProviderAuthStatusProjection | null> {
    const instance = this.providers.get(providerId)
    if (!instance) return null
    return instance.getAuthStatus()
  }

  async providerAuthFlows(
    providerId: string
  ): Promise<readonly HostProviderAuthFlowProjection[] | null> {
    const instance = this.providers.get(providerId)
    if (!instance) return null
    return instance.getAuthFlows()
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.providers.values()].map((instance) => instance.shutdown()))
  }
}
