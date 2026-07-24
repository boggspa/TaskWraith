import type { GitPrSummary } from '../../../main/services/GitService'
import type { WatchedPrDescriptor } from '../../../shared/watchedPrNotify'

export function watchedPrDescriptorFromGitHubUrl(input: {
  chatId: string
  workspacePath: string
  pr: GitPrSummary
}): WatchedPrDescriptor | null {
  const chatId = input.chatId.trim()
  const workspacePath = input.workspacePath.trim()
  const prNumber = Number(input.pr.number)
  const rawUrl = input.pr.url?.trim()
  if (!chatId || !workspacePath || !Number.isInteger(prNumber) || prNumber <= 0 || !rawUrl) {
    return null
  }

  try {
    const url = new URL(rawUrl)
    if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 4 || parts[2] !== 'pull' || Number(parts[3]) !== prNumber) return null
    const owner = decodeURIComponent(parts[0] || '').trim()
    const repo = decodeURIComponent(parts[1] || '').trim()
    if (!owner || !repo || owner.includes('/') || repo.includes('/')) return null
    return { chatId, workspacePath, owner, repo, prNumber }
  } catch {
    return null
  }
}

export function githubWatchDisabledReason(error: unknown): string {
  const detail =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'error' in error
        ? String((error as { error?: unknown }).error ?? '')
        : ''
  if (/not authenticated|auth login|authentication/i.test(detail)) {
    return "GitHub CLI isn't authenticated — run `gh auth login`, then try again."
  }
  if (/not installed|not on PATH|command not found/i.test(detail)) {
    return "GitHub CLI (gh) isn't installed or isn't on PATH."
  }
  if (/no pull request|no open pull request/i.test(detail)) {
    return 'No open pull request to watch.'
  }
  if (/detached HEAD/i.test(detail)) {
    return 'Select a branch with an open pull request before watching checks.'
  }
  return "Couldn't read the current pull request — check GitHub CLI and try again."
}

export function watchedPrDescriptorsMatch(
  left: WatchedPrDescriptor | null | undefined,
  right: WatchedPrDescriptor | null | undefined
): boolean {
  return Boolean(
    left &&
      right &&
      left.chatId === right.chatId &&
      left.workspacePath === right.workspacePath &&
      left.owner === right.owner &&
      left.repo === right.repo &&
      left.prNumber === right.prNumber
  )
}
