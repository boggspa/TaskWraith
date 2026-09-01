import type {
  ChildAgentInteractivity,
  ChildAgentState,
  ProviderId
} from '../../../main/store/types'

export type AgentInvocationSource = 'provider-native' | 'taskwraith-subthread'

export function providerDisplayName(provider?: ProviderId | string): string {
  if (provider === 'codex') return 'Codex'
  if (provider === 'claude') return 'Claude'
  if (provider === 'kimi') return 'Kimi'
  if (provider === 'grok') return 'Grok'
  if (provider === 'cursor') return 'Cursor'
  if (provider === 'ollama') return 'Ollama'
  if (provider === 'gemini') return 'Gemini'
  if (provider === 'antigravity') return 'AntiGravity'
  if (provider === 'pi') return 'Pi'
  if (provider === 'mistral') return 'Mistral'
  if (provider === 'muse') return 'Muse'
  if (provider === 'devin') return 'Devin'
  return 'Agent'
}

export function agentInvocationRouteLabel(source: AgentInvocationSource): string {
  return source === 'taskwraith-subthread' ? 'Durable sub-thread' : 'Provider-native'
}

export function childAgentStateLabel(state: ChildAgentState): string {
  if (state === 'running') return 'Running'
  if (state === 'completed') return 'Completed'
  if (state === 'failed') return 'Failed'
  if (state === 'cancelled') return 'Cancelled'
  return 'Queued'
}

export function childAgentInteractivityLabel(interactivity: ChildAgentInteractivity): string {
  if (interactivity === 'interactive') return 'Interactive'
  if (interactivity === 'observe-only') return 'Observe-only'
  return 'One-shot'
}
