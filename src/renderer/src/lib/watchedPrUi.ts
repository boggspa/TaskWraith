import type { WatchedPrDescriptor } from '../../../shared/watchedPrNotify'

export { watchedPrDescriptorFromGitHubUrl } from '../../../shared/watchedPrNotify'

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
