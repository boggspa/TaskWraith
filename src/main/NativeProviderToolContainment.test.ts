import { describe, expect, it } from 'vitest'
import {
  isExplicitTaskWraithBrokerTool,
  nativeProviderApprovalPriority,
  nativeProviderBrokerOnlyMessage,
  nativeProviderToolRequiresBroker
} from './NativeProviderToolContainment'

describe('NativeProviderToolContainment', () => {
  it.each([
    'Read',
    'ReadFile',
    'Glob',
    'Grep',
    'Write',
    'Edit',
    'NotebookEdit',
    'Bash',
    'Shell',
    'run_terminal_command'
  ])('requires brokered execution for native %s', (toolName) => {
    expect(nativeProviderToolRequiresBroker(toolName)).toBe(true)
  })

  it.each([
    'mcp__TaskWraith__read_file',
    'TaskWraith__write_file',
    'mcp_taskwraith-broker_run_shell_command',
    'taskwraith-broker__apply_patch'
  ])('preserves explicitly namespaced broker tool %s', (toolName) => {
    expect(isExplicitTaskWraithBrokerTool(toolName)).toBe(true)
    expect(nativeProviderToolRequiresBroker(toolName)).toBe(false)
  })

  it('does not classify unrelated native tools as filesystem authority', () => {
    expect(nativeProviderToolRequiresBroker('WebSearch')).toBe(false)
    expect(nativeProviderToolRequiresBroker('AskUserQuestion')).toBe(false)
  })

  it('denies a bare native read before the canonical MCP auto-allow path', () => {
    expect(nativeProviderApprovalPriority('read_file', true)).toBe('deny-native')
    expect(nativeProviderApprovalPriority('list_directory', true)).toBe('deny-native')
  })

  it('auto-allows only the explicitly namespaced broker form', () => {
    expect(nativeProviderApprovalPriority('mcp__TaskWraith__read_file', true)).toBe(
      'allow-auto'
    )
    expect(nativeProviderApprovalPriority('WebSearch', false)).toBe('continue')
  })

  it('produces an actionable denial', () => {
    expect(nativeProviderBrokerOnlyMessage('Claude', 'Read')).toContain(
      'namespaced TaskWraith MCP workspace tool'
    )
  })
})
