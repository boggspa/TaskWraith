import { ipcMain } from 'electron'

export interface ContextCompactionHandlersDeps {
  /**
   * Drive a provider-native "compact now" for a chat's linked provider
   * session, or — when `participantId` is set — for one ensemble seat's
   * session (Codex `thread/compact/start`; Claude via the maintenance-lane
   * SDK `/compact` call). Solo Claude chats compact through a normal
   * `/compact` run renderer-side and never reach this channel.
   */
  compactProviderContext: (payload: {
    chatId: string
    provider: 'claude' | 'codex' | 'cursor' | 'kimi'
    providerSessionId?: string
    participantId?: string
  }) => Promise<{ ok: boolean; error?: string }>
  requireNonEmptyString: (value: unknown, label: string) => string
}

export function registerContextCompactionHandlers(deps: ContextCompactionHandlersDeps): void {
  ipcMain.handle(
    'compact-provider-context',
    async (
      _event,
      payload?: {
        chatId?: string
        provider?: string
        providerSessionId?: string
        participantId?: string
      }
    ): Promise<{ ok: boolean; error?: string }> => {
      const chatId = deps.requireNonEmptyString(payload?.chatId, 'Chat id')
      const provider = deps.requireNonEmptyString(payload?.provider, 'Provider')
      if (
        provider !== 'codex' &&
        provider !== 'claude' &&
        provider !== 'cursor' &&
        provider !== 'kimi'
      ) {
        return { ok: false, error: `Manual context compaction is not supported for ${provider}.` }
      }
      const providerSessionId =
        typeof payload?.providerSessionId === 'string' && payload.providerSessionId.trim()
          ? payload.providerSessionId.trim()
          : undefined
      const participantId =
        typeof payload?.participantId === 'string' && payload.participantId.trim()
          ? payload.participantId.trim()
          : undefined
      return deps.compactProviderContext({ chatId, provider, providerSessionId, participantId })
    }
  )
}
