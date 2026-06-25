import os from 'os'
import type { ChatMessage, ChatRecord } from '../store/types'
import { redactSecrets } from '../../shared/secretRedaction'
import {
  humanCollaboratorMetadata,
  isHumanCollaboratorComment
} from './HumanCollaboratorMessages'
import type { HumanCollaborationShare } from './HumanCollaborationStore'

export interface HumanShareProjectionRow {
  id: string
  role: 'host' | 'assistant' | 'collaborator' | 'placeholder'
  speaker: string
  preview: string
  truncated: boolean
  timestamp: string
  sequence?: number
}

export interface HumanShareProjection {
  schemaVersion: 1
  shareId: string
  chatId: string
  title: string
  generatedAt: string
  mode: 'readOnly' | 'comments'
  participants: Array<{
    collaboratorId: string
    displayName: string
    status: string
  }>
  rows: HumanShareProjectionRow[]
  totalRows: number
}

export interface HumanShareProjectionOptions {
  maxRows?: number
  maxPreviewChars?: number
  /** Hard byte budget for the serialized projection (relay frame-cap safety). */
  maxBytes?: number
  generatedAt?: string
  hostLabel?: string
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
  const projectable = (chat.messages || []).filter((message) => Boolean(message?.id))
  const rows = projectable.slice(Math.max(0, projectable.length - maxRows)).map((message) =>
    projectRow(message, {
      maxPreviewChars,
      hostLabel: opts.hostLabel || 'Host',
      workspacePath: chat.workspacePath
    })
  )
  const projection: HumanShareProjection = {
    schemaVersion: 1,
    shareId: share.shareId,
    chatId: chat.appChatId,
    title: sanitizeTitle(chat.title || 'Shared chat', chat.workspacePath),
    generatedAt: opts.generatedAt || new Date().toISOString(),
    mode: share.mode,
    participants: share.participants.map((participant) => ({
      collaboratorId: participant.collaboratorId,
      displayName: participant.displayName,
      status: participant.status
    })),
    rows,
    totalRows: projectable.length
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

function projectRow(
  message: ChatMessage,
  opts: { maxPreviewChars: number; hostLabel: string; workspacePath?: string }
): HumanShareProjectionRow {
  if (isHumanCollaboratorComment(message)) {
    const metadata = humanCollaboratorMetadata(message)
    return {
      id: message.id,
      role: 'collaborator',
      speaker: metadata?.collaboratorDisplayName || 'Collaborator',
      ...preview(message.content, opts),
      timestamp: message.timestamp,
      ...(metadata ? { sequence: metadata.sequence } : {})
    }
  }
  if (message.role === 'user') {
    return {
      id: message.id,
      role: 'host',
      speaker: opts.hostLabel,
      ...preview(message.content, opts),
      timestamp: message.timestamp
    }
  }
  if (message.role === 'assistant') {
    return {
      id: message.id,
      role: 'assistant',
      speaker: 'Assistant',
      ...preview(message.content, opts),
      timestamp: message.timestamp
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
    .replace(/\u0000/g, '')
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
