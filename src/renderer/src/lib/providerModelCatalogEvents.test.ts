import { describe, expect, it, vi } from 'vitest'
import {
  notifyPiProviderModelCatalogMutation,
  PI_PROVIDER_MODEL_CATALOG_MUTATION_EVENT
} from './providerModelCatalogEvents'

describe('provider model catalog events', () => {
  it('emits one nonsecret Pi invalidation event', () => {
    const dispatchEvent = vi.fn((_event: Event) => true)

    notifyPiProviderModelCatalogMutation({ dispatchEvent })

    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    const event = dispatchEvent.mock.calls[0]?.[0]
    expect(event?.type).toBe(PI_PROVIDER_MODEL_CATALOG_MUTATION_EVENT)
    expect(Object.keys(event ?? {})).not.toContain('apiKey')
  })
})
