import { expect, it, vi } from 'vitest'
import { HostNodeMuseAuthHandoff } from './HostNodeMuseAuthHandoff'

it('launches only exact argv login and never claims cancellability', async () => {
  const launch = vi.fn()
  const handoff = new HostNodeMuseAuthHandoff('/opt/muse', { launch })
  await handoff.begin({ providerId: 'muse', operationId: 'op-1' })
  expect(launch).toHaveBeenCalledWith({ argv: ['/opt/muse', 'login'] })
  await expect(handoff.cancel({ providerId: 'muse', operationId: 'op-1' })).resolves.toBe(false)
})
