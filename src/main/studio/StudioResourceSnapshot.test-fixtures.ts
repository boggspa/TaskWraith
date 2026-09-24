import {
  STUDIO_RESOURCE_ACTIVITY_FIELDS,
  STUDIO_RESOURCE_AUDIO_FIELDS,
  STUDIO_RESOURCE_CACHE_FIELDS,
  STUDIO_RESOURCE_VIDEO_FIELDS,
  type StudioResourceSnapshot
} from '../../shared/studioResourceSnapshot'

function zeroCounts<T extends string>(fields: readonly T[]): Record<T, number> {
  return Object.fromEntries(fields.map((field) => [field, 0])) as Record<T, number>
}

export function resourceSnapshotFixture(
  values: Partial<
    Pick<
      StudioResourceSnapshot,
      'nonce' | 'processPid' | 'documentRevision' | 'sampleSequence' | 'monotonicMs'
    >
  > = {}
): StudioResourceSnapshot {
  return {
    schemaVersion: 1,
    nonce: 'a'.repeat(48),
    processPid: 4242,
    processInstanceId: 'ba817a10-ae01-4f01-8444-f09c01d1e4b2',
    sampleSequence: 1,
    monotonicMs: 100,
    documentRevision: 0,
    ...values,
    workspace: {
      windowIdentity: 'e04e4d5d-1723-4e1a-8a6e-e1f14f97825e',
      windowNumber: null,
      windowVisible: false,
      sourcePresentationAttached: false,
      reviewPresentationAttached: false
    },
    assets: { sourceAssetId: 'fixture-video', reviewAssetId: null, sequenceAssetIds: [] },
    resources: {
      video: { ...zeroCounts(STUDIO_RESOURCE_VIDEO_FIELDS), ioSurfaceIds: [] },
      audio: {
        ...zeroCounts(STUDIO_RESOURCE_AUDIO_FIELDS),
        playerObjects: 1,
        engineObjects: 1,
        attachedTracks: 1,
        pcmBuffers: 1,
        pcmBytes: 4096
      },
      persistentCaches: { ...zeroCounts(STUDIO_RESOURCE_CACHE_FIELDS), metalTextureCacheObjects: 1 }
    },
    activity: {
      ...zeroCounts(STUDIO_RESOURCE_ACTIVITY_FIELDS),
      decodeSubmissions: 10,
      decodeCompletions: 9,
      decodeFailures: 1
    },
    coverage: {
      resources: 'application-owned',
      frameworkInternalCaches: 'opaque',
      gpuDriverRetentions: 'opaque'
    }
  }
}
