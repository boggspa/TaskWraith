/** Read-only observations of application-owned Studio resources, never driver occupancy. */
export const STUDIO_RESOURCE_SNAPSHOT_SCHEMA_VERSION = 1

export const STUDIO_RESOURCE_VIDEO_FIELDS = [
  'decoderSessions',
  'activeDecodeOperations',
  'pendingSourceLoads',
  'frameObjects',
  'decodedFrameObjects',
  'planeTextures',
  'ioSurfaces',
  'ioSurfaceBytes',
  'gpuCommandFrameHolds',
  'presentationLeases',
  'presentationLeaseCapacity',
  'reorderCacheEntries',
  'reorderCacheCapacity',
  'compressedCacheEntries',
  'compressedCacheCapacity',
  'compressedCacheBytes'
] as const

export const STUDIO_RESOURCE_AUDIO_FIELDS = [
  'playerObjects',
  'engineObjects',
  'runningEngines',
  'attachedTracks',
  'playingPlayers',
  'playersWithQueuedOutput',
  'queuedBuffers',
  'queuedPcmBytes',
  'pcmBuffers',
  'pcmBytes'
] as const

export const STUDIO_RESOURCE_CACHE_FIELDS = [
  'lutTextures',
  'lutBytes',
  'overlayAtlasTextures',
  'overlayAtlasBytes',
  'metalTextureCacheObjects'
] as const

export const STUDIO_RESOURCE_ACTIVITY_FIELDS = [
  'decodeSubmissions',
  'decodeCompletions',
  'decodeFailures',
  'presentedFrames',
  'droppedFrames',
  'textureBinds',
  'frameCacheHits',
  'samplePayloadReads'
] as const

export interface StudioResourceSnapshot {
  schemaVersion: typeof STUDIO_RESOURCE_SNAPSHOT_SCHEMA_VERSION
  nonce: string
  processPid: number
  processInstanceId: string
  sampleSequence: number
  monotonicMs: number
  documentRevision: number
  workspace: {
    windowIdentity: string
    windowNumber: number | null
    windowVisible: boolean
    sourcePresentationAttached: boolean
    reviewPresentationAttached: boolean
  }
  assets: {
    sourceAssetId: string | null
    reviewAssetId: string | null
    sequenceAssetIds: string[]
  }
  resources: {
    /** frameObjects counts retained StudioVideoFrameTextures values by shared lifetime token. */
    video: Record<(typeof STUDIO_RESOURCE_VIDEO_FIELDS)[number], number> & {
      ioSurfaceIds: number[]
    }
    /** pcmBytes measures buffer capacity; queuedPcmBytes measures queued views of that data. */
    audio: Record<(typeof STUDIO_RESOURCE_AUDIO_FIELDS)[number], number>
    persistentCaches: Record<(typeof STUDIO_RESOURCE_CACHE_FIELDS)[number], number>
  }
  /** Process-lifetime totals; source replacement and cache release never reset these. */
  activity: Record<(typeof STUDIO_RESOURCE_ACTIVITY_FIELDS)[number], number>
  coverage: {
    resources: 'application-owned'
    frameworkInternalCaches: 'opaque'
    gpuDriverRetentions: 'opaque'
  }
}

export type StudioResourceSnapshotFailureCode =
  | 'studio_unavailable'
  | 'resource_snapshot_unavailable'
  | 'resource_query_capacity'
  | 'resource_query_timeout'
  | 'resource_query_delivery_failed'
  | 'resource_query_child_exited'
  | 'resource_query_stopped'
  | 'resource_snapshot_invalid'

export type StudioResourceSnapshotOutcome =
  | { ok: true; snapshot: StudioResourceSnapshot }
  | { ok: false; code: StudioResourceSnapshotFailureCode; message: string }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function uuid(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
}

function counts(value: unknown, fields: readonly string[]): boolean {
  return record(value) && fields.every((key) => count(value[key]))
}

/** Checks representation, not acceptance budgets: overcapacity is useful evidence. */
export function isStudioResourceSnapshot(value: unknown): value is StudioResourceSnapshot {
  if (!record(value) || value.schemaVersion !== STUDIO_RESOURCE_SNAPSHOT_SCHEMA_VERSION)
    return false
  if (
    typeof value.nonce !== 'string' ||
    !/^[0-9a-f]{48}$/.test(value.nonce) ||
    !count(value.processPid) ||
    value.processPid === 0 ||
    !uuid(value.processInstanceId) ||
    !count(value.sampleSequence) ||
    value.sampleSequence === 0 ||
    typeof value.monotonicMs !== 'number' ||
    !Number.isFinite(value.monotonicMs) ||
    value.monotonicMs < 0 ||
    !count(value.documentRevision)
  )
    return false
  const workspace = value.workspace
  if (
    !record(workspace) ||
    !uuid(workspace.windowIdentity) ||
    !(
      workspace.windowNumber === null ||
      (count(workspace.windowNumber) && workspace.windowNumber > 0)
    ) ||
    !['windowVisible', 'sourcePresentationAttached', 'reviewPresentationAttached'].every(
      (key) => typeof workspace[key] === 'boolean'
    )
  )
    return false
  const assets = value.assets
  if (
    !record(assets) ||
    !(assets.sourceAssetId === null || identifier(assets.sourceAssetId)) ||
    !(assets.reviewAssetId === null || identifier(assets.reviewAssetId)) ||
    !Array.isArray(assets.sequenceAssetIds) ||
    assets.sequenceAssetIds.length > 2048 ||
    !assets.sequenceAssetIds.every(identifier) ||
    new Set(assets.sequenceAssetIds).size !== assets.sequenceAssetIds.length
  )
    return false
  const resources = value.resources
  if (
    !record(resources) ||
    !counts(resources.video, STUDIO_RESOURCE_VIDEO_FIELDS) ||
    !counts(resources.audio, STUDIO_RESOURCE_AUDIO_FIELDS) ||
    !counts(resources.persistentCaches, STUDIO_RESOURCE_CACHE_FIELDS) ||
    !counts(value.activity, STUDIO_RESOURCE_ACTIVITY_FIELDS)
  )
    return false
  const video = resources.video as Record<string, unknown>
  if (
    !Array.isArray(video.ioSurfaceIds) ||
    video.ioSurfaceIds.length > 2048 ||
    !video.ioSurfaceIds.every((id) => count(id) && id > 0 && id <= 0xffffffff) ||
    new Set(video.ioSurfaceIds).size !== video.ioSurfaceIds.length ||
    video.ioSurfaceIds.length !== video.ioSurfaces
  )
    return false
  return (
    record(value.coverage) &&
    value.coverage.resources === 'application-owned' &&
    value.coverage.frameworkInternalCaches === 'opaque' &&
    value.coverage.gpuDriverRetentions === 'opaque'
  )
}
