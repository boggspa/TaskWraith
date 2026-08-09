import { describe, expect, it } from 'vitest'
import { reusePairedRemoteDevices, type PairedRemoteDeviceLike } from './pairedRemoteDevices'

function device(overrides: Partial<PairedRemoteDeviceLike> = {}): PairedRemoteDeviceLike {
  return {
    iphoneIdentityPubKey: 'device-key',
    pairId: 'pair-1',
    controllerDisplayName: 'Chris’s iPhone',
    pairedAt: '2026-08-09T00:00:00.000Z',
    connected: false,
    ...overrides
  }
}

describe('reusePairedRemoteDevices', () => {
  it('reuses the previous snapshot when every displayed field is unchanged', () => {
    const previous = [device()]
    expect(reusePairedRemoteDevices(previous, [device()])).toBe(previous)
  })

  it('returns the new snapshot when membership, order, or connection changes', () => {
    const previous = [device(), device({ pairId: 'pair-2', iphoneIdentityPubKey: 'device-2' })]
    const connected = [device({ connected: true }), previous[1]]
    const reordered = [previous[1], previous[0]]

    expect(reusePairedRemoteDevices(previous, connected)).toBe(connected)
    expect(reusePairedRemoteDevices(previous, reordered)).toBe(reordered)
    expect(reusePairedRemoteDevices(previous, [])).toEqual([])
  })
})
