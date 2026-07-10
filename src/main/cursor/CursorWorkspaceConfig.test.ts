import { describe, it, expect } from 'vitest'
import {
  applyCursorWriteModeConfig,
  cursorWriteModeSetupFailureMessage,
  CURSOR_WRITE_MODE_DENY_RULES,
  ensureGlobalCursorBrokerRegistered,
  mergeCursorDenyRules,
  type CursorConfigFs
} from './CursorWorkspaceConfig'
import {
  buildCursorMcpServerEntry,
  CURSOR_LEGACY_WEB_MCP_SERVER_NAME,
  CURSOR_MCP_ALLOW_RULES,
  CURSOR_MCP_SERVER_NAME
} from './CursorMcpBridge'
import {
  buildUserMcpCursorAllowRules,
  buildUserMcpCursorServerEntry,
  buildUserMcpLaunchServers
} from '../UserMcpServers'

describe('mergeCursorDenyRules', () => {
  it('produces a deny-shell config from nothing', () => {
    expect(mergeCursorDenyRules(null, ['Shell(**)'])).toEqual({
      permissions: { allow: [], deny: ['Shell(**)'] }
    })
  })
  it('merges into an existing config, preserving allow + deduping deny + unknown keys', () => {
    const existing = {
      version: 1,
      permissions: { allow: ['Read(**)'], deny: ['Write(.env*)'] }
    }
    expect(mergeCursorDenyRules(existing, ['Shell(**)'])).toEqual({
      version: 1,
      permissions: { allow: ['Read(**)'], deny: ['Write(.env*)', 'Shell(**)'] }
    })
  })
  it('does not duplicate an already-present deny rule', () => {
    const existing = { permissions: { allow: [], deny: ['Shell(**)'] } }
    expect(mergeCursorDenyRules(existing, ['Shell(**)']).permissions.deny).toEqual(['Shell(**)'])
  })
})

describe('cursorWriteModeSetupFailureMessage', () => {
  it('explains that the run was stopped rather than silently degraded, with the reason', () => {
    const message = cursorWriteModeSetupFailureMessage(new Error('Bridge unavailable'))

    expect(message).toContain('Cursor write-mode MCP setup failed')
    expect(message).toContain('stopped')
    expect(message).toContain('Bridge unavailable')
  })
})

// In-memory fake fs implementing the injected surface.
function makeFakeFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial))
  const dirs = new Set<string>()
  const fs: CursorConfigFs = {
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      const v = files.get(p)
      if (v == null) throw new Error('ENOENT')
      return v
    },
    writeFileSync: (p, data) => {
      files.set(p, data)
    },
    mkdirSync: (p) => {
      dirs.add(p)
    },
    rmSync: (p) => {
      files.delete(p)
      dirs.delete(p)
    }
  }
  return { fs, files, dirs }
}

describe('applyCursorWriteModeConfig', () => {
  const CONFIG = '/ws/.cursor/cli.json'
  const DIR = '/ws/.cursor'

  it('writes a deny-shell config when none exists, and restore removes it', () => {
    const { fs, files, dirs } = makeFakeFs()
    const restore = applyCursorWriteModeConfig(fs, CONFIG, DIR)
    expect(dirs.has(DIR)).toBe(true)
    const written = JSON.parse(files.get(CONFIG)!)
    expect(written.permissions.deny).toContain('Shell(**)')
    expect(written.permissions.deny).toContain('Write(**)')
    restore()
    expect(files.has(CONFIG)).toBe(false)
    expect(dirs.has(DIR)).toBe(false)
  })

  it('merges + restores the exact original bytes when a config already exists', () => {
    const originalBytes = '{\n  "permissions": { "allow": ["Read(**)"], "deny": [] }\n}\n'
    const { fs, files } = makeFakeFs({ [CONFIG]: originalBytes, [DIR]: '' })
    // Pre-create the dir so existsSync(DIR) is true.
    fs.mkdirSync(DIR, { recursive: true })
    const restore = applyCursorWriteModeConfig(fs, CONFIG, DIR)
    const merged = JSON.parse(files.get(CONFIG)!)
    expect(merged.permissions.deny).toContain('Shell(**)')
    expect(merged.permissions.deny).toContain('Write(**)')
    expect(merged.permissions.allow).toEqual(['Read(**)'])
    restore()
    expect(files.get(CONFIG)).toBe(originalBytes)
  })

  it('restore is idempotent', () => {
    const { fs, files } = makeFakeFs()
    const restore = applyCursorWriteModeConfig(fs, CONFIG, DIR)
    restore()
    restore()
    expect(files.has(CONFIG)).toBe(false)
  })

  it('exposes the canonical write-mode deny rule', () => {
    expect(CURSOR_WRITE_MODE_DENY_RULES).toEqual(['Shell(**)', 'Write(**)'])
  })

  it('drops the native shell/write deny-list under a full-access grant', () => {
    const { fs, files } = makeFakeFs()
    const restore = applyCursorWriteModeConfig(fs, CONFIG, DIR, undefined, { fullAccess: true })
    const written = JSON.parse(files.get(CONFIG)!)
    expect(written.permissions.deny).toEqual([])
    restore()
    expect(files.has(CONFIG)).toBe(false)
  })

  it('keeps the deny-list for a non-full-access write run', () => {
    const { fs, files } = makeFakeFs()
    applyCursorWriteModeConfig(fs, CONFIG, DIR, undefined, { fullAccess: false })
    const written = JSON.parse(files.get(CONFIG)!)
    expect(written.permissions.deny).toContain('Shell(**)')
    expect(written.permissions.deny).toContain('Write(**)')
  })
})

describe('applyCursorWriteModeConfig with the TaskWraith MCP bridge', () => {
  const CONFIG = '/ws/.cursor/cli.json'
  const MCP = '/ws/.cursor/mcp.json'
  const DIR = '/ws/.cursor'
  const bridge = () => ({
    mcpConfigPath: MCP,
    serverEntry: buildCursorMcpServerEntry({
      command: '/x/electron',
      args: ['/tmp/taskwraith-mcp-server.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    }),
    allowRules: CURSOR_MCP_ALLOW_RULES
  })

  function expectTaskWraithAllowRules(allow: string[]): void {
    expect(allow).toContain(`Mcp(${CURSOR_MCP_SERVER_NAME}:*)`)
    expect(allow).toContain(`Mcp(${CURSOR_MCP_SERVER_NAME}:run_shell_command)`)
    expect(allow).toContain(`Mcp(${CURSOR_MCP_SERVER_NAME}-run_shell_command)`)
    expect(allow).not.toContain(`Mcp(${CURSOR_MCP_SERVER_NAME}-*)`)
    expect(allow).toContain(`Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}:run_shell_command)`)
    expect(allow).toContain(`Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}-run_shell_command)`)
    expect(allow).not.toContain(`Mcp(${CURSOR_LEGACY_WEB_MCP_SERVER_NAME}:*)`)
  }

  function expectTaskWraithMcpServer(
    mcp: { mcpServers: Record<string, { command?: string; args?: string[]; env?: unknown }> }
  ): void {
    expect(mcp.mcpServers[CURSOR_MCP_SERVER_NAME].command).toBe('/x/electron')
    expect(mcp.mcpServers[CURSOR_MCP_SERVER_NAME].args).toEqual([
      '/tmp/taskwraith-mcp-server.cjs'
    ])
    expect(mcp.mcpServers[CURSOR_LEGACY_WEB_MCP_SERVER_NAME].command).toBe('/x/electron')
    expect(mcp.mcpServers[CURSOR_LEGACY_WEB_MCP_SERVER_NAME].args).toEqual([
      '/tmp/taskwraith-mcp-server.cjs'
    ])
  }

  it('writes cli.json (deny + MCP allow) AND mcp.json; restore removes both + the dir', () => {
    const { fs, files, dirs } = makeFakeFs()
    const restore = applyCursorWriteModeConfig(fs, CONFIG, DIR, bridge())

    const cli = JSON.parse(files.get(CONFIG)!)
    expect(cli.permissions.deny).toContain('Shell(**)')
    expect(cli.permissions.deny).toContain('Write(**)')
    expectTaskWraithAllowRules(cli.permissions.allow)

    const mcp = JSON.parse(files.get(MCP)!)
    expectTaskWraithMcpServer(mcp)
    expect(mcp.mcpServers[CURSOR_MCP_SERVER_NAME].env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
    expect(mcp.mcpServers[CURSOR_LEGACY_WEB_MCP_SERVER_NAME].env).toEqual({
      ELECTRON_RUN_AS_NODE: '1'
    })

    restore()
    expect(files.has(CONFIG)).toBe(false)
    expect(files.has(MCP)).toBe(false)
    expect(dirs.has(DIR)).toBe(false)
  })

  it('preserves + restores pre-existing cli.json and mcp.json bytes (and the dir)', () => {
    const cliBytes = '{\n  "permissions": { "allow": [], "deny": ["Write(.env)"] }\n}\n'
    const mcpBytes = '{\n  "mcpServers": { "other": { "command": "x", "args": [] } }\n}\n'
    const { fs, files, dirs } = makeFakeFs({ [CONFIG]: cliBytes, [MCP]: mcpBytes, [DIR]: '' })
    fs.mkdirSync(DIR, { recursive: true })

    const restore = applyCursorWriteModeConfig(fs, CONFIG, DIR, bridge())

    const cli = JSON.parse(files.get(CONFIG)!)
    expect(cli.permissions.deny).toEqual(['Write(.env)', 'Shell(**)', 'Write(**)'])
    expectTaskWraithAllowRules(cli.permissions.allow)

    const mcp = JSON.parse(files.get(MCP)!)
    // Other registered servers survive; the broker + legacy alias are added.
    expect(mcp.mcpServers.other).toEqual({ command: 'x', args: [] })
    expectTaskWraithMcpServer(mcp)

    restore()
    expect(files.get(CONFIG)).toBe(cliBytes)
    expect(files.get(MCP)).toBe(mcpBytes)
    // We didn't create the dir, so restore leaves it.
    expect(dirs.has(DIR)).toBe(true)
  })

  it('can register user-managed MCP servers alongside the TaskWraith bridge', () => {
    const userServers = buildUserMcpLaunchServers(
      [
        {
          id: 'filesystem',
          name: 'Filesystem',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          args: ['@modelcontextprotocol/server-filesystem', '/repo'],
          env: { PROJECT_ROOT: '/repo' }
        },
        {
          id: 'docs',
          name: 'Docs',
          enabled: true,
          transport: 'http',
          url: 'https://example.test/mcp'
        }
      ],
      ['stdio', 'http']
    )
    const { fs, files } = makeFakeFs()

    const restore = applyCursorWriteModeConfig(fs, CONFIG, DIR, {
      mcpConfigPath: MCP,
      serverEntry: {
        ...buildCursorMcpServerEntry({
          command: '/x/electron',
          args: ['/tmp/taskwraith-mcp-server.cjs']
        }),
        ...buildUserMcpCursorServerEntry(userServers)
      },
      allowRules: [...CURSOR_MCP_ALLOW_RULES, ...buildUserMcpCursorAllowRules(userServers)]
    })

    const cli = JSON.parse(files.get(CONFIG)!)
    expectTaskWraithAllowRules(cli.permissions.allow)
    expect(cli.permissions.allow).toContain('Mcp(user_filesystem:*)')
    expect(cli.permissions.allow).toContain('Mcp(user_docs:*)')

    const mcp = JSON.parse(files.get(MCP)!)
    expectTaskWraithMcpServer(mcp)
    expect(mcp.mcpServers.user_filesystem).toEqual({
      command: 'npx',
      args: ['@modelcontextprotocol/server-filesystem', '/repo'],
      env: { PROJECT_ROOT: '/repo' }
    })
    expect(mcp.mcpServers.user_docs).toEqual({
      url: 'https://example.test/mcp'
    })

    restore()
  })

  it('allowRules-only setup writes cli.json allow + deny but NO mcp.json', () => {
    const { fs, files } = makeFakeFs()
    // No mcpConfigPath / serverEntry — helper still supports callers that only
    // need cli.json permission merging.
    const restore = applyCursorWriteModeConfig(fs, CONFIG, DIR, {
      allowRules: CURSOR_MCP_ALLOW_RULES
    })

    const cli = JSON.parse(files.get(CONFIG)!)
    expect(cli.permissions.deny).toContain('Shell(**)')
    expect(cli.permissions.deny).toContain('Write(**)')
    expectTaskWraithAllowRules(cli.permissions.allow)
    // The per-run workspace mcp.json must NOT be written in B mode.
    expect(files.has(MCP)).toBe(false)

    restore()
    expect(files.has(CONFIG)).toBe(false)
  })
})

describe('ensureGlobalCursorBrokerRegistered (B mode)', () => {
  const GLOBAL_DIR = '/home/.cursor'
  const GLOBAL_MCP = '/home/.cursor/mcp.json'
  const broker = buildCursorMcpServerEntry({ command: '/x/electron', args: ['/s.cjs', '--token', 'T1'] })
  // buildCursorMcpServerEntry also emits the legacy alias; for the global path the
  // caller passes buildCursorBrokerMcpServerEntry, but any Record works here.
  const brokerOnly = { 'taskwraith-broker': (broker as Record<string, unknown>)['taskwraith-broker'] }

  it('writes the broker into a fresh global mcp.json and creates ~/.cursor', () => {
    const { fs, files, dirs } = makeFakeFs()
    const wrote = ensureGlobalCursorBrokerRegistered(fs, GLOBAL_MCP, GLOBAL_DIR, brokerOnly)
    expect(wrote).toBe(true)
    expect(dirs.has(GLOBAL_DIR)).toBe(true)
    const cfg = JSON.parse(files.get(GLOBAL_MCP)!)
    expect(cfg.mcpServers['taskwraith-broker']).toBeDefined()
  })

  it('PRESERVES the user\'s own global servers (never removes them)', () => {
    const { fs, files } = makeFakeFs({
      [GLOBAL_MCP]: JSON.stringify({
        mcpServers: { taskwraith: { command: 'node', args: ['/web.cjs'] }, agbench: { command: 'node', args: ['/a.cjs'] } }
      })
    })
    ensureGlobalCursorBrokerRegistered(fs, GLOBAL_MCP, GLOBAL_DIR, brokerOnly)
    const cfg = JSON.parse(files.get(GLOBAL_MCP)!)
    expect(cfg.mcpServers.taskwraith).toEqual({ command: 'node', args: ['/web.cjs'] })
    expect(cfg.mcpServers.agbench).toEqual({ command: 'node', args: ['/a.cjs'] })
    expect(cfg.mcpServers['taskwraith-broker']).toBeDefined()
  })

  it('is idempotent — no rewrite when the broker entry is unchanged', () => {
    const { fs, files } = makeFakeFs()
    expect(ensureGlobalCursorBrokerRegistered(fs, GLOBAL_MCP, GLOBAL_DIR, brokerOnly)).toBe(true)
    const first = files.get(GLOBAL_MCP)
    expect(ensureGlobalCursorBrokerRegistered(fs, GLOBAL_MCP, GLOBAL_DIR, brokerOnly)).toBe(false)
    expect(files.get(GLOBAL_MCP)).toBe(first)
  })

  it('refreshes (repairs) when the token rotated on a new launch', () => {
    const { fs } = makeFakeFs()
    ensureGlobalCursorBrokerRegistered(fs, GLOBAL_MCP, GLOBAL_DIR, brokerOnly)
    const rotated = { 'taskwraith-broker': { command: '/x/electron', args: ['/s.cjs', '--token', 'T2'] } }
    expect(ensureGlobalCursorBrokerRegistered(fs, GLOBAL_MCP, GLOBAL_DIR, rotated)).toBe(true)
  })

  it('migrates an obsolete app-owned scoped broker without touching user servers', () => {
    const { fs, files } = makeFakeFs({
      [GLOBAL_MCP]: JSON.stringify({
        mcpServers: {
          taskwraith: { command: 'node', args: ['/user-web.cjs'] },
          'taskwraith-cursor': { command: 'node', args: ['/old-readonly.cjs'] }
        }
      })
    })

    expect(
      ensureGlobalCursorBrokerRegistered(fs, GLOBAL_MCP, GLOBAL_DIR, brokerOnly, [
        'taskwraith-cursor'
      ])
    ).toBe(true)
    const cfg = JSON.parse(files.get(GLOBAL_MCP)!)
    expect(cfg.mcpServers['taskwraith-cursor']).toBeUndefined()
    expect(cfg.mcpServers.taskwraith).toEqual({ command: 'node', args: ['/user-web.cjs'] })
    expect(cfg.mcpServers['taskwraith-broker']).toBeDefined()
  })
})
