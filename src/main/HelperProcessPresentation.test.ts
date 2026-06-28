import { describe, expect, it } from 'vitest'
import { GEMINI_MCP_BRIDGE_ARG, GEMINI_MCP_BRIDGE_ENV } from './geminiMcpConstants'
import { isTaskWraithHelperProcess, shouldSuppressMacAppPresentation } from './HelperProcessPresentation'

describe('TaskWraith helper-process presentation', () => {
  it('detects current and stale MCP bridge child args', () => {
    expect(isTaskWraithHelperProcess(['/Applications/TaskWraith.app/Contents/MacOS/TaskWraith'])).toBe(false)
    expect(isTaskWraithHelperProcess(['TaskWraith', GEMINI_MCP_BRIDGE_ARG])).toBe(true)
    expect(isTaskWraithHelperProcess(['TaskWraith', '--agentbench-gemini-mcp-bridge'])).toBe(true)
  })

  it('detects TaskWraith-spawned self-test children by environment', () => {
    expect(isTaskWraithHelperProcess(['TaskWraith'], {})).toBe(false)
    expect(isTaskWraithHelperProcess(['TaskWraith'], { [GEMINI_MCP_BRIDGE_ENV]: '1' })).toBe(true)
  })

  it('suppresses app presentation only for macOS helper processes', () => {
    expect(shouldSuppressMacAppPresentation(['TaskWraith', GEMINI_MCP_BRIDGE_ARG], {}, 'darwin')).toBe(true)
    expect(shouldSuppressMacAppPresentation(['TaskWraith'], {}, 'darwin')).toBe(false)
    expect(shouldSuppressMacAppPresentation(['TaskWraith', GEMINI_MCP_BRIDGE_ARG], {}, 'linux')).toBe(false)
  })
})
