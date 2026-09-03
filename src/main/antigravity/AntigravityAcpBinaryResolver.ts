// Official Google Antigravity ACP binary resolver.
//
// The ACP registry entry (`antigravity-acp` 1.0.0, RC01) publishes archive URLs
// on dl.google.com but NO sha256. TaskWraith therefore uses pin-on-first-install
// (TOFU): hash the downloaded ARCHIVE on the first successful install, persist
// that pin in a sidecar JSON at the userData ACP install root (NOT inside the
// extract directory), and verify every later launch against it. A mismatch
// refuses to launch and never silently re-pins. This module does not invent,
// guess, or hardcode an archive hash.
//
// No provider registration lives here — S5 wires the factory at the composition
// root. Keep this file compile-independent of the combined-mode dispatch slice.

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export const ANTIGRAVITY_ACP_REGISTRY_ID = 'antigravity-acp'
export const ANTIGRAVITY_ACP_VERSION = '1.0.0'
export const ANTIGRAVITY_ACP_BUILD_TAG = 'agy_acp_server_20260818_01_RC01'

export const ANTIGRAVITY_ACP_PIN_FILENAME = 'pin.json'
export const ANTIGRAVITY_ACP_ARCHIVE_FILENAME = 'archive.zip'
export const ANTIGRAVITY_ACP_EXTRACT_DIRNAME = 'extract'

const SHA256_HEX = /^[a-f0-9]{64}$/

export type AntigravityAcpPlatformId =
  | 'darwin-aarch64'
  | 'linux-x86_64'
  | 'linux-aarch64'
  | 'windows-x86_64'
  | 'windows-aarch64'

export interface AntigravityAcpDistribution {
  readonly platformId: AntigravityAcpPlatformId
  readonly archiveUrl: string
  readonly entryFileName: string
  readonly requiresLinuxUid: boolean
}

export interface AntigravityAcpPinRecord {
  readonly sha256: string
  readonly pinnedAt: string
  readonly archiveUrl: string
  readonly version: string
  readonly platform: AntigravityAcpPlatformId
}

export interface AntigravityAcpResolvedBinary {
  readonly binaryPath: string
  readonly args: string[]
  readonly pin: AntigravityAcpPinRecord
  readonly distribution: AntigravityAcpDistribution
}

export type AntigravityAcpResolverErrorCode =
  | 'unsupported-platform'
  | 'uid-unavailable'
  | 'pin-corrupt'
  | 'pin-absent'
  | 'pin-mismatch'
  | 'pin-platform-mismatch'
  | 'download-failed'
  | 'extract-failed'
  | 'io-failed'

export class AntigravityAcpResolverError extends Error {
  readonly code: AntigravityAcpResolverErrorCode
  readonly pinnedSha256?: string
  readonly observedSha256?: string

  constructor(
    code: AntigravityAcpResolverErrorCode,
    message: string,
    extras?: { pinnedSha256?: string; observedSha256?: string }
  ) {
    super(message)
    this.name = 'AntigravityAcpResolverError'
    this.code = code
    this.pinnedSha256 = extras?.pinnedSha256
    this.observedSha256 = extras?.observedSha256
  }
}

export interface AntigravityAcpBinaryResolverDependencies {
  /** App userData ACP install root. The pin sidecar lives directly here. */
  readonly installRoot: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly getuid?: () => number | undefined
  readonly now?: () => Date
  readonly downloadArchive: (url: string) => Promise<Buffer>
  readonly extractArchive: (archiveBytes: Buffer, destDir: string) => Promise<void>
  readonly chmodExecutable?: (filePath: string) => Promise<void>
  readonly readFile?: (filePath: string) => Promise<Buffer>
  readonly writeFile?: (filePath: string, contents: Buffer | string) => Promise<void>
  readonly mkdir?: (dirPath: string) => Promise<void>
  readonly pathExists?: (filePath: string) => Promise<boolean>
}

const DISTRIBUTION_BY_PLATFORM: Record<AntigravityAcpPlatformId, AntigravityAcpDistribution> = {
  'darwin-aarch64': {
    platformId: 'darwin-aarch64',
    archiveUrl:
      'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_20260818_01_RC01-darwin-arm64.zip',
    entryFileName: 'agy_acp_server.par',
    requiresLinuxUid: false
  },
  'linux-x86_64': {
    platformId: 'linux-x86_64',
    archiveUrl:
      'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_20260818_01_RC01-linux-x86_64.zip',
    entryFileName: 'agy_acp_server.par',
    requiresLinuxUid: true
  },
  'linux-aarch64': {
    platformId: 'linux-aarch64',
    archiveUrl:
      'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_20260818_01_RC01-linux-arm64.zip',
    entryFileName: 'agy_acp_server.par',
    requiresLinuxUid: true
  },
  'windows-x86_64': {
    platformId: 'windows-x86_64',
    archiveUrl:
      'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_20260818_01_RC01-windows-x86_64.zip',
    entryFileName: 'agy_acp_server.exe',
    requiresLinuxUid: false
  },
  'windows-aarch64': {
    platformId: 'windows-aarch64',
    archiveUrl:
      'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_20260818_01_RC01-windows-arm64.zip',
    entryFileName: 'agy_acp_server.exe',
    requiresLinuxUid: false
  }
}

export function antigravityAcpPinPath(installRoot: string): string {
  return join(installRoot, ANTIGRAVITY_ACP_PIN_FILENAME)
}

export function antigravityAcpArchivePath(installRoot: string): string {
  return join(installRoot, ANTIGRAVITY_ACP_ARCHIVE_FILENAME)
}

export function antigravityAcpExtractDir(installRoot: string): string {
  return join(installRoot, ANTIGRAVITY_ACP_EXTRACT_DIRNAME)
}

export function hashAntigravityAcpArchive(archiveBytes: Buffer): string {
  return createHash('sha256').update(archiveBytes).digest('hex')
}

export function mapAntigravityAcpPlatform(
  platform: NodeJS.Platform,
  arch: string
): AntigravityAcpPlatformId | null {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-aarch64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x86_64'
  if (platform === 'linux' && arch === 'arm64') return 'linux-aarch64'
  if (platform === 'win32' && arch === 'x64') return 'windows-x86_64'
  if (platform === 'win32' && arch === 'arm64') return 'windows-aarch64'
  return null
}

export function resolveAntigravityAcpDistribution(
  platform: NodeJS.Platform,
  arch: string
): AntigravityAcpDistribution {
  const platformId = mapAntigravityAcpPlatform(platform, arch)
  if (!platformId) {
    throw new AntigravityAcpResolverError(
      'unsupported-platform',
      `Official Antigravity ACP has no published archive for ${platform}/${arch}. The binary was not launched.`
    )
  }
  return DISTRIBUTION_BY_PLATFORM[platformId]
}

export function buildAntigravityAcpLaunchArgs(
  distribution: AntigravityAcpDistribution,
  uid: number | undefined
): string[] {
  if (!distribution.requiresLinuxUid) return []
  if (typeof uid !== 'number' || !Number.isInteger(uid) || uid < 0) {
    throw new AntigravityAcpResolverError(
      'uid-unavailable',
      'Official Antigravity ACP on Linux requires a numeric --uid= argument, and no uid was available. The binary was not launched.'
    )
  }
  return [`--uid=${uid}`]
}

export function formatAntigravityAcpPinMismatchMessage(
  pinnedSha256: string,
  observedSha256: string
): string {
  return [
    'The official Antigravity ACP archive does not match the hash pinned on first install.',
    `Pinned sha256: ${pinnedSha256}.`,
    `Observed sha256: ${observedSha256}.`,
    'The binary was not launched and the pin was not updated.'
  ].join(' ')
}

export function parseAntigravityAcpPin(raw: string): AntigravityAcpPinRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AntigravityAcpResolverError(
      'pin-corrupt',
      'The Antigravity ACP pin sidecar is not valid JSON. The binary was not launched and the pin was not updated.'
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AntigravityAcpResolverError(
      'pin-corrupt',
      'The Antigravity ACP pin sidecar is not a JSON object. The binary was not launched and the pin was not updated.'
    )
  }
  const record = parsed as Record<string, unknown>
  const sha256 = typeof record.sha256 === 'string' ? record.sha256.trim().toLowerCase() : ''
  const pinnedAt = typeof record.pinnedAt === 'string' ? record.pinnedAt.trim() : ''
  const archiveUrl = typeof record.archiveUrl === 'string' ? record.archiveUrl.trim() : ''
  const version = typeof record.version === 'string' ? record.version.trim() : ''
  const platform = typeof record.platform === 'string' ? record.platform.trim() : ''
  if (!SHA256_HEX.test(sha256) || !pinnedAt || !archiveUrl || !version) {
    throw new AntigravityAcpResolverError(
      'pin-corrupt',
      'The Antigravity ACP pin sidecar is missing required fields. The binary was not launched and the pin was not updated.'
    )
  }
  if (!(platform in DISTRIBUTION_BY_PLATFORM)) {
    throw new AntigravityAcpResolverError(
      'pin-corrupt',
      'The Antigravity ACP pin sidecar names an unknown platform. The binary was not launched and the pin was not updated.'
    )
  }
  return {
    sha256,
    pinnedAt,
    archiveUrl,
    version,
    platform: platform as AntigravityAcpPlatformId
  }
}

async function defaultPathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function defaultChmodExecutable(filePath: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') return
  await fs.chmod(filePath, 0o755)
}

function io(deps: AntigravityAcpBinaryResolverDependencies) {
  return {
    readFile: deps.readFile ?? ((filePath: string) => fs.readFile(filePath)),
    writeFile:
      deps.writeFile ??
      ((filePath: string, contents: Buffer | string) => fs.writeFile(filePath, contents)),
    mkdir:
      deps.mkdir ??
      (async (dirPath: string) => {
        await fs.mkdir(dirPath, { recursive: true })
      }),
    pathExists: deps.pathExists ?? defaultPathExists,
    chmodExecutable:
      deps.chmodExecutable ??
      ((filePath: string) => defaultChmodExecutable(filePath, deps.platform ?? process.platform))
  }
}

export async function readAntigravityAcpPin(
  deps: Pick<AntigravityAcpBinaryResolverDependencies, 'installRoot' | 'readFile' | 'pathExists'>
): Promise<AntigravityAcpPinRecord | null> {
  const pinPath = antigravityAcpPinPath(deps.installRoot)
  const exists = await (deps.pathExists ?? defaultPathExists)(pinPath)
  if (!exists) return null
  const bytes = await (deps.readFile ?? ((filePath: string) => fs.readFile(filePath)))(pinPath)
  return parseAntigravityAcpPin(bytes.toString('utf8'))
}

async function downloadOrFail(
  deps: AntigravityAcpBinaryResolverDependencies,
  url: string
): Promise<Buffer> {
  try {
    const bytes = await deps.downloadArchive(url)
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new Error('empty archive')
    }
    return bytes
  } catch (error) {
    if (error instanceof AntigravityAcpResolverError) throw error
    throw new AntigravityAcpResolverError(
      'download-failed',
      'The official Antigravity ACP archive could not be downloaded. The binary was not launched and the pin was not updated.'
    )
  }
}

export async function resolveAntigravityAcpBinary(
  deps: AntigravityAcpBinaryResolverDependencies
): Promise<AntigravityAcpResolvedBinary> {
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const distribution = resolveAntigravityAcpDistribution(platform, arch)
  const args = buildAntigravityAcpLaunchArgs(
    distribution,
    deps.getuid ? deps.getuid() : process.getuid?.()
  )
  const files = io(deps)
  const pinPath = antigravityAcpPinPath(deps.installRoot)
  const archivePath = antigravityAcpArchivePath(deps.installRoot)
  const extractDir = antigravityAcpExtractDir(deps.installRoot)
  const binaryPath = join(extractDir, distribution.entryFileName)

  const pinExists = await files.pathExists(pinPath)
  const archiveExists = await files.pathExists(archivePath)
  const extractExists = await files.pathExists(extractDir)

  let pin: AntigravityAcpPinRecord | null = null
  if (pinExists) {
    const raw = await files.readFile(pinPath)
    pin = parseAntigravityAcpPin(raw.toString('utf8'))
    if (pin.platform !== distribution.platformId) {
      throw new AntigravityAcpResolverError(
        'pin-platform-mismatch',
        `The Antigravity ACP pin was recorded for ${pin.platform}, but this host is ${distribution.platformId}. The binary was not launched and the pin was not updated.`
      )
    }
  } else if (archiveExists || extractExists) {
    throw new AntigravityAcpResolverError(
      'pin-absent',
      'The Antigravity ACP install root has archive or extract artifacts but no pin sidecar. The binary was not launched and a new pin was not recorded.'
    )
  }

  let archiveBytes: Buffer
  if (archiveExists) {
    archiveBytes = await files.readFile(archivePath)
    if (archiveBytes.length === 0) {
      throw new AntigravityAcpResolverError(
        'io-failed',
        'The cached Antigravity ACP archive is empty. The binary was not launched and the pin was not updated.'
      )
    }
  } else {
    archiveBytes = await downloadOrFail(deps, distribution.archiveUrl)
  }

  const observedSha256 = hashAntigravityAcpArchive(archiveBytes)

  if (pin) {
    if (observedSha256 !== pin.sha256) {
      throw new AntigravityAcpResolverError(
        'pin-mismatch',
        formatAntigravityAcpPinMismatchMessage(pin.sha256, observedSha256),
        { pinnedSha256: pin.sha256, observedSha256 }
      )
    }
  } else {
    pin = {
      sha256: observedSha256,
      pinnedAt: (deps.now ?? ((): Date => new Date()))().toISOString(),
      archiveUrl: distribution.archiveUrl,
      version: ANTIGRAVITY_ACP_VERSION,
      platform: distribution.platformId
    }
    try {
      await files.mkdir(deps.installRoot)
      await files.writeFile(pinPath, `${JSON.stringify(pin, null, 2)}\n`)
    } catch (error) {
      if (error instanceof AntigravityAcpResolverError) throw error
      throw new AntigravityAcpResolverError(
        'io-failed',
        'The Antigravity ACP pin sidecar could not be written. The binary was not launched.'
      )
    }
  }

  try {
    await files.mkdir(deps.installRoot)
    if (!archiveExists) {
      await files.writeFile(archivePath, archiveBytes)
    }
    await files.mkdir(extractDir)
    await deps.extractArchive(archiveBytes, extractDir)
    await files.chmodExecutable(binaryPath)
  } catch (error) {
    if (error instanceof AntigravityAcpResolverError) throw error
    throw new AntigravityAcpResolverError(
      'extract-failed',
      'The official Antigravity ACP archive could not be extracted. The binary was not launched.'
    )
  }

  const entryExists = await files.pathExists(binaryPath)
  if (!entryExists) {
    throw new AntigravityAcpResolverError(
      'extract-failed',
      `The official Antigravity ACP archive did not contain ${distribution.entryFileName}. The binary was not launched.`
    )
  }

  return { binaryPath, args, pin, distribution }
}

export function createAntigravityAcpBinaryResolver(
  deps: AntigravityAcpBinaryResolverDependencies
): {
  resolve: () => Promise<AntigravityAcpResolvedBinary>
  readPin: () => Promise<AntigravityAcpPinRecord | null>
} {
  return {
    resolve: () => resolveAntigravityAcpBinary(deps),
    readPin: () => readAntigravityAcpPin(deps)
  }
}
