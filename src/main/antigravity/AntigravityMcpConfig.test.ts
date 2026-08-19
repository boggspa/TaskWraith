import { describe, expect, it } from 'vitest'
import {
  AGY_TASKWRAITH_MCP_SERVER_NAME,
  agyGlobalMcpConfigPath,
  agyMcpConfigNeedsUpdate,
  buildAgyMcpConfigDocument,
  isTaskWraithOwnedAgyMcpServerName,
  parseAgyMcpConfigDocument,
  serializeAgyMcpConfigDocument
} from './AntigravityMcpConfig'

const registration = {
  command: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
  args: ['--taskwraith-gemini-mcp-bridge', '--taskwraith-mcp-route-from-env']
}

describe('agyGlobalMcpConfigPath', () => {
  it('targets the migrated config/ path, not the legacy settings.json root', () => {
    // The measured defect: a full TaskWraith registration sat in
    // <root>/settings.json (Gemini CLI's legacy location) while agy read
    // config/mcp_config.json and found nothing.
    expect(agyGlobalMcpConfigPath({}, '/Users/example')).toBe(
      '/Users/example/.gemini/config/mcp_config.json'
    )
  })

  it('honours the GEMINI_CLI_HOME and GEMINI_HOME overrides the child receives', () => {
    // createAgyCliEnv strips only credential keys, so an override reaches the
    // agy child; writing a hard-coded ~/.gemini would register into a file the
    // child never opens.
    expect(agyGlobalMcpConfigPath({ GEMINI_CLI_HOME: '/opt/agy' }, '/Users/example')).toBe(
      '/opt/agy/.gemini/config/mcp_config.json'
    )
    expect(agyGlobalMcpConfigPath({ GEMINI_HOME: '/opt/agy/.custom' }, '/Users/example')).toBe(
      '/opt/agy/.custom/config/mcp_config.json'
    )
  })
})

describe('parseAgyMcpConfigDocument', () => {
  it('reads an absent or byte-empty file as empty, never as corrupt', () => {
    // agy creates a 0-byte mcp_config.json at migration — the exact state on
    // the machine that reported the missing profile. Treating it as corrupt
    // would refuse to install on precisely the machines that need it.
    expect(parseAgyMcpConfigDocument('')).toEqual({ status: 'empty' })
    expect(parseAgyMcpConfigDocument('   \n')).toEqual({ status: 'empty' })
    expect(parseAgyMcpConfigDocument(null)).toEqual({ status: 'empty' })
    expect(parseAgyMcpConfigDocument(undefined)).toEqual({ status: 'empty' })
  })

  it('reads a populated server map and a keyless document', () => {
    expect(
      parseAgyMcpConfigDocument('{"mcpServers":{"sqlite-helper":{"command":"sqlite-mcp-server"}}}')
    ).toEqual({
      status: 'ok',
      document: { mcpServers: { 'sqlite-helper': { command: 'sqlite-mcp-server' } } }
    })
    expect(parseAgyMcpConfigDocument('{}')).toEqual({ status: 'ok', document: { mcpServers: {} } })
  })

  it('refuses content it cannot read rather than clobbering it', () => {
    expect(parseAgyMcpConfigDocument('{not json')).toEqual({ status: 'unreadable' })
    expect(parseAgyMcpConfigDocument('[]')).toEqual({ status: 'unreadable' })
    expect(parseAgyMcpConfigDocument('{"mcpServers":[]}')).toEqual({ status: 'unreadable' })
    expect(
      parseAgyMcpConfigDocument(`{"mcpServers":{"a":{"b":"${'x'.repeat(1024 * 1024)}"}}}`)
    ).toEqual({ status: 'unreadable' })
  })
})

describe('buildAgyMcpConfigDocument', () => {
  it('registers the bridge and stamps the antigravity parent provider', () => {
    const document = buildAgyMcpConfigDocument({ taskWraith: registration })
    expect(document.mcpServers[AGY_TASKWRAITH_MCP_SERVER_NAME]).toEqual({
      command: registration.command,
      args: registration.args,
      env: { TASKWRAITH_PARENT_PROVIDER: 'antigravity' }
    })
  })

  it('preserves user servers verbatim and in order', () => {
    const document = buildAgyMcpConfigDocument({
      existing: {
        mcpServers: {
          'sqlite-helper': { command: 'sqlite-mcp-server', args: ['/db.sqlite'] },
          'remote-service': { serverUrl: 'https://mcp.example.com/sse' }
        }
      },
      taskWraith: registration
    })
    expect(Object.keys(document.mcpServers)).toEqual([
      'sqlite-helper',
      'remote-service',
      AGY_TASKWRAITH_MCP_SERVER_NAME
    ])
    expect(document.mcpServers['remote-service']).toEqual({
      serverUrl: 'https://mcp.example.com/sse'
    })
  })

  it('replaces a stale registration and drops historical rebrands', () => {
    const document = buildAgyMcpConfigDocument({
      existing: {
        mcpServers: {
          TaskWraith: { command: '/old/TaskWraith', args: [] },
          agentbench: { command: '/older/AGBench', args: [] },
          keep: { command: 'user-server' }
        }
      },
      taskWraith: registration
    })
    expect(Object.keys(document.mcpServers)).toEqual(['keep', AGY_TASKWRAITH_MCP_SERVER_NAME])
    expect(document.mcpServers[AGY_TASKWRAITH_MCP_SERVER_NAME]).toMatchObject({
      command: registration.command
    })
  })

  it('removes only TaskWraith when no registration is supplied', () => {
    // The restore path for a disabled lane: the user's own servers must
    // survive a de-registration untouched.
    const document = buildAgyMcpConfigDocument({
      existing: {
        mcpServers: {
          TaskWraith: { command: '/old/TaskWraith' },
          'sqlite-helper': { command: 'sqlite-mcp-server' }
        }
      }
    })
    expect(document.mcpServers).toEqual({ 'sqlite-helper': { command: 'sqlite-mcp-server' } })
  })

  it('never persists live endpoint authority', () => {
    // The registration is a STATIC document: socket path and broker token ride
    // the agy child's environment. A persisted token would outlive its run and
    // leak a live broker credential into a plaintext config file.
    const serialized = serializeAgyMcpConfigDocument(
      buildAgyMcpConfigDocument({ taskWraith: registration })
    )
    expect(serialized).not.toContain('TASKWRAITH_MCP_BROKER_TOKEN')
    expect(serialized).not.toContain('TASKWRAITH_MCP_SOCKET_PATH')
    expect(serialized.endsWith('\n')).toBe(true)
  })
})

describe('agyMcpConfigNeedsUpdate', () => {
  it('installs into an empty file and skips an already-current one', () => {
    const projected = buildAgyMcpConfigDocument({ taskWraith: registration })
    expect(agyMcpConfigNeedsUpdate({ status: 'empty' }, projected)).toBe(true)
    expect(agyMcpConfigNeedsUpdate({ status: 'ok', document: projected }, projected)).toBe(false)
  })

  it('never proposes a write over content it could not read', () => {
    expect(
      agyMcpConfigNeedsUpdate(
        { status: 'unreadable' },
        buildAgyMcpConfigDocument({ taskWraith: registration })
      )
    ).toBe(false)
  })

  it('ignores pure re-formatting by agy s own writer', () => {
    const projected = buildAgyMcpConfigDocument({ taskWraith: registration })
    const reformatted = parseAgyMcpConfigDocument(JSON.stringify(projected))
    expect(agyMcpConfigNeedsUpdate(reformatted, projected)).toBe(false)
  })
})

describe('isTaskWraithOwnedAgyMcpServerName', () => {
  it('matches case-insensitively and leaves user servers alone', () => {
    expect(isTaskWraithOwnedAgyMcpServerName('taskwraith')).toBe(true)
    expect(isTaskWraithOwnedAgyMcpServerName('  AGBench ')).toBe(true)
    expect(isTaskWraithOwnedAgyMcpServerName('taskwraith-helper')).toBe(false)
    expect(isTaskWraithOwnedAgyMcpServerName('sqlite-helper')).toBe(false)
  })
})
