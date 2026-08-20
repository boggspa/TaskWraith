import * as nodeFs from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Keep TaskWraith's own runtime markers out of a checkout it does not own.
 *
 * WHY THIS EXISTS. The work-lock authority projects
 * `.WORK-IN-PROGRESS-taskwraith-runtime-<instance>-<sha256>.md` into whatever
 * worktree a lease covers, and the authority is per-user, not per-repo: on
 * 2026-08-20 its event log carried 1834 lease events for `~/Documents/ChipTown`
 * alone. This repo happens to ignore that filename (.gitignore:20); a stranger's
 * repo does not. There the marker lands as an ordinary untracked file, so
 * `git status` shows a file nobody can explain and `git add -A` commits it. If
 * the app dies while a lease is held the marker outlives the lease entirely.
 *
 * The rule goes in `.git/info/exclude`, never `.gitignore`: excludes are
 * local-only and untracked, so TaskWraith never dirties a repo it is a guest in.
 *
 * NOT AUTHORITY. Nothing here grants, holds, or releases a lock, and every
 * failure is soft — a lease must never fail because of housekeeping. The caller
 * gets an outcome, never an exception.
 */

/** The single pattern written. Narrow on purpose: it matches only what we project. */
export const RUNTIME_MARKER_EXCLUDE_PATTERN = '.WORK-IN-PROGRESS-taskwraith-runtime-*.md'

/**
 * Lines that already cover our markers, so we stay silent rather than stack a
 * redundant rule on top of a repo that solved this its own way. Exact matches
 * only: parsing the full gitignore grammar here would be a second, worse
 * implementation of git, and guessing wrong writes a duplicate at every lease.
 */
const COVERING_PATTERNS: ReadonlySet<string> = new Set([
  RUNTIME_MARKER_EXCLUDE_PATTERN,
  `/${RUNTIME_MARKER_EXCLUDE_PATTERN}`,
  '.WORK-IN-PROGRESS-*.md',
  '/.WORK-IN-PROGRESS-*.md',
  '.WORK-IN-PROGRESS-*',
  '/.WORK-IN-PROGRESS-*'
])

const EXCLUDE_BLOCK = [
  '',
  '# TaskWraith work-lock markers, projected while a lease is held on this',
  '# checkout. Local-only and never committed. Delete the line below to stop',
  '# ignoring them.',
  RUNTIME_MARKER_EXCLUDE_PATTERN,
  ''
].join('\n')

export type WorkspaceMarkerExcludeOutcome =
  | { status: 'added'; excludePath: string }
  | { status: 'already-covered'; source: 'gitignore' | 'exclude' }
  | { status: 'skipped'; reason: 'not-a-git-worktree' | 'unresolvable-git-dir' | 'write-failed' }

/** Minimal synchronous seam, mirroring NodeWorkspaceLockPersistence's style. */
export interface WorkspaceMarkerExcludeFs {
  lstatSync(path: string): { isDirectory(): boolean; isFile(): boolean }
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string, encoding: 'utf8'): void
  mkdirSync(path: string, options: { recursive: boolean }): unknown
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
}

const productionFs = nodeFs as unknown as WorkspaceMarkerExcludeFs

function readTextOrNull(fs: WorkspaceMarkerExcludeFs, path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8')
  } catch {
    // Absent, a directory, or unreadable — all mean "nothing covers us here".
    return null
  }
}

function coversRuntimeMarker(text: string): boolean {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    if (COVERING_PATTERNS.has(line)) return true
  }
  return false
}

/**
 * The directory whose `info/exclude` git actually reads for this worktree.
 *
 * LANDMINE: a `git worktree add` checkout stores `.git` as a FILE pointing at a
 * per-worktree gitdir, and `info/exclude` is NOT read from there — it is read
 * from the shared common dir named by that gitdir's `commondir`. Stopping at the
 * per-worktree gitdir writes a rule git will never consult, which fails silently
 * and looks exactly like the bug it was meant to fix. TaskWraith's own fanout
 * worktrees under `.taskwraith-worktrees/` are all this shape.
 */
export function resolveGitCommonDirectory(
  worktreeRoot: string,
  fs: WorkspaceMarkerExcludeFs = productionFs
): string | null {
  const dotGit = join(worktreeRoot, '.git')

  let entry: { isDirectory(): boolean; isFile(): boolean }
  try {
    entry = fs.lstatSync(dotGit)
  } catch {
    return null
  }

  if (entry.isDirectory()) return dotGit
  if (!entry.isFile()) return null

  const pointer = readTextOrNull(fs, dotGit)
  if (pointer === null) return null

  const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)
  if (!match) return null

  const target = match[1]
  const linkedGitDir = isAbsolute(target) ? resolve(target) : resolve(worktreeRoot, target)

  const commonPointer = readTextOrNull(fs, join(linkedGitDir, 'commondir'))
  if (commonPointer === null) return linkedGitDir

  const commonTarget = commonPointer.trim()
  if (commonTarget.length === 0) return linkedGitDir

  return isAbsolute(commonTarget) ? resolve(commonTarget) : resolve(linkedGitDir, commonTarget)
}

/**
 * Ensure this checkout ignores TaskWraith's runtime markers. Idempotent, and
 * total: every failure path returns a status instead of throwing.
 */
export function ensureRuntimeMarkerExcluded(
  worktreeRoot: string,
  fs: WorkspaceMarkerExcludeFs = productionFs
): WorkspaceMarkerExcludeOutcome {
  const commonDirectory = resolveGitCommonDirectory(worktreeRoot, fs)
  if (commonDirectory === null) return { status: 'skipped', reason: 'not-a-git-worktree' }

  // A repo that already ignores markers its own way is left completely alone.
  const gitignore = readTextOrNull(fs, join(worktreeRoot, '.gitignore'))
  if (gitignore !== null && coversRuntimeMarker(gitignore)) {
    return { status: 'already-covered', source: 'gitignore' }
  }

  const excludePath = join(commonDirectory, 'info', 'exclude')
  const existing = readTextOrNull(fs, excludePath)
  if (existing !== null && coversRuntimeMarker(existing)) {
    return { status: 'already-covered', source: 'exclude' }
  }

  const base = existing ?? ''
  const separator = base.length === 0 || base.endsWith('\n') ? '' : '\n'
  const next = `${base}${separator}${EXCLUDE_BLOCK}`

  // Same-directory temp + rename, so a reader never observes a half-written
  // exclude file. A concurrent instance may lose this redundant write; the next
  // lease simply re-adds it, which is why losing it is harmless.
  const temporaryPath = `${excludePath}.taskwraith-${process.pid}.tmp`
  try {
    fs.mkdirSync(join(commonDirectory, 'info'), { recursive: true })
    fs.writeFileSync(temporaryPath, next, 'utf8')
  } catch {
    return { status: 'skipped', reason: 'write-failed' }
  }

  try {
    fs.renameSync(temporaryPath, excludePath)
  } catch {
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
      // Nothing further to do: the temp file is inert and the lease is unaffected.
    }
    return { status: 'skipped', reason: 'write-failed' }
  }

  return { status: 'added', excludePath }
}
