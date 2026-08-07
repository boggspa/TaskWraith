import { describe, expect, it } from 'vitest'
import { SIMULATOR_APP_CANDIDATE_PATHS, probeSimulatorCapability } from './SimulatorCapability'
import {
  SIMULATOR_INSTALL_DOCS_URL,
  SIMULATOR_UNSUPPORTED_PLATFORM_HINT
} from '../../shared/simulatorCanvas'

const SAMPLE_LIST_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
      {
        udid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        name: 'iPhone 16',
        state: 'Booted',
        isAvailable: true
      },
      {
        udid: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB',
        name: 'iPad Pro',
        state: 'Shutdown',
        isAvailable: true
      }
    ]
  }
})

describe('probeSimulatorCapability', () => {
  it('reports unsupported on non-darwin', async () => {
    const status = await probeSimulatorCapability({
      platform: 'linux',
      pathExists: async () => true,
      runSimctl: async () => ({ stdout: SAMPLE_LIST_JSON, stderr: '' })
    })
    expect(status.installed).toBe(false)
    expect(status.simctlAvailable).toBe(false)
    expect(status.installHint).toBe(SIMULATOR_UNSUPPORTED_PLATFORM_HINT)
    expect(status.docsUrl).toBe(SIMULATOR_INSTALL_DOCS_URL)
  })

  it('is not installed on darwin when simctl fails', async () => {
    const status = await probeSimulatorCapability({
      platform: 'darwin',
      pathExists: async (path) => path.includes('Simulator.app'),
      runSimctl: async () => {
        throw new Error('simctl missing')
      }
    })
    expect(status.installed).toBe(false)
    expect(status.simctlAvailable).toBe(false)
    expect(status.simulatorAppPath).toBe(SIMULATOR_APP_CANDIDATE_PATHS[0])
    expect(status.installHint).toMatch(/Xcode/i)
  })

  it('is installed when simctl works and Simulator.app exists', async () => {
    const status = await probeSimulatorCapability({
      platform: 'darwin',
      pathExists: async (path) =>
        path === SIMULATOR_APP_CANDIDATE_PATHS[0] || path === '/Applications/Xcode.app',
      runSimctl: async () => ({ stdout: SAMPLE_LIST_JSON, stderr: '' })
    })
    expect(status.installed).toBe(true)
    expect(status.simctlAvailable).toBe(true)
    expect(status.simulatorAppPath).toBe(SIMULATOR_APP_CANDIDATE_PATHS[0])
    expect(status.xcodeAppPath).toBe('/Applications/Xcode.app')
    expect(status.bootedDevices).toEqual([
      expect.objectContaining({
        udid: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
        name: 'iPhone 16',
        state: 'Booted'
      })
    ])
    expect(status.availableDevices.map((d) => d.name)).toEqual(['iPhone 16', 'iPad Pro'])
  })

  it('parses booted devices from simctl JSON', async () => {
    const status = await probeSimulatorCapability({
      platform: 'darwin',
      pathExists: async () => true,
      runSimctl: async (args) => {
        expect(args).toEqual(['list', 'devices', 'available', '--json'])
        return { stdout: SAMPLE_LIST_JSON, stderr: '' }
      }
    })
    expect(status.bootedDevices).toHaveLength(1)
    expect(status.bootedDevices[0]?.udid).toBe('AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA')
  })
})
