import type { ChatMessage } from '../../../main/store/types'
import { truncateUserMessagePreview } from './UserMessageCollapse'
import { sumHeights, type VirtualRow } from './TranscriptVirtualWindow'

const GUTTER_PREVIEW_THRESHOLDS = {
  maxLines: 4,
  maxChars: 320,
  previewLines: 4,
  previewChars: 320
}

export interface TranscriptUserGutterMarker {
  key: string
  messageId: string
  rowKey: string
  ordinal: number
  topPercent: number
  title: string
  preview: string
  message: ChatMessage
}

function compactInlineText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function truncateInlineText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const slice = value.slice(0, maxChars)
  const lastSpace = slice.search(/\s\S*$/)
  const trimmed = lastSpace > 24 ? slice.slice(0, lastSpace) : slice
  return `${trimmed.replace(/\s+$/, '')}...`
}

export function userGutterTitle(content: string): string {
  const firstLine = content
    .split('\n')
    .map((line) => compactInlineText(line))
    .find((line) => line.length > 0)
  if (!firstLine) return 'User message'
  return truncateInlineText(firstLine, 96)
}

export function userGutterPreview(content: string): string {
  const trimmed = content.trim()
  if (!trimmed) return ''
  return truncateUserMessagePreview(trimmed, GUTTER_PREVIEW_THRESHOLDS)
}

export function buildTranscriptUserGutterMarkers(
  messages: readonly ChatMessage[],
  rows: readonly VirtualRow[],
  rowHeights?: readonly number[]
): TranscriptUserGutterMarker[] {
  if (!Array.isArray(messages) || messages.length === 0 || rows.length === 0) return []

  const heights = rows.map((row, index) => {
    const measured = rowHeights?.[index]
    return typeof measured === 'number' && Number.isFinite(measured) && measured > 0
      ? measured
      : row.estimatedHeight
  })
  const totalHeight = Math.max(1, sumHeights(heights, 0, heights.length))
  const markers: TranscriptUserGutterMarker[] = []

  for (const row of rows) {
    const message = messages[row.index]
    if (!message || message.role !== 'user') continue

    const rowTop = sumHeights(heights, 0, row.index)
    const midpoint = rowTop + Math.max(0, row.estimatedHeight) / 2
    const topPercent = Math.max(0, Math.min(100, (midpoint / totalHeight) * 100))
    const ordinal = markers.length + 1
    markers.push({
      key: row.rowKey,
      messageId: message.id,
      rowKey: row.rowKey,
      ordinal,
      topPercent,
      title: userGutterTitle(message.content || ''),
      preview: userGutterPreview(message.content || ''),
      message
    })
  }

  return markers
}
