import os from 'os'
import type { ChatMessage, ChatRecord } from '../store/types'
import { redactSecrets } from '../../shared/secretRedaction'
import { isRetiredExternalChannelInboundMessage } from '../LegacyExternalChannelHistory'
import {
  humanCollaboratorMetadata,
  isHumanCollaboratorComment
} from './HumanCollaboratorMessages'
import type { HumanCollaborationShare } from './HumanCollaborationStore'

/**
 * What a row IS, as opposed to who said it. `role` (below) answers the second
 * question and is kept for older collaborator builds; `kind` answers the first
 * and is what a parity surface renders from.
 */
export type HumanShareProjectionRowKind = 'message' | 'toolActivity' | 'system' | 'placeholder'

/**
 * A tool call as an external may see it: DERIVED facts only.
 *
 * Never a filtered copy of the real activity. `parameters`, `resultSummary`,
 * `outputPreview` and `rawResultEvent` are the fields that carry file contents,
 * shell commands and command output, and none of them appear here — not
 * redacted, absent. Redaction is a filter and fails open on the pattern nobody
 * anticipated; a whitelist of scalars cannot leak a novel secret format at all.
 *
 * This is also why removing per-tool-call EXPANSION app-wide made the external
 * side safe rather than merely tidier: with no body to show anywhere, there is
 * no body to ship.
 */
export interface HumanShareProjectionToolRow {
  /** Bare tool name — no arguments. */
  name: string
  category: 'task' | 'read' | 'write' | 'search' | 'shell' | 'unknown'
  /** True when the call failed or was denied. The external gets to know THAT it
   * failed; `why` is host business and lives in Raw Events, which they cannot
   * reach. */
  failed: boolean
  /** Path-collapsed, workspace-relative when it is inside the shared workspace. */
  target?: string
  additions?: number
  deletions?: number
  /** Whether the counts are measured or estimated, so a surface can present
   * them honestly rather than implying precision they do not have. */
  confidence?: 'exact' | 'estimated' | 'unknown'
}

export interface HumanShareProjectionRow {
  id: string
  role: 'host' | 'assistant' | 'collaborator' | 'placeholder'
  speaker: string
  preview: string
  truncated: boolean
  timestamp: string
  sequence?: number
  /** v2, additive. Absent on rows an older host produced. */
  kind?: HumanShareProjectionRowKind
  /**
   * Which SEAT authored this — a model participant id, or a collaboratorId for
   * an external. Lets the viewer tell self from other (own messages render as
   * bubbles, everyone else as named output) and lets each speaker carry their
   * own accent instead of every model flattening to "Assistant".
   */
  authorSeatId?: string
  /** Palette index for this author's accent. See the store's `colorIndex`. */
  colorIndex?: number
  /** Present only on `kind: 'toolActivity'`. */
  tools?: HumanShareProjectionToolRow[]
}

/** One seat as an external may see it. Deliberately omits `seatDisabled`: a
 * collaborator has no business learning the host's private mute state. */
export interface HumanShareProjectionSeat {
  seatId: string
  kind: 'model' | 'external'
  label: string
  order: number
  colorIndex?: number
  present?: boolean
}

export interface HumanShareProjection {
  schemaVersion: 1
  shareId: string
  chatId: string
  title: string
  generatedAt: string
  mode: 'readOnly' | 'comments'
  /**
   * P2b: the share's contribution-rules preset (display/affordance only — the
   * collaborator UI uses it to offer "request host action"; every actual
   * contribution is still validated main-side against the persisted rules).
   */
  contributionPreset?: 'readOnly' | 'comments' | 'requestHostAction' | 'autoDraft' | 'directLimited'
  participants: Array<{
    collaboratorId: string
    displayName: string
    status: string
  }>
  rows: HumanShareProjectionRow[]
  totalRows: number
  /**
   * Which collaborator is RECEIVING this projection.
   *
   * Without it an external cannot tell their own words from anyone else's, and
   * the presentation rule — only your own messages are bubbles, everyone else is
   * named transcript output — is unimplementable. The projection is already
   * built and sealed per session, so this costs nothing; it simply was never
   * carried.
   */
  youAre?: string
  /** The effective panel, so an external can render the seat row. */
  roster?: HumanShareProjectionSeat[]
}

export interface HumanShareProjectionOptions {
  maxRows?: number
  maxPreviewChars?: number
  /** Hard byte budget for the serialized projection (relay frame-cap safety). */
  maxBytes?: number
  generatedAt?: string
  hostLabel?: string
  /** The receiving collaborator, so the projection can say who "you" are. */
  viewerCollaboratorId?: string
  /** The effective panel (`resolveChatEffectiveRoster`). Supplying it lets each
   * speaker be named and accented; without it every model still flattens to
   * "Assistant", which is the pre-parity behaviour. */
  roster?: HumanShareProjectionSeat[]
  /** Resolve a seat id to its display label + accent. Lets an assistant row be
   * attributed without the builder knowing anything about rosters. */
  resolveSeat?: (seatId: string) => { label?: string; colorIndex?: number } | undefined
}

const DEFAULT_MAX_ROWS = 120
const DEFAULT_MAX_PREVIEW_CHARS = 1200
// Byte budget for the serialized projection. The transport seals it and the
// dumb relay CLOSES the whole connection (ws 1009) on a frame over 1 MiB, so the
// plaintext projection must stay well under that even after base64 (+~33%) +
// envelope overhead. Multibyte content (emoji/CJK) inflates bytes ~3-4× per
// char, so the row/char caps alone are not enough — we trim oldest rows until
// the serialized projection fits.
const DEFAULT_MAX_BYTES = 600_000

export function buildHumanShareProjection(
  chat: ChatRecord,
  share: HumanCollaborationShare,
  opts: HumanShareProjectionOptions = {}
): HumanShareProjection {
  const maxRows = clamp(opts.maxRows ?? DEFAULT_MAX_ROWS, 1, 300)
  const maxPreviewChars = clamp(opts.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS, 120, 4000)
  const maxBytes = clamp(opts.maxBytes ?? DEFAULT_MAX_BYTES, 8_000, 900_000)
  const projectable = (chat.messages || []).filter(
    (message) => Boolean(message?.id) && !isRetiredExternalChannelInboundMessage(message)
  )
  // One lookup table for the whole build rather than a scan per row.
  const seatById = new Map<string, { label?: string; colorIndex?: number }>()
  for (const seat of opts.roster || []) {
    seatById.set(seat.seatId, {
      label: seat.label,
      ...(typeof seat.colorIndex === 'number' ? { colorIndex: seat.colorIndex } : {})
    })
  }
  const resolveSeat = opts.resolveSeat ?? ((seatId: string) => seatById.get(seatId))
  const rows = projectable.slice(Math.max(0, projectable.length - maxRows)).map((message) =>
    projectRow(message, {
      maxPreviewChars,
      hostLabel: opts.hostLabel || 'Host',
      workspacePath: chat.workspacePath,
      resolveSeat
    })
  )
  const projection: HumanShareProjection = {
    schemaVersion: 1,
    shareId: share.shareId,
    chatId: chat.appChatId,
    title: sanitizeTitle(chat.title || 'Shared chat', chat.workspacePath),
    generatedAt: opts.generatedAt || new Date().toISOString(),
    mode: share.mode,
    ...(share.contributionRules?.preset
      ? { contributionPreset: share.contributionRules.preset }
      : {}),
    participants: share.participants.map((participant) => ({
      collaboratorId: participant.collaboratorId,
      displayName: participant.displayName,
      status: participant.status
    })),
    rows,
    totalRows: projectable.length,
    ...(opts.viewerCollaboratorId ? { youAre: opts.viewerCollaboratorId } : {}),
    // Seats are copied field-by-field, not spread: `seatDisabled` must never
    // reach a collaborator, and a spread would carry whatever the seat type
    // grows next.
    ...(opts.roster?.length
      ? {
          roster: opts.roster.map((seat) => ({
            seatId: seat.seatId,
            kind: seat.kind,
            label: seat.label,
            order: seat.order,
            ...(typeof seat.colorIndex === 'number' ? { colorIndex: seat.colorIndex } : {}),
            ...(typeof seat.present === 'boolean' ? { present: seat.present } : {})
          }))
        }
      : {})
  }
  // Byte-budget trim: drop OLDEST rows (keep the most recent context) until the
  // serialized projection fits, so a long/multibyte transcript can never produce
  // a frame the relay will reject.
  while (projection.rows.length > 1 && byteLength(projection) > maxBytes) {
    projection.rows.shift()
  }
  return projection
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/**
 * Derive the tool row an external may see. WHITELIST, not a filter — only the
 * scalars named here are ever read, so a field that starts carrying secrets
 * later cannot leak through this function by default.
 */
function projectToolActivities(
  message: ChatMessage,
  workspacePath?: string
): HumanShareProjectionToolRow[] {
  const activities = Array.isArray(message.toolActivities) ? message.toolActivities : []
  return activities.slice(0, 24).map((activity) => {
    const diff = activity.diffSummary
    const failed = activity.status === 'error'
    return {
      name: String(activity.toolName || 'tool').slice(0, 64),
      category: activity.category || 'unknown',
      failed,
      ...(activity.filePath
        ? { target: redactSensitivePaths(String(activity.filePath), workspacePath).slice(0, 240) }
        : {}),
      // A failed write changed nothing, so its claimed counts would be a lie —
      // the host transcript already suppresses them for exactly this reason.
      ...(!failed && typeof diff?.additions === 'number' ? { additions: diff.additions } : {}),
      ...(!failed && typeof diff?.deletions === 'number' ? { deletions: diff.deletions } : {}),
      ...(!failed && diff?.confidence ? { confidence: diff.confidence } : {})
    }
  })
}

function projectRow(
  message: ChatMessage,
  opts: {
    maxPreviewChars: number
    hostLabel: string
    workspacePath?: string
    resolveSeat?: (seatId: string) => { label?: string; colorIndex?: number } | undefined
  }
): HumanShareProjectionRow {
  if (isHumanCollaboratorComment(message)) {
    const metadata = humanCollaboratorMetadata(message)
    const seat = metadata?.collaboratorId ? opts.resolveSeat?.(metadata.collaboratorId) : undefined
    return {
      id: message.id,
      role: 'collaborator',
      speaker: metadata?.collaboratorDisplayName || 'Collaborator',
      ...preview(message.content, opts),
      timestamp: message.timestamp,
      kind: 'message',
      ...(metadata?.collaboratorId ? { authorSeatId: metadata.collaboratorId } : {}),
      ...(typeof seat?.colorIndex === 'number' ? { colorIndex: seat.colorIndex } : {}),
      ...(metadata ? { sequence: metadata.sequence } : {})
    }
  }
  if (message.role === 'user') {
    return {
      id: message.id,
      role: 'host',
      speaker: opts.hostLabel,
      ...preview(message.content, opts),
      timestamp: message.timestamp,
      kind: 'message'
    }
  }
  if (message.role === 'assistant') {
    // Every model used to flatten to the single speaker "Assistant", so an
    // external saw a named seat row above a transcript where nobody had a name.
    // `metadata` carries an index signature, so the field arrives untyped.
    const rawSeatId = message.metadata?.ensembleParticipantId
    const seatId = typeof rawSeatId === 'string' && rawSeatId ? rawSeatId : undefined
    const seat = seatId ? opts.resolveSeat?.(seatId) : undefined
    return {
      id: message.id,
      role: 'assistant',
      speaker: seat?.label || 'Assistant',
      ...preview(message.content, opts),
      timestamp: message.timestamp,
      kind: 'message',
      ...(seatId ? { authorSeatId: seatId } : {}),
      ...(typeof seat?.colorIndex === 'number' ? { colorIndex: seat.colorIndex } : {})
    }
  }
  if (message.role === 'tool') {
    // Tool rows CROSS now, as a derived one-liner — never a body. Per-tool-call
    // expansion was removed app-wide, so there is no expanded view to withhold:
    // what the host sees on the collapsed row is what an external sees.
    const tools = projectToolActivities(message, opts.workspacePath)
    return {
      id: message.id,
      role: 'placeholder',
      speaker: 'TaskWraith',
      preview: '',
      truncated: false,
      timestamp: message.timestamp,
      kind: 'toolActivity',
      ...(tools.length ? { tools } : {})
    }
  }
  return {
    id: message.id,
    role: 'placeholder',
    speaker: 'TaskWraith',
    preview: placeholderFor(message),
    truncated: false,
    timestamp: message.timestamp
  }
}

function preview(
  content: string,
  opts: { maxPreviewChars: number; workspacePath?: string }
): { preview: string; truncated: boolean } {
  // Scrub credentials BEFORE collapsing paths: model/tool output (and the
  // host's own prompts) can echo keys/tokens verbatim, and this is shown to an
  // external_untrusted collaborator. Paths are collapsed second so neither the
  // filesystem layout nor any secret survives into the projection.
  const sanitized = redactSensitivePaths(redactSecrets(content || ''), opts.workspacePath)
    .split('\u0000')
    .join('')
    .trim()
  const truncated = sanitized.length > opts.maxPreviewChars
  return {
    preview: truncated ? sanitized.slice(0, opts.maxPreviewChars).trimEnd() : sanitized,
    truncated
  }
}

function placeholderFor(message: ChatMessage): string {
  if (message.role === 'tool') return '[Tool activity hidden from collaborators]'
  if (message.role === 'error') return '[Error details hidden from collaborators]'
  return '[Internal TaskWraith message hidden from collaborators]'
}

// Absolute-path roots whose contents reveal the host filesystem layout. A path
// under any of these (and its WHOLE tail) is collapsed to a single marker so an
// external_untrusted collaborator learns neither the root nor the project
// sub-structure. Anchored to a leading `/<root>` word boundary so ordinary
// prose ("and/or", "TCP/IP", "https://…") is never mangled.
const SENSITIVE_PATH_ROOTS =
  'Users|Volumes|private|var|tmp|opt|etc|Library|Applications|System|Network|home|usr|srv|mnt|data|cores'
const SENSITIVE_PATH_RE = new RegExp(
  `/(?:${SENSITIVE_PATH_ROOTS})\\b(?:/[^\\s'"\`)\\]]*)?`,
  'gi'
)

function redactSensitivePaths(value: string, workspacePath?: string): string {
  let next = value
  // 1) Shared workspace: strip the absolute prefix but KEEP the in-scope
  //    relative tail — the collaborator is working on this repo, so
  //    `[workspace]/src/main.ts` is useful context, not a leak.
  if (workspacePath) next = replaceAll(next, workspacePath, '[workspace]')
  // 2) Host home: collapse the WHOLE path (tail included) — the home tail can
  //    reveal sibling projects/clients outside the shared workspace (the old
  //    code collapsed only `/Users/<name>` and leaked the remainder).
  next = collapsePrefixPath(next, os.homedir(), '[host-home]')
  // 3) Any remaining absolute path under a known filesystem root, tail included
  //    — fixes /Volumes, /private, /var/folders, /tmp, /opt, /etc, /Library, …
  //    which the old `/Users/<name>` regex missed entirely.
  next = next.replace(SENSITIVE_PATH_RE, '[path]')
  return next
}

function replaceAll(value: string, search: string, replacement: string): string {
  if (!search) return value
  return value.split(search).join(replacement)
}

// Replace `<prefix>` and `<prefix>/any/sub/path` with `marker` (tail included).
function collapsePrefixPath(value: string, prefix: string | undefined, marker: string): string {
  if (!prefix) return value
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return value.replace(new RegExp(`${escaped}(?:/[^\\s'"\`)\\]]*)?`, 'g'), marker)
}

function sanitizeTitle(title: string, workspacePath?: string): string {
  return redactSensitivePaths(redactSecrets(title), workspacePath)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}
