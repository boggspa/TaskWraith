import { createHash } from 'crypto'
import { execFile as nodeExecFile, type ExecFileException, type ExecFileOptions } from 'child_process'
import { promises as fs } from 'fs'
import * as fsSync from 'fs'
import type { FileHandle } from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { inflateSync } from 'zlib'

export const PDF_ATTACHMENT_EXT = /\.pdf(?:[?#].*)?$/i
export const PDF_ATTACHMENT_RENDER_MAX_PAGES = 4
export const PDF_ATTACHMENT_RENDER_MAX_BYTES = 80 * 1024 * 1024
export const PDF_ATTACHMENT_RENDER_MAX_EDGE = 1600
export const PDF_ATTACHMENT_RENDER_MAX_OUTPUT_BYTES = 12 * 1024 * 1024
export const PDF_ATTACHMENT_RENDER_TIMEOUT_MS = 20_000

export interface PdfAttachmentLike {
  id?: string
  path?: string
  name?: string
}

export interface PdfRenderedPageAttachment {
  id: string
  path: string
  name: string
  sourcePdfPath: string
  pageIndex: number
}

export interface PdfAttachmentRenderSkipped {
  path: string
  name: string
  reason: string
}

export interface PdfAttachmentRenderResult {
  rendered: PdfRenderedPageAttachment[]
  skipped: PdfAttachmentRenderSkipped[]
}

type ExecFileLike = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void
) => unknown

export interface PdfAttachmentRenderOptions {
  cacheDir: string
  maxPages?: number
  maxPdfBytes?: number
  maxEdge?: number
  maxOutputBytes?: number
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  execFile?: ExecFileLike
  pdftoppmPath?: string | null
  sipsPath?: string | null
}

type RenderConfig = {
  cacheDir: string
  maxPages: number
  maxPdfBytes: number
  maxEdge: number
  maxOutputBytes: number
  timeoutMs: number
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  execFile: ExecFileLike
  pdftoppmPath?: string | null
  sipsPath?: string | null
}

const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex')
const PDF_RENDER_CACHE_FORMAT = 2
const PDF_RENDER_CACHE_MANIFEST = 'render-manifest.json'
const PDF_RENDER_CACHE_MANIFEST_MAX_BYTES = 16 * 1024
const PDF_COPY_BUFFER_BYTES = 1024 * 1024

type StablePdfSource = {
  realPath: string
  handle: FileHandle
  stat: fsSync.BigIntStats
  digest: string
}

type PdfRenderCacheManifest = {
  version: number
  sourceSha256: string
  maxPages: number
  maxEdge: number
  pages: string[]
}

const inFlightCacheRenders = new Map<string, Promise<string[]>>()

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

export function isPdfAttachmentPath(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false
  try {
    const candidate = trimmed.startsWith('file://') ? fileURLToPath(trimmed) : trimmed
    return PDF_ATTACHMENT_EXT.test(candidate)
  } catch {
    return PDF_ATTACHMENT_EXT.test(trimmed)
  }
}

function renderConfig(options: PdfAttachmentRenderOptions): RenderConfig {
  return {
    cacheDir: options.cacheDir,
    maxPages: Math.max(1, Math.min(12, Math.trunc(options.maxPages ?? PDF_ATTACHMENT_RENDER_MAX_PAGES))),
    maxPdfBytes: Math.max(1, options.maxPdfBytes ?? PDF_ATTACHMENT_RENDER_MAX_BYTES),
    maxEdge: Math.max(256, Math.min(4096, Math.trunc(options.maxEdge ?? PDF_ATTACHMENT_RENDER_MAX_EDGE))),
    maxOutputBytes: Math.max(1, options.maxOutputBytes ?? PDF_ATTACHMENT_RENDER_MAX_OUTPUT_BYTES),
    timeoutMs: Math.max(1000, options.timeoutMs ?? PDF_ATTACHMENT_RENDER_TIMEOUT_MS),
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
    execFile: options.execFile ?? (nodeExecFile as ExecFileLike),
    pdftoppmPath: options.pdftoppmPath,
    sipsPath: options.sipsPath
  }
}

function attachmentPath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string') return null
  const trimmed = rawPath.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed)
    } catch {
      return null
    }
  }
  return path.isAbsolute(trimmed) ? trimmed : null
}

function attachmentDisplayName(attachment: PdfAttachmentLike, filePath: string): string {
  const name = typeof attachment.name === 'string' ? attachment.name.trim() : ''
  return name || path.basename(filePath) || 'document.pdf'
}

function pageName(pdfName: string, pageIndex: number): string {
  return `${pdfName} page ${pageIndex}.png`
}

function hashKey(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function renderCacheKey(sourceDigest: string, config: RenderConfig): string {
  return hashKey(
    [
      `pdf-render-cache-v${PDF_RENDER_CACHE_FORMAT}`,
      sourceDigest,
      String(config.maxPages),
      String(config.maxEdge)
    ].join('\0')
  )
}

function sameFileSnapshot(left: fsSync.BigIntStats, right: fsSync.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

async function assertStablePdfSource(source: StablePdfSource): Promise<void> {
  const descriptorStat = await source.handle.stat({ bigint: true })
  const pathStat = await fs.lstat(source.realPath, { bigint: true })
  if (
    !descriptorStat.isFile() ||
    !pathStat.isFile() ||
    !sameFileSnapshot(source.stat, descriptorStat) ||
    !sameFileSnapshot(source.stat, pathStat)
  ) {
    throw new Error('PDF source changed while it was being read')
  }
}

async function hashPdfSource(handle: FileHandle, size: number): Promise<string> {
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(PDF_COPY_BUFFER_BYTES, Math.max(1, size)))
  let position = 0
  while (position < size) {
    const requested = Math.min(buffer.length, size - position)
    const { bytesRead } = await handle.read(buffer, 0, requested, position)
    if (bytesRead <= 0) throw new Error('PDF source ended before its recorded size')
    digest.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return digest.digest('hex')
}

async function openStablePdfSource(
  realPath: string,
  maxPdfBytes: number
): Promise<
  | { source: StablePdfSource }
  | { reason: 'missing' | 'not_file' | 'too_large' | 'changed_during_read' }
> {
  const noFollow = fsSync.constants.O_NOFOLLOW ?? 0
  let handle: FileHandle
  try {
    handle = await fs.open(realPath, fsSync.constants.O_RDONLY | noFollow)
  } catch {
    return { reason: 'missing' }
  }

  let transferred = false
  try {
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile()) return { reason: 'not_file' }
    if (stat.size <= 0n || stat.size > BigInt(maxPdfBytes)) return { reason: 'too_large' }
    const pathStat = await fs.lstat(realPath, { bigint: true })
    if (!pathStat.isFile() || !sameFileSnapshot(stat, pathStat)) {
      return { reason: 'changed_during_read' }
    }
    const source: StablePdfSource = {
      realPath,
      handle,
      stat,
      digest: await hashPdfSource(handle, Number(stat.size))
    }
    await assertStablePdfSource(source)
    transferred = true
    return { source }
  } catch {
    return { reason: 'changed_during_read' }
  } finally {
    if (!transferred) await handle.close().catch(() => undefined)
  }
}

function executableFromPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = env.PATH || ''
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK)
      return candidate
    } catch {
      // Try the next PATH entry.
    }
  }
  return null
}

function candidateExecutable(
  explicit: string | null | undefined,
  name: string,
  candidates: string[],
  env: NodeJS.ProcessEnv
): string | null {
  if (explicit === null) return null
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  for (const candidate of candidates) {
    try {
      fsSync.accessSync(candidate, fsSync.constants.X_OK)
      return candidate
    } catch {
      // Try the next well-known location.
    }
  }
  return executableFromPath(name, env)
}

function pdftoppmPath(config: RenderConfig): string | null {
  return candidateExecutable(
    config.pdftoppmPath,
    'pdftoppm',
    ['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm', '/usr/bin/pdftoppm'],
    config.env
  )
}

function sipsPath(config: RenderConfig): string | null {
  if (config.platform !== 'darwin') return null
  return candidateExecutable(config.sipsPath, 'sips', ['/usr/bin/sips'], config.env)
}

function execFilePromise(
  execFile: ExecFileLike,
  file: string,
  args: string[],
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '')
          reject(new Error(detail.trim() || error.message))
          return
        }
        resolve()
      }
    )
  })
}

function pngCrc32(buffer: Buffer, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function isStructurallyValidPng(buffer: Buffer, maxEdge: number): boolean {
  if (buffer.length < PNG_MAGIC.length + 12 || !buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return false
  }

  let offset = PNG_MAGIC.length
  let chunkIndex = 0
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let sawIdat = false
  let idatEnded = false
  let sawIend = false
  let sawPalette = false
  const idatChunks: Buffer[] = []

  while (offset < buffer.length) {
    if (buffer.length - offset < 12) return false
    const length = buffer.readUInt32BE(offset)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const chunkEnd = dataEnd + 4
    if (dataEnd < dataStart || chunkEnd > buffer.length) return false

    const typeBuffer = buffer.subarray(offset + 4, offset + 8)
    const type = typeBuffer.toString('ascii')
    if (!/^[A-Za-z]{4}$/.test(type)) return false
    if (pngCrc32(buffer, offset + 4, dataEnd) !== buffer.readUInt32BE(dataEnd)) return false

    if (chunkIndex === 0 && type !== 'IHDR') return false
    if (type === 'IHDR') {
      if (chunkIndex !== 0 || length !== 13) return false
      width = buffer.readUInt32BE(dataStart)
      height = buffer.readUInt32BE(dataStart + 4)
      bitDepth = buffer[dataStart + 8]
      colorType = buffer[dataStart + 9]
      const compression = buffer[dataStart + 10]
      const filter = buffer[dataStart + 11]
      const interlace = buffer[dataStart + 12]
      const validDepth =
        (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
        (colorType === 2 && [8, 16].includes(bitDepth)) ||
        (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
        (colorType === 4 && [8, 16].includes(bitDepth)) ||
        (colorType === 6 && [8, 16].includes(bitDepth))
      if (
        width <= 0 ||
        height <= 0 ||
        width > maxEdge ||
        height > maxEdge ||
        !validDepth ||
        compression !== 0 ||
        filter !== 0 ||
        interlace !== 0
      ) {
        return false
      }
    } else if (type === 'PLTE') {
      if (sawIdat || sawPalette || length === 0 || length % 3 !== 0 || length > 768) return false
      sawPalette = true
    } else if (type === 'IDAT') {
      if (idatEnded || length === 0) return false
      sawIdat = true
      idatChunks.push(buffer.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      if (!sawIdat || length !== 0 || chunkEnd !== buffer.length) return false
      sawIend = true
    } else if (sawIdat) {
      idatEnded = true
    }

    offset = chunkEnd
    chunkIndex += 1
    if (sawIend) break
  }

  if (!sawIend || offset !== buffer.length || (colorType === 3 && !sawPalette)) return false
  const channels = colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8)
  const expectedInflatedBytes = height * (rowBytes + 1)
  if (!Number.isSafeInteger(expectedInflatedBytes) || expectedInflatedBytes <= 0) return false
  try {
    const pixels = inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expectedInflatedBytes })
    if (pixels.length !== expectedInflatedBytes) return false
    for (let row = 0; row < height; row += 1) {
      if (pixels[row * (rowBytes + 1)] > 4) return false
    }
  } catch {
    return false
  }
  return true
}

async function isPngFile(filePath: string, maxBytes: number, maxEdge: number): Promise<boolean> {
  try {
    const noFollow = fsSync.constants.O_NOFOLLOW ?? 0
    const handle = await fs.open(filePath, fsSync.constants.O_RDONLY | noFollow)
    let stat: fsSync.BigIntStats
    let bytes: Buffer
    try {
      stat = await handle.stat({ bigint: true })
      if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(maxBytes)) return false
      bytes = await handle.readFile()
      const finalStat = await handle.stat({ bigint: true })
      const pathStat = await fs.lstat(filePath, { bigint: true })
      if (!sameFileSnapshot(stat, finalStat) || !sameFileSnapshot(stat, pathStat)) return false
    } finally {
      await handle.close()
    }
    return bytes.length === Number(stat.size) && isStructurallyValidPng(bytes, maxEdge)
  } catch {
    return false
  }
}

function pageNumberFromPath(filePath: string): number {
  const base = path.basename(filePath)
  const match = /-(\d+)\.png$/i.exec(base) || /page-(\d+)\.png$/i.exec(base)
  return match ? Number(match[1]) : 1
}

async function collectRenderedPngs(dir: string, config: RenderConfig): Promise<string[]> {
  let entries: fsSync.Dirent[] = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  if (
    entries.length === 0 ||
    entries.length > config.maxPages ||
    entries.some((entry) => !entry.isFile() || !entry.name.toLowerCase().endsWith('.png'))
  ) {
    return []
  }
  const paths = entries
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => pageNumberFromPath(a) - pageNumberFromPath(b) || a.localeCompare(b))
  const valid: string[] = []
  for (const filePath of paths) {
    if (!(await isPngFile(filePath, config.maxOutputBytes, config.maxEdge))) return []
    valid.push(filePath)
  }
  return valid
}

function expectedCacheManifest(
  sourceDigest: string,
  config: RenderConfig,
  pages: string[]
): PdfRenderCacheManifest {
  return {
    version: PDF_RENDER_CACHE_FORMAT,
    sourceSha256: sourceDigest,
    maxPages: config.maxPages,
    maxEdge: config.maxEdge,
    pages: pages.map((pagePath) => path.basename(pagePath))
  }
}

function isSafePageBasename(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    value === path.basename(value) &&
    value.toLowerCase().endsWith('.png')
  )
}

async function readCacheManifest(dir: string): Promise<PdfRenderCacheManifest | null> {
  const manifestPath = path.join(dir, PDF_RENDER_CACHE_MANIFEST)
  try {
    const noFollow = fsSync.constants.O_NOFOLLOW ?? 0
    const handle = await fs.open(manifestPath, fsSync.constants.O_RDONLY | noFollow)
    try {
      const stat = await handle.stat({ bigint: true })
      if (
        !stat.isFile() ||
        stat.size <= 0n ||
        stat.size > BigInt(PDF_RENDER_CACHE_MANIFEST_MAX_BYTES)
      ) {
        return null
      }
      const raw = await handle.readFile({ encoding: 'utf8' })
      const parsed = JSON.parse(raw) as Partial<PdfRenderCacheManifest>
      if (
        parsed.version !== PDF_RENDER_CACHE_FORMAT ||
        typeof parsed.sourceSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(parsed.sourceSha256) ||
        !Number.isInteger(parsed.maxPages) ||
        !Number.isInteger(parsed.maxEdge) ||
        !Array.isArray(parsed.pages) ||
        parsed.pages.length === 0 ||
        parsed.pages.some((page) => !isSafePageBasename(page)) ||
        new Set(parsed.pages).size !== parsed.pages.length
      ) {
        return null
      }
      return parsed as PdfRenderCacheManifest
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

async function collectPublishedPngs(
  dir: string,
  sourceDigest: string,
  config: RenderConfig
): Promise<string[]> {
  const manifest = await readCacheManifest(dir)
  if (
    !manifest ||
    manifest.sourceSha256 !== sourceDigest ||
    manifest.maxPages !== config.maxPages ||
    manifest.maxEdge !== config.maxEdge ||
    manifest.pages.length > config.maxPages
  ) {
    return []
  }

  let entries: fsSync.Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const expectedNames = new Set([PDF_RENDER_CACHE_MANIFEST, ...manifest.pages])
  if (
    entries.length !== expectedNames.size ||
    entries.some((entry) => !entry.isFile() || !expectedNames.has(entry.name))
  ) {
    return []
  }

  const pages = manifest.pages.map((name) => path.join(dir, name))
  for (const pagePath of pages) {
    if (!(await isPngFile(pagePath, config.maxOutputBytes, config.maxEdge))) return []
  }
  return pages
}

async function renderWithPoppler(realPath: string, outDir: string, config: RenderConfig): Promise<string[]> {
  const tool = pdftoppmPath(config)
  if (!tool) return []
  await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined)
  await fs.mkdir(outDir, { recursive: true })
  const prefix = path.join(outDir, 'page')
  await execFilePromise(
    config.execFile,
    tool,
    [
      '-png',
      '-f',
      '1',
      '-l',
      String(config.maxPages),
      '-scale-to',
      String(config.maxEdge),
      realPath,
      prefix
    ],
    config.timeoutMs
  )
  return collectRenderedPngs(outDir, config)
}

async function renderWithSips(realPath: string, outDir: string, config: RenderConfig): Promise<string[]> {
  const tool = sipsPath(config)
  if (!tool) return []
  await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined)
  await fs.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, 'page-1.png')
  await execFilePromise(
    config.execFile,
    tool,
    ['-Z', String(config.maxEdge), '-s', 'format', 'png', realPath, '--out', outPath],
    config.timeoutMs
  )
  return collectRenderedPngs(outDir, { ...config, maxPages: 1 })
}

async function renderPdf(realPath: string, outDir: string, config: RenderConfig): Promise<string[]> {
  try {
    const popplerPages = await renderWithPoppler(realPath, outDir, config)
    if (popplerPages.length > 0) return popplerPages
  } catch {
    // Fall back below. Poppler may be missing runtime libraries or reject a PDF
    // that macOS can still thumbnail.
  }
  try {
    const sipsPages = await renderWithSips(realPath, outDir, config)
    if (sipsPages.length > 0) return sipsPages
  } catch {
    // Caller records the render failure.
  }
  return []
}

async function copyStablePdfSource(source: StablePdfSource, targetPath: string): Promise<void> {
  const noFollow = fsSync.constants.O_NOFOLLOW ?? 0
  const target = await fs.open(
    targetPath,
    fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | noFollow,
    0o600
  )
  const digest = createHash('sha256')
  const size = Number(source.stat.size)
  const buffer = Buffer.allocUnsafe(Math.min(PDF_COPY_BUFFER_BYTES, Math.max(1, size)))
  let sourcePosition = 0
  let targetPosition = 0
  try {
    while (sourcePosition < size) {
      const requested = Math.min(buffer.length, size - sourcePosition)
      const { bytesRead } = await source.handle.read(buffer, 0, requested, sourcePosition)
      if (bytesRead <= 0) throw new Error('PDF source ended while preparing the render copy')
      digest.update(buffer.subarray(0, bytesRead))
      sourcePosition += bytesRead
      let writtenFromChunk = 0
      while (writtenFromChunk < bytesRead) {
        const { bytesWritten } = await target.write(
          buffer,
          writtenFromChunk,
          bytesRead - writtenFromChunk,
          targetPosition
        )
        if (bytesWritten <= 0) throw new Error('PDF render copy could not be completed')
        writtenFromChunk += bytesWritten
        targetPosition += bytesWritten
      }
    }
    await target.sync()
  } finally {
    await target.close()
  }
  if (targetPosition !== size || digest.digest('hex') !== source.digest) {
    throw new Error('PDF source changed while preparing the render copy')
  }
  await assertStablePdfSource(source)
}

async function syncFileBestEffort(filePath: string): Promise<void> {
  let handle: FileHandle | null = null
  try {
    handle = await fs.open(filePath, fsSync.constants.O_RDONLY)
    await handle.sync()
  } catch {
    // Atomic visibility is provided by directory rename. Some filesystems do
    // not support fsync for every file type, so durability sync is best effort.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function syncDirectoryBestEffort(dir: string): Promise<void> {
  let handle: FileHandle | null = null
  try {
    handle = await fs.open(dir, fsSync.constants.O_RDONLY)
    await handle.sync()
  } catch {
    // Windows and some mounted filesystems reject directory fsync.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function renderAndPublishPdf(
  source: StablePdfSource,
  key: string,
  config: RenderConfig
): Promise<string[]> {
  await fs.mkdir(config.cacheDir, { recursive: true, mode: 0o700 })
  const outDir = path.join(config.cacheDir, key)
  const existing = await collectPublishedPngs(outDir, source.digest, config)
  if (existing.length > 0) return existing

  const workDir = await fs.mkdtemp(path.join(config.cacheDir, '.render-'))
  const sourceCopyPath = path.join(workDir, 'source.pdf')
  const pagesDir = path.join(workDir, 'pages')
  try {
    await copyStablePdfSource(source, sourceCopyPath)
    const renderedPages = await renderPdf(sourceCopyPath, pagesDir, config)
    if (renderedPages.length === 0) return []
    await assertStablePdfSource(source)

    const manifest = expectedCacheManifest(source.digest, config, renderedPages)
    const manifestPath = path.join(pagesDir, PDF_RENDER_CACHE_MANIFEST)
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    await Promise.all([...renderedPages, manifestPath].map((filePath) => syncFileBestEffort(filePath)))
    await syncDirectoryBestEffort(pagesDir)

    const raced = await collectPublishedPngs(outDir, source.digest, config)
    if (raced.length > 0) return raced
    await fs.rm(outDir, { recursive: true, force: true })
    try {
      await fs.rename(pagesDir, outDir)
    } catch (error) {
      const winner = await collectPublishedPngs(outDir, source.digest, config)
      if (winner.length > 0) return winner
      await fs.rm(outDir, { recursive: true, force: true })
      try {
        await fs.rename(pagesDir, outDir)
      } catch {
        throw error
      }
    }
    await syncDirectoryBestEffort(config.cacheDir)
    return collectPublishedPngs(outDir, source.digest, config)
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function ensurePublishedPdfRender(
  source: StablePdfSource,
  key: string,
  config: RenderConfig
): Promise<string[]> {
  const outDir = path.join(config.cacheDir, key)
  const existing = await collectPublishedPngs(outDir, source.digest, config)
  if (existing.length > 0) {
    await assertStablePdfSource(source)
    return existing
  }

  const inFlightKey = `${path.resolve(config.cacheDir)}\0${key}`
  const current = inFlightCacheRenders.get(inFlightKey)
  if (current) {
    const pages = await current
    await assertStablePdfSource(source)
    return pages
  }
  const pending = renderAndPublishPdf(source, key, config)
  inFlightCacheRenders.set(inFlightKey, pending)
  try {
    return await pending
  } finally {
    if (inFlightCacheRenders.get(inFlightKey) === pending) inFlightCacheRenders.delete(inFlightKey)
  }
}

async function renderOneAttachment(
  attachment: PdfAttachmentLike,
  config: RenderConfig
): Promise<{ rendered: PdfRenderedPageAttachment[]; skipped?: PdfAttachmentRenderSkipped }> {
  const filePath = attachmentPath(attachment.path)
  const fallbackPath = typeof attachment.path === 'string' ? attachment.path : ''
  const name = attachmentDisplayName(attachment, filePath || fallbackPath || 'document.pdf')
  if (!filePath || !isPdfAttachmentPath(filePath)) {
    return { rendered: [] }
  }

  let realPath: string
  try {
    realPath = await fs.realpath(filePath)
  } catch {
    return { rendered: [], skipped: { path: filePath, name, reason: 'missing' } }
  }

  const opened = await openStablePdfSource(realPath, config.maxPdfBytes)
  if (!('source' in opened)) {
    return { rendered: [], skipped: { path: realPath, name, reason: opened.reason } }
  }
  const { source } = opened
  try {
    const key = renderCacheKey(source.digest, config)
    let pages: string[]
    try {
      pages = await ensurePublishedPdfRender(source, key, config)
    } catch {
      pages = []
    }
    if (pages.length === 0) {
      return { rendered: [], skipped: { path: realPath, name, reason: 'render_unavailable' } }
    }

    const rendered = pages.map((pagePath, index) => {
      const pageIndex = index + 1
      return {
        id: `${attachment.id || key}:pdf-page-${pageIndex}`,
        path: pagePath,
        name: pageName(name, pageIndex),
        sourcePdfPath: realPath,
        pageIndex
      }
    })
    return { rendered }
  } finally {
    await source.handle.close().catch(() => undefined)
  }
}

export async function renderPdfAttachmentPages(
  attachments: PdfAttachmentLike[],
  options: PdfAttachmentRenderOptions
): Promise<PdfAttachmentRenderResult> {
  const config = renderConfig(options)
  const rendered: PdfRenderedPageAttachment[] = []
  const skipped: PdfAttachmentRenderSkipped[] = []
  const seen = new Set<string>()
  for (const attachment of attachments) {
    const rawPath = typeof attachment?.path === 'string' ? attachment.path.trim() : ''
    if (!rawPath || !isPdfAttachmentPath(rawPath)) continue
    const key = rawPath.startsWith('file://') ? rawPath : path.resolve(rawPath)
    if (seen.has(key)) continue
    seen.add(key)
    const result = await renderOneAttachment(attachment, config)
    rendered.push(...result.rendered)
    if (result.skipped) skipped.push(result.skipped)
  }
  return { rendered, skipped }
}

export async function prunePdfAttachmentRenderCache(
  cacheDir: string,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000
): Promise<void> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(cacheDir)
  } catch {
    return
  }
  const cutoff = Date.now() - maxAgeMs
  await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(cacheDir, entry)
      try {
        const stat = await fs.stat(target)
        if (stat.mtimeMs < cutoff) await fs.rm(target, { recursive: true, force: true })
      } catch {
        // Best-effort cleanup only.
      }
    })
  )
}

export function defaultPdfAttachmentRenderCacheDir(userDataPath: string): string {
  return path.join(userDataPath || os.tmpdir(), 'pdf-page-cache')
}
