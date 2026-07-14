import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { scrubCliEnv } from './CliEnvSecurity'

type GitTopLevelProbe = (candidatePath: string) => string | null

/**
 * External Git authority must be self-contained inside the granted directory.
 * A regular `.git` file can redirect Git metadata to another filesystem root,
 * so only a real in-root directory is safe for an otherwise unregistered repo.
 * Registered workspaces continue to use `gitRepositoryRootForPath`, which
 * intentionally accepts linked-worktree `.git` files.
 */
export function externalGitRepositoryRootIsSelfContained(repositoryRoot: string): boolean {
  try {
    const root = fs.realpathSync.native(path.resolve(repositoryRoot))
    if (!fs.statSync(root).isDirectory()) return false
    const marker = fs.lstatSync(path.join(root, '.git'))
    return !marker.isSymbolicLink() && marker.isDirectory()
  } catch {
    return false
  }
}

function probeGitTopLevel(candidatePath: string): string | null {
  const env = scrubCliEnv(process.env)
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('GIT_')) delete env[key]
  }
  env.GIT_TERMINAL_PROMPT = '0'
  const result = spawnSync('git', ['-C', candidatePath, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 5_000
  })
  if (result.error || result.status !== 0) return null
  const topLevel = result.stdout.trim()
  return topLevel || null
}

/**
 * Return the canonical root of the Git repository containing `candidatePath`.
 *
 * The candidate is resolved through the filesystem before ancestors are
 * inspected so aliases cannot change the boundary. A `.git` marker may be a
 * normal directory or file (as used by worktrees), but never a symlink.
 */
export function gitRepositoryRootForPath(
  candidatePath: string,
  probe: GitTopLevelProbe = probeGitTopLevel
): string | null {
  try {
    const candidate = fs.realpathSync.native(path.resolve(candidatePath))
    if (!fs.statSync(candidate).isDirectory()) return null
    const reportedTopLevel = probe(candidate)
    if (!reportedTopLevel) return null
    const repositoryRoot = fs.realpathSync.native(path.resolve(reportedTopLevel))
    if (!fs.statSync(repositoryRoot).isDirectory()) return null
    const marker = fs.lstatSync(path.join(repositoryRoot, '.git'))
    if (marker.isSymbolicLink()) return null
    return marker.isDirectory() || marker.isFile() ? repositoryRoot : null
  } catch {
    return null
  }
}

/**
 * A registered workspace may be a repository root or a plain directory. A
 * non-null, different repository root means Git would widen the read to an
 * ancestor checkout and must remain blocked.
 */
export function registeredWorkspaceGitRootIsAllowed(
  workspaceRoot: string,
  repositoryRoot: string | null
): boolean {
  return repositoryRoot === null || path.resolve(repositoryRoot) === path.resolve(workspaceRoot)
}
