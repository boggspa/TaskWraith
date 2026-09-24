import type { ChatMessage, ProviderId, ToolActivity } from '../store/types'
import { isEnsembleParticipantAuthoredMessage } from '../../shared/ensembleParticipantMessage'
import {
  ENSEMBLE_SEAT_INGEST_MAX_CHARS,
  ENSEMBLE_SEAT_INGEST_MIN_CHARS
} from '../../shared/ensembleSeatIngest'
import { externalAgentAttribution } from '../../shared/messageOrigin'
import { isExternalProviderThreadImportMessage } from '../../shared/externalProviderThreadImport'
import { isTaskWraithCloseoutMessage } from '../../shared/taskWraithCloseout'
import { stripReasoningChains } from '../EnsembleThinkingEphemerality'
import {
  isExternalUntrustedMessage,
  isHumanCollaboratorComment
} from '../collaboration/HumanCollaboratorMessages'
import {
  looksExternallyWrapped,
  wrapExternalContribution
} from '../collaboration/ExternalContributionContext'
import { isRetiredExternalChannelInboundMessage } from '../LegacyExternalChannelHistory'
import { qualifyUnsupportedAntigravityPermissionClaim } from '../antigravity/AntigravityPermissionClaimEvidence'

const PROVIDER_LABELS: Record<ProviderId, string> = {
  gemini: 'Gemini',
  codex: 'Codex',
  claude: 'Claude',
  kimi: 'Kimi',
  grok: 'Grok',
  cursor: 'Cursor',
  ollama: 'Ollama',
  antigravity: 'Antigravity',
  pi: 'Pi',
  mistral: 'Mistral',
  muse: 'Muse',
  devin: 'Devin'
}

const MAX_MESSAGE_CHARS = 4000
export const MAX_TRANSCRIPT_CHARS = 24000

/**
 * 1.0.4-AR7 — compact tool-trace summary line for the tagged
 * transcript context. Pre-AR7 the prompt builder dropped tool
 * messages entirely AND ignored each assistant message's
 * `toolActivities` array, so downstream participants saw only
 * the prose output of upstream turns and had to guess whether a
 * file was read, edited, or searched. That made it harder for the
 * panel to coordinate on multi-turn work.
 *
 * Format (one line, prepended to the message body):
 *
 *   (tools: read_file × 3 · edit × 2 · search × 1)
 *
 * - Aggregated by `toolName` so repeated calls collapse into a
 *   single entry with a count.
 * - Ordered by descending count, then alphabetically — most-used
 *   tools surface first.
 * - Capped at the first 6 distinct tool names; an "…(+N more)"
 *   suffix indicates truncation so the line stays a single visual
 *   row even on heavy tool-call turns.
 *
 * Exported for unit-testing in isolation; the trip through
 * `buildTaggedTranscript` is covered by the prompt-builder tests.
 */
export function formatToolTraceSummary(activities: readonly ToolActivity[] | undefined): string {
  if (!activities || activities.length === 0) return ''
  const counts = new Map<string, number>()
  for (const activity of activities) {
    // Skip truly unnamed activities — better to omit them entirely
    // than to inject a synthetic `tool` placeholder that confuses
    // the trace summary.
    const name = ((activity.toolName || activity.displayName || '') as string).trim()
    if (!name) continue
    counts.set(name, (counts.get(name) || 0) + 1)
  }
  if (counts.size === 0) return ''
  const ordered = Array.from(counts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return a[0].localeCompare(b[0])
  })
  const HEAD = 6
  const head = ordered.slice(0, HEAD)
  const tail = ordered.length - head.length
  const segments = head.map(([name, count]) => (count > 1 ? `${name} × ${count}` : name))
  const suffix = tail > 0 ? ` · …(+${tail} more)` : ''
  return `(tools: ${segments.join(' · ')}${suffix})`
}

/**
 * Spike 3 (the staged fan-out design) — compact
 * per-file change digest for the tagged transcript.
 *
 * The tool-trace line above collapses peers' edits into
 * `(tools: apply_patch × 4)` — no file names, no sizes — even though
 * per-file diff summaries are already computed and stored on each
 * `ToolActivity.diffSummary` by the orchestrator. That left later
 * writers unable to see WHAT changed since their last turn without
 * re-reading the workspace. This renders the stored summaries as one
 * extra line:
 *
 *   (files changed: src/foo.ts +42/-7 · src/bar.ts +3/-0 · …(+2 more))
 *
 * - Aggregated by path across the message's activities (repeated edits
 *   to one file merge their adds/dels).
 * - Additions/deletions omitted when the summary carried none (a bare
 *   `write` activity's filePath still lists the touched file).
 * - Ordered by descending total churn, then alphabetically; capped at
 *   6 paths with an "…(+N more)" suffix, mirroring the tools line.
 *
 * Exported for unit-testing in isolation; the trip through
 * `buildTaggedTranscript` is covered by the prompt-builder tests.
 */
export function formatFileChangeDigest(activities: readonly ToolActivity[] | undefined): string {
  if (!activities || activities.length === 0) return ''
  const byPath = new Map<string, { additions: number; deletions: number; counted: boolean }>()
  const record = (
    path: string | undefined,
    additions: number | undefined,
    deletions: number | undefined
  ): void => {
    const key = (path || '').trim()
    if (!key) return
    const entry = byPath.get(key) || { additions: 0, deletions: 0, counted: false }
    if (typeof additions === 'number' && Number.isFinite(additions)) {
      entry.additions += Math.max(0, additions)
      entry.counted = true
    }
    if (typeof deletions === 'number' && Number.isFinite(deletions)) {
      entry.deletions += Math.max(0, deletions)
      entry.counted = true
    }
    byPath.set(key, entry)
  }
  for (const activity of activities) {
    const files = activity.diffSummary?.files
    if (files && files.length > 0) {
      for (const file of files) record(file.path, file.additions, file.deletions)
      continue
    }
    // No structured diff — a write-category activity still names the file
    // it touched, which is the load-bearing half of the digest.
    if (activity.category === 'write' && activity.filePath) {
      record(activity.filePath, undefined, undefined)
    }
  }
  if (byPath.size === 0) return ''
  const ordered = Array.from(byPath.entries()).sort((a, b) => {
    const churnA = a[1].additions + a[1].deletions
    const churnB = b[1].additions + b[1].deletions
    if (churnB !== churnA) return churnB - churnA
    return a[0].localeCompare(b[0])
  })
  const HEAD = 6
  const head = ordered.slice(0, HEAD)
  const tail = ordered.length - head.length
  const segments = head.map(([path, entry]) =>
    entry.counted ? `${path} +${entry.additions}/-${entry.deletions}` : path
  )
  const suffix = tail > 0 ? ` · …(+${tail} more)` : ''
  return `(files changed: ${segments.join(' · ')}${suffix})`
}

export interface TaggedTranscriptProjection {
  text: string
  truncated: boolean
  eligibleMessageIds: string[]
  suppliedMessageIds: string[]
  omittedMessageIds: string[]
  suppliedRows: Array<{
    messageId: string
    start: number
    end: number
    freshness: 'replayed' | 'fresh'
  }>
}

/**
 * Project borrowed message rows synchronously for full, resumed and omission
 * views. Reads include nested metadata and tool evidence; no revision or cache
 * is used. Inputs need only remain stable until return. An asynchronous caller
 * must establish its own immutable source ownership before using this renderer.
 */
export function projectTaggedTranscript(
  messages: readonly ChatMessage[],
  contextTurns: number,
  participantTokens?: Map<string, string>,
  contextChars?: number,
  modelLabels?: Map<string, string>,
  sinceParticipantId?: string,
  options?: {
    /**
     * The current round's user message is rendered separately as the final
     * request block. Exclude only that metadata-stamped row from the tagged
     * transcript so it is not sent twice. Older round prompts, ordinary user
     * messages, and fan-out lane requests remain intact.
     */
    excludeEnsembleRoundPromptRoundId?: string
    deltaOnly?: boolean
  }
): TaggedTranscriptProjection {
  // Total shared-transcript char budget — window-derived per seat since the
  // chat-wide Chars slider retired (see shared/ensembleSeatIngest.ts). This is
  // the real lever: it drives BOTH how many recent messages we walk and the
  // hard cap, so a bigger budget genuinely surfaces more panel history rather
  // than being silently capped by the turn-count. The ceiling admits a fully
  // used ~1.1M-token window (~4M chars).
  const maxChars = Math.min(
    ENSEMBLE_SEAT_INGEST_MAX_CHARS,
    Math.max(ENSEMBLE_SEAT_INGEST_MIN_CHARS, contextChars ?? MAX_TRANSCRIPT_CHARS)
  )
  // The default budget keeps the historical turn-window (contextTurns*2). A
  // raised budget widens the window enough to actually fill it (~600 chars/line
  // estimate), floored at the turn-window.
  const baseWindow = Math.max(1, contextTurns * 2)
  let windowSize =
    maxChars > MAX_TRANSCRIPT_CHARS ? Math.max(baseWindow, Math.ceil(maxChars / 600)) : baseWindow
  // Timeline-backed Ensemble runs store tool rows separately from assistant
  // prose. Keep a run-indexed view before filtering those rows so a later
  // provider-authored permission claim can be checked against the actual tool
  // outcomes from the same run rather than accepted as unaudited prose.
  const toolActivitiesByRunId = new Map<string, ToolActivity[]>()
  for (const message of messages) {
    if (!message.runId || !message.toolActivities?.length) continue
    const prior = toolActivitiesByRunId.get(message.runId) || []
    const byId = new Map(prior.map((activity) => [activity.id, activity]))
    for (const activity of message.toolActivities) byId.set(activity.id, activity)
    toolActivitiesByRunId.set(message.runId, [...byId.values()])
  }
  const filtered = messages.filter(
    (message) =>
      message.role !== 'tool' &&
      !isHumanCollaboratorComment(message) &&
      !isRetiredExternalChannelInboundMessage(message) &&
      !isTaskWraithCloseoutMessage(message) &&
      !(
        message.role === 'user' &&
        message.metadata?.kind === 'ensembleRoundPrompt' &&
        message.metadata?.ensembleRoundId === options?.excludeEnsembleRoundPromptRoundId
      )
  )
  // Spike 6 (the staged fan-out design) — "since your
  // last turn" widening. A fixed window (12 messages by default) means a
  // writer late in a large round can lose everything since its previous turn
  // — including its OWN prior contribution. When the caller identifies the
  // participant being prompted, widen the window (never shrink it) so it
  // reaches back to that participant's most recent assistant turn plus one
  // message of lead-in. The char budget below stays the hard cap: the
  // newest-first fill still drops the oldest lines when the widened window
  // exceeds it, so provider/context budgets (incl. Ollama's model-aware
  // budget) are never blown.
  let deltaStart = -1
  if (sinceParticipantId) {
    for (let i = filtered.length - 1; i >= 0; i--) {
      const message = filtered[i]
      if (
        message.role === 'assistant' &&
        message.metadata?.ensembleParticipantId === sinceParticipantId
      ) {
        windowSize = Math.max(windowSize, filtered.length - i + 1)
        deltaStart = i + 1
        break
      }
    }
  }
  // Spike 5 — delta-only mode (slim resumed turns): the seat's own session
  // already holds everything up to and including its previous turn, so only
  // messages strictly AFTER that turn are new to it. Falls back to the
  // normal (widened) window when the seat has no prior turn on record.
  const relevant =
    options?.deltaOnly && deltaStart >= 0 ? filtered.slice(deltaStart) : filtered.slice(-windowSize)
  const replayedMessages = new Set(deltaStart >= 0 ? filtered.slice(0, deltaStart) : [])
  // Fill from the MOST RECENT message backward so the budget keeps recent
  // context and truncation drops the OLDEST, not the newest. Output stays
  // chronological (unshift). For a non-truncated window this is identical to the
  // previous forward fill.
  const lines: Array<{
    text: string
    messageId?: string
    freshness?: 'replayed' | 'fresh'
  }> = []
  const suppliedMessages: ChatMessage[] = []
  let used = 0
  let truncated = false
  // F8 — external rows are metered separately from the shared budget so a
  // flood cannot displace the panel's own history. Newest-first fill means the
  // rows that survive the cap are the most recent ones, matching how the
  // overall budget already behaves.
  const externalBudget = Math.floor(maxChars * EXTERNAL_TRANSCRIPT_BUDGET_RATIO)
  let externalUsed = 0
  let externalCount = 0
  let externalDropped = 0
  for (let i = relevant.length - 1; i >= 0; i--) {
    const message = relevant[i]
    // Imported provider history is a local display snapshot, never panel
    // context. An explicit future bridge must create a new host-authored row.
    if (isExternalProviderThreadImportMessage(message)) continue
    const tag = messageTag(message, participantTokens, modelLabels)
    // M6 (1.0.7) — thinking-ephemerality. Strip any inlined reasoning chain
    // from a message authored by an ephemeral-reasoning provider before it
    // enters FUTURE-round context, keyed on the message's own authoring
    // provider (Codex reasoning is durable and retained). Today this is a
    // no-op — `.content` carries no reasoning fences — but it pins the
    // invariant so a future provider adapter that starts inlining a thinking
    // block can't silently leak it into the panel's shared transcript.
    const authoringProvider = message.metadata?.ensembleProvider as ProviderId | undefined
    const ephemeral = stripReasoningChains(message.content, authoringProvider)
    const sanitized = sanitizeText(ephemeral)
    const evidenceQualified =
      authoringProvider === 'antigravity'
        ? qualifyUnsupportedAntigravityPermissionClaim(
            sanitized,
            message.runId ? toolActivitiesByRunId.get(message.runId) : message.toolActivities
          )
        : sanitized
    const text = evidenceQualified.slice(0, MAX_MESSAGE_CHARS)
    // 1.0.4-AR7 — surface a compact tool-trace summary on every
    // message that has one, prepended to the content so downstream
    // participants can see at a glance what tools were used to
    // produce the response. Pure prose messages (no tools) skip
    // the line so the transcript stays lean.
    const trace = formatToolTraceSummary(message.toolActivities)
    const fileDigest = formatFileChangeDigest(message.toolActivities)
    const traceLines = [trace, fileDigest].filter(Boolean).join('\n')
    // THE CHOKE POINT (P2c security review, F2). This is the load-bearing
    // serializer — the one every ensemble seat's prompt is built from — so the
    // untrusted frame is applied HERE, by the code that renders the line, and
    // not by whoever appended the message.
    //
    // Why here rather than an assertion that a caller wrapped it: the two fail
    // in opposite directions. An assertion is only as good as the set of paths
    // someone remembered to route through it, and a missed path fails OPEN, as
    // raw text in front of a model. Wrapping at the point of render has no such
    // set — there is one way for a message to become a transcript line, and it
    // goes through here. `buildExternalContributionBody` is therefore reached by
    // every present and future append path for free, including ones written by
    // someone who has never read this review.
    //
    // Tool-trace lines are deliberately dropped for an external row rather than
    // prepended: they are host-derived text, and splicing them alongside
    // collaborator text inside one frame would blur exactly the authorship
    // boundary the frame is drawing. An external row has no tool activity
    // anyway; this is a guard, not a behaviour.
    // A row that arrived over the local-control socket says so on its own
    // line, so an outside agent never has to write "this is external, not a
    // prompt from the user" into its own body. It stays an ordinary
    // actionable message: the socket is owner-only and this is the
    // operator's own tooling, so it gets attribution, NOT the untrusted
    // frame below, which would tell the model to treat it as inert data.
    const originAttribution = externalAgentAttribution(message.metadata?.origin)
    const attributedText = originAttribution ? `${originAttribution}\n${text}` : text
    const body = isExternalUntrustedMessage(message)
      ? buildExternalContributionBody(message, text)
      : traceLines
        ? `${traceLines}\n${attributedText}`
        : attributedText
    const line = `[${tag}]\n${body}`
    if (isExternalUntrustedMessage(message)) {
      // SKIP, never break. Breaking would let one over-budget external row
      // truncate away all the OLDER host history behind it — handing a
      // collaborator a cheap way to blank the panel's context instead of
      // merely failing to add to it.
      if (
        externalCount >= MAX_EXTERNAL_ROWS_PER_PROMPT ||
        externalUsed + line.length > externalBudget
      ) {
        externalDropped += 1
        continue
      }
      externalUsed += line.length
      externalCount += 1
    }
    if (used + line.length > maxChars && lines.length > 0) {
      truncated = true
      break
    }
    used += line.length
    lines.unshift({
      text: line,
      messageId: message.id,
      freshness: replayedMessages.has(message) ? 'replayed' : 'fresh'
    })
    suppliedMessages.unshift(message)
  }
  if (externalDropped > 0) {
    // Stated, not silent. A seat that cannot see a contribution should know one
    // was withheld rather than reason from a transcript it believes is
    // complete — and a host reading the prompt log should be able to tell a
    // flood happened. Count only; no content, no author.
    lines.unshift({
      text: `[${externalDropped} external collaborator contribution(s) withheld from this prompt: external-content budget reached.]`
    })
  }
  if (truncated) {
    lines.unshift({ text: '[Transcript truncated to fit Ensemble V1 context budget.]' })
  }
  let rowOffset = 0
  const suppliedRows: TaggedTranscriptProjection['suppliedRows'] = []
  for (const [index, line] of lines.entries()) {
    if (line.messageId && line.freshness) {
      suppliedRows.push({
        messageId: line.messageId,
        start: rowOffset,
        end: rowOffset + line.text.length,
        freshness: line.freshness
      })
    }
    rowOffset += line.text.length
    if (index < lines.length - 1) rowOffset += 2
  }
  const suppliedSet = new Set(suppliedMessages)
  const relevantSet = new Set(relevant)
  const windowDroppedMessage = filtered.some(
    (message) =>
      !relevantSet.has(message) &&
      !(options?.deltaOnly && deltaStart >= 0 && replayedMessages.has(message))
  )
  return {
    text: lines.map((line) => line.text).join('\n\n'),
    truncated: truncated || externalDropped > 0 || windowDroppedMessage,
    eligibleMessageIds: filtered.map((message) => message.id),
    suppliedMessageIds: suppliedMessages.map((message) => message.id),
    omittedMessageIds: filtered
      .filter((message) => !suppliedSet.has(message))
      .map((message) => message.id),
    suppliedRows
  }
}

/**
 * Share of the transcript budget external-authored rows may occupy, and the
 * hard ceiling on how many of them any one prompt may carry.
 *
 * P2c security review, F8. The existing append limit (750ms spacing, 30/min per
 * collaborator) was sized for TRANSCRIPT rows, back when a collaborator comment
 * could never reach a model. Once external text is provider-visible, every
 * contribution is charged to a budget that EVERY seat pays on EVERY hop: thirty
 * messages a minute at the 8000-byte contribution cap is 240KB/min against a
 * 5K–256K window. That is a context-exhaustion attack that needs no bug — just
 * a talkative or compromised collaborator — and it crowds out the real history
 * the panel needs to do its work.
 *
 * Enforced HERE, at render, rather than only at append, for the same reason the
 * frame is: this is the one place every prompt is built, so the bound holds
 * whatever the append path allowed, however the text got in, and whichever grant
 * tier is live. An append-time per-round cap is still worth having as an
 * ergonomic control — it can tell the collaborator "not this round" instead of
 * silently dropping — but it is not the security boundary.
 *
 * A fifth of the window is deliberately generous enough that ordinary
 * collaboration never notices the cap and only abuse reaches it.
 */
const EXTERNAL_TRANSCRIPT_BUDGET_RATIO = 0.2
const MAX_EXTERNAL_ROWS_PER_PROMPT = 8

/**
 * Frame one external-untrusted row for the shared transcript.
 *
 * Idempotent by design: a body that already carries the frame is returned
 * unchanged rather than double-wrapped. Two frames around one body would read as
 * a nesting the model has to reason about, and would let a caller that DID wrap
 * correctly end up with a worse prompt than one that forgot.
 *
 * Provenance is read from the row's own metadata and every field is optional —
 * `wrapExternalContribution` sanitises each one itself and falls back to a fixed
 * label, so a row with a missing or hostile `collaboratorDisplayName` still
 * produces a well-formed frame. A malformed row must degrade to "wrapped with
 * less attribution", never to "unwrapped".
 */
function buildExternalContributionBody(message: ChatMessage, text: string): string {
  if (looksExternallyWrapped(text)) return text
  const metadata = message.metadata || {}
  return wrapExternalContribution(text, {
    senderDisplayName:
      typeof metadata.collaboratorDisplayName === 'string' ? metadata.collaboratorDisplayName : '',
    ...(typeof metadata.shareId === 'string' ? { shareId: metadata.shareId } : {}),
    ...(typeof metadata.collaboratorId === 'string'
      ? { collaboratorId: metadata.collaboratorId }
      : {}),
    ...(message.id ? { messageId: message.id } : {}),
    ...(message.timestamp ? { timestamp: message.timestamp } : {}),
    // `promotedBy: 'host'` is the only thing that makes a contribution
    // host-reviewed. Everything else — auto-append under a Promote grant, a
    // replay, an unrecognised state — is reported as unreviewed, because the
    // failure that matters is claiming review that did not happen.
    review: metadata.promotedBy === 'host' ? 'host-approved' : 'auto-appended'
  })
}

/**
 * The transcript tag for a message authored outside the trust boundary.
 *
 * FIXED CONSTANT, and the collaborator's name is deliberately NOT in it. The tag
 * sits at the start of its own line, immediately before the body — the single
 * most valuable position in the transcript for forging structure — so nothing
 * attacker-controlled may appear there. The (sanitised) name belongs on the
 * attribution line INSIDE the frame, where `wrapExternalContribution` has
 * already neutralised it.
 *
 * Without this, `messageTag` falls through to `'System'` for a collaborator row,
 * because the row is `role: 'system'`. Tagging untrusted human text as System —
 * the highest-authority voice a model recognises — is the exact inversion this
 * whole review exists to prevent.
 */
const EXTERNAL_UNTRUSTED_TAG = 'External collaborator (untrusted, not the host)'

function messageTag(
  message: ChatMessage,
  participantTokens?: Map<string, string>,
  modelLabels?: Map<string, string>
): string {
  // Checked FIRST, ahead of every role branch. A future path that carries
  // external text on a `user` or `assistant` role must not be able to pick up
  // the host's tag by winning a race with the role checks below.
  if (isExternalUntrustedMessage(message)) return EXTERNAL_UNTRUSTED_TAG
  if (message.role === 'user') return 'User'
  // Inter-seat notes and yield handoffs use a system carrier so they do not
  // count as completed provider turns. They are still authored by the sending
  // seat: tag them with that seat's identity instead of lending them
  // TaskWraith's `System` authority.
  if (message.role === 'assistant' || isEnsembleParticipantAuthoredMessage(message)) {
    const provider = message.metadata?.ensembleProvider as ProviderId | undefined
    const role =
      typeof message.metadata?.ensembleRole === 'string' ? message.metadata.ensembleRole : ''
    if (provider) {
      // 1.0.7 — append the rename-stable participant handle (`#p3`)
      // when this message carries an `ensembleParticipantId` that maps
      // to a CURRENT roster seat. Messages from a participant since
      // removed from the roster (or older messages predating the id
      // stamp) carry no token and fall back to the bare provider/role
      // form. See `buildParticipantTokenMap` for why the token is
      // resolver-safe.
      const participantId =
        typeof message.metadata?.ensembleParticipantId === 'string'
          ? message.metadata.ensembleParticipantId
          : ''
      const token = participantId ? participantTokens?.get(participantId) : undefined
      const tokenSuffix = token ? ` #${token}` : ''
      // Same-provider duplicate on the CURRENT roster → include the model
      // label so transcript tags model the addressing form we want agents
      // to use (`@<model>` resolves; the bare provider tag is ambiguous).
      // Agents mimic what they read far more reliably than what a rule
      // tells them — make the unambiguous identity the visible one.
      const modelLabel = participantId ? modelLabels?.get(participantId) : undefined
      const modelSuffix = modelLabel ? ` (${modelLabel})` : ''
      return `${providerLabel(provider)}${role ? ` / ${role}` : ''}${modelSuffix}${tokenSuffix}`
    }
    return 'Assistant'
  }
  if (message.role === 'error') return 'Error'
  return 'System'
}

export function providerLabel(provider: ProviderId): string {
  return PROVIDER_LABELS[provider] || provider
}

function sanitizeText(value: unknown): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}
