import { describe, expect, it } from 'vitest'
import {
  classifyNativeWorkspacePreflightDecision,
  isExplicitTaskWraithBrokerTool,
  nativeProviderApprovalPriority,
  nativeProviderBrokerOnlyMessage,
  nativeProviderToolRequiresBroker
} from './NativeProviderToolContainment'
import type { NativeWorkspaceToolPreflight } from './native-tools/NativeWorkspaceToolGate'

describe('NativeProviderToolContainment', () => {
  it.each([
    'Write',
    'Edit',
    'NotebookEdit',
    'Bash',
    'Shell',
    'run_terminal_command'
  ])('requires brokered execution for native %s', (toolName) => {
    expect(nativeProviderToolRequiresBroker(toolName)).toBe(true)
  })

  it.each(['Read', 'ReadFile', 'Glob', 'Grep', 'FindFiles', 'ListDirectory'])(
    'leaves side-effect-free native %s available',
    (toolName) => {
      expect(nativeProviderToolRequiresBroker(toolName)).toBe(false)
    }
  )

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

  it('does not trust a reserved prefix unless the full strict route is declared', () => {
    for (const toolName of [
      'mcp__TaskWraith__unknown_tool',
      'TaskWraith__mcp__evil__read_file',
      'mcp__evil__read_file'
    ]) {
      expect(isExplicitTaskWraithBrokerTool(toolName), toolName).toBe(false)
    }
    expect(nativeProviderToolRequiresBroker('mcp__TaskWraith__unknown_tool')).toBe(true)
  })

  it('resolves target-derived gateway identity before recognizing the broker route', () => {
    expect(
      isExplicitTaskWraithBrokerTool('mcp__TaskWraith__capability_invoke', {
        name: 'read_file',
        arguments: { path: 'README.md' }
      })
    ).toBe(true)
    expect(isExplicitTaskWraithBrokerTool('mcp__TaskWraith__capability_invoke')).toBe(false)
  })

  it('allows a declared native read to use the ordinary safe auto-allow path', () => {
    expect(nativeProviderApprovalPriority('read_file', true)).toBe('allow-auto')
    expect(nativeProviderApprovalPriority('list_directory', true)).toBe('allow-auto')
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

describe('classifyNativeWorkspacePreflightDecision', () => {
  it('allows a workspace-verified native read directly (no broker quarantine)', () => {
    const preflight: NativeWorkspaceToolPreflight = {
      kind: 'allow',
      canonicalTool: 'read_file',
      source: 'native',
      service: 'mcpTools',
      access: 'read',
      checkedPaths: ['/ws/src/a.ts'],
      requiresRuntimeSandbox: false
    }
    expect(classifyNativeWorkspacePreflightDecision('Claude', 'Read', preflight)).toEqual({
      action: 'allow'
    })
  })

  it('keeps a workspace-verified native write on the exact broker path', () => {
    const preflight: NativeWorkspaceToolPreflight = {
      kind: 'allow',
      canonicalTool: 'write_file',
      source: 'native',
      service: 'fileChanges',
      access: 'write',
      checkedPaths: ['/ws/src/a.ts'],
      requiresRuntimeSandbox: false
    }
    expect(classifyNativeWorkspacePreflightDecision('Claude', 'Write', preflight)).toEqual({
      action: 'deny',
      message: expect.stringContaining('TaskWraith MCP workspace tool')
    })
  })

  it('keeps even a workspace-sandboxed native shell on the exact broker path', () => {
    const preflight: NativeWorkspaceToolPreflight = {
      kind: 'allow',
      canonicalTool: 'run_shell_command',
      source: 'native',
      service: 'shellCommands',
      access: 'shell',
      checkedPaths: ['/ws'],
      normalizedCwd: '/ws',
      requiresRuntimeSandbox: true
    }
    expect(classifyNativeWorkspacePreflightDecision('Claude', 'Bash', preflight)).toEqual({
      action: 'deny',
      message: expect.stringContaining('TaskWraith MCP workspace tool')
    })
  })

  it('denies with the gate reason for out-of-workspace / unsandboxed-shell preflights', () => {
    const oow: NativeWorkspaceToolPreflight = {
      kind: 'deny',
      canonicalTool: 'read_file',
      source: 'native',
      reason: 'Native read_file requested a path outside the active workspace.',
      checkedPaths: [],
      requiresRuntimeSandbox: false
    }
    expect(classifyNativeWorkspacePreflightDecision('Claude', 'Read', oow)).toEqual({
      action: 'deny',
      message: 'Native read_file requested a path outside the active workspace.'
    })

    const shell: NativeWorkspaceToolPreflight = {
      kind: 'deny',
      canonicalTool: 'run_shell_command',
      source: 'native',
      reason:
        'Native shell requires a runtime workspace sandbox; cwd validation alone cannot contain absolute paths or egress.',
      checkedPaths: ['/ws'],
      requiresRuntimeSandbox: true
    }
    expect(classifyNativeWorkspacePreflightDecision('Claude', 'Bash', shell).action).toBe('deny')
  })

  it('keeps an unclassifiable native tool broker-only (prior containment preserved)', () => {
    const notApplicable: NativeWorkspaceToolPreflight = {
      kind: 'not_applicable',
      canonicalTool: null,
      source: 'unknown'
    }
    const decision = classifyNativeWorkspacePreflightDecision('Claude', 'Mystery', notApplicable)
    expect(decision.action).toBe('deny')
    if (decision.action === 'deny') {
      expect(decision.message).toContain('namespaced TaskWraith MCP workspace tool')
    }
  })
})
