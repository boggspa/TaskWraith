import { describe, expect, it } from 'vitest'
import {
  buildKimiBrokerOnlyAgentYaml,
  KIMI_BROKER_ONLY_AGENT_YAML
} from './KimiAgentContainment'

describe('KimiAgentContainment', () => {
  it('emits the exact broker-only Kimi agent specification', () => {
    expect(buildKimiBrokerOnlyAgentYaml()).toBe(
      `version: 1
agent:
  extend: default
  allowed_tools: []
  subagents: {}
`
    )
  })

  it('disables built-in tools and inherited subagents without naming native tools', () => {
    expect(KIMI_BROKER_ONLY_AGENT_YAML).toContain('  allowed_tools: []\n')
    expect(KIMI_BROKER_ONLY_AGENT_YAML).toContain('  subagents: {}\n')
    expect(KIMI_BROKER_ONLY_AGENT_YAML).not.toMatch(
      /ReadFile|ReadMediaFile|Glob|Grep|Shell|WriteFile|StrReplaceFile|Agent/
    )
  })

  it('is deterministic across calls', () => {
    expect(buildKimiBrokerOnlyAgentYaml()).toBe(buildKimiBrokerOnlyAgentYaml())
  })
})
