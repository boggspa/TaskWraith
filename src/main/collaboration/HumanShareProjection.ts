import os from 'os'
import type { ChatMessage, ChatRecord } from '../store/types'
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
  generatedAt?: string
  hostLabel?: string
}

const DEFAULT_MAX_ROWS = 120
const DEFAULT_MAX_PREVIEW_CHARS = 1200

export function buildHumanShareProjection(
  chat: ChatRecord,
  share: HumanCollaborationShare,
  opts: HumanShareProjectionOptions = {}
): HumanShareProjection {
  const maxRows = clamp(opts.maxRows ?? DEFAULT_MAX_ROWS, 1, 300)
  const maxPreviewChars = clamp(opts.maxPreviewChars ?? DEFAULT_MAX_PREVIEW_CHARS, 120, 4000)
  const projectable = (chat.messages || []).filter((message) => Boolean(message?.id))
  const rows = projectable.slice(Math.max(0, projectable.length - maxRows)).map((message) =>
    projectRow(message, {
      maxPreviewChars,
      hostLabel: opts.hostLabel || 'Host',
      workspacePath: chat.workspacePath
    })
  )
  return {
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
  const sanitized = redactSensitivePaths(content || '', opts.workspacePath)
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

function redactSensitivePaths(value: string, workspacePath?: string): string {
  let next = value
  const home = os.homedir()
  if (home) next = replaceAll(next, home, '[host-home]')
  if (workspacePath) next = replaceAll(next, workspacePath, '[workspace]')
  next = next.replace(/\/Users\/[^/\s]+/g, '[host-home]')
  return next
}

function replaceAll(value: string, search: string, replacement: string): string {
  if (!search) return value
  return value.split(search).join(replacement)
}

function sanitizeTitle(title: string, workspacePath?: string): string {
  return redactSensitivePaths(title, workspacePath)
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 120)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}
