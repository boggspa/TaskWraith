/**
 * Probe whether Xcode Simulator / simctl is available on this host.
 * Never auto-installs; argv-array exec only (no shell).
 */
import { access } from 'fs/promises'
import { constants as fsConstants } from 'fs'
import {
  SIMULATOR_INSTALL_DOCS_URL,
  simulatorInstallHint,
  type SimulatorCapabilityStatus,
  type SimulatorDeviceInfo
} from '../../shared/simulatorCanvas'
import { defaultSimctlRunner, type SimulatorSimctlRunner } from './SimctlRunner'

export type { SimulatorSimctlRunner }

export const SIMULATOR_APP_CANDIDATE_PATHS = [
  '/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app',
  '/Applications/Simulator.app'
] as const

export const XCODE_APP_CANDIDATE_PATHS = ['/Applications/Xcode.app'] as const

const MAX_AVAILABLE_DEVICES = 40

export interface SimulatorCapabilityDeps {
  platform?: NodeJS.Platform
  pathExists?: (path: string) => Promise<boolean>
  runSimctl?: SimulatorSimctlRunner
  now?: () => string
}

const defaultPathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function parseDeviceList(stdout: string): {
  booted: SimulatorDeviceInfo[]
  available: SimulatorDeviceInfo[]
} {
  const booted: SimulatorDeviceInfo[] = []
  const available: SimulatorDeviceInfo[] = []
  try {
    const parsed = JSON.parse(stdout) as {
      devices?: Record<
        string,
        Array<{
          udid?: string
          name?: string
          state?: string
          isAvailable?: boolean | string
        }>
      >
    }
    for (const [runtime, list] of Object.entries(parsed.devices || {})) {
      for (const device of list) {
        if (typeof device.udid !== 'string' || !device.udid.trim()) continue
        const isAvailable =
          device.isAvailable === true ||
          device.isAvailable === 'YES' ||
          device.isAvailable === 'true' ||
          device.isAvailable === undefined
        const info: SimulatorDeviceInfo = {
          udid: device.udid,
          name: typeof device.name === 'string' && device.name.trim() ? device.name : device.udid,
          state: typeof device.state === 'string' ? device.state : 'Unknown',
          runtime,
          isAvailable
        }
        if (info.state === 'Booted') booted.push(info)
        if (isAvailable && available.length < MAX_AVAILABLE_DEVICES) available.push(info)
      }
    }
  } catch {
    return { booted: [], available: [] }
  }
  return { booted, available }
}

async function firstExistingPath(
  paths: readonly string[],
  pathExists: (path: string) => Promise<boolean>
): Promise<string | null> {
  for (const candidate of paths) {
    if (await pathExists(candidate)) return candidate
  }
  return null
}

export async function probeSimulatorCapability(
  deps: SimulatorCapabilityDeps = {}
): Promise<SimulatorCapabilityStatus> {
  const platform = deps.platform ?? process.platform
  const pathExists = deps.pathExists ?? defaultPathExists
  const runSimctl = deps.runSimctl ?? defaultSimctlRunner
  const docsUrl = SIMULATOR_INSTALL_DOCS_URL
  const installHint = simulatorInstallHint(platform)

  if (platform !== 'darwin') {
    return {
      platform,
      installed: false,
      simctlAvailable: false,
      simulatorAppPath: null,
      xcodeAppPath: null,
      bootedDevices: [],
      availableDevices: [],
      installHint,
      docsUrl
    }
  }

  const simulatorAppPath = await firstExistingPath(SIMULATOR_APP_CANDIDATE_PATHS, pathExists)
  const xcodeAppPath = await firstExistingPath(XCODE_APP_CANDIDATE_PATHS, pathExists)

  let simctlAvailable = false
  let bootedDevices: SimulatorDeviceInfo[] = []
  let availableDevices: SimulatorDeviceInfo[] = []
  try {
    const { stdout } = await runSimctl(['list', 'devices', 'available', '--json'])
    simctlAvailable = true
    const parsed = parseDeviceList(stdout)
    bootedDevices = parsed.booted
    availableDevices = parsed.available
  } catch {
    simctlAvailable = false
  }

  const installed = Boolean(simctlAvailable && simulatorAppPath)

  return {
    platform,
    installed,
    simctlAvailable,
    simulatorAppPath,
    xcodeAppPath,
    bootedDevices,
    availableDevices,
    installHint: installed ? 'Xcode Simulator is available for Simulator Canvas.' : installHint,
    docsUrl
  }
}
