import path from 'path'
import type { TranscriptMediaAssetStore } from '../services/TranscriptMediaAssetStore'
import {
  validateWorkspaceImagePath,
  type TranscriptMediaThumbnailer
} from '../services/TranscriptMediaService'
import type { TranscriptMediaRef } from '../store/types'
import { BLACKBOARD_MAX_IMAGE_ATTACHMENTS, BLACKBOARD_MAX_IMAGE_BYTES } from './BlackboardMedia'
import type { BlackboardImageBufferInput } from './BlackboardMedia'
import { persistBlackboardImages } from './BlackboardMedia'

const MAX_BASE64_IMAGE_CHARS = Math.ceil(BLACKBOARD_MAX_IMAGE_BYTES / 3) * 4 + 4
const INVALID_BASE64_BODY_CHARACTER = /[^A-Za-z0-9+/]/

type ResolvedImage = {
  buffer: Buffer
  mimeType?: string
  name?: string
}

type ImageResolution = { ok: true; image: ResolvedImage } | { ok: false; error: string }

type InspectedImageResolution =
  | { ok: true; dataBase64: string; mimeType?: string; name?: string }
  | { ok: false; error: string }

export type IngestBlackboardPostImagesResult =
  | { ok: true; mediaRefs: TranscriptMediaRef[] }
  | { ok: false; code: string; error: string }

export type ResolveBlackboardPostImagesResult =
  | { ok: true; images: BlackboardImageBufferInput[] }
  | {
      ok: false
      code: 'blackboard_image_count_exceeded' | 'blackboard_image_resolution_failed'
      error: string
    }

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const normalized = item.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    items.push(normalized)
  }
  return items
}

function decodeInspectedImage(
  attachmentId: string,
  inspected: InspectedImageResolution
): ImageResolution {
  if (!inspected.ok) return inspected
  const normalized = inspected.dataBase64.trim().replace(/\s+/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  const body = padding > 0 ? normalized.slice(0, -padding) : normalized
  if (
    !normalized ||
    normalized.length > MAX_BASE64_IMAGE_CHARS ||
    normalized.length % 4 !== 0 ||
    INVALID_BASE64_BODY_CHARACTER.test(body) ||
    (padding > 0 && normalized.indexOf('=') !== normalized.length - padding)
  ) {
    return { ok: false, error: `Attachment ${attachmentId} returned invalid image bytes.` }
  }
  const buffer = Buffer.from(normalized, 'base64')
  if (buffer.length === 0 || buffer.length > BLACKBOARD_MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `Attachment ${attachmentId} exceeds the Blackboard image byte limit.`
    }
  }
  return {
    ok: true,
    image: {
      buffer,
      mimeType: inspected.mimeType,
      name: inspected.name
    }
  }
}

/**
 * Resolve agent attachment aliases and workspace paths through caller-supplied
 * authority seams. This module never opens a path itself; main owns both the
 * current-chat inspection check and the descriptor-anchored workspace read.
 */
export async function resolveBlackboardPostImages(input: {
  attachmentIds?: unknown
  workspaceImagePaths?: unknown
  inspectAttachment: (attachmentId: string) => Promise<InspectedImageResolution>
  readWorkspaceImage: (workspacePath: string) => Promise<ImageResolution> | ImageResolution
}): Promise<ResolveBlackboardPostImagesResult> {
  const attachmentIds = normalizeStringList(input.attachmentIds)
  const workspaceImagePaths = normalizeStringList(input.workspaceImagePaths)
  if (attachmentIds.length + workspaceImagePaths.length > BLACKBOARD_MAX_IMAGE_ATTACHMENTS) {
    return {
      ok: false,
      code: 'blackboard_image_count_exceeded',
      error: `A Blackboard entry can attach at most ${BLACKBOARD_MAX_IMAGE_ATTACHMENTS} images.`
    }
  }

  const images: BlackboardImageBufferInput[] = []
  for (const attachmentId of attachmentIds) {
    let inspected: InspectedImageResolution
    try {
      inspected = await input.inspectAttachment(attachmentId)
    } catch (error) {
      inspected = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const decoded = decodeInspectedImage(attachmentId, inspected)
    if (!decoded.ok) {
      return { ok: false, code: 'blackboard_image_resolution_failed', error: decoded.error }
    }
    images.push(decoded.image)
  }

  for (const workspaceImagePath of workspaceImagePaths) {
    let resolved: ImageResolution
    try {
      resolved = await input.readWorkspaceImage(workspaceImagePath)
    } catch (error) {
      resolved = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!resolved.ok) {
      return { ok: false, code: 'blackboard_image_resolution_failed', error: resolved.error }
    }
    images.push({ ...resolved.image, name: resolved.image.name || workspaceImagePath })
  }

  return { ok: true, images }
}

export function inspectedBlackboardImageFromToolResult(
  attachmentId: string,
  value: unknown
): InspectedImageResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: `Attachment ${attachmentId} could not be inspected.` }
  }
  const result = value as Record<string, unknown>
  const content = Array.isArray(result.content) ? result.content : []
  const block = content.find(
    (candidate): candidate is Record<string, unknown> =>
      Boolean(candidate && typeof candidate === 'object' && !Array.isArray(candidate)) &&
      (candidate as Record<string, unknown>).type === 'image'
  )
  const structured =
    result.structuredContent &&
    typeof result.structuredContent === 'object' &&
    !Array.isArray(result.structuredContent)
      ? (result.structuredContent as Record<string, unknown>)
      : undefined
  const attachment =
    structured?.attachment &&
    typeof structured.attachment === 'object' &&
    !Array.isArray(structured.attachment)
      ? (structured.attachment as Record<string, unknown>)
      : undefined
  if (
    result.isError === true ||
    !block ||
    typeof block.data !== 'string' ||
    typeof block.mimeType !== 'string'
  ) {
    return {
      ok: false,
      error:
        typeof structured?.error === 'string'
          ? structured.error
          : `Attachment ${attachmentId} is not an inspectable raster image.`
    }
  }
  return {
    ok: true,
    dataBase64: block.data,
    mimeType: block.mimeType,
    name: typeof attachment?.name === 'string' ? attachment.name : undefined
  }
}

/**
 * Main-process coordinator for both posting authorities. Renderer paths are
 * exact OS-picker capabilities; agent paths remain workspace-contained. Both
 * are descriptor-opened and magic-byte sniffed before persistence.
 */
export async function ingestBlackboardPostImages(input: {
  appChatId: string
  entryId: string
  attachmentIds?: unknown
  workspaceImagePaths?: unknown
  workspacePath?: string
  authorizedFilePaths?: readonly string[]
  inspectAttachmentTool?: (attachmentId: string, maxBytes: number) => Promise<unknown>
  store: Pick<TranscriptMediaAssetStore, 'writeOwnedMany'>
  thumbnailer?: TranscriptMediaThumbnailer
}): Promise<IngestBlackboardPostImagesResult> {
  const resolution = await resolveBlackboardPostImages({
    attachmentIds: input.attachmentIds,
    workspaceImagePaths: input.workspaceImagePaths,
    inspectAttachment: async (attachmentId) => {
      if (!input.inspectAttachmentTool) {
        return { ok: false, error: `Attachment ${attachmentId} cannot be inspected here.` }
      }
      const inspected = await input.inspectAttachmentTool(attachmentId, BLACKBOARD_MAX_IMAGE_BYTES)
      return inspectedBlackboardImageFromToolResult(attachmentId, inspected)
    },
    readWorkspaceImage: (workspaceImagePath) => {
      const workspacePath = input.workspacePath?.trim() || ''
      if (!workspacePath && !input.authorizedFilePaths?.length) {
        return {
          ok: false,
          error: 'workspaceImagePaths require an active workspace chat.'
        }
      }
      const validation = validateWorkspaceImagePath({
        workspacePath,
        candidatePath: workspaceImagePath,
        ...(input.authorizedFilePaths ? { authorizedFilePaths: input.authorizedFilePaths } : {}),
        maxBytes: BLACKBOARD_MAX_IMAGE_BYTES
      })
      if (!validation.ok) {
        return {
          ok: false,
          error: `Blackboard image ${path.basename(workspaceImagePath)} was rejected: ${validation.reason}.`
        }
      }
      return {
        ok: true,
        image: {
          buffer: validation.buffer,
          mimeType: validation.mimeType,
          name: path.basename(validation.realPath)
        }
      }
    }
  })
  if (!resolution.ok) return resolution
  return persistBlackboardImages({
    appChatId: input.appChatId,
    entryId: input.entryId,
    images: resolution.images,
    store: input.store,
    ...(input.thumbnailer ? { thumbnailer: input.thumbnailer } : {})
  })
}
