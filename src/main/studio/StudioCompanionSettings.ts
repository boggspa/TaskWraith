import { resolveDaemonShouldRun, type BridgeDaemonEnvOverride } from '../BridgeDaemonSettings'

export type StudioCompanionResolutionSource = 'environment' | 'settings' | 'platform'

export interface StudioCompanionResolution {
  shouldRun: boolean
  supported: boolean
  settingEnabled: boolean
  envOverride: BridgeDaemonEnvOverride
  source: StudioCompanionResolutionSource
}

/**
 * Resolve the production Studio lifecycle without teaching the companion a
 * second settings language. The explicit environment override mirrors the
 * bridge daemon, while the platform gate remains authoritative because the
 * AppKit/Metal product is macOS-only.
 */
export function resolveStudioCompanionShouldRun(
  settingEnabled: boolean | undefined,
  envValue: string | undefined,
  platform: NodeJS.Platform = process.platform
): StudioCompanionResolution {
  const resolution = resolveDaemonShouldRun(settingEnabled, envValue)
  if (platform !== 'darwin') {
    return {
      ...resolution,
      shouldRun: false,
      supported: false,
      source: 'platform'
    }
  }
  return { ...resolution, supported: true }
}
