/**
 * Host-side read-only git service.
 *
 * Every execution property here is a security property, so the seams are
 * injected: tests prove the hardening without shelling out to a real git.
 *
 * Guarantees, all fail-closed:
 *  - shell:false with a FIXED argv. No string interpolation ever reaches a shell.
 *  - cwd pinned to the workspace realPath supplied by the caller.
 *  - explicit timeout and bounded output.
 *  - the repository toplevel must resolve INSIDE the workspace realPath; a repo
 *    whose toplevel escapes is refused rather than read.
 *  - a `.git` FILE (worktree/submodule redirection) is refused unless the
 *    resolved toplevel is still inside the workspace, because a .git file can
 *    point metadata at another filesystem root.
 *  - payloads are capped and TRUNCATED-AND-MARKED, never silently clipped.
 */

import { isAbsolute, resolve } from 'node:path'

import {
  HostGitRefusedError,
  assertReadOnlyHostGitArgs,
  hardenedHostGitArgs,
  hostGitEnvironment
} from './HostGitSecurity'
import { parseHostGitStatusPorcelainZ, type HostGitFileStatus } from './HostGitStatusParse'

/**
 * Transport ceiling. MAX_LINE_BYTES is 256_000 and bounds the WHOLE JSON line;
 * diff text inflates under JSON escaping, so the git payload gets half.
 */
export const HOST_GIT_MAX_PAYLOAD_BYTES = 128 * 1024

export const HOST_GIT_DEFAULT_TIMEOUT_MS = 10_000

export type HostGitReadScope = 'status' | 'diff' | 'log'

export interface HostGitSpawnResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** True when the child was killed by the timeout rather than exiting. */
  readonly timedOut?: boolean
}

/** Injected process seam. Implementations must use shell:false. */
export interface HostGitSpawnPort {
  run(input: {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly env: Record<string, string>
    readonly timeoutMs: number
    readonly maxBytes: number
  }): Promise<HostGitSpawnResult>
}

/** Injected filesystem seam so scope refusals are testable without real repos. */
export interface HostGitFsPort {
  /** Canonical path; throws when the path does not exist. */
  realpath(path: string): string
  /** lstat-based classification of `<root>/.git`. */
  inspectGitMarker(repositoryRoot: string): { exists: boolean; kind: 'dir' | 'file' | 'symlink' }
}

export interface HostGitTruncatableText {
  readonly text: string
  readonly truncated: boolean
  readonly byteLength: number
}

export interface HostGitReadResult {
  readonly scope: HostGitReadScope
  readonly repositoryRoot: string
  readonly branch: string | null
  readonly head: string | null
  readonly files?: readonly HostGitFileStatus[]
  readonly text?: HostGitTruncatableText
}

export interface HostGitReadServiceOptions {
  readonly spawn: HostGitSpawnPort
  readonly fs: HostGitFsPort
  readonly gitExecutable?: string
  readonly timeoutMs?: number
  readonly maxPayloadBytes?: number
  readonly env?: Record<string, string | undefined>
}

export interface HostGitReadRequest {
  /** Canonical workspace directory. The read may never escape it. */
  readonly workspaceRealPath: string
  readonly scope: HostGitReadScope
  /** Optional workspace-relative pathspec. Absolute or traversing paths refused. */
  readonly path?: string
}

/**
 * Truncates on a BYTE budget and reports it. Callers must never treat a
 * truncated payload as complete, which is why `truncated` is required rather
 * than inferred from length.
 */
export function truncateHostGitText(text: string, maxBytes: number): HostGitTruncatableText {
  const full = Buffer.from(text, 'utf8')
  if (full.byteLength <= maxBytes) {
    return { text, truncated: false, byteLength: full.byteLength }
  }
  // Slice on a byte boundary, then drop any trailing partial UTF-8 sequence by
  // round-tripping through a lossy decode and re-encoding.
  const clipped = full.subarray(0, maxBytes).toString('utf8').replace(/�+$/u, '')
  const encoded = Buffer.from(clipped, 'utf8')
  return { text: clipped, truncated: true, byteLength: encoded.byteLength }
}

function assertRelativePathspec(value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HostGitRefusedError('Host git pathspec must be a non-empty string.')
  }
  if (/[\0\r\n]/.test(value)) {
    throw new HostGitRefusedError('Host git pathspec must not contain control characters.')
  }
  if (isAbsolute(value) || value.startsWith('-')) {
    throw new HostGitRefusedError('Host git pathspec must be workspace-relative.')
  }
  const segments = value.split(/[\\/]/)
  if (segments.some((segment) => segment === '..')) {
    throw new HostGitRefusedError('Host git pathspec must not traverse outside the workspace.')
  }
}

function isInside(parent: string, candidate: string): boolean {
  const base = resolve(parent)
  const target = resolve(candidate)
  if (target === base) return true
  return target.startsWith(base.endsWith('/') ? base : `${base}/`)
}

export class HostGitReadService {
  private readonly spawn: HostGitSpawnPort
  private readonly fs: HostGitFsPort
  private readonly gitExecutable: string
  private readonly timeoutMs: number
  private readonly maxPayloadBytes: number
  private readonly env: Record<string, string>

  constructor(options: HostGitReadServiceOptions) {
    if (!options?.spawn || typeof options.spawn.run !== 'function') {
      throw new Error('HostGitReadService requires a spawn port.')
    }
    if (!options.fs || typeof options.fs.realpath !== 'function') {
      throw new Error('HostGitReadService requires a filesystem port.')
    }
    this.spawn = options.spawn
    this.fs = options.fs
    this.gitExecutable = options.gitExecutable ?? 'git'
    this.timeoutMs = Math.max(1, options.timeoutMs ?? HOST_GIT_DEFAULT_TIMEOUT_MS)
    this.maxPayloadBytes = Math.max(1, options.maxPayloadBytes ?? HOST_GIT_MAX_PAYLOAD_BYTES)
    // Built ONCE at construction so every invocation shares the same scrubbed,
    // prompt-disabled environment.
    this.env = hostGitEnvironment(options.env ?? process.env)
  }

  async read(request: HostGitReadRequest): Promise<HostGitReadResult> {
    const workspace = this.canonicalWorkspace(request.workspaceRealPath)
    if (request.path !== undefined) assertRelativePathspec(request.path)

    const repositoryRoot = await this.resolveRepositoryRoot(workspace)
    const branch = await this.readOptional(workspace, ['branch', '--show-current'])
    const head = await this.readOptional(workspace, ['rev-parse', 'HEAD'])

    if (request.scope === 'status') {
      const output = await this.run(workspace, ['status', '--porcelain=v1', '-z'])
      return {
        scope: 'status',
        repositoryRoot,
        branch,
        head,
        files: parseHostGitStatusPorcelainZ(output)
      }
    }

    const args =
      request.scope === 'diff'
        ? ['diff', '--no-color', '--no-ext-diff', ...(request.path ? ['--', request.path] : [])]
        : ['log', '--no-color', '--max-count=100', '--date=iso-strict', '--pretty=%H%x09%ad%x09%s']
    const output = await this.run(workspace, args)
    return {
      scope: request.scope,
      repositoryRoot,
      branch,
      head,
      text: truncateHostGitText(output, this.maxPayloadBytes)
    }
  }

  private canonicalWorkspace(workspaceRealPath: string): string {
    if (typeof workspaceRealPath !== 'string' || !isAbsolute(workspaceRealPath)) {
      throw new HostGitRefusedError('Host git requires an absolute workspace path.')
    }
    try {
      return this.fs.realpath(resolve(workspaceRealPath))
    } catch (error) {
      throw new HostGitRefusedError('Host git workspace path does not resolve.', { cause: error })
    }
  }

  /**
   * Resolves the repository toplevel and refuses anything that escapes the
   * workspace. The toplevel is realpath'd BEFORE comparison so a symlinked
   * checkout cannot move the boundary.
   */
  private async resolveRepositoryRoot(workspace: string): Promise<string> {
    const reported = (await this.run(workspace, ['rev-parse', '--show-toplevel'])).trim()
    if (!reported) {
      throw new HostGitRefusedError('Host git found no repository for this workspace.')
    }
    let root: string
    try {
      root = this.fs.realpath(resolve(reported))
    } catch (error) {
      throw new HostGitRefusedError('Host git repository root does not resolve.', { cause: error })
    }
    if (!isInside(workspace, root)) {
      throw new HostGitRefusedError(
        'Host git refuses a repository whose root resolves outside the workspace.'
      )
    }
    const marker = this.fs.inspectGitMarker(root)
    if (!marker.exists || marker.kind === 'symlink') {
      throw new HostGitRefusedError('Host git refuses a missing or symlinked .git marker.')
    }
    // A .git FILE redirects metadata elsewhere. It is admissible only because
    // the toplevel above already proved to be inside the workspace; the check
    // order is what makes this safe, so do not reorder it.
    return root
  }

  private async readOptional(cwd: string, args: readonly string[]): Promise<string | null> {
    try {
      const value = (await this.run(cwd, args)).trim()
      return value.length > 0 ? value : null
    } catch {
      // A detached HEAD or an empty repository is not an error for a read.
      return null
    }
  }

  private async run(cwd: string, args: readonly string[]): Promise<string> {
    assertReadOnlyHostGitArgs(args)
    const result = await this.spawn.run({
      command: this.gitExecutable,
      // Hardening is applied HERE, on the exact argv handed to spawn.
      args: hardenedHostGitArgs(args),
      cwd,
      env: this.env,
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxPayloadBytes
    })
    if (result.timedOut) {
      throw new HostGitRefusedError('Host git command timed out.')
    }
    if (result.status !== 0) {
      throw new HostGitRefusedError(
        `Host git command failed: ${(result.stderr || '').slice(0, 200).trim()}`
      )
    }
    return result.stdout
  }
}
