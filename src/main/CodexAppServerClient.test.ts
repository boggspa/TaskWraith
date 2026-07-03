import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/taskwraith-codex-app-server-client-test',
    getVersion: () => 'test'
  }
}))

import {
  buildCodexFastServiceTierCompatibilityArgs,
  buildCodexTaskWraithMcpArgs,
  codexConfigParseUserMessage,
  codexInitializeAdvertisesNativeGoalControl,
  codexRuntimeProfileKey,
  CodexAppServerClient,
  compareCodexVersions,
  isCodexAppServerThreadId,
  isCodexConfigParseError,
  parseCodexVersion,
  type CodexMcpTaskWraithConfig
} from './CodexAppServerClient'
import type { RuntimeProfile } from './store/types'

function makeRuntimeProfile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: 'profile-1',
    name: 'Profile 1',
    provider: 'codex',
    scope: 'workspace',
    workspaceMode: 'local',
    binaryPath: '/custom/codex',
    env: { CODEX_HOME: '/custom/home' },
    networkPolicy: 'inherit',
    persistence: 'reusable',
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
    ...overrides
  }
}

describe('isCodexAppServerThreadId', () => {
  it('accepts a plain UUID (a real app-server thread id)', () => {
    expect(isCodexAppServerThreadId('7b057c8b-33fa-4eca-9efe-3313a83669f4')).toBe(true)
  })

  it('accepts a urn:uuid:-prefixed UUID', () => {
    expect(isCodexAppServerThreadId('urn:uuid:7b057c8b-33fa-4eca-9efe-3313a83669f4')).toBe(true)
  })

  it('rejects a codex-exec fallback session id (the poison-loop id)', () => {
    // This is the exact id shape that wedged a chat into perpetual exec
    // fallback ("invalid thread id: ... found `o` at 2").
    expect(isCodexAppServerThreadId('codex-exec-1780439561126')).toBe(false)
  })

  it('rejects other non-UUID ids and empty / nullish values', () => {
    expect(isCodexAppServerThreadId('1780439938268-rc0h3xqajl')).toBe(false)
    expect(isCodexAppServerThreadId('')).toBe(false)
    expect(isCodexAppServerThreadId(null)).toBe(false)
    expect(isCodexAppServerThreadId(undefined)).toBe(false)
  })
})

describe('CodexAppServerClient runtime profile tracking', () => {
  function makeMcpConfig(
    overrides: Partial<CodexMcpTaskWraithConfig> = {}
  ): CodexMcpTaskWraithConfig {
    return {
      enabled: true,
      bridgeBinaryPath: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
      bridgeArgs: ['--taskwraith-gemini-mcp-bridge'],
      parentProvider: 'codex',
      ...overrides
    }
  }

  it('keys app-server startup by runtime profile id', () => {
    expect(codexRuntimeProfileKey(null)).toBe('default')
    expect(codexRuntimeProfileKey(makeRuntimeProfile({ id: 'custom-codex' }))).toBe(
      'custom-codex'
    )
  })

  it('disposes a running client when switching profiles', () => {
    const client = new CodexAppServerClient()
    const dispose = vi.spyOn(client, 'dispose')
    client.setRuntimeProfile(makeRuntimeProfile({ id: 'profile-1' }))
    expect(client.getRuntimeProfileKey()).toBe('profile-1')
    expect(dispose).toHaveBeenCalledTimes(1)
    client.setRuntimeProfile(makeRuntimeProfile({ id: 'profile-1', binaryPath: '/other/codex' }))
    expect(dispose).toHaveBeenCalledTimes(1)
    client.setRuntimeProfile(null)
    expect(client.getRuntimeProfileKey()).toBe('default')
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('marks a running client stale when MCP config changes and clears it on dispose', () => {
    const client = new CodexAppServerClient()
    const initialConfig = makeMcpConfig()
    client.setMcpConfig(initialConfig)
    const kill = vi.fn()
    ;(client as any).proc = { killed: false, stdin: { writable: true }, kill }
    ;(client as any).startedMcpConfigFingerprint = JSON.stringify({
      args: buildCodexTaskWraithMcpArgs(initialConfig),
      providerEnv: {}
    })

    expect(client.hasStaleMcpConfig()).toBe(false)
    client.setMcpConfig(initialConfig)
    expect(client.hasStaleMcpConfig()).toBe(false)
    client.setMcpConfig(
      makeMcpConfig({
        userMcpServers: [
          {
            serverName: 'user_docs',
            transport: 'stdio',
            command: '/usr/local/bin/docs-mcp',
            args: []
          }
        ]
      })
    )
    expect(client.hasStaleMcpConfig()).toBe(true)
    client.setMcpConfig(initialConfig)
    expect(client.hasStaleMcpConfig()).toBe(false)
    client.setMcpConfig(
      makeMcpConfig({
        userMcpServers: [
          {
            serverName: 'user_docs',
            transport: 'stdio',
            command: '/usr/local/bin/docs-mcp',
            args: []
          }
        ]
      })
    )
    expect(client.hasStaleMcpConfig()).toBe(true)

    client.dispose()
    expect(kill).toHaveBeenCalled()
    expect(client.hasStaleMcpConfig()).toBe(false)
  })
})

// Phase I2: the Codex CLI gets the TaskWraith MCP server registered
// at spawn time via `-c mcp_servers.TaskWraith.*` config overrides.
// Pin the exact `-c` arg list (order + TOML escaping) so we don't
// regress the Codex → TaskWraith MCP bridge wiring on accident.
describe('buildCodexTaskWraithMcpArgs', () => {
  function makeConfig(overrides: Partial<CodexMcpTaskWraithConfig> = {}): CodexMcpTaskWraithConfig {
    return {
      enabled: true,
      bridgeBinaryPath: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
      bridgeArgs: [
        '--taskwraith-gemini-mcp-bridge',
        '--socket',
        '/tmp/taskwraith.sock',
        '--token',
        'deadbeef'
      ],
      parentProvider: 'codex',
      ...overrides
    }
  }

  it('returns empty arg list when MCP integration is disabled', () => {
    // Disabled: Codex spawns without any -c overrides, so its agents
    // can't reach the TaskWraith MCP server (matches the existing
    // user-controlled `geminiMcpBridgeEnabled` toggle behaviour).
    expect(buildCodexTaskWraithMcpArgs({ ...makeConfig(), enabled: false })).toEqual([])
  })

  it('emits three -c flag pairs in command/args/env order when enabled', () => {
    const args = buildCodexTaskWraithMcpArgs(makeConfig())
    expect(args).toHaveLength(6)
    expect(args[0]).toBe('-c')
    expect(args[1]).toBe(
      'mcp_servers.TaskWraith.command="/Applications/TaskWraith.app/Contents/MacOS/TaskWraith"'
    )
    expect(args[2]).toBe('-c')
    expect(args[3]).toBe(
      'mcp_servers.TaskWraith.args=["--taskwraith-gemini-mcp-bridge", "--socket", "/tmp/taskwraith.sock", "--token", "deadbeef"]'
    )
    expect(args[4]).toBe('-c')
    expect(args[5]).toBe('mcp_servers.TaskWraith.env={ TASKWRAITH_PARENT_PROVIDER = "codex" }')
  })

  it('TOML-escapes embedded backslashes and double quotes', () => {
    // Windows-style bridge path with backslashes. We don't expect to
    // ship Windows builds yet but the escape codepath should be
    // resilient if process.execPath ever returns one. Quotes must be
    // backslash-escaped or the TOML basic-string parser blows up.
    const args = buildCodexTaskWraithMcpArgs(
      makeConfig({
        bridgeBinaryPath: 'C:\\TaskWraith\\bench"executable"',
        bridgeArgs: ['weird\\path', 'has "quote"']
      })
    )
    expect(args[1]).toBe('mcp_servers.TaskWraith.command="C:\\\\TaskWraith\\\\bench\\"executable\\""')
    expect(args[3]).toBe('mcp_servers.TaskWraith.args=["weird\\\\path", "has \\"quote\\""]')
  })

  it('preserves the parentProvider stamp in the env override', () => {
    // Currently only 'codex' is supported (Gemini uses a different
    // spawn mechanism and stamps env directly). Pin the contract so
    // if a future provider rides on CodexAppServerClient it has to
    // update the test too.
    const args = buildCodexTaskWraithMcpArgs(makeConfig())
    expect(args[5]).toContain('TASKWRAITH_PARENT_PROVIDER = "codex"')
  })

  it('appends enabled user MCP stdio servers after the TaskWraith bridge', () => {
    const args = buildCodexTaskWraithMcpArgs(
      makeConfig({
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
    )

    expect(args).toContain('mcp_servers.user_filesystem.command="npx"')
    expect(args).toContain(
      'mcp_servers.user_filesystem.args=["@modelcontextprotocol/server-filesystem", "/repo"]'
    )
    expect(args).toContain('mcp_servers.user_filesystem.env={ PROJECT_ROOT = "/repo" }')
  })

  it('can emit user MCP servers when the TaskWraith bridge is disabled', () => {
    const args = buildCodexTaskWraithMcpArgs({
      ...makeConfig({ enabled: false }),
      userMcpServers: [
        {
          serverName: 'user_docs',
          transport: 'stdio',
          command: '/usr/local/bin/docs-mcp',
          args: []
        }
      ]
    })

    expect(args).toEqual([
      '-c',
      'mcp_servers.user_docs.command="/usr/local/bin/docs-mcp"',
      '-c',
      'mcp_servers.user_docs.args=[]'
    ])
  })

  it('can emit remote HTTP user MCP servers when the TaskWraith bridge is disabled', () => {
    const args = buildCodexTaskWraithMcpArgs({
      ...makeConfig({ enabled: false }),
      userMcpServers: [
        {
          serverName: 'user_remote_docs',
          transport: 'http',
          url: 'https://example.test/mcp',
          headers: {
            'X-Figma-Region': 'eu',
            Authorization: 'Bearer ${DOCS_TOKEN}'
          },
          bearerTokenEnvVar: 'DOCS_TOKEN'
        }
      ]
    })

    expect(args).toEqual([
      '-c',
      'mcp_servers.user_remote_docs.url="https://example.test/mcp"',
      '-c',
      'mcp_servers.user_remote_docs.bearer_token_env_var="DOCS_TOKEN"',
      '-c',
      'mcp_servers.user_remote_docs.http_headers={ "X-Figma-Region" = "eu", "Authorization" = "Bearer ${DOCS_TOKEN}" }'
    ])
  })

  it('skips user MCP servers with malformed TOML key names', () => {
    const args = buildCodexTaskWraithMcpArgs({
      ...makeConfig({ enabled: false }),
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

    expect(args).toEqual([
      '-c',
      'mcp_servers.user_docs.command="/usr/local/bin/docs-mcp"',
      '-c',
      'mcp_servers.user_docs.args=[]'
    ])
  })
})

describe('buildCodexFastServiceTierCompatibilityArgs', () => {
  it('builds the Codex CLI override used after service_tier parse failures', () => {
    expect(buildCodexFastServiceTierCompatibilityArgs()).toEqual([
      '-c',
      'service_tier="fast"'
    ])
  })
})

// Dogfood hardening (a): when the homebrew codex CLI TaskWraith spawns is older
// than the one the user's Codex.app uses, the app can write a config.toml value
// the older CLI rejects. The CLI prints a deserialize error on stderr and
// exits, so the app-server/probe/exec all fail generically. We classify that
// stderr so the user gets an actionable message instead of the cryptic fallback.
describe('isCodexConfigParseError', () => {
  it('matches the exact production error (unknown variant in service_tier)', () => {
    const stderr =
      'Error loading config.toml: unknown variant `priority`, expected `fast` or `flex` in `service_tier`'
    expect(isCodexConfigParseError(stderr)).toBe(true)
  })

  it('matches other serde-style config deserialize failures', () => {
    expect(isCodexConfigParseError('error loading config: bad value')).toBe(true)
    expect(isCodexConfigParseError('unknown field `foo`, expected one of `a`, `b`')).toBe(true)
    expect(isCodexConfigParseError('invalid type: string "x", expected a boolean')).toBe(true)
    expect(isCodexConfigParseError('missing field `model` at line 3')).toBe(true)
    expect(isCodexConfigParseError('duplicate key `model` in config')).toBe(true)
  })

  it('matches a config.toml reference paired with a parse verb', () => {
    expect(
      isCodexConfigParseError('failed to parse config.toml at /Users/me/.codex/config.toml')
    ).toBe(true)
    expect(isCodexConfigParseError('could not deserialize config.toml')).toBe(true)
  })

  it('does NOT false-positive on normal agent output', () => {
    expect(isCodexConfigParseError('')).toBe(false)
    expect(isCodexConfigParseError(null)).toBe(false)
    expect(isCodexConfigParseError(undefined)).toBe(false)
    // A bare config.toml mention with no parse/deserialize verb must not trigger.
    expect(isCodexConfigParseError('Reading config.toml for model defaults...')).toBe(false)
    expect(
      isCodexConfigParseError('The assistant edited config.toml to add a new mcp server.')
    ).toBe(false)
    expect(isCodexConfigParseError('Codex app-server exited with code 0.')).toBe(false)
    expect(isCodexConfigParseError('thread/start failed: invalid thread id')).toBe(false)
    // Prose that happens to contain "expected ... or" must NOT match — the
    // serde branch requires a backtick-quoted variant before `or`.
    expect(isCodexConfigParseError('Running 12 tests, all passed as expected or skipped.')).toBe(
      false
    )
    expect(isCodexConfigParseError('The test expected 5 or 6 rows but got 4.')).toBe(false)
    expect(isCodexConfigParseError('I expected this to work or fail loudly.')).toBe(false)
  })
})

describe('codexConfigParseUserMessage', () => {
  it('embeds the first stderr line and the two remedies', () => {
    const msg = codexConfigParseUserMessage(
      'Error loading config.toml: unknown variant `priority`, expected `fast` or `flex` in `service_tier`\n  at line 4'
    )
    expect(msg).toContain('~/.codex/config.toml')
    expect(msg).toContain('unknown variant `priority`')
    // First line only — the trailing "  at line 4" is dropped.
    expect(msg).not.toContain('at line 4')
    expect(msg).toContain('brew upgrade codex')
    expect(msg).toContain('fast')
    expect(msg).toContain('flex')
  })
})

describe('codexInitializeAdvertisesNativeGoalControl', () => {
  it('detects explicit native goal-control capabilities from initialize results', () => {
    expect(
      codexInitializeAdvertisesNativeGoalControl({
        capabilities: {
          nativeGoalControl: true
        }
      })
    ).toBe(true)
    expect(
      codexInitializeAdvertisesNativeGoalControl({
        capabilities: {
          experimental: {
            goals: {
              native: true,
              update: true
            }
          }
        }
      })
    ).toBe(true)
  })

  it('does not infer native goal control from generic TaskWraith goal tools', () => {
    expect(
      codexInitializeAdvertisesNativeGoalControl({
        capabilities: {
          tools: ['goal_read', 'goal_update', 'goal_complete', 'goal_blocked']
        }
      })
    ).toBe(false)
    expect(
      codexInitializeAdvertisesNativeGoalControl({
        capabilities: {
          experimentalApi: true,
          mcpServers: ['TaskWraith']
        }
      })
    ).toBe(false)
  })
})

// Dogfood hardening (b): prefer/notify-about the newest codex binary. We DETECT
// a newer codex than TaskWraith would use and warn — we do not auto-switch. These
// pin the version parser + comparator the detection relies on.
describe('parseCodexVersion', () => {
  it('parses a stable `codex-cli x.y.z` line', () => {
    expect(parseCodexVersion('codex-cli 0.128.0')).toMatchObject({
      major: 0,
      minor: 128,
      patch: 0,
      prerelease: ''
    })
  })

  it('parses a prerelease line', () => {
    expect(parseCodexVersion('codex-cli 0.136.0-alpha.2')).toMatchObject({
      major: 0,
      minor: 136,
      patch: 0,
      prerelease: 'alpha.2'
    })
  })

  it('tolerates a bare `x.y` (no patch)', () => {
    expect(parseCodexVersion('codex 1.2')).toMatchObject({ major: 1, minor: 2, patch: 0 })
  })

  it('returns null when there is no version token', () => {
    expect(parseCodexVersion('command not found')).toBeNull()
    expect(parseCodexVersion('')).toBeNull()
    expect(parseCodexVersion(null)).toBeNull()
  })
})

describe('compareCodexVersions', () => {
  it('orders the real-world homebrew vs Codex.app pair (0.128.0 < 0.136.0-alpha.2)', () => {
    expect(compareCodexVersions('codex-cli 0.128.0', 'codex-cli 0.136.0-alpha.2')).toBe(-1)
    expect(compareCodexVersions('codex-cli 0.136.0-alpha.2', 'codex-cli 0.128.0')).toBe(1)
  })

  it('treats equal versions as 0', () => {
    expect(compareCodexVersions('codex-cli 0.128.0', '0.128.0')).toBe(0)
  })

  it('ranks a stable release above its own prerelease (1.0.0 > 1.0.0-alpha)', () => {
    expect(compareCodexVersions('1.0.0', '1.0.0-alpha')).toBe(1)
    expect(compareCodexVersions('1.0.0-alpha', '1.0.0')).toBe(-1)
  })

  it('compares prerelease segments numerically then lexically', () => {
    expect(compareCodexVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1)
    expect(compareCodexVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
  })

  it('returns 0 (do not warn) when either side is unparseable', () => {
    expect(compareCodexVersions('command not found', '0.136.0')).toBe(0)
    expect(compareCodexVersions('0.128.0', null)).toBe(0)
  })

  it('orders major/minor/patch correctly', () => {
    expect(compareCodexVersions('0.9.0', '0.10.0')).toBe(-1)
    expect(compareCodexVersions('1.0.0', '0.999.0')).toBe(1)
    expect(compareCodexVersions('0.128.1', '0.128.0')).toBe(1)
  })
})
