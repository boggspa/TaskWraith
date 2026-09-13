// Production implementations for the official Antigravity ACP install transport.
//
// Frozen S5 factories consumed by composition-root wiring:
//   createAntigravityAcpDownloadArchive
//   createAntigravityAcpExtractArchive
//   createAntigravityAcpSpawnProcess
//
// Binding user rulings: never invent/hardcode a sha256 (pin-on-first-install lives in
// the resolver); extract by shelling out to system tools with an argv array and no
// shell; do not add an npm zip dependency.
//
// ZIP-SLIP: the committed resolver joins a hardcoded basename onto extractDir and
// checks pathExists — it does NOT realpath or walk the extract tree. Containment is
// enforced here: refuse zip members that escape destDir, then after extract realpath
// every extracted path and refuse if any escapes.

import { execFile as execFileCallback, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir as osTmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { AcpChildProcess } from './AntigravityAcpClient'

export type { AcpChildProcess }

export const ANTIGRAVITY_ACP_DOWNLOAD_TIMEOUT_MS = 60_000
export const ANTIGRAVITY_ACP_EXTRACT_TIMEOUT_MS = 120_000
export const ANTIGRAVITY_ACP_ARCHIVE_ENV = 'TASKWRAITH_ANTIGRAVITY_ACP_ARCHIVE'
export const ANTIGRAVITY_ACP_DEST_ENV = 'TASKWRAITH_ANTIGRAVITY_ACP_DEST'

/** Constant PowerShell command — paths travel through env, never string interpolation. */
export const ANTIGRAVITY_ACP_WINDOWS_EXPAND_COMMAND =
  'Expand-Archive -LiteralPath $env:TASKWRAITH_ANTIGRAVITY_ACP_ARCHIVE -DestinationPath $env:TASKWRAITH_ANTIGRAVITY_ACP_DEST -Force'

export const ANTIGRAVITY_ACP_EXTRACT_ENTRY_FILES = [
  'agy_acp_server.par',
  'agy_acp_server.exe'
] as const

const MAX_ZIP_ENTRIES = 4_096
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const promisifiedExecFile = promisify(execFileCallback)

export type AntigravityAcpInstallTransportErrorCode =
  | 'download-failed'
  | 'timeout'
  | 'extract-failed'
  | 'tool-missing'
  | 'zip-slip'
  | 'spawn-failed'

export class AntigravityAcpInstallTransportError extends Error {
  readonly code: AntigravityAcpInstallTransportErrorCode

  constructor(code: AntigravityAcpInstallTransportErrorCode, message: string) {
    super(message)
    this.name = 'AntigravityAcpInstallTransportError'
    this.code = code
  }
}

export interface AntigravityAcpExtractInvocation {
  readonly file: string
  readonly args: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}

export interface AntigravityAcpDownloadArchiveDependencies {
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

export type AntigravityAcpExecFile = (
  file: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv
    timeout?: number
    maxBuffer?: number
    windowsHide?: boolean
  }
) => Promise<unknown>

export interface AntigravityAcpExtractArchiveDependencies {
  readonly platform?: NodeJS.Platform
  readonly execFile?: AntigravityAcpExecFile
  readonly mkdtemp?: (prefix: string) => Promise<string>
  readonly tmpdir?: () => string
  readonly writeFile?: (filePath: string, contents: Buffer) => Promise<void>
  readonly mkdir?: (dirPath: string) => Promise<void>
  readonly rm?: (dirPath: string) => Promise<void>
  readonly realpath?: (filePath: string) => Promise<string>
  readonly readdir?: (dirPath: string) => Promise<string[]>
  readonly pathExists?: (filePath: string) => Promise<boolean>
  readonly extractTimeoutMs?: number
}

export interface AntigravityAcpSpawnProcessDependencies {
  readonly spawn?: typeof spawn
}

export function isAntigravityAcpPathInside(rootDir: string, candidate: string): boolean {
  const root = resolve(rootDir)
  const target = resolve(candidate)
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minOffset = Math.max(0, archive.length - 22 - 65_535)
  for (let cursor = archive.length - 22; cursor >= minOffset; cursor -= 1) {
    if (archive.readUInt32LE(cursor) === EOCD_SIGNATURE) return cursor
  }
  throw new AntigravityAcpInstallTransportError(
    'extract-failed',
    'The official Antigravity ACP archive is not a valid ZIP. The binary was not launched.'
  )
}

export function listAntigravityAcpZipEntryNames(archive: Buffer): string[] {
  if (!Buffer.isBuffer(archive) || archive.length < 22) {
    throw new AntigravityAcpInstallTransportError(
      'extract-failed',
      'The official Antigravity ACP archive is not a valid ZIP. The binary was not launched.'
    )
  }
  const eocdOffset = findEndOfCentralDirectory(archive)
  const entryCount = archive.readUInt16LE(eocdOffset + 10)
  const centralOffset = archive.readUInt32LE(eocdOffset + 16)
  if (centralOffset === 0xffffffff || entryCount === 0xffff) {
    throw new AntigravityAcpInstallTransportError(
      'extract-failed',
      'The official Antigravity ACP archive uses ZIP64, which is not supported. The binary was not launched.'
    )
  }
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new AntigravityAcpInstallTransportError(
      'extract-failed',
      'The official Antigravity ACP archive has too many ZIP entries. The binary was not launched.'
    )
  }
  const names: string[] = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new AntigravityAcpInstallTransportError(
        'extract-failed',
        'The official Antigravity ACP archive is not a valid ZIP. The binary was not launched.'
      )
    }
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    names.push(archive.toString('utf8', cursor + 46, cursor + 46 + nameLength))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return names
}

function zipEntryEscapesDest(name: string, destDir: string): boolean {
  if (name.includes('\0')) return true
  const unified = name.replace(/\\/g, '/')
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) return true
  if (unified.split('/').some((segment) => segment === '..')) return true
  return !isAntigravityAcpPathInside(destDir, resolve(destDir, name))
}

export function assertAntigravityAcpZipEntriesSafe(
  names: readonly string[],
  destDir: string
): void {
  for (const name of names) {
    if (zipEntryEscapesDest(name, destDir)) {
      throw new AntigravityAcpInstallTransportError(
        'zip-slip',
        'The official Antigravity ACP archive contains a path that escapes the extract directory. The binary was not launched.'
      )
    }
  }
}

export function buildAntigravityAcpExtractInvocation(
  platform: NodeJS.Platform,
  archivePath: string,
  destDir: string,
  parentEnv: NodeJS.ProcessEnv = process.env
): AntigravityAcpExtractInvocation {
  if (platform === 'darwin') {
    return { file: 'ditto', args: ['-x', '-k', archivePath, destDir] }
  }
  if (platform === 'linux') {
    return { file: 'unzip', args: ['-o', archivePath, '-d', destDir] }
  }
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', ANTIGRAVITY_ACP_WINDOWS_EXPAND_COMMAND],
      env: {
        ...parentEnv,
        [ANTIGRAVITY_ACP_ARCHIVE_ENV]: archivePath,
        [ANTIGRAVITY_ACP_DEST_ENV]: destDir
      }
    }
  }
  throw new AntigravityAcpInstallTransportError(
    'extract-failed',
    `The official Antigravity ACP archive cannot be extracted on ${platform}: no system unzip tool is configured. The binary was not launched.`
  )
}

async function defaultPathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function defaultExecFile(
  file: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv
    timeout?: number
    maxBuffer?: number
    windowsHide?: boolean
  }
): Promise<void> {
  await promisifiedExecFile(file, [...args], {
    env: options.env,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
    windowsHide: true
  })
}

function wrapExecFileError(error: unknown, tool: string): AntigravityAcpInstallTransportError {
  if (error instanceof AntigravityAcpInstallTransportError) return error
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
  if (code === 'ENOENT') {
    return new AntigravityAcpInstallTransportError(
      'tool-missing',
      `The official Antigravity ACP archive could not be extracted because ${tool} was not found. The binary was not launched.`
    )
  }
  return new AntigravityAcpInstallTransportError(
    'extract-failed',
    'The official Antigravity ACP archive could not be extracted. The binary was not launched.'
  )
}

async function assertExtractedTreeContained(
  destDir: string,
  files: {
    realpath: (filePath: string) => Promise<string>
    readdir: (dirPath: string) => Promise<string[]>
    pathExists: (filePath: string) => Promise<boolean>
  }
): Promise<void> {
  let rootReal: string
  try {
    rootReal = await files.realpath(destDir)
  } catch {
    throw new AntigravityAcpInstallTransportError(
      'extract-failed',
      'The official Antigravity ACP extract directory could not be resolved. The binary was not launched.'
    )
  }

  const relatives = await files.readdir(destDir)
  for (const rel of relatives) {
    const full = join(destDir, rel)
    let resolved: string
    try {
      resolved = await files.realpath(full)
    } catch {
      throw new AntigravityAcpInstallTransportError(
        'zip-slip',
        'The official Antigravity ACP archive contains a path that escapes the extract directory. The binary was not launched.'
      )
    }
    if (!isAntigravityAcpPathInside(rootReal, resolved)) {
      throw new AntigravityAcpInstallTransportError(
        'zip-slip',
        'The official Antigravity ACP archive contains a path that escapes the extract directory. The binary was not launched.'
      )
    }
  }

  for (const entryName of ANTIGRAVITY_ACP_EXTRACT_ENTRY_FILES) {
    const candidate = join(destDir, entryName)
    if (!(await files.pathExists(candidate))) continue
    let resolved: string
    try {
      resolved = await files.realpath(candidate)
    } catch {
      throw new AntigravityAcpInstallTransportError(
        'zip-slip',
        'The official Antigravity ACP archive contains a path that escapes the extract directory. The binary was not launched.'
      )
    }
    if (!isAntigravityAcpPathInside(rootReal, resolved)) {
      throw new AntigravityAcpInstallTransportError(
        'zip-slip',
        'The official Antigravity ACP archive contains a path that escapes the extract directory. The binary was not launched.'
      )
    }
  }
}

export function createAntigravityAcpDownloadArchive(
  deps: AntigravityAcpDownloadArchiveDependencies = {}
): (url: string) => Promise<Buffer> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? ANTIGRAVITY_ACP_DOWNLOAD_TIMEOUT_MS
  return async (url: string): Promise<Buffer> => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new AntigravityAcpInstallTransportError(
        'download-failed',
        'The official Antigravity ACP archive URL is invalid. The binary was not launched.'
      )
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new AntigravityAcpInstallTransportError(
        'download-failed',
        'The official Antigravity ACP archive URL is invalid. The binary was not launched.'
      )
    }
    let response: Response
    try {
      response = await fetchImpl(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new AntigravityAcpInstallTransportError(
          'timeout',
          'The official Antigravity ACP archive download timed out. The binary was not launched.'
        )
      }
      throw new AntigravityAcpInstallTransportError(
        'download-failed',
        'The official Antigravity ACP archive could not be downloaded. The binary was not launched.'
      )
    }
    if (!response.ok) {
      throw new AntigravityAcpInstallTransportError(
        'download-failed',
        `The official Antigravity ACP archive download failed with HTTP ${response.status}. The binary was not launched.`
      )
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0) {
      throw new AntigravityAcpInstallTransportError(
        'download-failed',
        'The official Antigravity ACP archive download was empty. The binary was not launched.'
      )
    }
    return bytes
  }
}

export function createAntigravityAcpExtractArchive(
  deps: AntigravityAcpExtractArchiveDependencies = {}
): (archiveBytes: Buffer, destDir: string) => Promise<void> {
  const platform = deps.platform ?? process.platform
  const execFile = deps.execFile ?? defaultExecFile
  const mkdtemp = deps.mkdtemp ?? ((prefix: string) => fs.mkdtemp(prefix))
  const tmpdir = deps.tmpdir ?? osTmpdir
  const writeFile =
    deps.writeFile ?? ((filePath: string, contents: Buffer) => fs.writeFile(filePath, contents))
  const mkdir =
    deps.mkdir ??
    (async (dirPath: string) => {
      await fs.mkdir(dirPath, { recursive: true })
    })
  const rm =
    deps.rm ??
    (async (dirPath: string) => {
      await fs.rm(dirPath, { recursive: true, force: true })
    })
  const realpath = deps.realpath ?? ((filePath: string) => fs.realpath(filePath))
  const readdir =
    deps.readdir ??
    ((dirPath: string) => fs.readdir(dirPath, { recursive: true }) as Promise<string[]>)
  const pathExists = deps.pathExists ?? defaultPathExists
  const extractTimeoutMs = deps.extractTimeoutMs ?? ANTIGRAVITY_ACP_EXTRACT_TIMEOUT_MS

  return async (archiveBytes: Buffer, destDir: string): Promise<void> => {
    const names = listAntigravityAcpZipEntryNames(archiveBytes)
    assertAntigravityAcpZipEntriesSafe(names, destDir)

    let tempDir: string | undefined
    try {
      tempDir = await mkdtemp(join(tmpdir(), 'tw-agy-acp-zip-'))
      const archivePath = join(tempDir, 'archive.zip')
      await writeFile(archivePath, archiveBytes)
      await mkdir(destDir)
      const launched = buildAntigravityAcpExtractInvocation(platform, archivePath, destDir)
      try {
        await execFile(launched.file, launched.args, {
          env: launched.env,
          timeout: extractTimeoutMs,
          windowsHide: true
        })
      } catch (error) {
        throw wrapExecFileError(error, launched.file)
      }
      await assertExtractedTreeContained(destDir, { realpath, readdir, pathExists })
    } finally {
      if (tempDir) {
        try {
          await rm(tempDir)
        } catch {
          // Best-effort temp cleanup must not hide the extract result.
        }
      }
    }
  }
}

export function createAntigravityAcpSpawnProcess(
  binaryPath: string,
  args: readonly string[],
  deps: AntigravityAcpSpawnProcessDependencies = {}
): () => AcpChildProcess {
  const trimmed = typeof binaryPath === 'string' ? binaryPath.trim() : ''
  if (!trimmed) {
    throw new AntigravityAcpInstallTransportError(
      'spawn-failed',
      'The official Antigravity ACP server path is empty. The binary was not launched.'
    )
  }
  const argv = [...args]
  const spawnImpl = deps.spawn ?? spawn
  return () => {
    const child = spawnImpl(trimmed, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    })
    return child as unknown as AcpChildProcess
  }
}
