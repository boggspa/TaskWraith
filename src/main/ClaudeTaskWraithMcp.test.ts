import { describe, expect, it } from 'vitest'
import {
  CLAUDE_TASKWRAITH_TOOL_NAMES,
  CLAUDE_TASKWRAITH_SERVER_NAME,
  TASKWRAITH_MCP_GATEWAY_SUBSET_ARG,
  buildClaudeTaskWraithAllowedToolNames,
  buildClaudeTaskWraithMcpConfigJson,
  buildClaudeTaskWraithMcpServers,
  extendClaudeCliArgsWithTaskWraithMcp
} from './ClaudeTaskWraithMcp'
import {
  CORE_MCP_ADVERTISE_TOOLS,
  GATEWAY_V7_MCP_ADVERTISE_TOOLS,
  GATEWAY_V9_MCP_ADVERTISE_TOOLS,
  GATEWAY_V9_MESH_MCP_ADVERTISE_TOOLS
} from './mcp/McpToolProfiles'
import {
  GEMINI_MCP_MESH_DIRECT_ARG,
  GEMINI_MCP_PORTABLE_ENSEMBLE_CONTROL_ARG,
  GEMINI_MCP_SKETCH_DIRECT_ARG
} from './mcp/McpBridgeRuntime'
import {
  TASKWRAITH_CORE_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V7_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_V9_MESH_MCP_PROFILE_ID
} from './mcp/McpSessionProfileFence'

// Phase I3 (Claude initiator): the Claude SDK + CLI fallback gain the
// same TaskWraith MCP server that Gemini/Codex already use. Pin the
// exact `mcpServers` shape (SDK path) and CLI argv extension so a
// regression in the broker / parent-provider routing trips immediately.
describe('buildClaudeTaskWraithMcpServers', () => {
  const fixture = {
    enabled: true,
    bridgeBinaryPath: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
    bridgeArgs: [
      '--taskwraith-gemini-mcp-bridge',
      '--socket',
      '/tmp/taskwraith.sock',
      '--token',
      'deadbeef'
    ]
  }

  it('returns null when disabled so the caller can omit the SDK option entirely', () => {
    expect(buildClaudeTaskWraithMcpServers({ ...fixture, enabled: false })).toBeNull()
  })

  it('emits a single TaskWraith stdio entry with the parentProvider env stamp', () => {
    const servers = buildClaudeTaskWraithMcpServers(fixture)
    expect(servers).toEqual({
      TaskWraith: {
        type: 'stdio',
        command: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
        args: [
          '--taskwraith-gemini-mcp-bridge',
          '--socket',
          '/tmp/taskwraith.sock',
          '--token',
          'deadbeef'
        ],
        env: { TASKWRAITH_PARENT_PROVIDER: 'claude' },
        // QMOD/1.0.3: alwaysLoad disables Claude SDK's tool-search
        // deferral so MCP tools are visible turn-1 without a ToolSearch
        // round-trip. See ClaudeTaskWraithMcp.ts doc for the why.
        alwaysLoad: true
      }
    })
  })

  it('adds run and chat route stamps when provided', () => {
    const servers = buildClaudeTaskWraithMcpServers({
      ...fixture,
      appRunId: 'run-1',
      appChatId: 'chat-1'
    })
    const taskWraith = servers?.TaskWraith
    expect(taskWraith?.type).toBe('stdio')
    if (!taskWraith || taskWraith.type !== 'stdio') throw new Error('TaskWraith server missing')
    expect(taskWraith.env).toEqual({
      TASKWRAITH_PARENT_PROVIDER: 'claude',
      TASKWRAITH_RUN_ID: 'run-1',
      TASKWRAITH_CHAT_ID: 'chat-1'
    })
  })

  it('adds the workspace path stamp when provided', () => {
    const servers = buildClaudeTaskWraithMcpServers({
      ...fixture,
      workspacePath: '/repo'
    })
    const taskWraith = servers?.TaskWraith
    expect(taskWraith?.type).toBe('stdio')
    if (!taskWraith || taskWraith.type !== 'stdio') throw new Error('TaskWraith server missing')
    expect(taskWraith.env).toEqual({
      TASKWRAITH_PARENT_PROVIDER: 'claude',
      TASKWRAITH_WORKSPACE_PATH: '/repo'
    })
  })

  it('uses the TaskWraith server name (matches Gemini/Codex bridge registrations)', () => {
    const servers = buildClaudeTaskWraithMcpServers(fixture)!
    expect(Object.keys(servers)).toEqual([CLAUDE_TASKWRAITH_SERVER_NAME])
    expect(CLAUDE_TASKWRAITH_SERVER_NAME).toBe('TaskWraith')
  })

  it('copies bridgeArgs by value so caller mutations cannot drift the SDK config', () => {
    const args = [...fixture.bridgeArgs]
    const servers = buildClaudeTaskWraithMcpServers({ ...fixture, bridgeArgs: args })!
    args.push('--mutated-after-build')
    const taskWraith = servers.TaskWraith
    expect(taskWraith.type).toBe('stdio')
    if (taskWraith.type !== 'stdio') throw new Error('TaskWraith server missing')
    expect(taskWraith.args).not.toContain('--mutated-after-build')
  })

  it('uses the exact core profile for both the bridge argv and allowed-tool surface', () => {
    const input = { ...fixture, profileId: TASKWRAITH_CORE_MCP_PROFILE_ID }
    const servers = buildClaudeTaskWraithMcpServers(input)
    const taskWraith = servers?.TaskWraith
    expect(taskWraith?.type).toBe('stdio')
    if (!taskWraith || taskWraith.type !== 'stdio') throw new Error('TaskWraith server missing')
    expect(taskWraith.args.at(-1)).toBe('--core-subset')

    const allowed = buildClaudeTaskWraithAllowedToolNames(TASKWRAITH_CORE_MCP_PROFILE_ID)
    expect(allowed).toHaveLength(CORE_MCP_ADVERTISE_TOOLS.length * 2)
    for (const tool of CORE_MCP_ADVERTISE_TOOLS) {
      expect(allowed).toContain(tool)
      expect(allowed).toContain(`mcp__TaskWraith__${tool}`)
    }
    expect(allowed).not.toContain('image_generate')
    expect(allowed).not.toContain('mcp__TaskWraith__image_generate')
  })

  it('uses the exact gateway profile for both the bridge argv and allowed-tool surface', () => {
    const input = { ...fixture, profileId: TASKWRAITH_GATEWAY_MCP_PROFILE_ID }
    const servers = buildClaudeTaskWraithMcpServers(input)
    const taskWraith = servers?.TaskWraith
    expect(taskWraith?.type).toBe('stdio')
    if (!taskWraith || taskWraith.type !== 'stdio') throw new Error('TaskWraith server missing')
    expect(taskWraith.args).toContain(TASKWRAITH_MCP_GATEWAY_SUBSET_ARG)
    expect(taskWraith.args).toContain(GEMINI_MCP_PORTABLE_ENSEMBLE_CONTROL_ARG)
    expect(taskWraith.args.at(-1)).toBe(GEMINI_MCP_SKETCH_DIRECT_ARG)
    expect(taskWraith.args).not.toContain('--core-subset')

    const allowed = buildClaudeTaskWraithAllowedToolNames(TASKWRAITH_GATEWAY_MCP_PROFILE_ID)
    expect(allowed).toHaveLength(GATEWAY_V9_MCP_ADVERTISE_TOOLS.length * 2)
    for (const tool of GATEWAY_V9_MCP_ADVERTISE_TOOLS) {
      expect(allowed).toContain(tool)
      expect(allowed).toContain(`mcp__TaskWraith__${tool}`)
    }
    expect(allowed).toContain('canvas_sketch_open')
    expect(allowed).toContain('canvas_sketch_get')
    expect(allowed).toContain('canvas_sketch_update')
    expect(allowed).toContain('ensemble_control')
    expect(allowed).not.toContain('ensemble_bossman_control')
    expect(allowed).not.toContain('image_generate')
    expect(allowed).not.toContain('mcp__TaskWraith__image_generate')
  })

  it('adds direct Mesh Canvas tools to the fresh non-denied participant profile', () => {
    const servers = buildClaudeTaskWraithMcpServers({
      ...fixture,
      profileId: TASKWRAITH_GATEWAY_V9_MESH_MCP_PROFILE_ID
    })
    const taskWraith = servers?.TaskWraith
    expect(taskWraith?.type).toBe('stdio')
    if (!taskWraith || taskWraith.type !== 'stdio') throw new Error('TaskWraith server missing')
    expect(taskWraith.args).toContain(GEMINI_MCP_MESH_DIRECT_ARG)
    expect(taskWraith.args).toContain(GEMINI_MCP_SKETCH_DIRECT_ARG)
    expect(taskWraith.args.at(-1)).toBe(GEMINI_MCP_SKETCH_DIRECT_ARG)

    const allowed = buildClaudeTaskWraithAllowedToolNames(
      TASKWRAITH_GATEWAY_V9_MESH_MCP_PROFILE_ID
    )
    expect(allowed).toHaveLength(GATEWAY_V9_MESH_MCP_ADVERTISE_TOOLS.length * 2)
    expect(allowed).toContain('mesh_scene_present')
    expect(allowed).toContain('mcp__TaskWraith__mesh_scene_present')
    expect(allowed).toContain('canvas_sketch_update')
    expect(allowed).toContain('ensemble_roster_edit')
  })

  it('keeps Sketch behind discovery for a pinned v7 gateway receipt', () => {
    const servers = buildClaudeTaskWraithMcpServers({
      ...fixture,
      profileId: TASKWRAITH_GATEWAY_V7_MCP_PROFILE_ID
    })
    const taskWraith = servers?.TaskWraith
    expect(taskWraith?.type).toBe('stdio')
    if (!taskWraith || taskWraith.type !== 'stdio') throw new Error('TaskWraith server missing')
    expect(taskWraith.args).not.toContain(GEMINI_MCP_SKETCH_DIRECT_ARG)
    const allowed = buildClaudeTaskWraithAllowedToolNames(TASKWRAITH_GATEWAY_V7_MCP_PROFILE_ID)
    expect(allowed).toHaveLength(GATEWAY_V7_MCP_ADVERTISE_TOOLS.length * 2)
    expect(allowed).not.toContain('canvas_sketch_update')
  })

  it('strips stale subset flags when the pinned profile is full', () => {
    const servers = buildClaudeTaskWraithMcpServers({
      ...fixture,
      bridgeArgs: [
        ...fixture.bridgeArgs,
        '--core-subset',
        '--gateway-subset',
        '--sketch-direct'
      ]
    })
    const taskWraith = servers?.TaskWraith
    expect(taskWraith?.type).toBe('stdio')
    if (!taskWraith || taskWraith.type !== 'stdio') throw new Error('TaskWraith server missing')
    expect(taskWraith.args).not.toContain('--core-subset')
    expect(taskWraith.args).not.toContain('--gateway-subset')
    expect(taskWraith.args).not.toContain('--sketch-direct')
  })

  it('adds user-managed stdio servers beside the TaskWraith bridge', () => {
    const servers = buildClaudeTaskWraithMcpServers({
      ...fixture,
      userMcpServers: [
        {
          serverName: 'user_filesystem',
          transport: 'stdio',
          command: 'npx',
          args: ['@modelcontextprotocol/server-filesystem', '/repo'],
          env: { PROJECT_ROOT: '/repo' }
        }
      ]
    })

    expect(servers?.TaskWraith.alwaysLoad).toBe(true)
    expect(servers?.user_filesystem).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['@modelcontextprotocol/server-filesystem', '/repo'],
      env: { PROJECT_ROOT: '/repo' }
    })
  })

  it('can emit user-managed stdio servers when the TaskWraith bridge is disabled', () => {
    const servers = buildClaudeTaskWraithMcpServers({
      ...fixture,
      enabled: false,
      userMcpServers: [
        {
          serverName: 'user_docs',
          transport: 'stdio',
          command: '/usr/local/bin/docs-mcp',
          args: []
        }
      ]
    })

    expect(servers).toEqual({
      user_docs: {
        type: 'stdio',
        command: '/usr/local/bin/docs-mcp',
        args: [],
        env: {}
      }
    })
  })

  it('adds user-managed remote HTTP and SSE servers beside the TaskWraith bridge', () => {
    const servers = buildClaudeTaskWraithMcpServers({
      ...fixture,
      userMcpServers: [
        {
          serverName: 'user_remote_docs',
          transport: 'http',
          url: 'https://example.test/mcp',
          headers: {
            'X-Region': 'eu'
          },
          bearerTokenEnvVar: 'DOCS_TOKEN'
        },
        {
          serverName: 'user_legacy_sse',
          transport: 'sse',
          url: 'https://example.test/sse',
          headers: {
            'X-Region': 'eu'
          }
        }
      ]
    })

    expect(servers?.user_remote_docs).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: {
        Authorization: 'Bearer ${DOCS_TOKEN}',
        'X-Region': 'eu'
      }
    })
    expect(servers?.user_legacy_sse).toEqual({
      type: 'sse',
      url: 'https://example.test/sse',
      headers: {
        'X-Region': 'eu'
      }
    })
  })

  it('skips user-managed servers with malformed provider-facing names', () => {
    const servers = buildClaudeTaskWraithMcpServers({
      ...fixture,
      enabled: false,
      userMcpServers: [
        {
          serverName: 'user.docs',
          transport: 'stdio',
          command: '/usr/local/bin/docs-mcp',
          args: []
        },
        {
          serverName: 'user_docs',
          transport: 'stdio',
          command: '/usr/local/bin/docs-mcp',
          args: []
        }
      ]
    })

    expect(Object.keys(servers ?? {})).toEqual(['user_docs'])
  })
})

describe('buildClaudeTaskWraithMcpConfigJson', () => {
  it('mirrors the SDK shape under a top-level mcpServers key (CLI path)', () => {
    const config = buildClaudeTaskWraithMcpConfigJson({
      enabled: true,
      bridgeBinaryPath: '/opt/taskwraith/bin/TaskWraith',
      bridgeArgs: [
        '--taskwraith-gemini-mcp-bridge',
        '--socket',
        '/run/taskwraith.sock',
        '--token',
        'cafebabe'
      ]
    })
    expect(config).toEqual({
      mcpServers: {
        TaskWraith: {
          type: 'stdio',
          command: '/opt/taskwraith/bin/TaskWraith',
          args: [
            '--taskwraith-gemini-mcp-bridge',
            '--socket',
            '/run/taskwraith.sock',
            '--token',
            'cafebabe'
          ],
          env: { TASKWRAITH_PARENT_PROVIDER: 'claude' },
          alwaysLoad: true
        }
      }
    })
  })

  it('returns null when disabled so the caller can skip the temp-file write', () => {
    expect(
      buildClaudeTaskWraithMcpConfigJson({ enabled: false, bridgeBinaryPath: '/x', bridgeArgs: [] })
    ).toBeNull()
  })
})

describe('buildClaudeTaskWraithAllowedToolNames', () => {
  it('emits both mcp__TaskWraith__<tool> and bare <tool> names for every TaskWraith MCP tool', () => {
    const names = buildClaudeTaskWraithAllowedToolNames()
    for (const tool of CLAUDE_TASKWRAITH_TOOL_NAMES) {
      expect(names).toContain(`mcp__TaskWraith__${tool}`)
      expect(names).toContain(tool)
    }
    // Each tool is emitted in both namespaced and bare form.
    expect(names).toHaveLength(CLAUDE_TASKWRAITH_TOOL_NAMES.length * 2)
  })

  it('lists the namespaced form before the bare form (Claude CLI namespacing comes first)', () => {
    const names = buildClaudeTaskWraithAllowedToolNames()
    const firstBareIndex = names.findIndex((name) => !name.startsWith('mcp__'))
    const lastNamespacedIndex = names
      .map((name, index) => (name.startsWith('mcp__') ? index : -1))
      .filter((index) => index >= 0)
      .pop()!
    expect(firstBareIndex).toBeGreaterThan(lastNamespacedIndex)
  })

  it('always includes delegate_to_subthread (the headline Phase I tool)', () => {
    expect(buildClaudeTaskWraithAllowedToolNames()).toContain('mcp__TaskWraith__delegate_to_subthread')
    expect(buildClaudeTaskWraithAllowedToolNames()).toContain('delegate_to_subthread')
  })
})

describe('extendClaudeCliArgsWithTaskWraithMcp', () => {
  const baseArgs = ['-p', 'hello', '--output-format', 'stream-json']
  const fixture = {
    enabled: true,
    bridgeBinaryPath: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
    bridgeArgs: [
      '--taskwraith-gemini-mcp-bridge',
      '--socket',
      '/tmp/taskwraith.sock',
      '--token',
      'deadbeef'
    ],
    configFilePath: '/tmp/taskwraith-claude-mcp-run-123.json'
  }

  it('returns a copy of base args unchanged when disabled', () => {
    const out = extendClaudeCliArgsWithTaskWraithMcp(baseArgs, { ...fixture, enabled: false })
    expect(out).toEqual(baseArgs)
    expect(out).not.toBe(baseArgs)
    expect(out).not.toContain('--mcp-config')
    expect(out).not.toContain('--allowedTools')
  })

  it('appends --mcp-config <path> and --allowedTools <comma-joined-names> after the base args', () => {
    const out = extendClaudeCliArgsWithTaskWraithMcp(baseArgs, fixture)
    // The base args stay in order at the front.
    expect(out.slice(0, baseArgs.length)).toEqual(baseArgs)
    // --mcp-config followed by the temp file path.
    const mcpIndex = out.indexOf('--mcp-config')
    expect(mcpIndex).toBeGreaterThan(-1)
    expect(out[mcpIndex + 1]).toBe('/tmp/taskwraith-claude-mcp-run-123.json')
    // --allowedTools followed by the comma-joined list.
    const allowedIndex = out.indexOf('--allowedTools')
    expect(allowedIndex).toBeGreaterThan(-1)
    const allowedValue = out[allowedIndex + 1]
    expect(allowedValue.split(',')).toEqual(buildClaudeTaskWraithAllowedToolNames())
  })

  it('uses the core allowedTools set when the CLI config bridge is core-filtered', () => {
    const out = extendClaudeCliArgsWithTaskWraithMcp(baseArgs, {
      ...fixture,
      profileId: TASKWRAITH_CORE_MCP_PROFILE_ID
    })
    const allowedIndex = out.indexOf('--allowedTools')
    expect(allowedIndex).toBeGreaterThan(-1)
    expect(out[allowedIndex + 1].split(',')).toEqual(
      buildClaudeTaskWraithAllowedToolNames(TASKWRAITH_CORE_MCP_PROFILE_ID)
    )
    expect(out[allowedIndex + 1]).not.toContain('image_generate')
  })

  it('uses the gateway allowedTools set when the CLI config bridge is gateway-filtered', () => {
    const out = extendClaudeCliArgsWithTaskWraithMcp(baseArgs, {
      ...fixture,
      profileId: TASKWRAITH_GATEWAY_MCP_PROFILE_ID
    })
    const allowedIndex = out.indexOf('--allowedTools')
    expect(allowedIndex).toBeGreaterThan(-1)
    expect(out[allowedIndex + 1].split(',')).toEqual(
      buildClaudeTaskWraithAllowedToolNames(TASKWRAITH_GATEWAY_MCP_PROFILE_ID)
    )
    expect(out[allowedIndex + 1]).toContain('capability_search')
    expect(out[allowedIndex + 1]).toContain('capability_invoke')
    expect(out[allowedIndex + 1]).not.toContain('image_generate')
  })

  it('appends --mcp-config without pre-approving unknown user MCP tools', () => {
    const out = extendClaudeCliArgsWithTaskWraithMcp(baseArgs, {
      ...fixture,
      enabled: false,
      userMcpServers: [
        {
          serverName: 'user_docs',
          transport: 'stdio',
          command: '/usr/local/bin/docs-mcp',
          args: []
        }
      ]
    })

    expect(out).toContain('--mcp-config')
    expect(out).not.toContain('--allowedTools')
  })

  it('does not mutate the supplied base args array (pure function contract)', () => {
    const args = [...baseArgs]
    extendClaudeCliArgsWithTaskWraithMcp(args, fixture)
    expect(args).toEqual(baseArgs)
  })
})
