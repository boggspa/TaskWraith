import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadExternalProviderUsageRecords: vi.fn(),
  setCursorRecordsForwarder: vi.fn(),
  setExternalScanYieldMode: vi.fn()
}))

vi.mock('../ExternalProviderActivity', () => mocks)

describe('externalActivityWorker startup posture', () => {
  it('uses the resource-governed duty cycle in its isolated process', async () => {
    await import('./externalActivityWorker')

    expect(mocks.setExternalScanYieldMode).toHaveBeenCalledWith('duty-cycle')
  })
})
