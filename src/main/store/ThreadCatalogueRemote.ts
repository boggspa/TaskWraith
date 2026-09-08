import type { ChatRecord, PooledAgentIdentitySnapshot } from './types'
import { assignAgentIdentityFromSeed } from '../AgentIdentitySeed'
import {
  buildRemoteTaskCard,
  buildRemoteCanvasPreviews,
  buildRemoteQueuedComposerPrompts,
  type RemoteTaskCard,
  type BuildRemoteTaskCardOptions
} from '../RemoteTaskProjection'
import {
  projectRemoteThread,
  fitRemoteThreadSnapshotToByteBudget,
  remoteSpeakerForMessage,
  REMOTE_IOS_PREVIEW_MAX,
  type RemoteProjectionOptions
} from '../RemoteThreadProjection'
import { ensembleSpeakerForMessage } from '../EnsemblePrompt'
export const remotePooledAgentIdentityForChat = (
  chat: ChatRecord
): PooledAgentIdentitySnapshot | undefined => {
  const metadata = chat.providerMetadata as Record<string, unknown> | undefined
  const raw = metadata?.pooledAgentIdentity
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const agentId =
    (typeof metadata?.pooledAgentId === 'string' && metadata.pooledAgentId.trim()) ||
    (typeof record.agentId === 'string' && record.agentId.trim()) ||
    ''
  const nickname =
    typeof record.nickname === 'string' && record.nickname.trim() ? record.nickname.trim() : ''
  const iconKind = record.iconKind
  const hue = Number(record.hue)
  if (
    !agentId ||
    !nickname ||
    !Number.isFinite(hue) ||
    (iconKind !== 'named' && iconKind !== 'seed' && iconKind !== 'asset')
  ) {
    return undefined
  }
  return {
    schemaVersion: 1,
    agentId,
    nickname,
    iconKind,
    hue: ((Math.round(hue) % 360) + 360) % 360,
    ...(Number.isFinite(Number(record.saturation))
      ? {
          saturation: Math.max(0, Math.min(100, Math.round(Number(record.saturation))))
        }
      : {}),
    ...(Number.isFinite(Number(record.brightness))
      ? {
          brightness: Math.max(0, Math.min(100, Math.round(Number(record.brightness))))
        }
      : {}),
    ...(typeof record.accent === 'string' && record.accent ? { accent: record.accent } : {}),
    ...(typeof record.slug === 'string' && record.slug ? { slug: record.slug } : {}),
    ...(typeof record.assetKey === 'string' && record.assetKey
      ? { assetKey: record.assetKey }
      : {}),
    ...(typeof record.seed === 'string' && record.seed ? { seed: record.seed } : {}),
    ...(typeof record.hueEnabled === 'boolean' ? { hueEnabled: record.hueEnabled } : {})
  }
}

/** Sub-agent character identity for a child chat — read from the PARENT
 * chat's persisted providerMetadata.agentIdentities registry (the
 * renderer assigns + persists these; reading keeps phone names
 * byte-identical to the desktop's instead of re-deriving). */
export const remoteAgentIdentityForChat = (
  chat: ChatRecord,
  readParent: (id: string) => ChatRecord | null
): { name: string; accent?: string; slug?: string } | undefined => {
  const pooledIdentity = remotePooledAgentIdentityForChat(chat)
  if (pooledIdentity) {
    return {
      name: pooledIdentity.nickname,
      ...(pooledIdentity.accent ? { accent: pooledIdentity.accent } : {}),
      ...(pooledIdentity.slug ? { slug: pooledIdentity.slug } : {})
    }
  }
  if (!chat.parentChatId) return undefined
  const parent = readParent(chat.parentChatId)
  const meta = parent?.providerMetadata as Record<string, unknown> | undefined
  const map = meta?.agentIdentities as
    | Record<string, { name?: string; color?: string; accent?: string; slug?: string }>
    | undefined
  const identity = map?.[chat.appChatId]
  if (identity && typeof identity.name === 'string' && identity.name) {
    return {
      name: identity.name,
      accent:
        (typeof identity.accent === 'string' && identity.accent) ||
        (typeof identity.color === 'string' && identity.color) ||
        undefined,
      slug: typeof identity.slug === 'string' ? identity.slug : undefined
    }
  }
  if (chat.parentChatRelation === 'subThread' || (chat.parentChatId && !chat.parentChatRelation)) {
    return assignAgentIdentityFromSeed(chat.appChatId)
  }
  if (chat.parentChatRelation === 'sideChat' && chat.sideChatContext?.mode === 'guestParticipant') {
    return assignAgentIdentityFromSeed(`${chat.parentChatId || chat.appChatId}:guest`)
  }
  if (chat.parentChatRelation === 'sideChat' && chat.sideChatContext?.mode === 'singleProvider') {
    const selectedParticipantId = chat.providerMetadata?.sideChatSelectedParticipantId
    if (typeof selectedParticipantId === 'string' && selectedParticipantId) {
      return assignAgentIdentityFromSeed(
        `${chat.parentChatId || chat.appChatId}:${selectedParticipantId}`
      )
    }
  }
  return undefined
}

export interface CatalogueRemoteOptions {
  costDisplay?: RemoteProjectionOptions['costDisplay']
  showRunCompleteSummary?: boolean
  includeViewport?: boolean
}
export interface CatalogueRemoteProjection {
  taskCard: RemoteTaskCard
  threadSnapshot?: ReturnType<typeof projectRemoteThread>
}

/** Complete history is resident only in the decoder. */
export function projectCatalogueRemote(
  chat: ChatRecord,
  options: CatalogueRemoteOptions,
  readParent: (id: string) => ChatRecord | null
): CatalogueRemoteProjection {
  const generatedAt = new Date().toISOString()
  const taskCard = buildRemoteTaskCard(chat, {
    generatedAt,
    previewMaxChars: 240,
    agentIdentity: remoteAgentIdentityForChat(chat, readParent)
  })
  const threadSnapshot = options.includeViewport
    ? fitRemoteThreadSnapshotToByteBudget(
        projectRemoteThread(chat.messages ?? [], chat.runs ?? [], {
          notes: chat.pinnedNotes,
          blackboardEntries: chat.ensemble?.blackboard,
          threadId: chat.appChatId,
          mode: { kind: 'latestViewportN', n: 24 },
          previewMaxChars: REMOTE_IOS_PREVIEW_MAX,
          generatedAt,
          costDisplay: options.costDisplay,
          showRunCompleteSummary: options.showRunCompleteSummary,
          pooledAgentIdentity: remotePooledAgentIdentityForChat(chat),
          speakerForMessage: remoteSpeakerForMessage(
            chat,
            chat.ensemble?.enabled
              ? ensembleSpeakerForMessage(chat.ensemble.participants)
              : undefined
          )
        })
      )
    : undefined
  return { taskCard, ...(threadSnapshot ? { threadSnapshot } : {}) }
}

/** Overlay current process state without deriving history again on main. */
export function overlayCatalogueRemoteTask(
  base: RemoteTaskCard,
  options: BuildRemoteTaskCardOptions
): RemoteTaskCard {
  const card = structuredClone(base)
  card.pendingQuestionCount = options.pendingQuestionCount ?? 0
  card.pendingApprovalCount = options.pendingApprovalCount ?? 0
  const queued =
    options.queuedComposerJobs?.some(
      (job) => job.status === 'queued' && job.request?.remoteComposer
    ) ?? false
  if (card.pendingQuestionCount) card.status = 'awaitingQuestion'
  else if (card.pendingApprovalCount) card.status = 'awaitingApproval'
  else if (queued) card.status = 'running'
  card.completionNotificationEligible =
    base.completionNotificationEligible && card.status === 'success' && !queued
  card.capabilities = options.capabilities
  card.isShared = options.isShared
  card.sharedMode = options.sharedMode
  card.runtimeProfileId = options.runtimeProfileId ?? base.runtimeProfileId
  card.trustedSessionEnabled = options.trustedSessionEnabled
  card.externalGrantsCount = options.externalGrantsCount
  card.canvasPreviews = buildRemoteCanvasPreviews(options.openCanvases ?? [])
  card.queuedComposerPrompts = buildRemoteQueuedComposerPrompts(options.queuedComposerJobs)
  for (const participant of card.ensembleState?.roster ?? [])
    participant.trustedSessionEnabled =
      options.trustedSessionParticipantIds?.has(participant.id) ?? false
  return card
}
