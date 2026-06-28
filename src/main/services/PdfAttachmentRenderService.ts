import { createHash } from 'crypto'
import { execFile as nodeExecFile, type ExecFileException, type ExecFileOptions } from 'child_process'
import { promises as fs } from 'fs'
import * as fsSync from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

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
  return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

function renderCacheKey(realPath: string, stat: fsSync.Stats, config: RenderConfig): string {
  return hashKey(
    [
      realPath,
      String(stat.size),
      String(Math.trunc(stat.mtimeMs)),
      String(config.maxPages),
      String(config.maxEdge)
    ].join('\0')
  )
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

async function isPngFile(filePath: string, maxBytes: number): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return false
    const handle = await fs.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(PNG_MAGIC.length)
      await handle.read(buffer, 0, PNG_MAGIC.length, 0)
      return buffer.equals(PNG_MAGIC)
    } finally {
      await handle.close()
    }
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
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }
  const paths = entries
    .filter((entry) => entry.toLowerCase().endsWith('.png'))
    .map((entry) => path.join(dir, entry))
    .sort((a, b) => pageNumberFromPath(a) - pageNumberFromPath(b) || a.localeCompare(b))
  const valid: string[] = []
  for (const filePath of paths) {
    if (valid.length >= config.maxPages) break
    if (await isPngFile(filePath, config.maxOutputBytes)) valid.push(filePath)
  }
  return valid
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
  let stat: fsSync.Stats
  try {
    realPath = await fs.realpath(filePath)
    stat = await fs.stat(realPath)
  } catch {
    return { rendered: [], skipped: { path: filePath, name, reason: 'missing' } }
  }
  if (!stat.isFile()) {
    return { rendered: [], skipped: { path: realPath, name, reason: 'not_file' } }
  }
  if (stat.size <= 0 || stat.size > config.maxPdfBytes) {
    return { rendered: [], skipped: { path: realPath, name, reason: 'too_large' } }
  }

  const key = renderCacheKey(realPath, stat, config)
  const outDir = path.join(config.cacheDir, key)
  let pages = await collectRenderedPngs(outDir, config)
  if (pages.length === 0) {
    pages = await renderPdf(realPath, outDir, config)
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
