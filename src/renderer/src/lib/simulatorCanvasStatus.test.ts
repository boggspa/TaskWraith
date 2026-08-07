import { describe, expect, it } from 'vitest'
import { unwrapSimulatorCapabilityStatus } from './simulatorCanvasStatus'
import type { SimulatorCapabilityStatus } from '../../../shared/simulatorCanvas'

const sampleStatus: SimulatorCapabilityStatus = {
  platform: 'darwin',
  installed: true,
  simctlAvailable: true,
  simulatorAppPath: '/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app',
  xcodeAppPath: '/Applications/Xcode.app',
  bootedDevices: [],
  availableDevices: [],
  installHint: '',
  docsUrl: 'https://developer.apple.com/xcode/'
}

describe('unwrapSimulatorCapabilityStatus', () => {
  it('unwraps the IPC { ok, status } envelope from simulator-canvas:status', () => {
    expect(
      unwrapSimulatorCapabilityStatus({
        ok: true,
        status: sampleStatus
      })
    ).toEqual(sampleStatus)
  })

  it('accepts a bare capability status for defensive compatibility', () => {
    expect(unwrapSimulatorCapabilityStatus(sampleStatus)).toEqual(sampleStatus)
  })

  it('rejects malformed payloads', () => {
    expect(unwrapSimulatorCapabilityStatus(null)).toBeNull()
    expect(unwrapSimulatorCapabilityStatus({ ok: true })).toBeNull()
    expect(unwrapSimulatorCapabilityStatus({ ok: false, status: sampleStatus })).toBeNull()
  })
})
