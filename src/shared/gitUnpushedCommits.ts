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
