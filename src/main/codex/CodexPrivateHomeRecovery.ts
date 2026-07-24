import { isCodexAppServerThreadId } from '../CodexSessionIdentity'

export interface PreparedCodexPrivateHomeLink {
  prompt: string
  providerSessionId?: string
  resumableThreadId: string | null
  discardedSessionId?: string
}

/**
 * Normalize a persisted Codex link before app-server admission. Historical
 * `codex-exec-*` ids cannot be resumed by app-server, so they must be cleared
 * and the signed full-context fallback used for the one cold-start turn.
 */
export function prepareCodexPrivateHomeLink(input: {
  providerSessionId?: string | null
  prompt: string
  resumeFallbackPrompt?: string
}): PreparedCodexPrivateHomeLink {
  const providerSessionId = input.providerSessionId?.trim()
  if (!providerSessionId) {
    return {
      prompt: input.prompt,
      providerSessionId: undefined,
      resumableThreadId: null
    }
  }
  if (isCodexAppServerThreadId(providerSessionId)) {
    return {
      prompt: input.prompt,
      providerSessionId,
      resumableThreadId: providerSessionId
    }
  }
  return {
    prompt: input.resumeFallbackPrompt || input.prompt,
    providerSessionId: undefined,
    resumableThreadId: null,
    discardedSessionId: providerSessionId
  }
}

/**
 * Select a context-complete prompt when an exact legacy rollout cannot be
 * migrated. A full Ensemble dispatch is already its own recovery prompt;
 * slim/native-resume turns require the separately signed fallback.
 */
export function codexPrivateHomeColdStartPrompt(input: {
  prompt: string
  resumeFallbackPrompt?: string
  ensemblePromptMode?: 'full' | 'slim'
}): string | null {
  if (input.resumeFallbackPrompt) return input.resumeFallbackPrompt
  return input.ensemblePromptMode === 'full' ? input.prompt : null
}
