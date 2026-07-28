import { existsSync } from 'fs'
import os from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { buildRuntimeFeatureGateSnapshot, type RuntimeFeatureGateSnapshot } from '../shared/runtimeFeatureGates'
import { getHostToolSnapshot, type HostToolSnapshot } from './HostToolResolver'

export interface NativeFeatureCapability {
  available: boolean
  reason?: string
}

export interface NativeBridgeCapability extends NativeFeatureCapability {
  binaryPath?: string
  binaryArchs?: string[]
  requiredArch?: string
}

export interface NativeCapabilitySnapshot {
  platform: string
  arch: string
  osRelease: string
  macosVersion?: string
  bridge: NativeBridgeCapability
  screenWatch: NativeFeatureCapability
  appwatch: NativeFeatureCapability
  ocr: NativeFeatureCapability
  appleEvents: NativeFeatureCapability
  /**
   * Structural AppDrive availability only. Accessibility trust is mutable
   * runtime state and must be checked immediately before native actuation.
   */
  appDrive: NativeFeatureCapability
  /**
   * Presence of OPTIONAL, user-installed host binaries (ffmpeg, poppler, …).
   * Unlike the fields above — which describe the BUNDLED Swift daemon — these can
   * appear and disappear while the app is running, so treat them as a snapshot
   * rather than a constant. Probed once and cached; see HostToolResolver.
   */
  hostTools: HostToolSnapshot
  /** Main-process feature gates — safe for the renderer to read (no process.env). */
  featureGates: RuntimeFeatureGateSnapshot
}

export interface NativeCapabilityInput {
  platform?: string
  arch?: string
  osRelease?: string
  macosVersion?: string
  binaryPath?: string
  binaryExists?: boolean
  binaryArchs?: string[]
  resourcesPath?: string
  dirname?: string
  /** Injected host-tool presence — lets tests describe a machine without probing it. */
  hostTools?: HostToolSnapshot
  /** Re-probe host tools instead of reusing the cache (post-install refresh). */
  forceHostToolProbe?: boolean
}

const MIN_BRIDGE_MACOS = '14.0'
const MIN_APP_DRIVE_MACOS = '15.2'

export function getNativeCapabilitySnapshot(
  input: NativeCapabilityInput = {}
): NativeCapabilitySnapshot {
  const platform = input.platform || process.platform
  const arch = input.arch || process.arch
  const osRelease = input.osRelease || os.release()
  const macosVersion = platform === 'darwin' ? input.macosVersion || readMacosVersion() : undefined
  const binaryPath =
    input.binaryPath ||
    (platform === 'darwin'
      ? resolveBridgeDaemonBinaryPath({
          resourcesPath: input.resourcesPath,
          dirname: input.dirname
        })
      : undefined)
  const binaryExists =
    input.binaryExists !== undefined ? input.binaryExists : Boolean(binaryPath && existsSync(binaryPath))
  const requiredArch = requiredMachOArch(arch)
  const binaryArchs =
    input.binaryArchs ||
    (binaryPath && binaryExists && platform === 'darwin' ? readMachOArchs(binaryPath) : undefined)

  let bridge: NativeBridgeCapability
  if (platform !== 'darwin') {
    bridge = { available: false, reason: 'Native bridge features are available on macOS only.' }
  } else if (!macosVersion || compareVersions(macosVersion, MIN_BRIDGE_MACOS) < 0) {
    bridge = {
      available: false,
      reason: `Native bridge features require macOS ${MIN_BRIDGE_MACOS} or newer.`
    }
  } else if (!binaryPath || !binaryExists) {
    bridge = { available: false, reason: 'TaskWraithBridgeDaemon binary was not found.' }
  } else if (requiredArch && binaryArchs && !binaryArchs.includes(requiredArch)) {
    bridge = {
      available: false,
      binaryPath,
      binaryArchs,
      requiredArch,
      reason: `TaskWraithBridgeDaemon does not contain the current CPU architecture (${requiredArch}).`
    }
  } else {
    bridge = {
      available: true,
      binaryPath,
      ...(binaryArchs ? { binaryArchs } : {}),
      ...(requiredArch ? { requiredArch } : {})
    }
  }

  const nativeBridgeFeature =
    platform === 'win32'
      ? {
          available: false,
          reason: 'Appwatch, AppDrive, and Appshots are not available on Windows in v1.'
        }
      : featureFromBridge(bridge)
  const appleEventsFeature =
    platform === 'win32'
      ? { available: false, reason: 'AppleEvents automation is available on macOS only.' }
      : nativeBridgeFeature
  const appDriveFeature = appDriveFeatureForHost(platform, macosVersion, bridge)
  return {
    platform,
    arch,
    osRelease,
    ...(macosVersion ? { macosVersion } : {}),
    bridge,
    screenWatch: nativeBridgeFeature,
    appwatch: nativeBridgeFeature,
    ocr: bridge.available
      ? { available: true, reason: 'Vision OCR is optional and capture remains available if OCR fails.' }
      : nativeBridgeFeature,
    appleEvents: appleEventsFeature,
    appDrive: appDriveFeature,
    hostTools: input.hostTools ?? getHostToolSnapshot(input.forceHostToolProbe),
    featureGates: buildRuntimeFeatureGateSnapshot(process.env)
  }
}

export function resolveBridgeDaemonBinaryPath(input: {
  resourcesPath?: string
  dirname?: string
} = {}): string {
  const resourcesPath = input.resourcesPath || process.resourcesPath
  if (resourcesPath) {
    const bundled = join(resourcesPath, 'bridge', 'TaskWraithBridgeDaemon')
    if (existsSync(bundled)) return bundled
  }
  const dirname = input.dirname || __dirname
  const devDebug = join(
    dirname,
    '..',
    '..',
    'swift',
    'TaskWraithBridge',
    '.build',
    'debug',
    'TaskWraithBridgeDaemon'
  )
  if (existsSync(devDebug)) return devDebug
  return join(
    dirname,
    '..',
    '..',
    'swift',
    'TaskWraithBridge',
    '.build',
    'release',
    'TaskWraithBridgeDaemon'
  )
}

function featureFromBridge(bridge: NativeBridgeCapability): NativeFeatureCapability {
  return bridge.available ? { available: true } : { available: false, reason: bridge.reason }
}

function appDriveFeatureForHost(
  platform: string,
  macosVersion: string | undefined,
  bridge: NativeBridgeCapability
): NativeFeatureCapability {
  if (platform !== 'darwin') {
    return {
      available: false,
      reason: `AppDrive requires macOS ${MIN_APP_DRIVE_MACOS} or newer for exact picker window identity.`
    }
  }
  if (!isValidVersion(macosVersion)) {
    return {
      available: false,
      reason: `AppDrive could not verify this Mac's OS version. Exact picker window identity requires macOS ${MIN_APP_DRIVE_MACOS} or newer.`
    }
  }
  if (compareVersions(macosVersion, MIN_APP_DRIVE_MACOS) < 0) {
    return {
      available: false,
      reason: `AppDrive requires macOS ${MIN_APP_DRIVE_MACOS} or newer for exact picker window identity; this Mac is running macOS ${macosVersion}.`
    }
  }
  if (!bridge.available) {
    return {
      available: false,
      reason: `AppDrive requires the TaskWraith native bridge. ${bridge.reason || 'The bridge is unavailable.'}`
    }
  }
  // This is deliberately not an Accessibility trust assertion. Trust can be
  // granted or revoked while TaskWraith is running and belongs at actuation time.
  return { available: true }
}

function isValidVersion(version: string | undefined): version is string {
  if (!version || !/^\d+(?:\.\d+)*$/.test(version)) return false
  return version.split('.').every((part) => Number.isSafeInteger(Number(part)))
}

function requiredMachOArch(arch: string): string | undefined {
  if (arch === 'arm64') return 'arm64'
  if (arch === 'x64') return 'x86_64'
  return undefined
}

function readMacosVersion(): string | undefined {
  const result = spawnSync('/usr/bin/sw_vers', ['-productVersion'], {
    encoding: 'utf8',
    stdio: 'pipe'
  })
  const version = result.status === 0 ? result.stdout.trim() : ''
  return version || undefined
}

function readMachOArchs(filePath: string): string[] | undefined {
  const result = spawnSync('/usr/bin/lipo', ['-archs', filePath], {
    encoding: 'utf8',
    stdio: 'pipe'
  })
  if (result.status !== 0) return undefined
  return result.stdout.trim().split(/\s+/).filter(Boolean)
}

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map((part) => Number(part) || 0)
  const right = b.split('.').map((part) => Number(part) || 0)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0)
    if (delta !== 0) return delta > 0 ? 1 : -1
  }
  return 0
}
