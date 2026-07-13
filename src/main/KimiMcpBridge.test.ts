import { describe, expect, it } from 'vitest'
import {
  KIMI_TASKWRAITH_SERVER_NAME,
  KIMI_TASKWRAITH_TOOL_NAMES,
  KIMI_LEGACY_TASKWRAITH_SERVER_NAMES,
  buildKimiWirePromptRequest,
  buildKimiRunMcpConfig,
  buildKimiMcpBridgeAddArgs,
  buildKimiMcpBridgeRemoveArgs,
  extendKimiCliArgsWithMcpConfig,
  redactKimiMcpBridgeAddArgs
} from './KimiMcpBridge'

// Legacy explicit registration helpers remain available for migration and
// repair commands. Active runs use the isolated --mcp-config-file helpers
// tested below rather than mutating ~/.kimi/mcp.json.
//
// Kimi CLI 1.43.0 syntax (verified via `kimi mcp add --help`):
//
//   kimi mcp add <name> --transport stdio --env KEY=VALUE -- <command> <args>
//
// The `--` separator is the key difference vs. Gemini/Codex: it tells
// Kimi to stop flag-parsing so the bridge's --socket / --token args
// survive intact to the subprocess.
describe('buildKimiMcpBridgeAddArgs', () => {
  const fixture = {
    bridgeBinaryPath: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
    bridgeArgs: [
      '--taskwraith-gemini-mcp-bridge',
      '--socket',
      '/tmp/taskwraith.sock',
      '--token',
      'deadbeef'
    ]
  }

  it('emits the canonical kimi mcp add argv with --env env-stamp and -- separator', () => {
    const args = buildKimiMcpBridgeAddArgs(fixture)
    expect(args).toEqual([
      'mcp',
      'add',
      'TaskWraith',
      '--transport',
      'stdio',
      '--env',
      'TASKWRAITH_PARENT_PROVIDER=kimi',
      '--',
      '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
      '--taskwraith-gemini-mcp-bridge',
      '--socket',
      '/tmp/taskwraith.sock',
      '--token',
      'deadbeef'
    ])
  })

  it("uses 'TaskWraith' as the server name (matches Gemini / Codex / Claude registrations)", () => {
    const args = buildKimiMcpBridgeAddArgs(fixture)
    // Name is the third positional after `mcp add`.
    expect(args[0]).toBe('mcp')
    expect(args[1]).toBe('add')
    expect(args[2]).toBe(KIMI_TASKWRAITH_SERVER_NAME)
    expect(KIMI_TASKWRAITH_SERVER_NAME).toBe('TaskWraith')
  })

  it('declares stdio transport explicitly via `--transport stdio`', () => {
    const args = buildKimiMcpBridgeAddArgs(fixture)
    const transportIndex = args.indexOf('--transport')
    expect(transportIndex).toBeGreaterThan(-1)
    expect(args[transportIndex + 1]).toBe('stdio')
  })

  it('stamps TASKWRAITH_PARENT_PROVIDER=kimi via the --env flag so the bridge inherits the routing key', () => {
    const args = buildKimiMcpBridgeAddArgs(fixture)
    const envIndex = args.indexOf('--env')
    expect(envIndex).toBeGreaterThan(-1)
    expect(args[envIndex + 1]).toBe('TASKWRAITH_PARENT_PROVIDER=kimi')
  })

  it('places the `--` separator BEFORE the bridge command (so Kimi stops flag-parsing)', () => {
    const args = buildKimiMcpBridgeAddArgs(fixture)
    const sepIndex = args.indexOf('--')
    expect(sepIndex).toBeGreaterThan(-1)
    expect(args[sepIndex + 1]).toBe(fixture.bridgeBinaryPath)
    // All bridgeArgs come after the binary path.
    for (const bridgeArg of fixture.bridgeArgs) {
      const argIndex = args.indexOf(bridgeArg)
      expect(argIndex).toBeGreaterThan(sepIndex)
    }
  })

  it('preserves bridgeArgs order verbatim after the binary path', () => {
    const args = buildKimiMcpBridgeAddArgs(fixture)
    const binaryIndex = args.indexOf(fixture.bridgeBinaryPath)
    expect(args.slice(binaryIndex + 1)).toEqual(fixture.bridgeArgs)
  })

  it('always includes delegate_to_subthread in the TaskWraith MCP tool list (headline Phase I tool)', () => {
    expect(KIMI_TASKWRAITH_TOOL_NAMES).toContain('delegate_to_subthread')
  })

  it('publishes the compact gateway profile rather than every hidden first-party schema', () => {
    expect(KIMI_TASKWRAITH_TOOL_NAMES).toContain('capability_search')
    expect(KIMI_TASKWRAITH_TOOL_NAMES).toContain('capability_invoke')
    expect(KIMI_TASKWRAITH_TOOL_NAMES).not.toContain('video_encode_clip')
  })

  it('handles bridges with no extra args (degenerate but valid input shape)', () => {
    const args = buildKimiMcpBridgeAddArgs({
      bridgeBinaryPath: '/usr/local/bin/taskwraith',
      bridgeArgs: []
    })
    const sepIndex = args.indexOf('--')
    expect(args[sepIndex + 1]).toBe('/usr/local/bin/taskwraith')
    expect(args).toHaveLength(sepIndex + 2)
  })

  it('does not mutate the supplied bridgeArgs array (pure function contract)', () => {
    const bridgeArgs = [...fixture.bridgeArgs]
    buildKimiMcpBridgeAddArgs({ ...fixture, bridgeArgs })
    expect(bridgeArgs).toEqual(fixture.bridgeArgs)
  })
})

describe('redactKimiMcpBridgeAddArgs', () => {
  it('redacts the argument immediately following --token so logs do not leak the broker secret', () => {
    const args = buildKimiMcpBridgeAddArgs({
      bridgeBinaryPath: '/opt/taskwraith/bin/TaskWraith',
      bridgeArgs: [
        '--taskwraith-gemini-mcp-bridge',
        '--socket',
        '/run/taskwraith.sock',
        '--token',
        'cafebabe-secret-token'
      ]
    })
    const redacted = redactKimiMcpBridgeAddArgs(args)
    expect(redacted).not.toContain('cafebabe-secret-token')
    const tokenIndex = redacted.indexOf('--token')
    expect(redacted[tokenIndex + 1]).toBe('[redacted-token]')
  })

  it('does not redact any other argument', () => {
    const args = buildKimiMcpBridgeAddArgs({
      bridgeBinaryPath: '/opt/taskwraith/bin/TaskWraith',
      bridgeArgs: [
        '--taskwraith-gemini-mcp-bridge',
        '--socket',
        '/run/taskwraith.sock',
        '--token',
        'cafebabe'
      ]
    })
    const redacted = redactKimiMcpBridgeAddArgs(args)
    expect(redacted).toContain('/opt/taskwraith/bin/TaskWraith')
    expect(redacted).toContain('--socket')
    expect(redacted).toContain('/run/taskwraith.sock')
    expect(redacted).toContain('TASKWRAITH_PARENT_PROVIDER=kimi')
  })
})

describe('buildKimiMcpBridgeRemoveArgs', () => {
  it('builds the canonical remove argv for TaskWraith-owned bridge entries', () => {
    expect(buildKimiMcpBridgeRemoveArgs('TaskWraith')).toEqual(['mcp', 'remove', 'TaskWraith'])
  })

  it('lists legacy AGBench bridge entries that TaskWraith should prune', () => {
    expect(KIMI_LEGACY_TASKWRAITH_SERVER_NAMES).toEqual(['agentbench', 'AGBench'])
  })
})

describe('per-run Kimi MCP config', () => {
  const taskWraith = {
    bridgeBinaryPath: '/Applications/TaskWraith Dev.app/Contents/MacOS/TaskWraith Dev',
    bridgeArgs: [
      '--taskwraith-gemini-mcp-bridge',
      '--socket',
      '/tmp/taskwraith-dev.sock',
      '--token',
      'dev-token'
    ],
    env: { CUSTOM_ROUTE_HINT: '1', TASKWRAITH_PARENT_PROVIDER: 'wrong-provider' }
  }

  it('preserves user servers only when an audited caller explicitly opts in', () => {
    const config = buildKimiRunMcpConfig({
      preserveUserServers: true,
      globalConfig: {
        mcpServers: {
          docs: { command: 'docs-server', args: ['--stdio'] },
          TaskWraith: { command: '/Applications/TaskWraith.app/old-release' },
          agentbench: { command: 'old-agentbench' },
          AGBench: { command: 'old-agbench' }
        }
      },
      taskWraith
    })

    expect(config.mcpServers).toEqual({
      docs: { command: 'docs-server', args: ['--stdio'] },
      TaskWraith: {
        command: taskWraith.bridgeBinaryPath,
        args: taskWraith.bridgeArgs,
        env: { CUSTOM_ROUTE_HINT: '1', TASKWRAITH_PARENT_PROVIDER: 'kimi' }
      }
    })
  })

  it('removes stale TaskWraith entries when the bridge is disabled', () => {
    expect(
      buildKimiRunMcpConfig({
        preserveUserServers: true,
        globalConfig: {
          mcpServers: {
            TaskWraith: { command: 'stale-app' },
            userServer: { url: 'https://example.test/mcp' }
          }
        }
      })
    ).toEqual({
      mcpServers: { userServer: { url: 'https://example.test/mcp' } }
    })
  })

  it('builds an empty config for maintenance turns', () => {
    expect(buildKimiRunMcpConfig({})).toEqual({ mcpServers: {} })
  })

  it('omits opaque global MCP servers from a broker-only active run', () => {
    expect(
      buildKimiRunMcpConfig({
        globalConfig: {
          mcpServers: {
            filesystem: { command: 'arbitrary-filesystem-server' },
            shell: { command: 'arbitrary-shell-server' }
          }
        },
        taskWraith
      }).mcpServers
    ).toEqual({
      TaskWraith: {
        command: taskWraith.bridgeBinaryPath,
        args: taskWraith.bridgeArgs,
        env: { CUSTOM_ROUTE_HINT: '1', TASKWRAITH_PARENT_PROVIDER: 'kimi' }
      }
    })
  })

  it('prefixes an explicit config file without mutating the base args', () => {
    const baseArgs = ['--print', '--plan', '--prompt', 'hello']
    expect(extendKimiCliArgsWithMcpConfig(baseArgs, '/tmp/kimi-mcp.json')).toEqual([
      '--mcp-config-file',
      '/tmp/kimi-mcp.json',
      ...baseArgs
    ])
    expect(baseArgs).toEqual(['--print', '--plan', '--prompt', 'hello'])
  })
})

describe('buildKimiWirePromptRequest', () => {
  it('builds a plain text Kimi wire prompt request', () => {
    expect(buildKimiWirePromptRequest({ id: 'prompt-1', prompt: 'hello' })).toEqual({
      jsonrpc: '2.0',
      id: 'prompt-1',
      method: 'prompt',
      params: { user_input: 'hello' }
    })
  })

  it('preserves image attachments in Kimi wire prompt requests', () => {
    expect(
      buildKimiWirePromptRequest({
        id: 'prompt-2',
        prompt: 'inspect this',
        imagePaths: ['/tmp/a.png', '/tmp/b.png']
      })
    ).toEqual({
      jsonrpc: '2.0',
      id: 'prompt-2',
      method: 'prompt',
      params: {
        user_input: [
          { type: 'text', text: 'inspect this' },
          { type: 'image_url', image_url: { url: '/tmp/a.png' } },
          { type: 'image_url', image_url: { url: '/tmp/b.png' } }
        ]
      }
    })
  })
})
