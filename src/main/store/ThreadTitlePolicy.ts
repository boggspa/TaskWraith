import {
  derivePromptFallbackThreadTitle,
  isKnownPromptFallbackThreadTitle,
  isPlaceholderThreadTitle,
  normalizeLocalAiThreadTitle,
  threadTitleSourceFingerprint
} from '../../shared/threadTitles'
import { isExternalProviderThreadImportMessage } from '../../shared/externalProviderThreadImport'
import { isRetiredExternalChannelInboundMessage } from '../LegacyExternalChannelHistory'
import { EXTERNAL_CONTRIBUTION_TAG } from '../collaboration/ExternalContributionContext'
import {
  isExternalUntrustedMessage,
  isHumanCollaboratorComment
} from '../collaboration/HumanCollaboratorMessages'
import type { ChatMessage, ChatRecord, ThreadTitleProvenance } from './types'

function firstHumanPrompt(chat: ChatRecord): ChatMessage | null {
  return (
    (chat.messages || []).find(
      (message) =>
        message.role === 'user' &&
        Boolean(message.content?.trim()) &&
        !isRetiredExternalChannelInboundMessage(message) &&
        !isHumanCollaboratorComment(message) &&
        !isExternalUntrustedMessage(message) &&
        !isExternalProviderThreadImportMessage(message) &&
        !message.content.includes(`<${EXTERNAL_CONTRIBUTION_TAG}`)
    ) || null
  )
}

function sameProvenance(
  left: ThreadTitleProvenance | undefined,
  right: ThreadTitleProvenance | undefined
): boolean {
  return (
    left?.source === right?.source &&
    left?.sourceMessageId === right?.sourceMessageId &&
    left?.sourceFingerprint === right?.sourceFingerprint &&
    left?.evidenceFingerprint === right?.evidenceFingerprint
  )
}

function withTitle(
  chat: ChatRecord,
  title: string,
  threadTitle: ThreadTitleProvenance
): ChatRecord {
  if (chat.title === title && sameProvenance(chat.threadTitle, threadTitle)) return chat
  return { ...chat, title, threadTitle }
}

/**
 * Main-owned live invariant for every persisted ChatRecord.
 *
 * A factory placeholder transitions when the first durable human prompt is
 * present, independent of which renderer/remote/resume path appended it. A
 * changed non-automatic title is classified as explicit user intent and can
 * never be replaced by a later automatic refinement.
 */
export function applyThreadTitlePolicy(
  chat: ChatRecord,
  previous: ChatRecord | null | undefined
): ChatRecord {
  const prompt = firstHumanPrompt(chat)
  const prior = previous?.threadTitle

  if (!prompt) {
    if (previous) {
      if (chat.title !== previous.title) {
        return withTitle(chat, chat.title, { source: 'user' })
      }
      if (prior) return withTitle(chat, chat.title, prior)
    }
    if (chat.threadTitle?.source === 'user') return chat
    return withTitle(chat, chat.title, {
      source: isPlaceholderThreadTitle(chat.title) ? 'placeholder' : 'user'
    })
  }

  // Explicit/manual and already-applied AI titles outrank a stale first-send
  // clone. The old renderer gates can still overwrite `chat.title` before the
  // save reaches main; restore the canonical pair atomically here.
  if (previous && (prior?.source === 'user' || prior?.source === 'local-ai')) {
    if (
      chat.title !== previous.title &&
      (!chat.threadTitle ||
        chat.threadTitle.source === 'user' ||
        sameProvenance(chat.threadTitle, prior))
    ) {
      return withTitle(chat, chat.title, { source: 'user' })
    }
    return withTitle(chat, previous.title, prior)
  }

  if (previous && chat.title === previous.title && prior) {
    if (chat.threadTitle?.source === 'user' && prior.source !== 'user') {
      return withTitle(chat, chat.title, { source: 'user' })
    }
    if (prior.source === 'placeholder') {
      return withTitle(chat, derivePromptFallbackThreadTitle(prompt.content, previous.title), {
        source: 'prompt-fallback',
        sourceMessageId: prompt.id,
        sourceFingerprint: threadTitleSourceFingerprint(prompt.id, prompt.content)
      })
    }
    return withTitle(chat, chat.title, prior)
  }

  if (chat.threadTitle?.source === 'local-ai') {
    const expectedSourceId = prior?.sourceMessageId || prompt.id
    const eligiblePrior =
      !prior || prior.source === 'placeholder' || prior.source === 'prompt-fallback'
    const title = normalizeLocalAiThreadTitle(chat.title)
    if (
      eligiblePrior &&
      title &&
      chat.threadTitle.sourceMessageId === expectedSourceId &&
      chat.threadTitle.sourceFingerprint ===
        threadTitleSourceFingerprint(prompt.id, prompt.content) &&
      /^sha256:[a-f0-9]{64}$/.test(chat.threadTitle.evidenceFingerprint || '') &&
      Boolean(chat.threadTitle.evidenceFingerprint)
    ) {
      return withTitle(chat, title, chat.threadTitle)
    }
    if (previous) return withTitle(chat, previous.title, prior || { source: 'user' })
  }

  if (chat.threadTitle?.source === 'user') {
    return withTitle(chat, chat.title, { source: 'user' })
  }

  if (isPlaceholderThreadTitle(chat.title)) {
    return withTitle(chat, derivePromptFallbackThreadTitle(prompt.content, chat.title), {
      source: 'prompt-fallback',
      sourceMessageId: prompt.id,
      sourceFingerprint: threadTitleSourceFingerprint(prompt.id, prompt.content)
    })
  }

  if (isKnownPromptFallbackThreadTitle(chat.title, prompt.content)) {
    return withTitle(chat, chat.title, {
      source: 'prompt-fallback',
      sourceMessageId: prompt.id,
      sourceFingerprint: threadTitleSourceFingerprint(prompt.id, prompt.content)
    })
  }

  // Any other non-placeholder rename is explicit. This also upgrades legacy
  // titles that predate provenance so an asynchronous result cannot clobber
  // them merely because the metadata was absent.
  return withTitle(chat, chat.title, { source: 'user' })
}

export interface LocalAiThreadTitleInput {
  title: string
  sourceMessageId: string
  evidenceFingerprint: string
  sourceFingerprint: string
  expectedTitle: string
}

/** Renderer-side CAS plan; main re-runs `applyThreadTitlePolicy` on save. */
export function applyLocalAiThreadTitle(
  chat: ChatRecord,
  input: LocalAiThreadTitleInput
): ChatRecord | null {
  const normalized = normalizeLocalAiThreadTitle(input.title)
  if (!normalized || chat.title !== input.expectedTitle) return null
  const prompt = firstHumanPrompt(chat)
  if (!prompt || prompt.id !== input.sourceMessageId) return null
  if (threadTitleSourceFingerprint(prompt.id, prompt.content) !== input.sourceFingerprint)
    return null
  const provenance = chat.threadTitle
  if (provenance?.source === 'user' || provenance?.source === 'local-ai') return null
  if (provenance?.sourceMessageId && provenance.sourceMessageId !== input.sourceMessageId)
    return null
  if (!input.evidenceFingerprint.trim()) return null
  return {
    ...chat,
    title: normalized,
    threadTitle: {
      source: 'local-ai',
      sourceMessageId: input.sourceMessageId,
      sourceFingerprint: input.sourceFingerprint,
      evidenceFingerprint: input.evidenceFingerprint
    }
  }
}

export function firstHumanPromptForTitle(chat: ChatRecord): ChatMessage | null {
  return firstHumanPrompt(chat)
}
