import type { ToolActivity } from './store/types'

const FILE_PATH_KEYS = [
  'file_path',
  'filePath',
  'path',
  'target',
  'target_file',
  'target_file_path',
  'source',
  'source_file',
  'source_file_path',
  'destination',
  'destination_file',
  'destination_file_path'
] as const

const MAX_TARGET_CHARS = 2_048
const MAX_URL_SCAN_CHARS = 16_384
const MAX_PARAMETER_NODES = 128
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi

function boundedTarget(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_TARGET_CHARS || /^https?:\/\//i.test(trimmed)) {
    return undefined
  }
  return trimmed
}

export function extractRemoteToolFilePath(activity: ToolActivity): string | undefined {
  const parameters = activity.parameters
  if (parameters) {
    for (const key of FILE_PATH_KEYS) {
      const target = boundedTarget(parameters[key])
      if (target) return target
    }
  }
  const direct = boundedTarget(activity.filePath)
  if (direct) return direct
  if (activity.diffSummary?.files?.length === 1) {
    return boundedTarget(activity.diffSummary.files[0]?.path)
  }
  return undefined
}

function trimUrlPunctuation(value: string): string {
  let next = value
  while (/[,.;:!?]$/.test(next)) next = next.slice(0, -1)
  const pairs: Array<[string, string]> = [
    [')', '('],
    [']', '['],
    ['}', '{']
  ]
  for (const [close, open] of pairs) {
    while (next.endsWith(close) && next.split(close).length > next.split(open).length) {
      next = next.slice(0, -1)
    }
  }
  return next
}

function normalizeHttpUrl(value: string): string | undefined {
  const trimmed = trimUrlPunctuation(value.trim())
  if (!trimmed || trimmed.length > MAX_TARGET_CHARS) return undefined
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.username = ''
    url.password = ''
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

function collectParameterStrings(value: unknown): string[] {
  const strings: string[] = []
  let visited = 0
  const visit = (candidate: unknown, depth: number): void => {
    if (visited >= MAX_PARAMETER_NODES || depth > 4) return
    visited += 1
    if (typeof candidate === 'string') {
      strings.push(candidate)
      return
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1)
      return
    }
    if (candidate && typeof candidate === 'object') {
      for (const item of Object.values(candidate as Record<string, unknown>)) {
        visit(item, depth + 1)
      }
    }
  }
  visit(value, 0)
  return strings
}

export function extractRemoteToolUrls(activity: ToolActivity, limit = 5): string[] {
  const cap = Math.max(0, Math.min(12, Math.floor(limit)))
  if (cap === 0) return []
  const sources = [
    ...collectParameterStrings(activity.parameters),
    activity.resultSummary,
    activity.outputPreview
  ]
  const urls: string[] = []
  const seen = new Set<string>()
  for (const source of sources) {
    if (typeof source !== 'string' || !/https?:\/\//i.test(source)) continue
    const matches = source.slice(0, MAX_URL_SCAN_CHARS).match(URL_PATTERN) ?? []
    for (const match of matches) {
      const normalized = normalizeHttpUrl(match)
      if (!normalized || seen.has(normalized)) continue
      seen.add(normalized)
      urls.push(normalized)
      if (urls.length >= cap) return urls
    }
  }
  return urls
}

export interface RemoteToolDetailProjection {
  detail?: string
  truncated?: boolean
}

export function projectRemoteToolDetail(
  activity: ToolActivity,
  maxChars = 1_200
): RemoteToolDetailProjection {
  const cap = Math.max(0, Math.floor(maxChars))
  const detail = activity.resultSummary?.trim()
  if (!detail || cap === 0) return {}
  if (detail.length <= cap) return { detail }
  return {
    detail: detail.slice(0, Math.max(0, cap - 3)).trimEnd() + '...',
    truncated: true
  }
}
