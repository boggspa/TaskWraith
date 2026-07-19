import { createHash } from 'crypto'
import type {
  ExternalPathGrant,
  PersistedAttachmentRef,
  ScheduledTaskAttachmentRef
} from './store/types'
import {
  isPersistedAttachmentRef,
  type TranscriptMediaAssetStore
} from './services/TranscriptMediaAssetStore'
import { snapshotRasterOrPdfAttachment } from './services/TranscriptMediaService'

/** Main-authority ceiling matching the composer attachment affordance. */
export const MAX_DURABLE_ATTACHMENT_REFS = 15

export const SCHEDULED_ATTACHMENT_RESELECT_REASON =
  'Saved attachments could not be recovered safely. Re-select the attachments and save the schedule or workflow again.'

export interface ScheduledAttachmentPersistenceContext {
  /** Canonical chat that owns this scheduled/workflow attachment set. */
  appChatId: string
  workspaceId: string
  workspacePath: string
  externalPathGrants: ExternalPathGrant[]
}

export interface ScheduledAttachmentStageInput extends ScheduledAttachmentPersistenceContext {
  attachments: ScheduledTaskAttachmentRef[]
}

export type ScheduledAttachmentStageResult =
  | { ok: true; attachments: PersistedAttachmentRef[] }
  | { ok: false; reason: string }

export type StageScheduledAttachments = (
  input: ScheduledAttachmentStageInput
) => ScheduledAttachmentStageResult

export interface ScheduledAttachmentResolveInput extends ScheduledAttachmentPersistenceContext {
  source: 'scheduled-task' | 'workflow-template'
  recordId: string
  attachments: ScheduledTaskAttachmentRef[]
}

export type ScheduledAttachmentResolveResult =
  | { ok: true; attachments: PersistedAttachmentRef[] }
  | { ok: false; reason: string }

export type ResolveScheduledAttachments = (
  input: ScheduledAttachmentResolveInput
) => ScheduledAttachmentResolveResult

export function isDurableScheduledAttachmentRef(
  value: unknown
): value is ScheduledTaskAttachmentRef & PersistedAttachmentRef {
  if (!isPersistedAttachmentRef(value)) return false
  return (
    typeof value.id === 'string' &&
    Boolean(value.id.trim()) &&
    typeof value.name === 'string' &&
    Boolean(value.name.trim())
  )
}

export function copyResolvedScheduledAttachments(
  source: readonly ScheduledTaskAttachmentRef[],
  resolved: readonly PersistedAttachmentRef[]
): ScheduledTaskAttachmentRef[] | null {
  if (source.length !== resolved.length || !resolved.every(isPersistedAttachmentRef)) return null
  return resolved.map((attachment, index) => ({
    persistenceVersion: 1,
    id: source[index].id,
    path: attachment.path,
    name: source[index].name,
    sha256: attachment.sha256,
    mimeType: attachment.mimeType.toLowerCase(),
    byteLength: attachment.byteLength
  }))
}

export const rejectUnconfiguredScheduledAttachmentResolution: ResolveScheduledAttachments = () => ({
  ok: false,
  reason: SCHEDULED_ATTACHMENT_RESELECT_REASON
})

export interface MainOwnedScheduledAttachmentPersistenceDeps {
  getAssetStore: () => Pick<
    TranscriptMediaAssetStore,
    'owns' | 'resolvePersistedAttachment' | 'writeOwnedMany'
  >
  getAuthorizedFilePaths?: () => readonly string[]
}

export function createMainOwnedScheduledAttachmentPersistence(
  deps: MainOwnedScheduledAttachmentPersistenceDeps
): {
  stage: StageScheduledAttachments
  resolve: ResolveScheduledAttachments
} {
  const stage: StageScheduledAttachments = (input) => {
    const slots: Array<
      | { kind: 'persisted'; attachment: PersistedAttachmentRef }
      | { kind: 'pending'; index: number; id: string; name: string }
    > = []
    const pendingWrites: Array<{
      sha256: string
      mimeType: string
      buffer: Buffer
      appChatId: string
    }> = []
    try {
      if (input.attachments.length > MAX_DURABLE_ATTACHMENT_REFS) {
        return { ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON }
      }
      const store = deps.getAssetStore()
      for (const attachment of input.attachments) {
        if ('persistenceVersion' in attachment) {
          const resolved = store.resolvePersistedAttachment(attachment)
          if (!resolved.ok) {
            return { ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON }
          }
          if (
            !store.owns({
              sha256: resolved.attachment.sha256,
              mimeType: resolved.attachment.mimeType,
              appChatId: input.appChatId
            })
          ) {
            return { ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON }
          }
          slots.push({
            kind: 'persisted',
            attachment: {
              ...resolved.attachment,
              id: attachment.id,
              name: attachment.name
            }
          })
          continue
        }
        const snapshot = snapshotRasterOrPdfAttachment({
          candidatePath: attachment.path,
          workspacePath: input.workspacePath,
          externalPathGrants: input.externalPathGrants,
          authorizedFilePaths: [...(deps.getAuthorizedFilePaths?.() || [])]
        })
        if (!snapshot.ok) {
          return { ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON }
        }
        const pendingIndex = pendingWrites.length
        pendingWrites.push({
          sha256: createHash('sha256').update(snapshot.buffer).digest('base64url'),
          mimeType: snapshot.mimeType,
          buffer: snapshot.buffer,
          appChatId: input.appChatId
        })
        slots.push({
          kind: 'pending',
          index: pendingIndex,
          id: attachment.id,
          name: attachment.name
        })
      }
      const written =
        pendingWrites.length > 0
          ? store.writeOwnedMany(pendingWrites)
          : { ok: true as const, assets: [] }
      if (!written.ok) return { ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON }
      return {
        ok: true,
        attachments: slots.map((slot) => {
          if (slot.kind === 'persisted') return slot.attachment
          const asset = written.assets[slot.index]
          return {
            persistenceVersion: 1,
            id: slot.id,
            path: asset.path,
            name: slot.name,
            sha256: asset.sha256,
            mimeType: asset.mimeType,
            byteLength: asset.byteLength
          }
        })
      }
    } catch {
      return { ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON }
    }
  }

  const resolve: ResolveScheduledAttachments = (input) => {
    const resolvedAttachments: PersistedAttachmentRef[] = []
    try {
      if (input.attachments.length > MAX_DURABLE_ATTACHMENT_REFS) {
        return { ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON }
      }
      for (const attachment of input.attachments) {
        if (!isDurableScheduledAttachmentRef(attachment)) {
          return { ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON }
        }
        const store = deps.getAssetStore()
        const resolved = store.resolvePersistedAttachment(attachment)
        if (!resolved.ok) {
          return { ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON }
        }
        if (
          !store.owns({
            sha256: resolved.attachment.sha256,
            mimeType: resolved.attachment.mimeType,
            appChatId: input.appChatId
          })
        ) {
          return { ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON }
        }
        resolvedAttachments.push({
          ...resolved.attachment,
          id: attachment.id,
          name: attachment.name
        })
      }
      return { ok: true, attachments: resolvedAttachments }
    } catch {
      return { ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON }
    }
  }

  return { stage, resolve }
}
