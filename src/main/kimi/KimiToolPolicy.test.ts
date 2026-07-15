import { describe, it, expect } from 'vitest'
import {
  classifyKimiToolPermission,
  isKimiSafeMcpTool,
  unqualifyKimiMcpToolName,
  type KimiToolPolicyRequest
} from './KimiToolPolicy'

const never = () => false
const opts = (over: Partial<Parameters<typeof classifyKimiToolPermission>[1]> = {}) => ({
  writeCapable: true,
  isSafeMcpTool: never,
  isReadOnlyShell: never,
  ...over
})

describe('unqualifyKimiMcpToolName', () => {
  it('strips the mcp__<server>__ namespace (incl. capitalized alias)', () => {
    expect(unqualifyKimiMcpToolName('mcp__taskwraith__capability_search')).toBe('capability_search')
    expect(unqualifyKimiMcpToolName('mcp__TaskWraith__ask_user_question')).toBe('ask_user_question')
  })
  it('passes an already-unqualified name through', () => {
    expect(unqualifyKimiMcpToolName('capability_search')).toBe('capability_search')
  })
  it('returns null for non-strings/empty', () => {
    expect(unqualifyKimiMcpToolName(undefined)).toBeNull()
    expect(unqualifyKimiMcpToolName('')).toBeNull()
  })
})

describe('isKimiSafeMcpTool', () => {
  it('recognises a namespaced capability gateway tool as safe (the ensemble-soak bug)', () => {
    expect(isKimiSafeMcpTool({ toolName: 'mcp__taskwraith__capability_search' })).toBe(true)
    expect(isKimiSafeMcpTool({ toolName: 'mcp__TaskWraith__capability_search' })).toBe(true)
  })
  it('recognises the tool name from rawToolCall.rawInput too', () => {
    expect(
      isKimiSafeMcpTool({ rawToolCall: { rawInput: { tool_name: 'mcp__taskwraith__capability_search' } } })
    ).toBe(true)
  })
  it('does not classify a mutating tool as safe', () => {
    expect(isKimiSafeMcpTool({ toolName: 'Write' })).toBe(false)
    expect(isKimiSafeMcpTool({ toolName: 'mcp__taskwraith__ensemble_bossman_control' })).toBe(false)
  })
})

describe('classifyKimiToolPermission', () => {
  it('auto-allows a safe / read-only MCP tool', () => {
    const req: KimiToolPolicyRequest = { toolName: 'mcp__taskwraith__capability_search', toolKind: 'other' }
    expect(classifyKimiToolPermission(req, opts({ isSafeMcpTool: () => true }))).toBe('allow')
  })

  it('auto-allows a read-only shell command', () => {
    const req: KimiToolPolicyRequest = { toolName: 'Bash', toolKind: 'execute' }
    expect(classifyKimiToolPermission(req, opts({ isReadOnlyShell: () => true }))).toBe('allow')
  })

  it('auto-allows native read/search kinds', () => {
    expect(classifyKimiToolPermission({ toolKind: 'read' }, opts())).toBe('allow')
    expect(classifyKimiToolPermission({ toolKind: 'search' }, opts())).toBe('allow')
    expect(classifyKimiToolPermission({ toolKind: 'READ' }, opts())).toBe('allow')
  })

  it('gates a mutating tool on a write-capable seat', () => {
    expect(classifyKimiToolPermission({ toolName: 'Write', toolKind: 'edit' }, opts())).toBe('gate')
    expect(classifyKimiToolPermission({ toolName: 'Bash', toolKind: 'execute' }, opts())).toBe('gate')
    // unknown kind defaults to gate (fail-safe: prompt, not silent-allow)
    expect(classifyKimiToolPermission({ toolKind: 'other' }, opts())).toBe('gate')
  })

  it('denies a mutating tool on a read-only / plan seat', () => {
    expect(
      classifyKimiToolPermission({ toolName: 'Write', toolKind: 'edit' }, opts({ writeCapable: false }))
    ).toBe('deny')
    expect(classifyKimiToolPermission({ toolKind: 'execute' }, opts({ writeCapable: false }))).toBe('deny')
  })

  it('still auto-allows read-only tools even on a read-only seat', () => {
    expect(
      classifyKimiToolPermission({ toolKind: 'read' }, opts({ writeCapable: false }))
    ).toBe('allow')
    expect(
      classifyKimiToolPermission(
        { toolName: 'mcp__taskwraith__list' },
        opts({ writeCapable: false, isSafeMcpTool: () => true })
      )
    ).toBe('allow')
  })
})
