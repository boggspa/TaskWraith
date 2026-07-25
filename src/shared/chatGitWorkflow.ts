// Per-chat git workflow snapshot — the durable "this thread shipped something"
// marker behind the sidebar's per-row git status icon and its "Git" section.
//
// PURE shared logic: no IPC, no store, no I/O. The snapshot itself is
// MAIN-OWNED on ChatRecord (like watchedPr): renderers report observations
// over a dedicated channel and main persists via an async atomic patch, so a
// lagging whole-record save can never clobber it.
//
// Association contract (why a thread "graduates" to the Git section): a chat is
// tagged only when a workflow TRANSITION is observed while that chat is focused
// (a push completing, a PR appearing / merging / closing / failing CI), or when
// the chat's watched-PR poller reports state for an explicit watch opt-in.
// Merely opening an old chat in a workspace that happens to have an open PR is
// a steady-state observation and must never tag it.

/** Lifecycle buckets a thread's git workflow can be in. Single-icon precedence
 * (most significant wins): merged > closed > failed > draft > open > pushed. */
export type ChatGitWorkflowState =
  | 'pushed' // upstream fully synced, no PR yet
  | 'draft' // draft PR open
  | 'open' // PR open
  | 'merged' // PR merged
  | 'closed' // PR closed without merging
  | 'failed' // PR open but CI failed on its head

/** What a reporter (renderer observer or host poller) hands main to persist. */
export interface ChatGitWorkflowInput {
  state: ChatGitWorkflowState
  prNumber?: number
  prUrl?: string
}

/** The persisted per-chat snapshot. updatedAt is stamped by MAIN at persist
 * time so reporter clocks never enter the record. */
export interface ChatGitWorkflowSnapshot extends ChatGitWorkflowInput {
  updatedAt: number
}

/** Sidebar "Git" section subheaders. */
export type ChatGitWorkflowGroup = 'pushed' | 'pr' | 'merged' | 'closed'

export const CHAT_GIT_WORKFLOW_STATES: readonly ChatGitWorkflowState[] = [
  'pushed',
  'draft',
  'open',
  'merged',
  'closed',
  'failed'
]

export const CHAT_GIT_WORKFLOW_GROUP_ORDER: readonly ChatGitWorkflowGroup[] = [
  'pr',
  'pushed',
  'merged',
  'closed'
]

export const CHAT_GIT_WORKFLOW_GROUP_LABELS: Record<ChatGitWorkflowGroup, string> = {
  pushed: 'Pushed',
  pr: 'PRs',
  merged: 'Merged',
  closed: 'Closed'
}

export function isChatGitWorkflowState(value: unknown): value is ChatGitWorkflowState {
  return CHAT_GIT_WORKFLOW_STATES.includes(value as ChatGitWorkflowState)
}

/** Which "Git" section subheader a state files under. */
export function chatGitWorkflowGroup(state: ChatGitWorkflowState): ChatGitWorkflowGroup {
  switch (state) {
    case 'draft':
    case 'open':
    case 'failed':
      return 'pr'
    case 'merged':
      return 'merged'
    case 'closed':
      return 'closed'
    case 'pushed':
      return 'pushed'
  }
}

/** Short human label for tooltips ("PR #12 merged", "Pushed"). */
export function chatGitWorkflowLabel(snapshot: ChatGitWorkflowInput): string {
  const pr = typeof snapshot.prNumber === 'number' ? `PR #${snapshot.prNumber}` : 'PR'
  switch (snapshot.state) {
    case 'pushed':
      return 'Pushed'
    case 'draft':
      return `${pr} draft`
    case 'open':
      return `${pr} open`
    case 'merged':
      return `${pr} merged`
    case 'closed':
      return `${pr} closed`
    case 'failed':
      return `${pr} — CI failed`
  }
}

/** Structural mirror of GitService's GitPrSummary — shared/ must not import
 * main-process types. */
export interface GitWorkflowPrLike {
  number?: number
  url?: string
  state?: string
  isDraft?: boolean
}

/**
 * Collapse a PR summary + CI conclusion + local sync state into the single
 * per-thread workflow state. Shared verbatim by the renderer satellite
 * observer and the main-process watch-PR poller so the two reporters can
 * never disagree.
 *
 * Precedence: merged/closed are terminal for the PR; a failing CI head beats
 * draft/open (the sidebar icon is a "needs attention" glance); with no PR at
 * all, a fully synced upstream reads as "pushed".
 */
export function deriveChatGitWorkflowState(input: {
  pr?: GitWorkflowPrLike | null
  /** GitCiStatusKind-shaped conclusion for the PR head ('failed' is the only
   * value that changes the outcome here). */
  ciStatus?: string | null
  /** ahead === 0 with an upstream and not detached — the satellite row's
   * "Pushed" condition. */
  pushedClean?: boolean
}): ChatGitWorkflowState | null {
  const pr = input.pr
  if (pr && typeof pr.number === 'number' && pr.number > 0) {
    const state = (pr.state || '').toUpperCase()
    if (state === 'MERGED') return 'merged'
    if (state === 'CLOSED') return 'closed'
    if (input.ciStatus === 'failed') return 'failed'
    if (pr.isDraft) return 'draft'
    return 'open'
  }
  return input.pushedClean ? 'pushed' : null
}

/** Build the reporter payload for a derived state, keeping only a safe,
 * clickable-on-github PR url. Returns null when there is nothing to report. */
export function chatGitWorkflowInputFromObservation(
  state: ChatGitWorkflowState | null,
  pr?: GitWorkflowPrLike | null
): ChatGitWorkflowInput | null {
  if (!state) return null
  const input: ChatGitWorkflowInput = { state }
  if (state !== 'pushed' && pr && typeof pr.number === 'number' && pr.number > 0) {
    input.prNumber = pr.number
    if (typeof pr.url === 'string' && pr.url.startsWith('https://github.com/')) {
      input.prUrl = pr.url
    }
  }
  return input
}

/** True when a fresh observation is materially different from what is already
 * persisted — the write filter both reporters apply before invoking main. */
export function chatGitWorkflowDiffers(
  persisted: ChatGitWorkflowInput | undefined | null,
  next: ChatGitWorkflowInput
): boolean {
  if (!persisted) return true
  return (
    persisted.state !== next.state ||
    (persisted.prNumber ?? null) !== (next.prNumber ?? null) ||
    (persisted.prUrl ?? null) !== (next.prUrl ?? null)
  )
}

/**
 * Strict decode for persisted snapshots. Throws on malformed data — callers
 * treat that as absent (mirror of normalizeWatchedPr's posture).
 */
export function normalizeChatGitWorkflow(value: unknown): ChatGitWorkflowSnapshot {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<ChatGitWorkflowSnapshot>)
      : null
  const state = record?.state
  const updatedAt = record?.updatedAt
  if (
    !isChatGitWorkflowState(state) ||
    typeof updatedAt !== 'number' ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt <= 0
  ) {
    throw new Error('The saved git workflow marker is incomplete.')
  }
  const snapshot: ChatGitWorkflowSnapshot = { state, updatedAt }
  const prNumber = record?.prNumber
  if (typeof prNumber === 'number' && Number.isSafeInteger(prNumber) && prNumber > 0) {
    snapshot.prNumber = prNumber
  }
  const prUrl = record?.prUrl
  if (
    typeof prUrl === 'string' &&
    prUrl.startsWith('https://github.com/') &&
    prUrl.length <= 2048
  ) {
    snapshot.prUrl = prUrl
  }
  return snapshot
}
