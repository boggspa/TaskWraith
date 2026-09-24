import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/thread-catalogue-install-test' } }))

import type { HostProjectionBroker } from '../host/HostProjectionBroker'
import { createHostThreadCatalogueTransport } from './installThreadCatalogue'

describe('external Host thread catalogue transport', () => {
  it('forwards the recovery lane without changing the catalogue query', async () => {
    const queryThreadCatalogue = vi.fn(async () => ({ title: 'quiet' }))
    const port = createHostThreadCatalogueTransport({
      queryThreadCatalogue
    } as unknown as HostProjectionBroker)

    await expect(
      port.query({ method: 'open', chatId: 'chat-1', mode: 'metadata' }, { priority: 'background' })
    ).resolves.toEqual({ title: 'quiet' })
    expect(queryThreadCatalogue).toHaveBeenCalledWith(
      { method: 'open', chatId: 'chat-1', mode: 'metadata' },
      { priority: 'background' }
    )
  })
})
