import type { ChatRecord, ProviderId, TaskWraithMcpProfileId } from '../store/types'
import { planContinuityDeliveryForNextHostTurn } from '../../shared/continuityDelivery'
import {
  taskWraithGatewayDirectToolNamesForProfile,
  taskWraithGatewayHiddenToolNamesForProfile
} from '../mcp/McpToolProfiles'

export function planPromptContinuity(input: {
  chat: Pick<ChatRecord, 'appChatId' | 'messages' | 'runs' | 'continuityCheckpoints'>
  provider: ProviderId
  seatId?: string
  providerSessionId?: string | null
  nativeSessionResume?: boolean
  profileId?: TaskWraithMcpProfileId
  mcpAdvertised?: boolean
  isolated?: boolean
  verbatim?: boolean
}) {
  const tools =
    input.mcpAdvertised !== false && input.profileId
      ? new Set<string>([
          ...taskWraithGatewayDirectToolNamesForProfile(input.profileId),
          ...taskWraithGatewayHiddenToolNamesForProfile(input.profileId)
        ])
      : new Set<string>()
  const hostFed =
    ['grok', 'cursor', 'mistral', 'muse', 'devin', 'ollama', 'antigravity'].includes(
      input.provider
    ) ||
    (input.provider === 'kimi' && !input.nativeSessionResume)
  return planContinuityDeliveryForNextHostTurn({
    chat: input.chat,
    provider: input.provider,
    seatId: input.seatId,
    providerSessionId: input.providerSessionId,
    contextMode: hostFed ? 'host-fed' : 'native-session',
    enabled: !input.verbatim,
    contextIsolated: Boolean(input.isolated),
    tools: {
      checkpoint: tools.has('tw_checkpoint') ? 'tw_checkpoint' : undefined,
      historySearch: tools.has('tw_history_search') ? 'tw_history_search' : undefined,
      historyRead: tools.has('tw_history_read') ? 'tw_history_read' : undefined
    }
  })
}

/** Native delegated continuations otherwise bypass the desktop prompt composer. */
export function withDelegatedCheckpoint(input: {
  provider: ProviderId
  subThread: ChatRecord
  prompt: string
  resumeSessionId?: string
}): string {
  const plan = planPromptContinuity({
    chat: input.subThread,
    provider: input.provider,
    providerSessionId: input.resumeSessionId,
    mcpAdvertised: false,
    verbatim: input.prompt.trim().startsWith('/')
  })
  return plan.action === 'deliver' ? `${plan.block}\n\n${input.prompt}` : input.prompt
}

/** Prepare the cold candidate before a native adapter can discard an unusable session. */
export function buildDelegatedContinuityPrompts(
  input: Parameters<typeof withDelegatedCheckpoint>[0]
): { prompt: string; resumeFallbackPrompt?: string } {
  const prompt = withDelegatedCheckpoint(input)
  if (!input.resumeSessionId || !['codex', 'claude'].includes(input.provider)) return { prompt }
  const resumeFallbackPrompt = withDelegatedCheckpoint({ ...input, resumeSessionId: undefined })
  return {
    prompt,
    ...(resumeFallbackPrompt !== prompt ? { resumeFallbackPrompt } : {})
  }
}
