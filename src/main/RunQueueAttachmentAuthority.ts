import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  DirectoryAttachmentRef,
  ExternalPathGrant,
  PersistedAttachmentRef,
  ProviderId,
  ProviderRunReroute,
  RunQueueDirectoryAttachmentReceipt,
  RunQueueJob,
  RunQueueImageAttachmentSnapshot
} from './store/types'
import {
  isPersistedAttachmentRef,
  type TranscriptMediaAssetStore
} from './services/TranscriptMediaAssetStore'
import { snapshotRasterOrPdfAttachment } from './services/TranscriptMediaService'
import { MAX_DURABLE_ATTACHMENT_REFS } from './ScheduledAttachmentDurability'
import {
  runQueueDirectoryAttachmentReceiptMatchesBinding,
  type RunQueueDirectoryAttachmentReceiptBinding
} from './RunQueueDirectoryAttachmentReceipt'
import { isDirectoryComposerAttachment } from '../shared/composerAttachment'

type RunQueueAttachmentStore = Pick<
  TranscriptMediaAssetStore,
  'owns' | 'resolvePersistedAttachment' | 'writeContentAddressed' | 'writeOwnedMany'
>

export type OwnedPersistedRunQueueAttachmentResult =
  | { ok: true; attachment: PersistedAttachmentRef }
  | { ok: false; reason: 'invalid_reference' | 'not_owner' }

export interface MainOwnedQueuedComposerAttachments {
  imageAttachments: Array<PersistedAttachmentRef | DirectoryAttachmentRef>
}

export type MainOwnedQueuedComposerAttachmentResolution =
  | { kind: 'not-applicable' }
  | { kind: 'invalid' }
  | {
      kind: 'resolved'
      provider: ProviderId
      imageAttachments: MainOwnedQueuedComposerAttachments['imageAttachments']
    }

export interface QueuedRunAttachmentPayloadLike {
  provider?: string
  appRunId?: string
  appChatId?: string
  imagePaths?: string[]
  composer?: {
    imagePaths?: string[]
  }
}

export interface QueuedRunAttachmentProviderAuthority {
  /** Exact current provider read from the same durable chat as the queue job. */
  durableChat?: { appChatId: string; provider: ProviderId } | null
  /** A provider-reroute payload whose signed run posture was verified by main. */
  rerouteProof?: {
    providerReroute: ProviderRunReroute
    postureVerified: true
  } | null
}

export interface QueuedDirectoryReplayAuthority {
  /** Exact live picker receipts belonging to the renderer performing compose. */
  authorizedDirectoryPickerPaths?: readonly string[]
  /**
   * Grants already verified by main for this exact chat/workspace/run/provider.
   * The resolver additionally requires the same signed grant to have travelled
   * with the queued request, preserving enqueue-time provenance. These are a
   * live-process fallback only; durable queue receipts never depend on them.
   */
  verifiedExternalPathGrants?: readonly ExternalPathGrant[]
  /** Main verifier closed over the persistent external-grant signing root. */
  verifyQueueReceipt?: (
    receipt: RunQueueDirectoryAttachmentReceipt,
    expected: RunQueueDirectoryAttachmentReceiptBinding
  ) => boolean
}

export function queuedRunAttachmentProviderRerouteAllowed(input: {
  jobProvider: string
  jobChatId: string
  payloadProvider: string
  payloadChatId: string
  authority?: QueuedRunAttachmentProviderAuthority
}): boolean {
  if (!input.jobChatId || input.payloadChatId !== input.jobChatId) return false
  if (input.jobProvider === input.payloadProvider) return true
  const durableChat = input.authority?.durableChat
  if (
    durableChat &&
    durableChat.appChatId === input.jobChatId &&
    input.payloadChatId === input.jobChatId &&
    durableChat.provider === input.payloadProvider
  ) {
    return true
  }
  const proof = input.authority?.rerouteProof
  const reroute = proof?.providerReroute
  return Boolean(
    proof?.postureVerified === true &&
    reroute &&
    reroute.from === input.jobProvider &&
    reroute.to === input.payloadProvider
  )
}

interface MainOwnedQueuedAttachmentAuthority {
  provider: ProviderId
  imageAttachments: Array<PersistedAttachmentRef | DirectoryAttachmentRef>
  imagePaths: string[]
}

type MainOwnedQueuedAttachmentAuthorityResolution =
  | { kind: 'not-applicable' }
  | { kind: 'invalid' }
  | { kind: 'resolved'; authority: MainOwnedQueuedAttachmentAuthority }

export type MainOwnedQueuedRunAttachmentPayloadResolution<
  T extends QueuedRunAttachmentPayloadLike
> = { kind: 'not-applicable' } | { kind: 'invalid' } | { kind: 'resolved'; payload: T }

export type MainOwnedQueuedSteerImagePathsResult =
  | { ok: true; imagePaths: string[] }
  | {
      ok: false
      reason: 'not_steer_promoting' | 'invalid_attachment_authority'
    }

/**
 * A renderer may replay a durable content-addressed reference, but possession
 * of its hash/path is not ownership. Queue staging may reuse the bytes only
 * when the exact canonical chat already owns the asset; it must never mint a
 * new ownership grant from renderer-supplied metadata.
 */
export function resolveOwnedPersistedRunQueueAttachment(input: {
  store: Pick<TranscriptMediaAssetStore, 'owns' | 'resolvePersistedAttachment'>
  attachment: PersistedAttachmentRef
  appChatId?: string
}): OwnedPersistedRunQueueAttachmentResult {
  const existing = input.store.resolvePersistedAttachment(input.attachment)
  if (!existing.ok) return { ok: false, reason: 'invalid_reference' }
  const appChatId = input.appChatId?.trim()
  if (
    !appChatId ||
    !input.store.owns({
      sha256: existing.attachment.sha256,
      mimeType: existing.attachment.mimeType,
      appChatId
    })
  ) {
    return { ok: false, reason: 'not_owner' }
  }
  return existing
}

/**
 * Recover the exact chat-owned snapshots for a queued renderer dispatch.
 *
 * A queued file attachment stops being renderer-owned when RunQueueService
 * copies it into transcript-media. The later renderer may be a different
 * window (or a replacement renderer after restart), so requiring its ephemeral
 * picker receipt for that main-owned path is both impossible and incorrect.
 * Only a leased, previously-enqueued job with exact chat/run identity
 * may cross this seam, and every ref is re-resolved through the chat ownership
 * ledger before it is returned. Directory contents cannot be snapshotted, so
 * replay re-derives authority from the exact workspace, a still-live picker or
 * grant, or the exact main-HMAC queue receipt minted at enqueue.
 */
export function resolveMainOwnedQueuedComposerAttachments(input: {
  store: Pick<TranscriptMediaAssetStore, 'owns' | 'resolvePersistedAttachment'>
  job: RunQueueJob | null | undefined
  appRunId: string
  appChatId: string
  provider?: string
  providerAuthority?: QueuedRunAttachmentProviderAuthority
  directoryAuthority?: QueuedDirectoryReplayAuthority
}): MainOwnedQueuedComposerAttachments | null {
  const resolution = resolveMainOwnedQueuedAttachmentAuthority({
    ...input,
    directoryMode: 'require'
  })
  if (resolution.kind !== 'resolved') return null
  return { imageAttachments: resolution.authority.imageAttachments }
}

export function resolveMainOwnedQueuedComposerAttachmentAuthority(input: {
  store: Pick<TranscriptMediaAssetStore, 'owns' | 'resolvePersistedAttachment'>
  job: RunQueueJob | null | undefined
  appRunId: string
  appChatId: string
  provider?: string
  providerAuthority?: QueuedRunAttachmentProviderAuthority
  directoryAuthority?: QueuedDirectoryReplayAuthority
}): MainOwnedQueuedComposerAttachmentResolution {
  const resolution = resolveMainOwnedQueuedAttachmentAuthority({
    ...input,
    directoryMode: 'require'
  })
  return resolution.kind === 'resolved'
    ? {
        kind: 'resolved',
        provider: resolution.authority.provider,
        imageAttachments: resolution.authority.imageAttachments
      }
    : resolution
}

/** Nullable compatibility wrapper. Dispatch authority gates must use the
 * classified API below so `invalid` can never fall through as ordinary
 * renderer authority. */
export function resolveMainOwnedQueuedRunAttachmentPayload<
  T extends QueuedRunAttachmentPayloadLike
>(input: {
  store: Pick<TranscriptMediaAssetStore, 'owns' | 'resolvePersistedAttachment'>
  job: RunQueueJob | null | undefined
  payload: T
}): T | null {
  const resolution = resolveMainOwnedQueuedRunAttachmentPayloadAuthority(input)
  return resolution.kind === 'resolved' ? resolution.payload : null
}

/**
 * Classify queued attachment authority without making the caller reproduce the
 * eligibility predicate. Provider reroutes do not change the chat/run-owned
 * attachment authority. Only unrelated/non-queued payloads are allowed to
 * fall through to ordinary renderer path authority. Once an exact
 * starting+enqueued run/chat/provider candidate is identified, malformed or
 * unowned refs are an explicit invalid result and must fail closed. A resolved
 * candidate overwrites renderer-round-tripped paths rather than intersecting
 * or merging them, at both the payload and nested composer levels. Directory
 * refs remain in composer authority, but never enter provider image paths.
 */
export function resolveMainOwnedQueuedRunAttachmentPayloadAuthority<
  T extends QueuedRunAttachmentPayloadLike
>(input: {
  store: Pick<TranscriptMediaAssetStore, 'owns' | 'resolvePersistedAttachment'>
  job: RunQueueJob | null | undefined
  payload: T
  providerAuthority?: QueuedRunAttachmentProviderAuthority
}): MainOwnedQueuedRunAttachmentPayloadResolution<T> {
  const { payload } = input
  const appRunId = nonEmptyString(payload.appRunId)
  const appChatId = nonEmptyString(payload.appChatId)
  const provider = nonEmptyString(payload.provider)
  if (!appRunId || !appChatId || !provider) return { kind: 'not-applicable' }

  const resolution = resolveMainOwnedQueuedAttachmentAuthority({
    store: input.store,
    job: input.job,
    appRunId,
    appChatId,
    provider,
    providerAuthority: input.providerAuthority,
    directoryMode: 'ignore'
  })
  if (resolution.kind !== 'resolved') return resolution

  const imagePaths = [...resolution.authority.imagePaths]
  return {
    kind: 'resolved',
    payload: {
      ...payload,
      imagePaths,
      ...(payload.composer
        ? {
            composer: {
              ...payload.composer,
              imagePaths: [...imagePaths]
            }
          }
        : {})
    }
  }
}

/**
 * Resolve file inputs for a native provider steer from an already
 * barrier-validated main-owned queue job. The caller owns exact
 * run/chat/provider/owner-token validation; this helper independently requires
 * the steer lifecycle state and re-proves every file against the canonical
 * chat's attachment ownership ledger. It has no renderer-path input by design.
 */
export function resolveMainOwnedQueuedSteerImagePaths(input: {
  store: Pick<TranscriptMediaAssetStore, 'owns' | 'resolvePersistedAttachment'>
  job: RunQueueJob | null | undefined
  appChatId: string
}): MainOwnedQueuedSteerImagePathsResult {
  const { job } = input
  if (!job || job.status !== 'steer_promoting') {
    return { ok: false, reason: 'not_steer_promoting' }
  }
  if (
    !nonEmptyString(input.appChatId) ||
    !job.request ||
    !Array.isArray(job.request.imageAttachments) ||
    job.request.imageAttachments.length > MAX_DURABLE_ATTACHMENT_REFS
  ) {
    return { ok: false, reason: 'invalid_attachment_authority' }
  }

  const imagePaths: string[] = []
  try {
    for (const attachment of job.request.imageAttachments) {
      if (isDirectoryComposerAttachment(attachment) || !isPersistedAttachmentRef(attachment)) {
        return { ok: false, reason: 'invalid_attachment_authority' }
      }
      const resolved = resolveOwnedPersistedRunQueueAttachment({
        store: input.store,
        attachment,
        appChatId: input.appChatId
      })
      if (!resolved.ok || !resolved.attachment.mimeType.toLowerCase().startsWith('image/')) {
        return { ok: false, reason: 'invalid_attachment_authority' }
      }
      imagePaths.push(resolved.attachment.path)
    }
  } catch {
    return { ok: false, reason: 'invalid_attachment_authority' }
  }
  return { ok: true, imagePaths }
}

function resolveMainOwnedQueuedAttachmentAuthority(input: {
  store: Pick<TranscriptMediaAssetStore, 'owns' | 'resolvePersistedAttachment'>
  job: RunQueueJob | null | undefined
  appRunId: string
  appChatId: string
  provider?: string
  providerAuthority?: QueuedRunAttachmentProviderAuthority
  directoryAuthority?: QueuedDirectoryReplayAuthority
  directoryMode: 'ignore' | 'require'
}): MainOwnedQueuedAttachmentAuthorityResolution {
  const job = input.job
  if (
    !job ||
    job.runId !== input.appRunId ||
    job.chatId !== input.appChatId ||
    job.status !== 'starting' ||
    typeof job.enqueuedAt !== 'string' ||
    !job.enqueuedAt.trim()
  ) {
    return { kind: 'not-applicable' }
  }
  const requestedProvider = input.provider || job.provider
  const provider =
    requestedProvider === job.provider
      ? job.provider
      : queuedRunAttachmentProviderRerouteAllowed({
            jobProvider: job.provider,
            jobChatId: job.chatId || '',
            payloadProvider: requestedProvider,
            payloadChatId: input.appChatId,
            authority: input.providerAuthority
          })
        ? input.providerAuthority?.durableChat?.provider === requestedProvider
          ? input.providerAuthority.durableChat.provider
          : input.providerAuthority?.rerouteProof?.providerReroute.to === requestedProvider
            ? input.providerAuthority.rerouteProof.providerReroute.to
            : null
        : null
  if (!provider) return { kind: 'invalid' }
  if (
    !job.request ||
    !Array.isArray(job.request.imageAttachments) ||
    job.request.imageAttachments.length > MAX_DURABLE_ATTACHMENT_REFS
  ) {
    return { kind: 'invalid' }
  }

  const imageAttachments: Array<PersistedAttachmentRef | DirectoryAttachmentRef> = []
  const imagePaths: string[] = []
  try {
    for (const attachment of job.request.imageAttachments) {
      if (isDirectoryComposerAttachment(attachment)) {
        if (input.directoryMode === 'require') {
          const directory = resolveQueuedDirectoryAttachment({
            attachment,
            job,
            provider,
            authority: input.directoryAuthority
          })
          if (!directory) return { kind: 'invalid' }
          imageAttachments.push(directory)
        } else if (!nonEmptyString(attachment.path)) {
          return { kind: 'invalid' }
        }
        continue
      }
      if (!isPersistedAttachmentRef(attachment)) return { kind: 'invalid' }
      const resolved = resolveOwnedPersistedRunQueueAttachment({
        store: input.store,
        attachment,
        appChatId: input.appChatId
      })
      if (!resolved.ok) return { kind: 'invalid' }
      imageAttachments.push({
        ...resolved.attachment,
        ...(attachment.id ? { id: attachment.id } : {}),
        ...(attachment.name ? { name: attachment.name } : {})
      })
      imagePaths.push(resolved.attachment.path)
    }
  } catch {
    return { kind: 'invalid' }
  }
  return { kind: 'resolved', authority: { provider, imageAttachments, imagePaths } }
}

function resolveQueuedDirectoryAttachment(input: {
  attachment: DirectoryAttachmentRef
  job: RunQueueJob
  provider: ProviderId
  authority?: QueuedDirectoryReplayAuthority
}): DirectoryAttachmentRef | null {
  const directoryPath = canonicalExistingDirectory(input.attachment.path)
  if (!directoryPath) return null
  const workspacePath = canonicalExistingDirectory(input.job.workspacePath)
  const workspaceOwned = Boolean(workspacePath && pathWithinRoot(directoryPath, workspacePath))
  const pickerOwned = (input.authority?.authorizedDirectoryPickerPaths || []).some(
    (candidate) => canonicalExistingDirectory(candidate) === directoryPath
  )
  const queuedGrants = input.job.request?.externalPathGrants || []
  const grantOwned = (input.authority?.verifiedExternalPathGrants || []).some((grant) => {
    if (
      grant.bindingVersion !== 2 ||
      grant.issuedBy !== 'main' ||
      !/^[0-9a-f]{64}$/i.test(grant.signature || '') ||
      grant.provider !== input.provider ||
      grant.kind !== 'directory' ||
      grant.chatId !== input.job.chatId ||
      !grant.workspaceId ||
      grant.workspaceId !== input.job.workspaceId ||
      (grant.appRunId !== undefined && grant.appRunId !== input.job.runId) ||
      !queuedGrants.some(
        (queued) =>
          queued.id === grant.id &&
          queued.signature === grant.signature &&
          queued.bindingVersion === grant.bindingVersion
      )
    ) {
      return false
    }
    const grantPath = canonicalExistingDirectory(grant.path)
    return Boolean(grantPath && pathWithinRoot(directoryPath, grantPath))
  })
  const receiptBinding = directoryReceiptBindingForJob(input.job, directoryPath)
  const queueReceipt = input.attachment.queueReceipt
  const receiptOwned = Boolean(
    queueReceipt &&
    receiptBinding &&
    runQueueDirectoryAttachmentReceiptMatchesBinding(queueReceipt, receiptBinding) &&
    input.authority?.verifyQueueReceipt?.(queueReceipt, receiptBinding)
  )
  if (!workspaceOwned && !pickerOwned && !grantOwned && !receiptOwned) return null
  const id = nonEmptyString(input.attachment.id)
  const name = nonEmptyString(input.attachment.name)
  return {
    kind: 'directory',
    ...(id ? { id } : {}),
    path: directoryPath,
    ...(name ? { name } : {}),
    ...(receiptOwned && queueReceipt ? { queueReceipt: { ...queueReceipt } } : {})
  }
}

function directoryReceiptBindingForJob(
  job: RunQueueJob,
  canonicalPath: string
): RunQueueDirectoryAttachmentReceiptBinding | null {
  const runId = nonEmptyString(job.runId)
  const chatId = nonEmptyString(job.chatId)
  if (!runId || !chatId) return null
  const workspacePath = canonicalExistingDirectory(job.workspacePath)
  const workspaceId = nonEmptyString(job.workspaceId)
  if (Boolean(workspacePath) !== Boolean(workspaceId)) return null
  if (job.scope === 'global' ? Boolean(workspacePath) : !workspacePath) return null
  return {
    canonicalPath,
    runId,
    chatId,
    workspaceId,
    workspacePath,
    provider: job.provider
  }
}

function canonicalExistingDirectory(value: unknown): string | null {
  const candidate = nonEmptyString(value)
  if (!candidate || !path.isAbsolute(candidate)) return null
  try {
    const lexicalStat = fs.lstatSync(candidate)
    if (lexicalStat.isSymbolicLink()) return null
    const real = fs.realpathSync.native(candidate)
    const realStat = fs.lstatSync(real)
    return !realStat.isSymbolicLink() && realStat.isDirectory() ? real : null
  } catch {
    return null
  }
}

function pathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export interface MainOwnedRunQueueAttachmentStageInput {
  runId?: string
  chatId?: string
  provider?: ProviderId
  workspaceId?: string
  workspacePath?: string
  externalPathGrants: ExternalPathGrant[]
  authorizedFilePaths?: string[]
  /** Sender-local picker receipts only; never union process-wide main paths. */
  authorizedDirectoryPickerPaths?: string[]
  attachments: RunQueueImageAttachmentSnapshot[]
}

export type MainOwnedRunQueueAttachmentStageResult =
  | { ok: true; attachments: RunQueueImageAttachmentSnapshot[] }
  | { ok: false; reason: string }

export interface MainOwnedRunQueueAttachmentStageDeps {
  getAssetStore: () => RunQueueAttachmentStore
  getAuthorizedFilePaths?: () => readonly string[]
  signDirectoryReceipt?: (
    binding: RunQueueDirectoryAttachmentReceiptBinding
  ) => RunQueueDirectoryAttachmentReceipt
}

/**
 * Snapshot fresh queue attachments first, then establish any chat ownership in
 * one durable ledger replacement before returning a locator-bearing ref set.
 * Replayed v1 refs remain owns-only and can never mint authority from metadata.
 */
export function createMainOwnedRunQueueAttachmentStager(
  deps: MainOwnedRunQueueAttachmentStageDeps
): (input: MainOwnedRunQueueAttachmentStageInput) => MainOwnedRunQueueAttachmentStageResult {
  return (input) => {
    if (input.attachments.length > MAX_DURABLE_ATTACHMENT_REFS) {
      return { ok: false, reason: 'Attachment snapshot failed.' }
    }
    const slots: Array<
      | { kind: 'persisted'; attachment: PersistedAttachmentRef }
      | { kind: 'directory'; attachment: DirectoryAttachmentRef }
      | { kind: 'pending'; index: number; id?: string; name?: string }
    > = []
    const pendingWrites: Array<{
      sha256: string
      mimeType: string
      buffer: Buffer
      appChatId: string
    }> = []
    try {
      const store = deps.getAssetStore()
      const authorizedPaths = new Set(
        input.authorizedFilePaths ?? [...(deps.getAuthorizedFilePaths?.() || [])]
      )
      // A durable directory receipt may be minted only from the exact
      // enqueueing principal's picker list. The process-wide main fallback is
      // useful for main-owned file materialization, but is not chat provenance.
      const directoryPickerPaths = input.authorizedDirectoryPickerPaths || []
      for (const attachment of input.attachments) {
        if (isDirectoryComposerAttachment(attachment)) {
          const directoryPath = canonicalExistingDirectory(attachment.path)
          const workspacePath = canonicalExistingDirectory(input.workspacePath)
          const workspaceOwned = Boolean(
            directoryPath && workspacePath && pathWithinRoot(directoryPath, workspacePath)
          )
          const pickerOwned = Boolean(
            directoryPath &&
            directoryPickerPaths.some(
              (candidate) => canonicalExistingDirectory(candidate) === directoryPath
            )
          )
          if (!directoryPath || (!workspaceOwned && !pickerOwned)) {
            return { ok: false, reason: 'Attachment snapshot failed.' }
          }
          let queueReceipt: RunQueueDirectoryAttachmentReceipt | undefined
          if (!workspaceOwned) {
            const binding = directoryReceiptBindingForStage(input, directoryPath)
            if (!binding || !deps.signDirectoryReceipt) {
              return { ok: false, reason: 'Attachment snapshot failed.' }
            }
            queueReceipt = deps.signDirectoryReceipt(binding)
            if (!runQueueDirectoryAttachmentReceiptMatchesBinding(queueReceipt, binding)) {
              return { ok: false, reason: 'Attachment snapshot failed.' }
            }
          }
          slots.push({
            kind: 'directory',
            attachment: {
              kind: 'directory',
              ...(attachment.id ? { id: attachment.id } : {}),
              path: directoryPath,
              ...(attachment.name ? { name: attachment.name } : {}),
              ...(queueReceipt ? { queueReceipt: { ...queueReceipt } } : {})
            }
          })
          continue
        }
        if ('persistenceVersion' in attachment && attachment.persistenceVersion === 1) {
          const existing = resolveOwnedPersistedRunQueueAttachment({
            store,
            attachment,
            appChatId: input.chatId
          })
          if (!existing.ok) return { ok: false, reason: 'Attachment snapshot failed.' }
          slots.push({
            kind: 'persisted',
            attachment: {
              ...existing.attachment,
              ...(attachment.id ? { id: attachment.id } : {}),
              ...(attachment.name ? { name: attachment.name } : {})
            }
          })
          continue
        }
        const snapshot = snapshotRasterOrPdfAttachment({
          candidatePath: attachment.path,
          workspacePath: input.workspacePath,
          // Renderer-supplied grants are decode/display inputs at this seam.
          // Only workspace containment or an exact picker receipt may mint a
          // new durable CAS ownership entry for queue dispatch.
          externalPathGrants: [],
          authorizedFilePaths: [...authorizedPaths]
        })
        if (!snapshot.ok) return { ok: false, reason: 'Attachment snapshot failed.' }
        if (!input.chatId) {
          const persisted = store.writeContentAddressed({
            buffer: snapshot.buffer,
            mimeType: snapshot.mimeType
          })
          if (!persisted.ok) return { ok: false, reason: 'Attachment snapshot failed.' }
          slots.push({
            kind: 'persisted',
            attachment: {
              persistenceVersion: 1,
              ...(attachment.id ? { id: attachment.id } : {}),
              path: persisted.path,
              ...(attachment.name ? { name: attachment.name } : {}),
              sha256: persisted.sha256,
              mimeType: persisted.mimeType,
              byteLength: persisted.byteLength
            }
          })
          continue
        }
        const pendingIndex = pendingWrites.length
        pendingWrites.push({
          sha256: createHash('sha256').update(snapshot.buffer).digest('base64url'),
          mimeType: snapshot.mimeType,
          buffer: snapshot.buffer,
          appChatId: input.chatId
        })
        slots.push({
          kind: 'pending',
          index: pendingIndex,
          ...(attachment.id ? { id: attachment.id } : {}),
          ...(attachment.name ? { name: attachment.name } : {})
        })
      }
      const written =
        pendingWrites.length > 0
          ? store.writeOwnedMany(pendingWrites)
          : { ok: true as const, assets: [] }
      if (!written.ok) return { ok: false, reason: 'Attachment snapshot failed.' }
      return {
        ok: true,
        attachments: slots.map((slot) => {
          if (slot.kind === 'persisted' || slot.kind === 'directory') return slot.attachment
          const asset = written.assets[slot.index]
          return {
            persistenceVersion: 1,
            ...(slot.id ? { id: slot.id } : {}),
            path: asset.path,
            ...(slot.name ? { name: slot.name } : {}),
            sha256: asset.sha256,
            mimeType: asset.mimeType,
            byteLength: asset.byteLength
          }
        })
      }
    } catch {
      return { ok: false, reason: 'Attachment snapshot failed.' }
    }
  }
}

function directoryReceiptBindingForStage(
  input: MainOwnedRunQueueAttachmentStageInput,
  canonicalPath: string
): RunQueueDirectoryAttachmentReceiptBinding | null {
  const runId = nonEmptyString(input.runId)
  const chatId = nonEmptyString(input.chatId)
  const workspacePath = canonicalExistingDirectory(input.workspacePath)
  const workspaceId = nonEmptyString(input.workspaceId)
  if (!runId || !chatId || !input.provider || Boolean(workspacePath) !== Boolean(workspaceId)) {
    return null
  }
  return {
    canonicalPath,
    runId,
    chatId,
    workspaceId,
    workspacePath,
    provider: input.provider
  }
}
