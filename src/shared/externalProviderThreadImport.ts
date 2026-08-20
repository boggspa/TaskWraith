export const EXTERNAL_PROVIDER_THREAD_IMPORT_SCHEMA_VERSION = 1 as const
export const EXTERNAL_PROVIDER_THREAD_IMPORT_TRUST = 'external_untrusted' as const
export const EXTERNAL_PROVIDER_THREAD_IMPORT_MESSAGE_KIND = 'externalProviderThreadImport' as const
export const EXTERNAL_PROVIDER_THREAD_IMPORT_NOTICE_KIND =
  'externalProviderThreadImportNotice' as const

export const EXTERNAL_PROVIDER_THREAD_IMPORT_PROVIDERS = [
  'codex',
  'claude',
  'cursor',
  'antigravity'
] as const

export type ExternalProviderThreadImportProvider =
  (typeof EXTERNAL_PROVIDER_THREAD_IMPORT_PROVIDERS)[number]

export interface ExternalProviderThreadImportMetadata {
  readonly schemaVersion: typeof EXTERNAL_PROVIDER_THREAD_IMPORT_SCHEMA_VERSION
  readonly provider: ExternalProviderThreadImportProvider
  readonly trust: typeof EXTERNAL_PROVIDER_THREAD_IMPORT_TRUST
  readonly sourceFileName: string
  readonly sourceFingerprintSha256: string
  readonly sourceConversationId?: string
  readonly sourceMessageCount: number
  readonly importedMessageCount: number
  readonly omittedRecordCount: number
  readonly invalidRecordCount: number
  readonly importedAt: string
  readonly truncated: boolean
  /** Imported rows never enter a provider prompt in V1. */
  readonly promptBridgeEnabled: false
  /** Native provider continuation identifiers are deliberately never imported. */
  readonly nativeResumeAllowed: false
}

export type ExternalProviderThreadImportResult<TChat> =
  | { ok: true; canceled: true }
  | {
      ok: true
      canceled: false
      chat: TChat
      duplicate: boolean
      truncated: boolean
      importedMessageCount: number
      sourceMessageCount: number
    }
  | { ok: false; canceled: false; code: string; error: string }

export interface ExternalProviderThreadImportChatSummary {
  readonly appChatId: string
  readonly title: string
  readonly archived: true
  readonly externalProviderThreadImport: ExternalProviderThreadImportMetadata
}

export function isExternalProviderThreadImportProvider(
  value: unknown
): value is ExternalProviderThreadImportProvider {
  return (EXTERNAL_PROVIDER_THREAD_IMPORT_PROVIDERS as readonly unknown[]).includes(value)
}

export function externalProviderThreadImportLabel(
  provider: ExternalProviderThreadImportProvider
): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'cursor') return 'Cursor'
  return 'AntiGravity'
}

export function externalProviderThreadImportMessageLabel(
  provider: ExternalProviderThreadImportProvider,
  role: 'user' | 'assistant' | 'system'
): string {
  const source = externalProviderThreadImportLabel(provider)
  return `Imported ${source} · ${role === 'system' ? 'Notice' : role === 'user' ? 'User' : 'Assistant'}`
}

export function isExternalProviderThreadImportMessage(
  message: { metadata?: { kind?: unknown } | null } | null | undefined
): boolean {
  return (
    message?.metadata?.kind === EXTERNAL_PROVIDER_THREAD_IMPORT_MESSAGE_KIND ||
    message?.metadata?.kind === EXTERNAL_PROVIDER_THREAD_IMPORT_NOTICE_KIND
  )
}

/**
 * Imported snapshots never become provider-native continuity, including after
 * an unarchive or later fresh TaskWraith turn. Kept structural so the store and
 * ChatService can apply the same fence without a shared→main type dependency.
 */
export function stripExternalProviderThreadImportContinuity<T extends object>(chat: T): T {
  type ContinuityCarrier = {
    externalProviderThreadImport?: { nativeResumeAllowed?: unknown }
    linkedProviderSessionId?: unknown
    linkedGeminiSessionId?: unknown
    taskWraithMcpProfileReceipt?: unknown
    seatGeneration?: unknown
    contextCompactionSummary?: unknown
    forkContext?: unknown
    providerMetadata?: Record<string, unknown>
    runs?: unknown[]
    ensemble?: { participants?: unknown[] }
  }
  const source = chat as T & ContinuityCarrier
  if (source.externalProviderThreadImport?.nativeResumeAllowed !== false) return chat
  const next = { ...source } as T & ContinuityCarrier
  delete next.linkedProviderSessionId
  delete next.linkedGeminiSessionId
  delete next.taskWraithMcpProfileReceipt
  delete next.seatGeneration
  delete next.contextCompactionSummary
  delete next.forkContext
  if (Array.isArray(source.runs)) {
    next.runs = source.runs.map((run) => {
      if (!run || typeof run !== 'object' || Array.isArray(run)) return run
      const copy = { ...(run as Record<string, unknown>) }
      delete copy.providerThreadId
      delete copy.providerSessionId
      return copy
    })
  }
  if (source.providerMetadata) {
    const providerMetadata = { ...source.providerMetadata }
    delete providerMetadata.kimiAcpNativeSession
    next.providerMetadata = providerMetadata
  }
  if (source.ensemble && Array.isArray(source.ensemble.participants)) {
    next.ensemble = {
      ...source.ensemble,
      participants: source.ensemble.participants.map((participant) => {
        if (!participant || typeof participant !== 'object' || Array.isArray(participant)) {
          return participant
        }
        const copy = { ...(participant as Record<string, unknown>) }
        delete copy.linkedProviderSessionId
        delete copy.kimiAcpNativeSession
        delete copy.kimiAcpPostureVersion
        delete copy.taskWraithMcpProfileReceipt
        delete copy.seatGeneration
        delete copy.contextCompactionSummary
        delete copy.promptShellVersion
        delete copy.promptDynamicStateVersion
        return copy
      })
    }
  }
  return next as T
}
