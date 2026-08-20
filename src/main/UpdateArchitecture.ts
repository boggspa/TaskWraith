export type UpdateArtifactArch = 'universal' | 'arm64' | 'x64' | 'unknown'
export type MacUpdateArtifactArch = UpdateArtifactArch

export interface UpdateFileLike {
  url?: string
  path?: string
}

export interface UpdateInfoLike {
  path?: string
  files?: UpdateFileLike[]
}

export interface UpdateArchitectureCompatibility {
  platform: string
  arch: string
  artifactName?: string
  artifactArch: UpdateArtifactArch
  compatible: boolean
  reason?: string
}

export function selectedUpdateArtifact(
  info: UpdateInfoLike,
  platform: string = process.platform
): string | undefined {
  const path = cleanArtifactName(info.path)
  if (path) return path
  const files = Array.isArray(info.files) ? info.files : []
  const preferredExtension = platform === 'win32' ? '.exe' : platform === 'darwin' ? '.zip' : ''
  const preferredFile = preferredExtension
    ? files
        .map((file) => cleanArtifactName(file.url || file.path))
        .find((name) => Boolean(name && name.toLowerCase().endsWith(preferredExtension)))
    : undefined
  if (preferredFile) return preferredFile
  return files.map((file) => cleanArtifactName(file.url || file.path)).find(Boolean)
}

export function selectedMacUpdateArtifact(info: UpdateInfoLike): string | undefined {
  return selectedUpdateArtifact(info, 'darwin')
}

export function selectedWindowsUpdateArtifact(info: UpdateInfoLike): string | undefined {
  return selectedUpdateArtifact(info, 'win32')
}

export function classifyUpdateArtifact(
  name: string | undefined,
  platform: string = process.platform
): UpdateArtifactArch {
  if (platform === 'win32') return classifyWindowsUpdateArtifact(name)
  if (platform === 'darwin') return classifyMacUpdateArtifact(name)
  return 'unknown'
}

export function classifyMacUpdateArtifact(name: string | undefined): MacUpdateArtifactArch {
  const cleanName = cleanArtifactName(name)?.toLowerCase()
  if (!cleanName) return 'unknown'
  if (/\buniversal\b|[-_.]universal[-_.]/i.test(cleanName)) return 'universal'
  if (/\barm64\b|[-_.]arm64[-_.]/i.test(cleanName)) return 'arm64'
  if (/\bx64\b|\bx86_64\b|[-_.](?:x64|x86_64)[-_.]/i.test(cleanName)) return 'x64'
  // electron-builder's universal mac zip commonly has no arch token.
  // Treat the conventional shared mac zip as universal at runtime; the
  // release-feed validator still enforces explicit universal naming for
  // publish safety when configured to do so.
  if (/(?:^|[-_.])mac\.zip$/i.test(cleanName)) return 'universal'
  return 'unknown'
}

export function classifyWindowsUpdateArtifact(name: string | undefined): UpdateArtifactArch {
  const cleanName = cleanArtifactName(name)?.toLowerCase()
  if (!cleanName) return 'unknown'
  if (/\barm64\b|[-_.]arm64[-_.]/i.test(cleanName)) return 'arm64'
  if (/\bx64\b|\bx86_64\b|[-_.](?:x64|x86_64)[-_.]/i.test(cleanName)) return 'x64'
  return 'unknown'
}

export function windowsUpdateChannelForHost(
  channel: 'stable' | 'nightly',
  arch: string = process.arch,
  stableChannel: 'latest' | 'release' = 'latest'
): string {
  const channelPrefix = channel === 'nightly' ? 'beta' : stableChannel
  return `${channelPrefix}-win-${normalizeWindowsUpdateArch(arch)}`
}

function normalizeWindowsUpdateArch(arch: string): string {
  if (arch === 'arm64') return 'arm64'
  return 'x64'
}

export function evaluateUpdateArchitectureCompatibility(
  info: UpdateInfoLike,
  host: { platform: string; arch: string }
): UpdateArchitectureCompatibility {
  const artifactName = selectedUpdateArtifact(info, host.platform)
  const artifactArch = classifyUpdateArtifact(artifactName, host.platform)
  const base: UpdateArchitectureCompatibility = {
    platform: host.platform,
    arch: host.arch,
    ...(artifactName ? { artifactName } : {}),
    artifactArch,
    compatible: true
  }

  if (host.platform === 'darwin') {
    if (host.arch !== 'x64' && host.arch !== 'arm64') return base
    if (artifactArch === 'unknown') {
      return {
        ...base,
        reason: `Unknown mac update artifact architecture: ${artifactName || 'none'}`
      }
    }
    if (artifactArch === 'universal' || artifactArch === host.arch) return base
    return {
      ...base,
      compatible: false,
      reason: `Incompatible update artifact: host=darwin-${host.arch} artifact=${artifactArch}`
    }
  }

  if (host.platform === 'win32') {
    if (host.arch !== 'x64' && host.arch !== 'arm64') return base
    if (artifactArch === 'unknown' || artifactArch === 'universal') {
      return {
        ...base,
        compatible: false,
        reason: `Unknown Windows update artifact architecture: ${artifactName || 'none'}`
      }
    }
    if (artifactArch === host.arch) return base
    return {
      ...base,
      compatible: false,
      reason: `Incompatible update artifact: host=win32-${host.arch} artifact=${artifactArch}`
    }
  }

  return base
}

function cleanArtifactName(value: string | undefined): string | undefined {
  if (!value || typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const withoutQuery = trimmed.split(/[?#]/)[0]
  return withoutQuery.split('/').filter(Boolean).pop() || withoutQuery
}
