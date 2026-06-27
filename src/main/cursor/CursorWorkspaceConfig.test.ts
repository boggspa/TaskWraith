import { describe, it, expect } from 'vitest'
import {
  applyCursorWriteModeConfig,
  CURSOR_WRITE_MODE_DENY_RULES,
  mergeCursorDenyRules,
  type CursorConfigFs
} from './CursorWorkspaceConfig'
import { buildCursorMcpServerEntry, CURSOR_MCP_ALLOW_RULES } from './CursorMcpBridge'
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

  it('writes cli.json (deny + MCP allow) AND mcp.json; restore removes both + the dir', () => {
    const { fs, files, dirs } = makeFakeFs()
    const restore = applyCursorWriteModeConfig(fs, CONFIG, DIR, bridge())

    const cli = JSON.parse(files.get(CONFIG)!)
    expect(cli.permissions.deny).toContain('Shell(**)')
    expect(cli.permissions.deny).toContain('Write(**)')
    expect(cli.permissions.allow).toContain('Mcp(taskwraith:*)')

    const mcp = JSON.parse(files.get(MCP)!)
    expect(mcp.mcpServers.taskwraith.command).toBe('/x/electron')
    expect(mcp.mcpServers.taskwraith.args).toEqual(['/tmp/taskwraith-mcp-server.cjs'])
    expect(mcp.mcpServers.taskwraith.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })

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
    expect(cli.permissions.allow).toEqual(['Mcp(taskwraith:*)'])

    const mcp = JSON.parse(files.get(MCP)!)
    // Other registered servers survive; taskwraith is added.
    expect(mcp.mcpServers.other).toEqual({ command: 'x', args: [] })
    expect(mcp.mcpServers.taskwraith.command).toBe('/x/electron')

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
    expect(cli.permissions.allow).toContain('Mcp(taskwraith:*)')
    expect(cli.permissions.allow).toContain('Mcp(user_filesystem:*)')
    expect(cli.permissions.allow).toContain('Mcp(user_docs:*)')

    const mcp = JSON.parse(files.get(MCP)!)
    expect(mcp.mcpServers.taskwraith.command).toBe('/x/electron')
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

  it('"B" mode (allowRules only) writes cli.json allow + deny but NO mcp.json', () => {
    const { fs, files } = makeFakeFs()
    // No mcpConfigPath / serverEntry — relies on the user's global server.
    const restore = applyCursorWriteModeConfig(fs, CONFIG, DIR, {
      allowRules: CURSOR_MCP_ALLOW_RULES
    })

    const cli = JSON.parse(files.get(CONFIG)!)
    expect(cli.permissions.deny).toContain('Shell(**)')
    expect(cli.permissions.deny).toContain('Write(**)')
    expect(cli.permissions.allow).toContain('Mcp(taskwraith:*)')
    // The per-run workspace mcp.json must NOT be written in B mode.
    expect(files.has(MCP)).toBe(false)

    restore()
    expect(files.has(CONFIG)).toBe(false)
  })
})
