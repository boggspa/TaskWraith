import { isAbsolute, relative, resolve, sep } from 'node:path'

export const MAX_GIT_COMMIT_SLICE_PATHS = 200
export const MAX_GIT_COMMIT_SLICE_PATCH_BYTES = 5 * 1024 * 1024
export const MAX_GIT_COMMIT_SLICE_MESSAGE_CHARS = 10_000

export type GitCommitSliceMode = 'pathspec' | 'private_index'

export interface GitCommitSliceRequest {
  mode: GitCommitSliceMode
  message: string
  paths: string[]
  patch?: string
}

export function parseGitCommitSliceRequest(args: Record<string, unknown>): GitCommitSliceRequest {
  const message = String(args.message || '').trim()
  if (!message) throw new Error('Commit message is required.')
  if (message.length > MAX_GIT_COMMIT_SLICE_MESSAGE_CHARS) {
    throw new Error(
      `Commit message exceeds ${MAX_GIT_COMMIT_SLICE_MESSAGE_CHARS.toLocaleString()} characters.`
    )
  }
  if (message.includes('\0')) throw new Error('Commit message cannot contain NUL bytes.')

  const mode = args.mode
  if (mode !== 'pathspec' && mode !== 'private_index') {
    throw new Error('git_commit requires mode="pathspec" or mode="private_index".')
  }

  const paths = normalizeDeclaredPaths(args.paths)
  const patch = typeof args.patch === 'string' ? args.patch : undefined
  if (mode === 'pathspec' && patch !== undefined) {
    throw new Error('git_commit pathspec mode does not accept patch; use private_index mode.')
  }
  if (mode === 'private_index') {
    if (!patch?.trim()) throw new Error('git_commit private_index mode requires a patch.')
    if (Buffer.byteLength(patch, 'utf8') > MAX_GIT_COMMIT_SLICE_PATCH_BYTES) {
      throw new Error(
        `git_commit patch exceeds ${MAX_GIT_COMMIT_SLICE_PATCH_BYTES.toLocaleString()} bytes.`
      )
    }
    if (patch.includes('\0')) throw new Error('git_commit patch cannot contain NUL bytes.')
  }

  return {
    mode,
    message,
    paths,
    ...(patch !== undefined ? { patch } : {})
  }
}

function normalizeDeclaredPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('git_commit requires a non-empty paths array.')
  }
  const paths: string[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('git_commit paths must be non-empty strings.')
    }
    const path = raw.trim()
    if (path.includes('\0')) throw new Error('git_commit paths cannot contain NUL bytes.')
    if (seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  if (paths.length === 0) throw new Error('git_commit requires at least one exact path.')
  if (paths.length > MAX_GIT_COMMIT_SLICE_PATHS) {
    throw new Error(`git_commit accepts at most ${MAX_GIT_COMMIT_SLICE_PATHS} paths per slice.`)
  }
  return paths
}

export function nulSeparatedPaths(value: string): string[] {
  return value
    .split('\0')
    .map((path) => path.trim())
    .filter(Boolean)
}

export function resolveGitReportedPaths(repoRoot: string, paths: readonly string[]): string[] {
  return paths.map((path) => (isAbsolute(path) ? resolve(path) : resolve(repoRoot, path)))
}

export function assertCommittedPathsCovered(
  declaredAbsolutePaths: readonly string[],
  actualAbsolutePaths: readonly string[]
): void {
  if (actualAbsolutePaths.length === 0) throw new Error('The commit slice contains no changes.')
  const uncovered = actualAbsolutePaths.filter(
    (actual) => !declaredAbsolutePaths.some((declared) => pathCovers(declared, actual))
  )
  if (uncovered.length > 0) {
    throw new Error(
      `Commit slice escaped its declared paths: ${uncovered.map((path) => JSON.stringify(path)).join(', ')}`
    )
  }
}

export function repoRelativePaths(repoRoot: string, absolutePaths: readonly string[]): string[] {
  return absolutePaths.map((path) => relative(repoRoot, path).replace(/\\/g, '/'))
}

function pathCovers(declaredPath: string, actualPath: string): boolean {
  const declared = resolve(declaredPath)
  const actual = resolve(actualPath)
  return actual === declared || actual.startsWith(`${declared}${sep}`)
}
