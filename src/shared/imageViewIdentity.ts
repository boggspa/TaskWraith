import {
  compactToolIdentifier,
  resolveCanonicalToolName,
  stripToolNamespace
} from './canonicalToolCoalesce'

export const IMAGE_VIEW_TOOL_NAME = 'image_view' as const
export const IMAGE_VIEW_DISPLAY_NAME = 'Image View' as const

const RASTER_IMAGE_PATH = /\.(?:png|jpe?g|webp|gif|bmp)(?:[?#].*)?$/i

const IMAGE_VIEW_COMPACT_NAMES = new Set([
  'imageview',
  'viewimage',
  'inspectimage',
  'openimage',
  'readimage',
  'displayimage'
])

// These tools differ in where their pixels originate, but all represent the
// same user-visible act in a transcript: the seat looked at one or more raster
// frames. Their original invocation remains available on rawUseEvent for audit.
const IMAGE_RETURNING_COMPACT_NAMES = new Set([
  'appshots',
  'appwatchlatestframe',
  'appwatchframes',
  'attachedwindowcapture',
  'browserscreenshot',
  'canvasscreenshot',
  'simulatorscreenshot'
])

const GENERIC_FILE_VIEW_COMPACT_NAMES = new Set([
  'read',
  'readfile',
  'openfile',
  'viewfile',
  'openworkspacefile'
])

const WRAPPER_COMPACT_NAMES = new Set([
  'exec',
  'execute',
  'calltool',
  'usetool',
  'mcp',
  'runjavascript'
])

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        // Provider argument strings are often code rather than JSON.
      }
    }
    return { code: value }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function positiveInt(value: unknown): number | undefined {
  const number =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : undefined
}

function valuesForKeys(record: Record<string, unknown>, keys: readonly string[]): unknown[] {
  return keys.flatMap((key) => (key in record ? [record[key]] : []))
}

function rasterPathsInString(value: string): string[] {
  const matches = value.match(
    /(?:[A-Za-z]:\\|\.?\.?\/|\/)?[^\s"'`<>()[\]{},;]+\.(?:png|jpe?g|webp|gif|bmp)(?:[?#][^\s"'`<>()[\]{},;]*)?/gi
  )
  return matches ?? []
}

function imageSourceCount(value: unknown, depth = 0): number {
  if (depth > 4 || value == null) return 0
  if (typeof value === 'string') return rasterPathsInString(value).length
  if (Array.isArray(value)) {
    if (value.length === 0) return 0
    const nested = value.reduce((count, item) => count + imageSourceCount(item, depth + 1), 0)
    // Media ids do not carry extensions. An explicitly image-oriented array is
    // counted by its caller; generic nested arrays require visible image paths.
    return nested
  }
  if (typeof value !== 'object') return 0
  return Object.values(value as Record<string, unknown>).reduce<number>(
    (count, item) => count + imageSourceCount(item, depth + 1),
    0
  )
}

function explicitImageSourceCount(parameters: Record<string, unknown>): number {
  const imageArrays = valuesForKeys(parameters, [
    'paths',
    'sourcePaths',
    'source_paths',
    'sourceMediaIds',
    'source_media_ids',
    'mediaIds',
    'media_ids',
    'images',
    'frames'
  ])
  const arrayCount = imageArrays.reduce<number>(
    (count, value) => count + (Array.isArray(value) ? value.length : 0),
    0
  )
  const singularCount = valuesForKeys(parameters, [
    'path',
    'filePath',
    'file_path',
    'sourcePath',
    'source_path',
    'sourceMediaId',
    'source_media_id',
    'mediaId',
    'media_id'
  ]).filter((value) => typeof value === 'string' && value.trim()).length
  return arrayCount + singularCount
}

function parametersContainRasterImage(parameters: Record<string, unknown>): boolean {
  if (explicitImageSourceCount(parameters) > 0) {
    const pathValues = valuesForKeys(parameters, [
      'path',
      'filePath',
      'file_path',
      'sourcePath',
      'source_path',
      'paths',
      'sourcePaths',
      'source_paths'
    ])
    if (pathValues.some((value) => imageSourceCount(value) > 0)) return true
    if (
      valuesForKeys(parameters, [
        'sourceMediaId',
        'source_media_id',
        'mediaId',
        'media_id',
        'sourceMediaIds',
        'source_media_ids',
        'mediaIds',
        'media_ids'
      ]).some(Boolean)
    ) {
      return true
    }
  }
  const mimeType = String(parameters.mimeType || parameters.mime_type || '')
  return mimeType.toLowerCase().startsWith('image/')
}

function wrapperInvokesImageViewer(parameters: Record<string, unknown>): boolean {
  const text = valuesForKeys(parameters, [
    'code',
    'script',
    'command',
    'input',
    'arguments',
    'args',
    'payload'
  ])
    .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
    .join('\n')
  return /(?:tools\s*\.\s*)?view_image\s*\(|\bimage_view\s*\(/i.test(text)
}

/**
 * Coalesce provider-native image viewers and TaskWraith screenshot producers
 * onto one transcript identity. This is a display/activity projection only;
 * dispatch continues to use the exact raw tool name.
 */
export function canonicalImageViewToolName(rawToolName: string, rawParameters?: unknown): string {
  const parameters = recordValue(rawParameters)
  const canonical = resolveCanonicalToolName(rawToolName)
  if (canonical === IMAGE_VIEW_TOOL_NAME) return IMAGE_VIEW_TOOL_NAME

  const compact = compactToolIdentifier(stripToolNamespace(rawToolName))
  if (IMAGE_VIEW_COMPACT_NAMES.has(compact)) return IMAGE_VIEW_TOOL_NAME
  if (IMAGE_RETURNING_COMPACT_NAMES.has(compact)) return IMAGE_VIEW_TOOL_NAME
  if (GENERIC_FILE_VIEW_COMPACT_NAMES.has(compact) && parametersContainRasterImage(parameters)) {
    return IMAGE_VIEW_TOOL_NAME
  }
  if (WRAPPER_COMPACT_NAMES.has(compact) && wrapperInvokesImageViewer(parameters)) {
    return IMAGE_VIEW_TOOL_NAME
  }
  return rawToolName
}

export function isImageViewToolUse(rawToolName: string, rawParameters?: unknown): boolean {
  return canonicalImageViewToolName(rawToolName, rawParameters) === IMAGE_VIEW_TOOL_NAME
}

export function imageViewCountFromParameters(rawParameters: unknown): number | undefined {
  const parameters = recordValue(rawParameters)
  const explicit = positiveInt(
    parameters.imageCount ??
      parameters.image_count ??
      parameters.frameCount ??
      parameters.frame_count ??
      parameters.returned
  )
  if (explicit) return explicit

  const sources = explicitImageSourceCount(parameters)
  if (sources > 0) return sources

  const requested = positiveInt(parameters.count)
  if (requested) return requested

  const codeCount = imageSourceCount(parameters)
  return codeCount > 0 ? codeCount : undefined
}

function imageBlocksInEnvelope(value: unknown): number {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return 0
    try {
      return imageBlocksInEnvelope(JSON.parse(trimmed))
    } catch {
      return 0
    }
  }
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + imageBlocksInEnvelope(item), 0)
  }
  if (!value || typeof value !== 'object') return 0
  const record = value as Record<string, unknown>
  if (record.type === 'image' || record.type === 'input_image') return 1
  const candidates = ['content', 'result', 'output', 'structuredContent', 'structured_content']
  // Providers often repeat the same envelope under `result`, `output`, and
  // top-level `content`. Take the strongest representation instead of adding
  // duplicates and reporting three views for one returned image.
  return Math.max(
    0,
    ...candidates.map((key) => (key in record ? imageBlocksInEnvelope(record[key]) : 0))
  )
}

export function imageViewCountFromResult(rawResult: unknown): number | undefined {
  const blockCount = imageBlocksInEnvelope(rawResult)
  if (blockCount > 0) return blockCount

  const result = recordValue(rawResult)
  const explicit = positiveInt(
    result.imageCount ??
      result.image_count ??
      result.frameCount ??
      result.frame_count ??
      result.returned
  )
  return explicit
}

export function resolveImageViewCount(rawParameters: unknown, rawResult?: unknown): number {
  return imageViewCountFromResult(rawResult) ?? imageViewCountFromParameters(rawParameters) ?? 1
}

export function isRasterImagePath(value: unknown): boolean {
  return typeof value === 'string' && RASTER_IMAGE_PATH.test(value.trim())
}
