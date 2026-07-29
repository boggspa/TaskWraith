import { describe, expect, it } from 'vitest'
import {
  isNativeSubAgentToolName,
  nativeSubAgentRedirectMessage,
  normalizeNativeSubAgentPolicy,
  previewNativeSubAgentTask
} from './NativeSubAgentPolicy'

describe('NativeSubAgentPolicy', () => {
  it('normalizes stored preference values', () => {
    expect(normalizeNativeSubAgentPolicy('provider')).toBe('provider')
    expect(normalizeNativeSubAgentPolicy('taskwraith')).toBe('taskwraith')
    expect(normalizeNativeSubAgentPolicy('ask')).toBe('ask')
    expect(normalizeNativeSubAgentPolicy('bad')).toBe('ask')
  })

  it('classifies common provider-native sub-agent tool names', () => {
    expect(isNativeSubAgentToolName('Task')).toBe(true)
    expect(isNativeSubAgentToolName('invoke_agent')).toBe(true)
    expect(isNativeSubAgentToolName('spawn-agent')).toBe(true)
    expect(isNativeSubAgentToolName('mcp__TaskWraith__delegate_to_subthread')).toBe(false)
    expect(isNativeSubAgentToolName('mcp__evil__task')).toBe(false)
    expect(isNativeSubAgentToolName('evil__spawn_agent')).toBe(false)
    expect(isNativeSubAgentToolName('taskwraith-broker__task')).toBe(false)
    expect(isNativeSubAgentToolName('run_shell_command')).toBe(false)
  })

  it('extracts a model-actionable task preview', () => {
    expect(previewNativeSubAgentTask({ prompt: 'Audit the Swift tests' })).toBe(
      'Audit the Swift tests'
    )
    expect(previewNativeSubAgentTask({ description: 'Read only' })).toBe('Read only')
  })

  it('builds Claude-specific TaskWraith redirect guidance', () => {
    const message = nativeSubAgentRedirectMessage({
      provider: 'claude',
      toolName: 'Task',
      input: { prompt: 'Check lint failures' }
    })

    expect(message).toContain('mcp__TaskWraith__delegate_to_subthread')
    expect(message).toContain('provider="claude"')
    expect(message).toContain('Check lint failures')
  })
})
