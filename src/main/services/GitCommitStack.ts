import type { GitCommandRunner, GitRepositorySnapshot } from './GitService'

const COMMIT_RECORD_SEPARATOR = '\u001e'
const COMMIT_FIELD_SEPARATOR = '\u0000'
const COMMIT_LOG_FORMAT = '%x1e%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00'

export const DEFAULT_GIT_UNPUSHED_COMMIT_PAGE_SIZE = 50
export const MAX_GIT_UNPUSHED_COMMIT_PAGE_SIZE = 100
const MAX_GIT_UNPUSHED_COMMIT_PAGE_OFFSET = 100_000

export interface GitCommitAuthor {
  name: string
  email?: string
  authoredAt?: string
}

export interface GitUnpushedCommit {
  hash: string
  parents: string[]
  subject: string
  author: GitCommitAuthor
  filesChanged: number
  additions: number
  deletions: number
}

export interface GitUnpushedCommitStack {
  repoRoot: string
  branch?: string
  head?: string
  upstream?: string
  remoteName?: string
  remoteUrl?: string
  comparison: 'upstream' | 'remote-refs'
  observedAt: string
  commits: GitUnpushedCommit[]
  page?: GitUnpushedCommitPage
}

export interface GitUnpushedCommitPageRequest {
  offset?: number
  limit?: number
}

export interface GitUnpushedCommitPage {
  offset: number
  limit: number
  hasMore: boolean
  nextOffset?: number
}

export interface ReadGitUnpushedCommitStackInput {
  repoRoot: string
  snapshot: GitRepositorySnapshot
  run: GitCommandRunner
  timeoutMs: number
  now?: () => Date
  page?: GitUnpushedCommitPageRequest
}

export function normalizeGitUnpushedCommitPage(
  input: GitUnpushedCommitPageRequest | undefined
): { offset: number; limit: number } | null {
  if (!input) return null
  const offset =
    typeof input.offset === 'number' && Number.isSafeInteger(input.offset)
      ? Math.min(MAX_GIT_UNPUSHED_COMMIT_PAGE_OFFSET, Math.max(0, input.offset))
      : 0
  const limit =
    typeof input.limit === 'number' && Number.isSafeInteger(input.limit)
      ? Math.min(MAX_GIT_UNPUSHED_COMMIT_PAGE_SIZE, Math.max(1, input.limit))
      : DEFAULT_GIT_UNPUSHED_COMMIT_PAGE_SIZE
  return { offset, limit }
}

/**
 * Read every commit reachable from the current checkout that has not reached
 * its tracking ref. An unpublished checkout has no tracking ref, so its stack
 * is the commits absent from every remote-tracking ref instead. This keeps the
 * result useful before a first push without pretending the repository's whole
 * history is local-only.
 */
export async function readGitUnpushedCommitStack(
  input: ReadGitUnpushedCommitStackInput
): Promise<GitUnpushedCommitStack> {
  const { repoRoot, run, snapshot, timeoutMs } = input
  const comparison = snapshot.upstream ? 'upstream' : 'remote-refs'
  const revisions = snapshot.upstream ? ['@{u}..HEAD'] : ['HEAD', '--not', '--remotes']
  const page = normalizeGitUnpushedCommitPage(input.page)
  const result = await run(
    'git',
    [
      '--no-optional-locks',
      'log',
      '--topo-order',
      ...(page ? [`--max-count=${page.limit + 1}`, `--skip=${page.offset}`] : []),
      `--format=${COMMIT_LOG_FORMAT}`,
      '--numstat',
      '-z',
      ...revisions,
      '--'
    ],
    { cwd: repoRoot, timeoutMs }
  )
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || 'Could not read unpushed commits.'
    )
  }

  const parsedCommits = parseGitUnpushedCommitLog(result.stdout)
  const commits = page ? parsedCommits.slice(0, page.limit) : parsedCommits
  const hasMore = Boolean(page && parsedCommits.length > page.limit)

  return {
    repoRoot,
    branch: snapshot.branch,
    head: snapshot.commit,
    upstream: snapshot.upstream,
    remoteName: snapshot.remoteName,
    remoteUrl: snapshot.remoteUrl,
    comparison,
    observedAt: (input.now?.() || new Date()).toISOString(),
    commits,
    ...(page
      ? {
          page: {
            ...page,
            hasMore,
            ...(hasMore ? { nextOffset: page.offset + page.limit } : {})
          }
        }
      : {})
  }
}

/** Parse the NUL-delimited `git log --numstat -z` projection above. */
export function parseGitUnpushedCommitLog(stdout: string): GitUnpushedCommit[] {
  const commits: GitUnpushedCommit[] = []
  for (const rawRecord of stdout.split(COMMIT_RECORD_SEPARATOR)) {
    if (!rawRecord) continue
    const fields = rawRecord.split(COMMIT_FIELD_SEPARATOR)
    if (fields.length < 6) continue
    const hash = fields[0]?.trim()
    if (!/^[0-9a-f]{40}$/i.test(hash || '')) continue

    let filesChanged = 0
    let additions = 0
    let deletions = 0
    const statTokens = fields.slice(6)
    for (let index = 0; index < statTokens.length; index += 1) {
      const token = statTokens[index].replace(/^\r?\n+/, '')
      const stat = token.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s)
      if (!stat) continue
      filesChanged += 1
      if (stat[1] !== '-') additions += Number(stat[1]) || 0
      if (stat[2] !== '-') deletions += Number(stat[2]) || 0
      // With `-z`, a rename/copy record has an empty path in the stat token,
      // followed by old-path and new-path NUL tokens. They still represent one
      // changed file; skip both path-only tokens so they cannot be re-read.
      if (!stat[3]) index += 2
    }

    const authorName = fields[2]?.trim() || 'Unknown author'
    const authorEmail = fields[3]?.trim()
    const authoredAt = fields[4]?.trim()
    commits.push({
      hash,
      parents: (fields[1] || '').trim().split(/\s+/).filter(Boolean),
      subject: fields[5]?.replace(/[\r\n]+/g, ' ').trim() || 'Untitled commit',
      author: {
        name: authorName,
        ...(authorEmail ? { email: authorEmail } : {}),
        ...(authoredAt ? { authoredAt } : {})
      },
      filesChanged,
      additions,
      deletions
    })
  }
  return commits
}
