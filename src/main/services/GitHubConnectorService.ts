import { execFile } from 'child_process'

import {
  parseGitHubReferenceLocator,
  MAX_PROJECT_REFERENCE_REVISION_LENGTH,
  type ProjectReferenceAvailability
} from '../../shared/projects'

/**
 * Phase-6 read-only GitHub connector: resolves a `github://owner/repo[/path]
 * [@ref]` reference to its current availability and stable revision.
 *
 * The entire request surface is ONE metadata call — the latest commit
 * touching the resource (`GET /repos/{owner}/{repo}/commits?per_page=1
 * [&path=][&sha=]`). Content is never fetched; the commits endpoint carries
 * no file bytes, so the connector cannot leak resource content by
 * construction.
 *
 * Credential lifecycle is delegated to the user's own `gh` CLI, matching how
 * every provider CLI in this app owns its auth: `gh auth login` grants,
 * `gh auth refresh` refreshes, `gh auth logout` revokes — after which this
 * service degrades to the anonymous public API (private resources then
 * verify as errors, never as silently-missing). The app stores no tokens.
 */

export interface GitHubReferenceProbe {
  status: ProjectReferenceAvailability
  revision?: string
}

export interface GitHubConnectorServiceDeps {
  /** Runs `gh api <path>` and resolves stdout; rejects on any failure.
   * Injected for tests; production uses the real CLI with a timeout. */
  execGhApi?: (apiPath: string) => Promise<string>
  /** Anonymous public-API fallback; resolves the parsed JSON body, resolves
   * `{ notFound: true }` for a definitive 404, rejects otherwise. */
  fetchPublicJson?: (url: string) => Promise<{ notFound: true } | { body: unknown }>
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 8000

function defaultExecGhApi(apiPath: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['api', apiPath],
      { timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message))
          return
        }
        resolve(stdout)
      }
    )
  })
}

async function defaultFetchPublicJson(
  url: string,
  timeoutMs: number
): Promise<{ notFound: true } | { body: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'TaskWraith-Project-References'
      }
    })
    if (response.status === 404) return { notFound: true }
    if (!response.ok) {
      throw new Error(`GitHub API responded ${response.status}.`)
    }
    return { body: (await response.json()) as unknown }
  } finally {
    clearTimeout(timer)
  }
}

function commitsApiPath(locator: {
  owner: string
  repo: string
  path?: string
  ref?: string
}): string {
  const params = new URLSearchParams({ per_page: '1' })
  if (locator.path) params.set('path', locator.path)
  if (locator.ref) params.set('sha', locator.ref)
  return `repos/${locator.owner}/${locator.repo}/commits?${params.toString()}`
}

function revisionFromCommits(body: unknown): string | null {
  if (!Array.isArray(body) || body.length === 0) return null
  const sha = (body[0] as { sha?: unknown } | null)?.sha
  if (typeof sha !== 'string' || !sha.trim()) return null
  return sha.slice(0, MAX_PROJECT_REFERENCE_REVISION_LENGTH)
}

function isGhNotFound(message: string): boolean {
  // Deliberately narrow: gh resource 404s read "Not Found (HTTP 404)", while
  // a missing gh BINARY reads "command not found" — which must fall through
  // to the anonymous lane, not report the resource as missing.
  return /HTTP 404/i.test(message)
}

export function createGitHubConnectorService(deps: GitHubConnectorServiceDeps = {}): {
  probeReference: (locator: string) => Promise<GitHubReferenceProbe>
} {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const execGhApi = deps.execGhApi ?? ((apiPath: string) => defaultExecGhApi(apiPath, timeoutMs))
  const fetchPublicJson =
    deps.fetchPublicJson ?? ((url: string) => defaultFetchPublicJson(url, timeoutMs))

  return {
    async probeReference(locator: string): Promise<GitHubReferenceProbe> {
      const parsed = parseGitHubReferenceLocator(locator)
      if (!parsed) {
        throw new Error('Connector locator must be github://owner/repo[/path][@ref].')
      }
      const apiPath = commitsApiPath(parsed)

      // The user's own gh credentials first (covers private resources)...
      let ghFailure: Error | null = null
      try {
        const stdout = await execGhApi(apiPath)
        const revision = revisionFromCommits(JSON.parse(stdout))
        // An empty commit list for a path filter means the path never existed
        // on that ref — a definitive miss, same as a 404.
        return revision ? { status: 'ok', revision } : { status: 'missing' }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        if (isGhNotFound(failure.message)) return { status: 'missing' }
        ghFailure = failure
      }

      // ...then the anonymous public API, so verification still works with gh
      // absent, logged out, or revoked. Private resources land in the throw
      // below rather than being mislabelled 'missing': anonymous GitHub
      // reports them as 404, which is indistinguishable from absent — so
      // when gh failed for a NON-404 reason we surface the error instead.
      try {
        const result = await fetchPublicJson(`https://api.github.com/${apiPath}`)
        if ('notFound' in result) {
          if (ghFailure) {
            throw new Error(
              `Could not verify with GitHub credentials (${ghFailure.message}); the resource is not publicly visible.`
            )
          }
          return { status: 'missing' }
        }
        const revision = revisionFromCommits(result.body)
        return revision ? { status: 'ok', revision } : { status: 'missing' }
      } catch (error) {
        if (error instanceof Error) throw error
        throw new Error(String(error))
      }
    }
  }
}
