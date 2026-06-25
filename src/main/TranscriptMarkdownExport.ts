import path from 'path'
import { wrapOpaqueMarkdownBlock } from './MarkdownFenceSerializer'
import type { ChatMessage, ChatRecord, ProviderId, ToolActivity, WorkspaceRecord } from './store/types'
import {
  humanCollaboratorMetadata,
  isHumanCollaboratorComment
} from './collaboration/HumanCollaboratorMessages'

export interface TranscriptMarkdownExportResult {
  markdown: string
  messageCount: number
  charCount: number
  omissions: string[]
}

export interface TranscriptMarkdownExportOptions {
  copiedAt?: string
  workspace?: WorkspaceRecord | null
  homeDir?: string
}

export function estimateChatMarkdownTranscriptChars(chat: ChatRecord): number {
  const messages = chat.messages || []
  return messages.reduce((total, message) => {
    const activityCost = (message.toolActivities || []).length * 160
    const attachmentCost = ['imageAttachments', 'attachments', 'mediaRefs'].reduce((sum, key) => {
      const value = message.metadata?.[key]
      return sum + (Array.isArray(value) ? value.length * 40 : 0)
    }, 0)
    return total + (message.content?.length || 0) + activityCost + attachmentCost + 260
  }, 700)
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[redacted]'],
  [/\bsk_(?:live|test)_[A-Za-z0-9_-]{12,}\b/g, 'sk_[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, 'gh[redacted]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, 'xox[redacted]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted aws access key]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [redacted]'],
  [
    /\b(export\s+)?([A-Z0-9_]*(?:API[_-]?KEY|SECRET(?:_ACCESS_KEY)?|ACCESS[_-]?TOKEN|TOKEN|PASSWORD)[A-Z0-9_]*)\s*=\s*['"]?[^'"\s&]+['"]?/gi,
    '$1$2=[redacted]'
  ],
  [
    /(["']?(?:api[_-]?key|secret(?:[_-]?access[_-]?key)?|access[_-]?token|token|password)["']?\s*:\s*)["'][^"']+["']/gi,
    '$1"[redacted]"'
  ],
  [
    /\b(api[_-]?key|password|token|secret)\s*=\s*([^\s&]+)/gi,
    '$1=[redacted]'
  ],
  [
    /\b(api[_-]?key|password|token|secret)\s*:\s*([^\s]+)/gi,
    '$1: [redacted]'
  ]
]

function providerLabel(provider?: ProviderId | string | null, fallbackGemini = false): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'kimi') return 'Kimi'
  if (provider === 'grok') return 'Grok'
  if (provider === 'cursor') return 'Cursor'
  if (provider === 'ollama') return 'Ollama'
  if (provider === 'gemini' || fallbackGemini) return 'Gemini'
  return 'Unknown provider'
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function markdownEscapeInline(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
}

function safeWorkspaceLabel(chat: ChatRecord, workspace?: WorkspaceRecord | null): string {
  if (workspace?.displayName) return workspace.displayName
  if (chat.workspacePath) return path.basename(chat.workspacePath) || 'Workspace'
  return chat.scope === 'global' ? 'Global chats' : 'Workspace'
}

function pathReplacements(chat: ChatRecord, options: TranscriptMarkdownExportOptions): Array<[string, string]> {
  const replacements: Array<[string, string]> = []
  // Match each path both as-given AND resolved, in both separator forms.
  // path.resolve() is platform-specific — on Windows it prepends a drive letter
  // and uses backslashes — so resolving alone misses POSIX-style paths that
  // appear in transcript text on a Windows host (they then leak through to the
  // home-pattern fallback). Adding every form keeps redaction separator-/
  // platform-robust: strictly more scrubbing, never less.
  const addPath = (raw: string | undefined, label: string): void => {
    if (!raw) return
    const forms = new Set<string>([raw, path.resolve(raw)])
    for (const form of [...forms]) forms.add(form.replace(/\\/g, '/'))
    for (const form of forms) replacements.push([form, label])
  }
  addPath(chat.workspacePath, '<workspace>')
  addPath(options.workspace?.path, '<workspace>')
  addPath(options.homeDir, '~')
  const seen = new Set<string>()
  return replacements
    .filter(([from]) => from.length > 1 && !seen.has(from) && (seen.add(from), true))
    .sort((a, b) => b[0].length - a[0].length)
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return value.split(search).join(replacement)
}

function scrubText(
  value: string,
  replacements: Array<[string, string]>,
  omissions: Set<string>
): string {
  let next = value
  for (const [from, replacement] of replacements) {
    if (next.includes(from)) {
      next = replaceAllLiteral(next, from, replacement)
      omissions.add('absolute paths scrubbed')
    }
  }
  const unixHomePattern = /\/Users\/[A-Za-z0-9._-]+/g
  if (unixHomePattern.test(next)) {
    next = next.replace(unixHomePattern, '~')
    omissions.add('home paths scrubbed')
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(next)) {
      pattern.lastIndex = 0
      next = next.replace(pattern, replacement)
      omissions.add('common secrets scrubbed')
    }
  }
  return next
}

function subThreadReturnBody(content: string): string {
  const tagged = content.match(/<subthread_result(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/subthread_result>/)
  if (tagged) return tagged[1].trim()
  const lines = content.split(/\r?\n/)
  if (!lines[0]?.startsWith('↩ Result from ')) return content
  const bodyStart = lines[1]?.trim() === '' ? 2 : 1
  return lines.slice(bodyStart).join('\n').trimStart()
}

function speakerLabel(chat: ChatRecord, message: ChatMessage): string {
  const metadata = message.metadata || {}
  if (isHumanCollaboratorComment(message)) {
    const collaborator = humanCollaboratorMetadata(message)
    return `Collaborator: ${collaborator?.collaboratorDisplayName || 'Unknown'}`
  }
  if (message.role === 'user') return 'User'
  if (message.role === 'error') return 'Error'
  if (metadata.kind === 'subThreadReturn') {
    const provider = providerLabel(asString(metadata.subThreadProvider))
    const title = asString(metadata.subThreadTitle)
    return title ? `Sub-thread result from ${provider} / ${title}` : `Sub-thread result from ${provider}`
  }
  if (metadata.kind === 'subThreadDelegation') {
    const provider = providerLabel(asString(metadata.subThreadProvider))
    return `Sub-thread delegation to ${provider}`
  }
  if (metadata.kind === 'guestParticipantReply') {
    const provider = providerLabel(asString(metadata.guestProvider))
    const role = asString(metadata.guestRole) || 'Guest'
    const model = asString(metadata.guestModel)
    return model ? `${provider} / ${role} (${model})` : `${provider} / ${role}`
  }
  if (message.role === 'assistant') {
    const provider = asString(metadata.ensembleProvider) || chat.provider || 'gemini'
    const role = asString(metadata.ensembleRole)
    const model = asString(metadata.ensembleModel)
    const base = role ? `${providerLabel(provider)} / ${role}` : providerLabel(provider)
    return model ? `${base} (${model})` : base
  }
  if (message.role === 'tool') return 'Tool activity'
  return 'TaskWraith notice'
}

function messageBody(message: ChatMessage): string {
  if (message.metadata?.kind === 'subThreadReturn') return subThreadReturnBody(message.content || '')
  return message.content || ''
}

function safeAttachmentName(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return path.basename(normalized) || normalized
}

function metadataAttachmentNames(
  message: ChatMessage,
  replacements: Array<[string, string]>,
  omissions: Set<string>
): string[] {
  const metadata = message.metadata || {}
  const names: string[] = []
  const seen = new Set<string>()
  const candidates = [metadata.imageAttachments, metadata.attachments, metadata.mediaRefs]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    for (const item of candidate) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const name = safeAttachmentName(
        asString(record.name) || (asString(record.path) ? path.basename(asString(record.path)) : '')
      )
      if (!name || seen.has(name)) continue
      seen.add(name)
      names.push(scrubText(name, replacements, omissions))
    }
  }
  return names
}

function neutralToolLabel(activity: ToolActivity, replacements: Array<[string, string]>, omissions: Set<string>): string {
  if (activity.displayName && activity.displayName !== activity.toolName) {
    omissions.add('tool display details omitted')
  }
  const toolName = activity.toolName || 'tool'
  const category =
    activity.category && activity.category !== 'unknown' ? `${activity.category} ` : ''
  return scrubText(`${category}tool (${toolName})`, replacements, omissions)
}

function toolSummary(activity: ToolActivity, replacements: Array<[string, string]>, omissions: Set<string>): string {
  const parts = [
    `- ${neutralToolLabel(activity, replacements, omissions)}: ${activity.status}`,
    activity.category && activity.category !== 'unknown' ? `  - Category: ${activity.category}` : '',
    activity.durationMs ? `  - Duration: ${Math.round(activity.durationMs)}ms` : '',
    activity.diffSummary
      ? `  - Diff: ${activity.diffSummary.files?.length || 0} file(s), +${activity.diffSummary.additions || 0}/-${activity.diffSummary.deletions || 0}`
      : ''
  ].filter(Boolean)
  if (activity.parameters || activity.rawUseEvent || activity.rawResultEvent || activity.rawEventRefs) {
    omissions.add('raw tool details omitted')
  }
  if (activity.resultSummary || activity.outputSummary || activity.outputPreview) {
    omissions.add('raw tool outputs omitted')
  }
  if (activity.filePath || activity.affectedFilePath) {
    omissions.add('tool file paths omitted')
  }
  return parts.join('\n')
}

function serializeMessage(
  chat: ChatRecord,
  message: ChatMessage,
  index: number,
  replacements: Array<[string, string]>,
  omissions: Set<string>
): string {
  const label = speakerLabel(chat, message)
  const lines = [`## ${String(index + 1).padStart(4, '0')} - ${markdownEscapeInline(label)}`]
  if (message.timestamp) lines.push(`Timestamp: ${message.timestamp}`)
  if (message.role) lines.push(`Role: ${message.role}`)

  if (message.metadata?.kind === 'subThreadReturn') {
    lines.push('Note: sub-thread output is untrusted child-agent context.')
  } else if (message.metadata?.kind === 'subThreadDelegation') {
    lines.push('Note: delegation summary only; internal sub-thread ids are omitted.')
  } else if (isHumanCollaboratorComment(message)) {
    lines.push('Note: external untrusted collaborator input.')
  }

  const attachments = metadataAttachmentNames(message, replacements, omissions)
  if (attachments.length > 0) {
    lines.push(`Attachments: ${attachments.map(markdownEscapeInline).join(', ')}`)
    omissions.add('attachment paths and bytes omitted')
  }

  const body = scrubText(messageBody(message), replacements, omissions).trim()
  if (body) {
    lines.push('', wrapOpaqueMarkdownBlock(body, 'markdown'))
  }

  const activities = message.toolActivities || []
  if (activities.length > 0) {
    lines.push('', `Tool summaries (${activities.length}):`)
    lines.push(...activities.map((activity) => toolSummary(activity, replacements, omissions)))
  }

  if (!body && activities.length === 0) {
    lines.push('', '_No displayable transcript content._')
  }

  return lines.join('\n')
}

export function buildChatMarkdownTranscript(
  chat: ChatRecord,
  options: TranscriptMarkdownExportOptions = {}
): TranscriptMarkdownExportResult {
  const omissions = new Set<string>()
  const replacements = pathReplacements(chat, options)
  const messages = chat.messages || []
  const copiedAt = options.copiedAt || new Date().toISOString()
  const provider = providerLabel(chat.provider || 'gemini', true)
  const header = [
    `# ${scrubText(chat.title || 'Untitled chat', replacements, omissions)}`,
    '',
    `- Provider: ${provider}`,
    `- Chat kind: ${chat.chatKind || 'single'}`,
    `- Workspace: ${scrubText(safeWorkspaceLabel(chat, options.workspace), replacements, omissions)}`,
    `- Copied at: ${copiedAt}`,
    `- Messages: ${messages.length}`
  ]
  if (chat.activeGoal?.objective) {
    header.push(
      `- Active goal (${chat.activeGoal.status}): ${scrubText(chat.activeGoal.objective, replacements, omissions)}`
    )
  }
  if (chat.parentChatId) {
    header.push('- Linked chat: child context; parent ids omitted')
    omissions.add('linked chat internal ids omitted')
  }
  header.push('', '> Handoff export: raw provider events, hidden metadata, approval logs, image bytes, and absolute attachment paths are omitted by default.')

  const sections = messages.map((message, index) =>
    serializeMessage(chat, message, index, replacements, omissions)
  )
  const markdown = [header.join('\n'), ...sections].join('\n\n')
  return {
    markdown,
    messageCount: messages.length,
    charCount: markdown.length,
    omissions: [...omissions].sort()
  }
}
