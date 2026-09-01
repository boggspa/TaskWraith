import type { ChatRecord, ChatWorkflowMode, ProviderId } from '../main/store/types'
import { queueProviderChange, readPendingProviderChange } from './providerChangeQueue'

export const CHAT_COMPOSER_SELECTION_PROVIDER_METADATA_KEYS = [
  'selectedModelType',
  'customModel',
  'codexReasoningEffort',
  'codexServiceTier',
  'claudeReasoningEffort',
  'claudeFastMode',
  'kimiFastMode',
  'kimiReasoningEffort',
  'kimiThinkingEnabled',
  'grokReasoningEffort',
  'museReasoningEffort',
  'mistralReasoningEffort',
  'piReasoningEffort',
  'ollamaReasoningEffort',
  'cursorReasoningEffort',
  'cursorFastMode',
  'antigravityReasoningEffort',
  'antigravityUltraTaskSelected',
  'runtimeProfileId',
  'geminiAuthProfileId'
] as const

export const CHAT_COMPOSER_SELECTION_METADATA_KEYS = [
  ...CHAT_COMPOSER_SELECTION_PROVIDER_METADATA_KEYS,
  'approvalMode',
  'permissionPresetId',
  'workflowMode'
] as const

export type ChatComposerSelectionMetadataKey =
  (typeof CHAT_COMPOSER_SELECTION_METADATA_KEYS)[number]
export type ChatComposerSelectionPatchValue = string | boolean | null
export type ChatComposerSelectionPatch = Partial<
  Record<ChatComposerSelectionMetadataKey, ChatComposerSelectionPatchValue>
>

export interface ChatComposerSelectionPatchRequest {
  chatId: string
  patch: ChatComposerSelectionPatch
  provider: ProviderId
  deferProviderScoped: boolean
  queuedAt?: string
}

export type ChatComposerSelectionPatchResult =
  | {
      ok: true
      changed: boolean
      chatId: string
      revision: number
      updatedAt: number
    }
  | {
      ok: false
      changed: false
      chatId: string
      reason: 'chat-not-found'
    }

const METADATA_KEY_SET = new Set<string>(CHAT_COMPOSER_SELECTION_METADATA_KEYS)
const PROVIDER_METADATA_KEY_SET = new Set<string>(CHAT_COMPOSER_SELECTION_PROVIDER_METADATA_KEYS)
const BOOLEAN_KEYS = new Set<ChatComposerSelectionMetadataKey>([
  'claudeFastMode',
  'kimiFastMode',
  'kimiThinkingEnabled',
  'cursorFastMode',
  'antigravityUltraTaskSelected'
])
const NULLABLE_KEYS = new Set<ChatComposerSelectionMetadataKey>([
  'runtimeProfileId',
  'geminiAuthProfileId'
])
const PROVIDERS = new Set<ProviderId>([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral',
  'muse',
  'devin'
])
const PERMISSION_PRESETS = new Set([
  'plan',
  'read_only',
  'default',
  'workspace_write',
  'full_access'
])
const APPROVAL_MODES = new Set(['default', 'plan', 'auto_edit'])
const WORKFLOW_MODES = new Set<ChatWorkflowMode>(['normal', 'plan'])
const MAX_METADATA_STRING_LENGTH = 4_096

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDERS.has(value as ProviderId)
}

function isValidMetadataValue(
  key: ChatComposerSelectionMetadataKey,
  value: unknown
): value is ChatComposerSelectionPatchValue {
  if (value === null) return NULLABLE_KEYS.has(key)
  if (BOOLEAN_KEYS.has(key)) return typeof value === 'boolean'
  if (typeof value !== 'string' || value.length > MAX_METADATA_STRING_LENGTH) return false
  if (key === 'permissionPresetId') return PERMISSION_PRESETS.has(value)
  if (key === 'approvalMode') return APPROVAL_MODES.has(value)
  if (key === 'workflowMode') return WORKFLOW_MODES.has(value as ChatWorkflowMode)
  return true
}

export function sanitizeChatComposerSelectionPatch(
  value: unknown
): ChatComposerSelectionPatch | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length === 0 || keys.some((key) => !METADATA_KEY_SET.has(key))) return null
  const patch: ChatComposerSelectionPatch = {}
  for (const key of keys as ChatComposerSelectionMetadataKey[]) {
    const candidate = value[key]
    if (candidate === undefined) continue
    if (!isValidMetadataValue(key, candidate)) return null
    patch[key] = candidate
  }
  return Object.keys(patch).length > 0 ? patch : null
}

export function parseChatComposerSelectionPatchRequest(
  value: unknown
): ChatComposerSelectionPatchRequest | null {
  if (!isRecord(value)) return null
  const chatId = typeof value.chatId === 'string' ? value.chatId : ''
  const patch = sanitizeChatComposerSelectionPatch(value.patch)
  if (!chatId || !patch || !isProviderId(value.provider)) return null
  if (value.deferProviderScoped !== undefined && typeof value.deferProviderScoped !== 'boolean') {
    return null
  }
  const queuedAt =
    typeof value.queuedAt === 'string' && value.queuedAt.length <= 64 ? value.queuedAt : undefined
  return {
    chatId,
    patch,
    provider: value.provider,
    deferProviderScoped: value.deferProviderScoped === true,
    ...(queuedAt ? { queuedAt } : {})
  }
}

export function chatComposerSelectionPatchTouchesProviderMetadata(
  patch: ChatComposerSelectionPatch
): boolean {
  return Object.keys(patch).some((key) => PROVIDER_METADATA_KEY_SET.has(key))
}

function patchAlreadyApplied(
  metadata: Record<string, unknown> | undefined,
  patch: ChatComposerSelectionPatch
): boolean {
  return Object.entries(patch).every(([key, value]) => Object.is(metadata?.[key], value))
}

export function applyChatComposerSelectionPatch(
  chat: ChatRecord,
  request: ChatComposerSelectionPatchRequest,
  now: () => number = Date.now
): ChatRecord {
  const workflowMode =
    request.patch.workflowMode === 'normal' || request.patch.workflowMode === 'plan'
      ? request.patch.workflowMode
      : undefined
  let next = chat
  if (request.deferProviderScoped && chat.chatKind !== 'ensemble') {
    const pending = readPendingProviderChange(chat)
    const pendingMetadata = pending?.providerMetadata
    const queuedProvider = pending?.provider || request.provider
    const queuedAt = pending?.queuedAt || request.queuedAt || new Date(now()).toISOString()
    const pendingUnchanged =
      queuedProvider === request.provider && patchAlreadyApplied(pendingMetadata, request.patch)
    if (!pendingUnchanged) {
      next = queueProviderChange(chat, {
        provider: queuedProvider,
        providerMetadata: {
          ...(pendingMetadata || {}),
          ...request.patch
        },
        queuedAt
      })
    }
  } else if (!patchAlreadyApplied(chat.providerMetadata, request.patch)) {
    next = {
      ...chat,
      providerMetadata: {
        ...(chat.providerMetadata || {}),
        ...request.patch
      }
    }
  }

  if (workflowMode && next.workflowMode !== workflowMode) {
    next = { ...next, workflowMode }
  }
  return next === chat ? chat : { ...next, updatedAt: now() }
}
