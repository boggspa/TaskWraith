import { ipcMain } from 'electron'

export interface ContextCompactionHandlersDeps {
  /**
   * Drive a provider-native "compact now" for a chat's linked provider session.
   * Currently Codex-only (`thread/compact/start` on the persistent app-server);
   * Claude manual compaction is dispatched renderer-side as a normal `/compact`
   * run, so it never reaches this channel.
   */
  compactCodexProviderContext: (payload: {
    chatId: string
    providerSessionId?: string
  }) => Promise<{ ok: boolean; error?: string }>
  requireNonEmptyString: (value: unknown, label: string) => string
}

export function registerContextCompactionHandlers(deps: ContextCompactionHandlersDeps): void {
  ipcMain.handle(
    'compact-provider-context',
    async (
      _event,
      payload?: { chatId?: string; provider?: string; providerSessionId?: string }
    ): Promise<{ ok: boolean; error?: string }> => {
      const chatId = deps.requireNonEmptyString(payload?.chatId, 'Chat id')
      const provider = deps.requireNonEmptyString(payload?.provider, 'Provider')
      if (provider !== 'codex') {
        return { ok: false, error: `Manual context compaction is not supported for ${provider}.` }
      }
      const providerSessionId =
        typeof payload?.providerSessionId === 'string' && payload.providerSessionId.trim()
          ? payload.providerSessionId.trim()
          : undefined
      return deps.compactCodexProviderContext({ chatId, providerSessionId })
    }
  )
}
