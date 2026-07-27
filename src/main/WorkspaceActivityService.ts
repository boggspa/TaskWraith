import { execFile, type ExecFileException } from 'child_process'
import type { Dirent } from 'fs'
import { promises as fs } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import { parseGitStatusZ } from './DiffService'
import type {
  WorkspaceActivityEvent,
  WorkspaceActivitySnapshot,
  WorkspaceActivityEventKind
} from './store/types'

const DEFAULT_DAY_COUNT = 90
const MAX_DAY_COUNT = 180
const CACHE_TTL_MS = 30_000
const GIT_TIMEOUT_MS = 2_000
const MAX_GIT_COMMITS = 2_000
const DEFAULT_SCAN_LIMIT = 5_000
const MAX_WORKTREE_FILES = 500

const IGNORED_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'build',
  '.vite',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'DerivedData',
  '.gradle',
  '.idea',
  '.pytest_cache'
])

interface WorkspaceActivityOptions {
  now?: number
  cacheTtlMs?: number
  scanLimit?: number
  gitTimeoutMs?: number
}

interface GitResult {
  stdout: string
  stderr: string
  code: number
  timedOut: boolean
}

const snapshotCache = new Map<string, { cachedAt: number; snapshot: WorkspaceActivitySnapshot }>()

export function normalizeWorkspaceActivityDayCount(value: number | undefined): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_DAY_COUNT
  return Math.max(1, Math.min(MAX_DAY_COUNT, Math.round(numeric)))
}

/** A lightweight placeholder for a workspace heatmap while its disk scan is
 * running in a utility process. Keep this shape identical to a completed
 * snapshot so renderers can paint an honest empty grid immediately. */
export function createEmptyWorkspaceActivitySnapshot(
  workspacePath: string,
  dayCountInput = DEFAULT_DAY_COUNT,
  generatedAt = Date.now()
): WorkspaceActivitySnapshot {
  return {
    workspacePath,
    dayCount: normalizeWorkspaceActivityDayCount(dayCountInput),
    generatedAt,
    source: 'none',
    truncated: false,
    events: [],
    stats: {
      gitRepo: false,
      commits: 0,
      worktreeFiles: 0,
      filesystemFiles: 0,
      scannedFiles: 0,
      scanLimit: DEFAULT_SCAN_LIMIT
    }
  }
}

function windowBounds(nowMs: number, dayCount: number): { startMs: number; endMs: number } {
  const now = new Date(nowMs)
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  const start = new Date(end)
  start.setDate(start.getDate() - (dayCount - 1))
  start.setHours(0, 0, 0, 0)
  return { startMs: start.getTime(), endMs: end.getTime() }
}

function isInWindow(timestamp: number, startMs: number, endMs: number): boolean {
  return Number.isFinite(timestamp) && timestamp >= startMs && timestamp <= endMs
}

function makeEvent(
  timestamp: number,
  kind: WorkspaceActivityEventKind,
  weight = 1
): WorkspaceActivityEvent {
  return { timestamp, kind, count: 1, weight }
}

function shouldSkipName(name: string): boolean {
  return IGNORED_NAMES.has(name)
}

function resolveWorkspaceChild(workspacePath: string, childPath: string): string | null {
  const target = resolve(workspacePath, childPath)
  const rel = relative(workspacePath, target)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return target
}

function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolveResult) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: timeoutMs
      },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        resolveResult({
          stdout: stdout || '',
          stderr: stderr || '',
          code: typeof error?.code === 'number' ? error.code : error ? -1 : 0,
          timedOut: Boolean(error?.killed || error?.signal === 'SIGTERM')
        })
      }
    )
  })
}

async function isGitRepo(workspacePath: string, timeoutMs: number): Promise<boolean> {
  const result = await runGit(workspacePath, ['rev-parse', '--is-inside-work-tree'], timeoutMs)
  return result.code === 0 && result.stdout.trim() === 'true'
}

async function loadGitCommitEvents(input: {
  workspacePath: string
  startMs: number
  endMs: number
  timeoutMs: number
}): Promise<WorkspaceActivityEvent[]> {
  const since = new Date(input.startMs).toISOString()
  const result = await runGit(
    input.workspacePath,
    ['log', `--since=${since}`, `--max-count=${MAX_GIT_COMMITS}`, '--format=%ct'],
    input.timeoutMs
  )
  if (result.code !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()) * 1000)
    .filter((timestamp) => isInWindow(timestamp, input.startMs, input.endMs))
    .map((timestamp) => makeEvent(timestamp, 'git_commit', 1.5))
}

async function loadWorktreeEvents(input: {
  workspacePath: string
  startMs: number
  endMs: number
  nowMs: number
  timeoutMs: number
}): Promise<{ events: WorkspaceActivityEvent[]; truncated: boolean }> {
  const result = await runGit(
    input.workspacePath,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    input.timeoutMs
  )
  if (result.code !== 0 || !result.stdout) return { events: [], truncated: false }

  const seen = new Set<string>()
  const entries = parseGitStatusZ(result.stdout)
  const events: WorkspaceActivityEvent[] = []
  let truncated = false

  for (const entry of entries) {
    if (seen.size >= MAX_WORKTREE_FILES) {
      truncated = true
      break
    }
    if (!entry.filePath || seen.has(entry.filePath)) continue
    seen.add(entry.filePath)
    const targetPath = resolveWorkspaceChild(input.workspacePath, entry.filePath)
    if (!targetPath) continue
    let timestamp = input.nowMs
    try {
      const stat = await fs.stat(targetPath)
      timestamp = stat.mtimeMs
    } catch {
      // Deleted/renamed-away files still represent current dirty activity.
      timestamp = input.nowMs
    }
    if (isInWindow(timestamp, input.startMs, input.endMs)) {
      events.push(makeEvent(timestamp, 'worktree_change', 1))
    }
  }

  return { events, truncated }
}

async function loadFilesystemEvents(input: {
  workspacePath: string
  startMs: number
  endMs: number
  scanLimit: number
}): Promise<{ events: WorkspaceActivityEvent[]; scannedFiles: number; truncated: boolean }> {
  const queue = [input.workspacePath]
  const events: WorkspaceActivityEvent[] = []
  let scannedFiles = 0
  let truncated = false

  while (queue.length > 0) {
    const directory = queue.shift()!
    let entries: Dirent[]
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (shouldSkipName(entry.name)) continue
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        queue.push(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      scannedFiles += 1
      if (scannedFiles > input.scanLimit) {
        truncated = true
        queue.length = 0
        break
      }
      try {
        const stat = await fs.stat(fullPath)
        if (isInWindow(stat.mtimeMs, input.startMs, input.endMs)) {
          events.push(makeEvent(stat.mtimeMs, 'filesystem_change', 1))
        }
      } catch {
        // Files can vanish during a scan; ignore them.
      }
    }
  }

  return { events, scannedFiles: Math.min(scannedFiles, input.scanLimit), truncated }
}

export function clearWorkspaceActivityCache(): void {
  snapshotCache.clear()
}

export async function getWorkspaceActivitySnapshot(
  workspacePath: string,
  dayCountInput = DEFAULT_DAY_COUNT,
  options: WorkspaceActivityOptions = {}
): Promise<WorkspaceActivitySnapshot> {
  const dayCount = normalizeWorkspaceActivityDayCount(dayCountInput)
  const nowMs = options.now ?? Date.now()
  const cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS
  const scanLimit = Math.max(
    1,
    Math.min(DEFAULT_SCAN_LIMIT, Math.round(options.scanLimit || DEFAULT_SCAN_LIMIT))
  )
  const cacheKey = `${resolve(workspacePath)}:${dayCount}:${scanLimit}`

  if (cacheTtlMs > 0 && options.now === undefined) {
    const cached = snapshotCache.get(cacheKey)
    if (cached && Date.now() - cached.cachedAt <= cacheTtlMs) return cached.snapshot
  }

  const { startMs, endMs } = windowBounds(nowMs, dayCount)
  const timeoutMs = options.gitTimeoutMs ?? GIT_TIMEOUT_MS
  const gitRepo = await isGitRepo(workspacePath, timeoutMs)
  let source: WorkspaceActivitySnapshot['source'] = 'none'
  let events: WorkspaceActivityEvent[] = []
  let truncated = false
  let scannedFiles = 0

  if (gitRepo) {
    source = 'git'
    const commitEvents = await loadGitCommitEvents({ workspacePath, startMs, endMs, timeoutMs })
    const worktree = await loadWorktreeEvents({ workspacePath, startMs, endMs, nowMs, timeoutMs })
    events = [...commitEvents, ...worktree.events]
    truncated = worktree.truncated || commitEvents.length >= MAX_GIT_COMMITS
  } else {
    source = 'filesystem'
    const filesystem = await loadFilesystemEvents({ workspacePath, startMs, endMs, scanLimit })
    events = filesystem.events
    scannedFiles = filesystem.scannedFiles
    truncated = filesystem.truncated
  }

  const snapshot: WorkspaceActivitySnapshot = {
    workspacePath,
    dayCount,
    generatedAt: nowMs,
    source,
    truncated,
    events,
    stats: {
      gitRepo,
      commits: events.filter((event) => event.kind === 'git_commit').length,
      worktreeFiles: events.filter((event) => event.kind === 'worktree_change').length,
      filesystemFiles: events.filter((event) => event.kind === 'filesystem_change').length,
      scannedFiles,
      scanLimit
    }
  }

  if (cacheTtlMs > 0 && options.now === undefined) {
    snapshotCache.set(cacheKey, { cachedAt: Date.now(), snapshot })
  }

  return snapshot
}

export const WORKSPACE_ACTIVITY_IGNORED_NAMES = IGNORED_NAMES
