import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const BETA_DESKTOP_APP_ID = 'com.chrisizatt.taskwraith'
export const RELEASE_DESKTOP_APP_ID = 'com.taskwraith.desktop'

export type AppDistributionSeries = 'beta' | 'release' | 'development' | 'invalid'

export interface AppDistributionIdentity {
  series: AppDistributionSeries
  appId?: string
  stableUpdateChannel: 'latest' | 'release'
  valid: boolean
  reason?: string
}

interface PackagedDistributionMetadata {
  taskwraithDistributionIdentity?: unknown
  taskwraithAppId?: unknown
  taskwraithUpdateFeedChannel?: unknown
}

/**
 * Read identity metadata from the package.json embedded in app.asar.
 *
 * electron-builder writes these fields through `extraMetadata`; keeping them
 * in the packaged bytes means the same compiled main bundle can be wrapped as
 * the final beta handoff build or the public Release identity without a
 * build-time define that can drift from the installer configuration.
 */
export function readAppDistributionIdentity(
  appPath: string,
  readText: (filePath: string) => string = (filePath) => readFileSync(filePath, 'utf8')
): AppDistributionIdentity {
  let metadata: PackagedDistributionMetadata
  try {
    metadata = JSON.parse(readText(join(appPath, 'package.json'))) as PackagedDistributionMetadata
  } catch (error) {
    return {
      series: 'invalid',
      stableUpdateChannel: 'latest',
      valid: false,
      reason: `Packaged distribution metadata could not be read: ${errorMessage(error)}`
    }
  }

  const series = cleanString(metadata.taskwraithDistributionIdentity)
  const appId = cleanString(metadata.taskwraithAppId)
  const updateFeedChannel = cleanString(metadata.taskwraithUpdateFeedChannel)

  // Source/dev runs use the repository package.json, which intentionally has
  // no packaged-distribution fields. They are not a beta or Release identity.
  if (!series && !appId && !updateFeedChannel) {
    return {
      series: 'development',
      stableUpdateChannel: 'latest',
      valid: true
    }
  }

  if (series === 'beta' && appId === BETA_DESKTOP_APP_ID && updateFeedChannel === 'latest') {
    return {
      series: 'beta',
      appId,
      stableUpdateChannel: 'latest',
      valid: true
    }
  }

  if (series === 'release' && appId === RELEASE_DESKTOP_APP_ID && updateFeedChannel === 'release') {
    return {
      series: 'release',
      appId,
      stableUpdateChannel: 'release',
      valid: true
    }
  }

  return {
    series: 'invalid',
    ...(appId ? { appId } : {}),
    stableUpdateChannel: 'latest',
    valid: false,
    reason: 'Packaged distribution metadata is not one of the frozen beta or Release identities.'
  }
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
