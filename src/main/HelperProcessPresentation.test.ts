import { PEOPLE_MIGRATION_HELPER_ARG } from './startup/PeopleMigrationHelperProtocol'
import { describe, expect, it } from 'vitest'
import { GEMINI_MCP_BRIDGE_ARG, GEMINI_MCP_BRIDGE_ENV } from './geminiMcpConstants'
import { isTaskWraithHelperProcess, shouldSuppressMacAppPresentation } from './HelperProcessPresentation'
import { TUI_HEADLESS_HOST_ARG } from '../host-shared/TuiHeadlessHostLaunch'

describe('TaskWraith helper-process presentation', () => {
  it('detects current and stale MCP bridge child args', () => {
    expect(isTaskWraithHelperProcess(['/Applications/TaskWraith.app/Contents/MacOS/TaskWraith'])).toBe(false)
    expect(isTaskWraithHelperProcess(['TaskWraith', GEMINI_MCP_BRIDGE_ARG])).toBe(true)
    expect(isTaskWraithHelperProcess(['TaskWraith', '--agentbench-gemini-mcp-bridge'])).toBe(true)
  })

  it('recognizes the isolated migration helper without turning it into a normal app', () => {
    expect(isTaskWraithHelperProcess(['TaskWraith', PEOPLE_MIGRATION_HELPER_ARG], {})).toBe(true)
    expect(shouldSuppressMacAppPresentation(['TaskWraith', PEOPLE_MIGRATION_HELPER_ARG], {}, 'darwin')).toBe(true)
  })

  it('detects TaskWraith-spawned self-test children by environment', () => {
    expect(isTaskWraithHelperProcess(['TaskWraith'], {})).toBe(false)
    expect(isTaskWraithHelperProcess(['TaskWraith'], { [GEMINI_MCP_BRIDGE_ENV]: '1' })).toBe(true)
  })

  it('hides TUI Host launches while preserving their normal singleton routing', () => {
    const argv = ['TaskWraith', TUI_HEADLESS_HOST_ARG, '--taskwraith-headless-parent=123']
    expect(shouldSuppressMacAppPresentation(argv, {}, 'darwin')).toBe(true)
    expect(isTaskWraithHelperProcess(argv, {})).toBe(false)
    expect(shouldSuppressMacAppPresentation(argv, {}, 'win32')).toBe(false)
  })

  it('suppresses app presentation only for macOS helper processes', () => {
    expect(shouldSuppressMacAppPresentation(['TaskWraith', GEMINI_MCP_BRIDGE_ARG], {}, 'darwin')).toBe(true)
    expect(shouldSuppressMacAppPresentation(['TaskWraith'], {}, 'darwin')).toBe(false)
    expect(shouldSuppressMacAppPresentation(['TaskWraith', GEMINI_MCP_BRIDGE_ARG], {}, 'linux')).toBe(false)
  })
})
