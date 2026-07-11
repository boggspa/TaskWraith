import { describe, expect, it } from 'vitest'
import {
  agentInvocationRouteLabel,
  childAgentInteractivityLabel,
  childAgentStateLabel,
  providerDisplayName
} from './AgentInvocationPresentation'

describe('AgentInvocationPresentation', () => {
  it('keeps the route distinction explicit', () => {
    expect(agentInvocationRouteLabel('provider-native')).toBe(
      'Provider tool call in this transcript'
    )
    expect(agentInvocationRouteLabel('taskwraith-subthread')).toBe('Durable sub-thread')
  })

  it('formats provider, status, and interactivity labels', () => {
    expect(providerDisplayName('claude')).toBe('Claude')
    expect(providerDisplayName('cursor')).toBe('Cursor')
    expect(providerDisplayName('ollama')).toBe('Ollama')
    expect(providerDisplayName('unknown')).toBe('Agent')
    expect(childAgentStateLabel('running')).toBe('Running')
    expect(childAgentStateLabel('queued')).toBe('Queued')
    expect(childAgentInteractivityLabel('observe-only')).toBe('Observe-only')
  })
})
