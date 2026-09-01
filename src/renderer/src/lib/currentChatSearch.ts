import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import { buildTranscriptRowKeys } from './transcriptRowKey'

export interface CurrentChatSearchTarget {
  messageId: string
  rowKey: string
  label: string
  text: string
}

export interface CurrentChatSearchMatch extends CurrentChatSearchTarget {
  preview: string
}

export interface CurrentChatSearchOptions {
  assistantLabel?: (message: ChatMessage) => string | undefined
}

const SKIPPED_OBJECT_KEYS = new Set([
  'dataBase64',
  'encryptedClientSecret',
  'imagePaths',
  'imageThumbnails',
  'mediaRefs',
  'rawEventRefs',
  'rawResultEvent',
  'rawUseEvent'
])

export function normalizeCurrentChatSearchQuery(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase()
}

function collectStringValues(value: unknown, out: string[], depth = 0): void {
  if (depth > 4 || value == null) return
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) out.push(trimmed)
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out, depth + 1)
    return
  }
  if (typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SKIPPED_OBJECT_KEYS.has(key)) continue
    collectStringValues(item, out, depth + 1)
  }
}

function toolActivitySearchText(activity: ToolActivity): string {
  const parts: string[] = [
    activity.displayName,
    activity.toolName,
    activity.category,
    activity.status,
    activity.filePath,
    activity.affectedFilePath,
    activity.resultSummary,
    activity.outputSummary,
    activity.outputPreview
  ].filter((part): part is string => Boolean(part))
  collectStringValues(activity.parameters, parts)
  collectStringValues(activity.diffSummary, parts)
  return parts.join('\n')
}

function messageLabel(message: ChatMessage, options?: CurrentChatSearchOptions): string {
  if (message.metadata?.kind === 'providerRunFailure') return 'Provider failure'
  if (message.role === 'tool') return 'Tool'
  if (message.role === 'system') return 'System'
  if (message.role === 'error') return 'Error'
  if (message.role === 'assistant') return options?.assistantLabel?.(message) || 'Assistant'
  return 'You'
}

function isRetiredExternalChannelInboundMessage(message: ChatMessage): boolean {
  return message.metadata?.kind === 'channelInbound'
}

export function currentChatSearchTextForMessage(
  message: ChatMessage,
  options?: CurrentChatSearchOptions
): string {
  if (isRetiredExternalChannelInboundMessage(message)) return ''
  const parts: string[] = [messageLabel(message, options), message.role, message.content].filter(
    (part): part is string => Boolean(part)
  )
  collectStringValues(message.metadata, parts)
  for (const activity of message.toolActivities || []) {
    parts.push(toolActivitySearchText(activity))
  }
  return parts.join('\n')
}

export function buildCurrentChatSearchTargets(
  messages: readonly ChatMessage[],
  options?: CurrentChatSearchOptions
): CurrentChatSearchTarget[] {
  // Keys come from the UNFILTERED list: a search hit has to scroll to the row
  // the transcript actually rendered, and retired rows still occupy an
  // occurrence slot in that walk.
  const rowKeys = buildTranscriptRowKeys(messages)
  return messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => !isRetiredExternalChannelInboundMessage(message))
    .map(({ message, index }) => ({
      messageId: message.id,
      rowKey: rowKeys[index],
      label: messageLabel(message, options),
      text: currentChatSearchTextForMessage(message, options)
    }))
}

function buildPreview(text: string, normalizedQuery: string): string {
  const normalizedText = text.toLowerCase()
  const index = normalizedText.indexOf(normalizedQuery)
  if (index < 0) return text.replace(/\s+/g, ' ').trim().slice(0, 120)
  const start = Math.max(0, index - 42)
  const end = Math.min(text.length, index + normalizedQuery.length + 78)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

export function findCurrentChatSearchMatches(
  targets: readonly CurrentChatSearchTarget[],
  query: string
): CurrentChatSearchMatch[] {
  const normalizedQuery = normalizeCurrentChatSearchQuery(query)
  if (!normalizedQuery) return []
  return targets
    .filter((target) => normalizeCurrentChatSearchQuery(target.text).includes(normalizedQuery))
    .map((target) => ({
      ...target,
      preview: buildPreview(target.text, normalizedQuery)
    }))
}
