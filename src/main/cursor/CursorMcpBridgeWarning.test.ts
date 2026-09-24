import { beforeEach, describe, expect, it } from 'vitest'

import { CursorGlobalBrokerRegistryInstallError } from './CursorGlobalBrokerRegistryLease'
import {
  buildCursorMcpBridgeUnavailableWarning,
  classifyCursorMcpBridgeFailure,
  clearCursorMcpBridgeLastFailure,
  peekCursorMcpBridgeLastFailure
} from './CursorMcpBridgeWarning'

beforeEach(() => {
  clearCursorMcpBridgeLastFailure()
})

describe('classifyCursorMcpBridgeFailure', () => {
  it('distinguishes enable, ready-probe, and other setup failures', () => {
    expect(
      classifyCursorMcpBridgeFailure(new Error('cursor-agent mcp enable taskwraith-broker failed'))
    ).toBe('enable')
    expect(
      classifyCursorMcpBridgeFailure(
        new Error('cursor-agent mcp list failed while checking taskwraith-broker')
      )
    ).toBe('ready-probe')
    expect(
      classifyCursorMcpBridgeFailure(
        new Error('Cursor MCP server taskwraith-broker is not ready for this run')
      )
    ).toBe('ready-probe')
    expect(
      classifyCursorMcpBridgeFailure(
        new Error('The composed Cursor broker request has no TaskWraith MCP profile.')
      )
    ).toBe('other')
  })
})

describe('buildCursorMcpBridgeUnavailableWarning', () => {
  it('keeps native-only continuity while naming the failed phase', () => {
    const enable = buildCursorMcpBridgeUnavailableWarning({
      writeCapable: true,
      error: new Error('cursor-agent mcp enable taskwraith-broker failed: exit 1')
    })
    expect(enable.title).toBe('Cursor MCP enable failed')
    expect(enable.message).toContain('user-approved native Shell/Write')
    expect(enable.message).toContain('mcp enable')

    const probe = buildCursorMcpBridgeUnavailableWarning({
      writeCapable: false,
      error: new Error('Cursor MCP server taskwraith-broker is not ready for this run')
    })
    expect(probe.title).toBe('Cursor MCP broker not ready')
    expect(probe.message).toContain('native reads only')
  })

  it('keeps registry recovery outcome on the warning when install cleanup is uncertain', () => {
    const error = new CursorGlobalBrokerRegistryInstallError(new Error('EACCES'), {
      outcome: 'cleanup-failed',
      message: 'could not restore mcp.json'
    })
    expect(classifyCursorMcpBridgeFailure(error)).toBe('registry')
    const warning = buildCursorMcpBridgeUnavailableWarning({ writeCapable: false, error })
    expect(warning.title).toBe('Cursor MCP registry install failed')
    expect(warning.message).toContain('Registry recovery outcome: cleanup-failed')
    expect(warning.message).toContain('could not restore mcp.json')
  })

  it('records the last MCP setup failure for Settings to read', () => {
    expect(peekCursorMcpBridgeLastFailure()).toBeNull()
    buildCursorMcpBridgeUnavailableWarning({
      writeCapable: true,
      error: new Error('cursor-agent mcp enable taskwraith-broker failed: exit 1')
    })
    expect(peekCursorMcpBridgeLastFailure()).toEqual({
      phase: 'enable',
      title: 'Cursor MCP enable failed',
      message: expect.stringContaining('mcp enable')
    })
  })
})
