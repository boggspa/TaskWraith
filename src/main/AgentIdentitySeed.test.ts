import { describe, expect, it } from 'vitest'
import { agentIdenticonHash, assignAgentIdentityFromSeed } from './AgentIdentitySeed'

describe('AgentIdentitySeed', () => {
  it('assigns a stable named identity from a sub-thread id', () => {
    const first = assignAgentIdentityFromSeed('subthread-chat-1')
    const second = assignAgentIdentityFromSeed('subthread-chat-1')

    expect(second).toEqual(first)
    expect(first.name).toBeTruthy()
    expect(first.slug).toBeTruthy()
    expect(first.accent).toMatch(/^#[0-9A-F]{6}$/)
  })

  it('uses the same FNV bucket for case/space-normalised seeds', () => {
    expect(agentIdenticonHash('  SubThread-Chat-1  ')).toBe(
      agentIdenticonHash('subthread-chat-1')
    )
  })
})
