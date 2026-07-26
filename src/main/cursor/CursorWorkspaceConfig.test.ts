import * as nodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  applyCursorWriteModeConfig,
  createVerifiedCursorWorkspaceConfigTransaction,
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
import {
  CursorWorkspaceConfigLeaseCoordinator,
  cursorWorkspaceConfigurationKey
} from './CursorWorkspaceConfigLease'

const fsConstants = nodeFs.constants

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
  it('keeps the legacy qualification failure distinct from live Path-B fallback', () => {
    const message = cursorWriteModeSetupFailureMessage(new Error('Bridge unavailable'))

    expect(message).toContain('Legacy Cursor broker-only write-mode setup failed')
    expect(message).toContain('stopped')
    expect(message).toContain('Path-B')
    expect(message).toContain('sandboxed native tools')
    expect(message).toContain('Bridge unavailable')
  })
})

// In-memory fake fs implementing the injected surface.
function makeFakeFs(initial: Record<string, string> = {}, symlinks: readonly string[] = []) {
  const files = new Map<string, string>(Object.entries(initial))
  const dirs = new Set<string>()
  const links = new Set(symlinks)
  const specialFiles = new Set<string>()
  const nlinks = new Map<string, number>()
  const identities = new Map<string, number>()
  const openFiles = new Map<
    number,
    { path: string; identity: number; kind: 'file' | 'directory' | 'symlink' | 'special' }
  >()
  let nextIdentity = 1
  let nextFileDescriptor = 100
  const identityFor = (path: string): number => {
    let identity = identities.get(path)
    if (identity === undefined) {
      identity = nextIdentity
      nextIdentity += 1
      identities.set(path, identity)
    }
    return identity
  }
  const fs: CursorConfigFs = {
    existsSync: (p) => files.has(p) || dirs.has(p) || links.has(p) || specialFiles.has(p),
    lstatSync: (p) => {
      if (!files.has(p) && !dirs.has(p) && !links.has(p) && !specialFiles.has(p)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return {
        dev: 1,
        ino: identityFor(p),
        nlink: nlinks.get(p) ?? 1,
        isDirectory: () => dirs.has(p) && !links.has(p),
        isFile: () => files.has(p) && !links.has(p) && !specialFiles.has(p),
        isSymbolicLink: () => links.has(p)
      }
    },
    fstatSync: (file) => {
      const opened = openFiles.get(file)
      if (!opened) throw Object.assign(new Error('EBADF'), { code: 'EBADF' })
      return {
        dev: 1,
        ino: opened.identity,
        nlink: nlinks.get(opened.path) ?? 1,
        isDirectory: () => opened.kind === 'directory',
        isFile: () => opened.kind === 'file',
        isSymbolicLink: () => opened.kind === 'symlink'
      }
    },
    realpathSync: (p) => p,
    readFileSync: ((p: string | number, encoding?: 'utf8') => {
      const path = typeof p === 'number' ? openFiles.get(p)?.path : p
      if (!path) throw Object.assign(new Error('EBADF'), { code: 'EBADF' })
      const v = files.get(path)
      if (v == null) throw new Error('ENOENT')
      return encoding === 'utf8' ? v : Buffer.from(v, 'utf8')
    }) as CursorConfigFs['readFileSync'],
    writeFileSync: (p, data, options) => {
      const path = typeof p === 'number' ? openFiles.get(p)?.path : p
      if (!path) throw Object.assign(new Error('EBADF'), { code: 'EBADF' })
      if (options?.flag === 'wx' && (files.has(path) || dirs.has(path) || links.has(path))) {
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      }
      identityFor(path)
      files.set(path, data)
    },
    openSync: (p, flags) => {
      const exists = files.has(p) || dirs.has(p) || links.has(p) || specialFiles.has(p)
      if (links.has(p) && (flags & fsConstants.O_NOFOLLOW) !== 0) {
        throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' })
      }
      if ((flags & fsConstants.O_CREAT) !== 0 && (flags & fsConstants.O_EXCL) !== 0 && exists) {
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      }
      if (!exists) {
        if ((flags & fsConstants.O_CREAT) === 0) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        identityFor(p)
        files.set(p, '')
      }
      const file = nextFileDescriptor
      nextFileDescriptor += 1
      openFiles.set(file, {
        path: p,
        identity: identityFor(p),
        kind: links.has(p)
          ? 'symlink'
          : dirs.has(p)
            ? 'directory'
            : specialFiles.has(p)
              ? 'special'
              : 'file'
      })
      return file
    },
    writeSync: (file, buffer, offset, length, position) => {
      const opened = openFiles.get(file)
      if (!opened) throw Object.assign(new Error('EBADF'), { code: 'EBADF' })
      const existing = Buffer.from(files.get(opened.path) ?? '', 'utf8')
      const incoming = Buffer.from(buffer).subarray(offset, offset + length)
      const required = Math.max(existing.byteLength, position + incoming.byteLength)
      const result = Buffer.alloc(required)
      existing.copy(result)
      incoming.copy(result, position)
      files.set(opened.path, result.toString('utf8'))
      return incoming.byteLength
    },
    ftruncateSync: (file, length) => {
      const opened = openFiles.get(file)
      if (!opened) throw Object.assign(new Error('EBADF'), { code: 'EBADF' })
      const existing = Buffer.from(files.get(opened.path) ?? '', 'utf8')
      const result = Buffer.alloc(length)
      existing.copy(result, 0, 0, Math.min(existing.byteLength, length))
      files.set(opened.path, result.toString('utf8'))
    },
    fsyncSync: () => undefined,
    closeSync: (file) => {
      if (!openFiles.delete(file)) {
        throw Object.assign(new Error('EBADF'), { code: 'EBADF' })
      }
    },
    mkdirSync: (p, options) => {
      if (!options.recursive && (files.has(p) || dirs.has(p) || links.has(p))) {
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      }
      identityFor(p)
      dirs.add(p)
    },
    rmSync: (p) => {
      files.delete(p)
      dirs.delete(p)
      links.delete(p)
      specialFiles.delete(p)
      nlinks.delete(p)
      identities.delete(p)
    },
    rmdirSync: (p) => {
      const prefix = p.endsWith('/') ? p : `${p}/`
      const hasChildren = [...files.keys(), ...dirs, ...links].some(
        (entry) => entry !== p && entry.startsWith(prefix)
      )
      if (hasChildren) {
        throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' })
      }
      if (!dirs.delete(p)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      identities.delete(p)
    }
  }
  return {
    fs,
    files,
    dirs,
    links,
    specialFiles,
    nlinks,
    identities,
    openFiles
  }
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

  it('exposes the canonical broker-only native tool deny rules', () => {
    expect(CURSOR_WRITE_MODE_DENY_RULES).toEqual([
      'Shell(**)',
      'Write(**)',
      'Read(**)',
      'Glob(**)',
      'Grep(**)'
    ])
  })

  it('keeps native tools broker-only under a full-access grant', () => {
    const { fs, files } = makeFakeFs()
    const restore = applyCursorWriteModeConfig(fs, CONFIG, DIR, undefined, { fullAccess: true })
    const written = JSON.parse(files.get(CONFIG)!)
    expect(written.permissions.deny).toEqual(
      expect.arrayContaining([...CURSOR_WRITE_MODE_DENY_RULES])
    )
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

  function expectTaskWraithMcpServer(mcp: {
    mcpServers: Record<string, { command?: string; args?: string[]; env?: unknown }>
  }): void {
    expect(mcp.mcpServers[CURSOR_MCP_SERVER_NAME].command).toBe('/x/electron')
    expect(mcp.mcpServers[CURSOR_MCP_SERVER_NAME].args).toEqual(['/tmp/taskwraith-mcp-server.cjs'])
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
    expect(cli.permissions.deny).toEqual(['Write(.env)', ...CURSOR_WRITE_MODE_DENY_RULES])
    expectTaskWraithAllowRules(cli.permissions.allow)

    const mcp = JSON.parse(files.get(MCP)!)
    // Pre-existing project servers are hidden for the managed run.
    expect(mcp.mcpServers.other).toBeUndefined()
    expectTaskWraithMcpServer(mcp)

    restore()
    expect(files.get(CONFIG)).toBe(cliBytes)
    expect(files.get(MCP)).toBe(mcpBytes)
    // We didn't create the dir, so restore leaves it.
    expect(dirs.has(DIR)).toBe(true)
  })

  it('rolls cli.json back if the later mcp.json write fails', () => {
    const cliBytes = '{"permissions":{"allow":[],"deny":[]}}\n'
    const mcpBytes = '{"mcpServers":{"other":{"command":"x"}}}\n'
    const { fs, files } = makeFakeFs({ [CONFIG]: cliBytes, [MCP]: mcpBytes })
    fs.mkdirSync(DIR, { recursive: true })
    const write = fs.writeFileSync.bind(fs)
    let failMcpOnce = true
    fs.writeFileSync = (path, data) => {
      if (path === MCP && failMcpOnce) {
        failMcpOnce = false
        throw new Error('simulated mcp write failure')
      }
      write(path, data)
    }

    expect(() => applyCursorWriteModeConfig(fs, CONFIG, DIR, bridge())).toThrow(
      'simulated mcp write failure'
    )
    expect(files.get(CONFIG)).toBe(cliBytes)
    expect(files.get(MCP)).toBe(mcpBytes)
  })

  it('fails before mutation when an existing config cannot be snapshotted', () => {
    const cliBytes = '{"permissions":{"allow":[],"deny":[]}}\n'
    const mcpBytes = '{"mcpServers":{}}\n'
    const { fs, files } = makeFakeFs({ [CONFIG]: cliBytes, [MCP]: mcpBytes })
    fs.mkdirSync(DIR, { recursive: true })
    const read = fs.readFileSync
    fs.readFileSync = ((path: string | number, encoding?: 'utf8') => {
      if (path === MCP) throw new Error('simulated read failure')
      return encoding === 'utf8' ? read(path, encoding) : read(path)
    }) as CursorConfigFs['readFileSync']

    expect(() => applyCursorWriteModeConfig(fs, CONFIG, DIR, bridge())).toThrow(
      'simulated read failure'
    )
    expect(files.get(CONFIG)).toBe(cliBytes)
    expect(files.get(MCP)).toBe(mcpBytes)
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

  it('retains only canonical TaskWraith brokers when the workspace path aliases the global registry', () => {
    const originalBytes = `${JSON.stringify(
      {
        mcpServers: {
          'taskwraith-broker': { command: '/x/electron', args: ['/broker.cjs'] },
          taskwraith: { command: 'node', args: ['/user-web.cjs'] },
          agbench: { command: 'node', args: ['/agbench.cjs'] }
        }
      },
      null,
      2
    )}\n`
    const { fs, files } = makeFakeFs({ [MCP]: originalBytes })

    const restore = applyCursorWriteModeConfig(fs, CONFIG, DIR, {
      mcpConfigPath: MCP,
      serverEntry: { user_docs: { url: 'https://example.test/mcp' } },
      allowRules: CURSOR_MCP_ALLOW_RULES,
      preserveExistingMcpServers: true
    })

    const mcp = JSON.parse(files.get(MCP)!)
    expect(mcp.mcpServers['taskwraith-broker']).toEqual({
      command: '/x/electron',
      args: ['/broker.cjs']
    })
    expect(mcp.mcpServers.taskwraith).toBeUndefined()
    expect(mcp.mcpServers.agbench).toBeUndefined()
    expect(mcp.mcpServers.user_docs).toEqual({ url: 'https://example.test/mcp' })

    restore()
    expect(files.get(MCP)).toBe(originalBytes)
  })

  it('strips every pre-existing server from ordinary workspace configs', () => {
    const { fs, files } = makeFakeFs({
      [MCP]: JSON.stringify({
        mcpServers: {
          'taskwraith-broker': { command: 'stale-broker' },
          taskwraith: { command: 'shadow-alias' },
          other: { command: 'user-server' }
        }
      })
    })

    applyCursorWriteModeConfig(fs, CONFIG, DIR, {
      mcpConfigPath: MCP,
      serverEntry: { user_docs: { url: 'https://example.test/mcp' } },
      allowRules: CURSOR_MCP_ALLOW_RULES
    })

    const mcp = JSON.parse(files.get(MCP)!)
    expect(mcp.mcpServers['taskwraith-broker']).toBeUndefined()
    expect(mcp.mcpServers.taskwraith).toBeUndefined()
    expect(mcp.mcpServers.other).toBeUndefined()
    expect(mcp.mcpServers.user_docs).toEqual({ url: 'https://example.test/mcp' })
  })

  it.each([
    ['.cursor directory', DIR],
    ['cli.json', CONFIG],
    ['mcp.json', MCP]
  ])('rejects a pre-existing symlinked %s before writing', (_label, symlinkPath) => {
    const { fs, files } = makeFakeFs({}, [symlinkPath])

    expect(() => applyCursorWriteModeConfig(fs, CONFIG, DIR, bridge())).toThrow(/symlinked/)
    expect(files.has(CONFIG)).toBe(false)
    expect(files.has(MCP)).toBe(false)
  })

  it('allowRules-only setup writes cli.json allow + deny but NO mcp.json', () => {
    const { fs, files } = makeFakeFs()
    // No mcpConfigPath / serverEntry — helper still supports callers that only
    // need cli.json permission merging and no transient registry.
    const restore = applyCursorWriteModeConfig(fs, CONFIG, DIR, {
      allowRules: CURSOR_MCP_ALLOW_RULES
    })

    const cli = JSON.parse(files.get(CONFIG)!)
    expect(cli.permissions.deny).toContain('Shell(**)')
    expect(cli.permissions.deny).toContain('Write(**)')
    expectTaskWraithAllowRules(cli.permissions.allow)
    // Without both registry inputs, no workspace mcp.json is written.
    expect(files.has(MCP)).toBe(false)

    restore()
    expect(files.has(CONFIG)).toBe(false)
  })
})

describe('createVerifiedCursorWorkspaceConfigTransaction', () => {
  const CONFIG = '/ws/.cursor/cli.json'
  const MCP = '/ws/.cursor/mcp.json'
  const DIR = '/ws/.cursor'
  const CONTEXT = {
    resourceKey: '/ws',
    configurationKey: cursorWorkspaceConfigurationKey('write')
  }
  const transactionOptions = () => ({ configurationKey: CONTEXT.configurationKey })
  const bridge = () => ({
    mcpConfigPath: MCP,
    serverEntry: {
      'taskwraith-broker': {
        command: '/x/electron',
        args: ['/tmp/taskwraith-mcp-server.cjs']
      }
    },
    allowRules: CURSOR_MCP_ALLOW_RULES
  })

  it('installs exact overlays and verifies a fresh workspace returns to absence', async () => {
    const { fs, files, dirs } = makeFakeFs()
    const transaction = createVerifiedCursorWorkspaceConfigTransaction(
      fs,
      CONFIG,
      DIR,
      bridge(),
      transactionOptions()
    )
    const installation = transaction.install({
      ...CONTEXT,
      configurationKey: transaction.configurationKey
    })

    expect(JSON.parse(files.get(CONFIG)!).permissions.deny).toEqual(
      expect.arrayContaining([...CURSOR_WRITE_MODE_DENY_RULES])
    )
    expect(JSON.parse(files.get(MCP)!).mcpServers['taskwraith-broker']).toBeDefined()
    const first = await installation.onLastRelease()
    const second = await installation.onLastRelease()

    expect(first).toEqual({ outcome: 'restored-verified' })
    expect(second).toEqual(first)
    expect(files.has(CONFIG)).toBe(false)
    expect(files.has(MCP)).toBe(false)
    expect(dirs.has(DIR)).toBe(false)
  })

  it('restores and verifies exact captured bytes through the lease API', async () => {
    const cliBytes = '{\n  "permissions": { "allow": ["Read(**)"], "deny": [] }\n}\n'
    const mcpBytes = '{\n  "mcpServers": { "other": { "command": "x" } }\n}\n'
    const { fs, files } = makeFakeFs({ [CONFIG]: cliBytes, [MCP]: mcpBytes })
    fs.mkdirSync(DIR, { recursive: true })
    const transaction = createVerifiedCursorWorkspaceConfigTransaction(
      fs,
      CONFIG,
      DIR,
      bridge(),
      transactionOptions()
    )
    const coordinator = new CursorWorkspaceConfigLeaseCoordinator()
    const lease = await coordinator.acquire({
      resourceKey: '/ws',
      ...transaction
    })

    const receipt = await lease.release()
    expect(receipt).toMatchObject({
      finalHolder: true,
      cleanup: { outcome: 'restored-verified' }
    })
    expect(files.get(CONFIG)).toBe(cliBytes)
    expect(files.get(MCP)).toBe(mcpBytes)
  })

  it('preserves divergent external bytes while restoring other owned overlays', async () => {
    const cliBytes = '{"permissions":{"allow":[],"deny":[]}}\n'
    const mcpBytes = '{"mcpServers":{"other":{"command":"x"}}}\n'
    const externalCli = '{"permissions":{"allow":["External(**)"],"deny":[]}}\n'
    const { fs, files, dirs } = makeFakeFs({ [CONFIG]: cliBytes, [MCP]: mcpBytes })
    fs.mkdirSync(DIR, { recursive: true })
    const transaction = createVerifiedCursorWorkspaceConfigTransaction(
      fs,
      CONFIG,
      DIR,
      bridge(),
      transactionOptions()
    )
    const installation = transaction.install({
      ...CONTEXT,
      configurationKey: transaction.configurationKey
    })
    files.set(CONFIG, externalCli)

    const receipt = await installation.onLastRelease()
    expect(receipt).toMatchObject({
      outcome: 'cleanup-failed',
      message: expect.stringContaining('Preserved external change')
    })
    expect(files.get(CONFIG)).toBe(externalCli)
    expect(files.get(MCP)).toBe(mcpBytes)
    expect(dirs.has(DIR)).toBe(true)
  })

  it('never recursively deletes external content from an owned directory', async () => {
    const { fs, files, dirs } = makeFakeFs()
    const transaction = createVerifiedCursorWorkspaceConfigTransaction(
      fs,
      CONFIG,
      DIR,
      bridge(),
      transactionOptions()
    )
    const installation = transaction.install({
      ...CONTEXT,
      configurationKey: transaction.configurationKey
    })
    const externalPath = `${DIR}/notes-from-user.txt`
    files.set(externalPath, 'keep me')

    const receipt = await installation.onLastRelease()
    expect(receipt).toMatchObject({
      outcome: 'cleanup-failed',
      message: expect.stringContaining('Preserved non-empty or changed directory')
    })
    expect(files.get(externalPath)).toBe('keep me')
    expect(files.has(CONFIG)).toBe(false)
    expect(files.has(MCP)).toBe(false)
    expect(dirs.has(DIR)).toBe(true)
  })

  it('reports a restore write failure without claiming verified cleanup', async () => {
    const cliBytes = '{"permissions":{"allow":[],"deny":[]}}\n'
    const { fs, files, openFiles } = makeFakeFs({ [CONFIG]: cliBytes })
    fs.mkdirSync(DIR, { recursive: true })
    const transaction = createVerifiedCursorWorkspaceConfigTransaction(
      fs,
      CONFIG,
      DIR,
      undefined,
      transactionOptions()
    )
    const installation = transaction.install({
      ...CONTEXT,
      configurationKey: transaction.configurationKey
    })
    const write = fs.writeSync.bind(fs)
    fs.writeSync = (file, buffer, offset, length, position) => {
      const data = Buffer.from(buffer)
        .subarray(offset, offset + length)
        .toString('utf8')
      if (openFiles.get(file)?.path === CONFIG && data === cliBytes) {
        throw new Error('restore write denied')
      }
      return write(file, buffer, offset, length, position)
    }

    const receipt = await installation.onLastRelease()
    expect(receipt).toMatchObject({
      outcome: 'cleanup-failed',
      message: expect.stringContaining('restore write denied')
    })
    expect(files.get(CONFIG)).not.toBe(cliBytes)
  })

  it('rolls a partial install back and reports verified recovery', () => {
    const cliBytes = '{"permissions":{"allow":[],"deny":[]}}\n'
    const mcpBytes = '{"mcpServers":{"other":{"command":"x"}}}\n'
    const { fs, files } = makeFakeFs({ [CONFIG]: cliBytes, [MCP]: mcpBytes })
    fs.mkdirSync(DIR, { recursive: true })
    const open = fs.openSync.bind(fs)
    let failMcpOnce = true
    fs.openSync = (path, flags, mode) => {
      if (path === MCP && (flags & fsConstants.O_RDWR) !== 0 && failMcpOnce) {
        failMcpOnce = false
        throw new Error('simulated mcp install failure')
      }
      return open(path, flags, mode)
    }
    const transaction = createVerifiedCursorWorkspaceConfigTransaction(
      fs,
      CONFIG,
      DIR,
      bridge(),
      transactionOptions()
    )

    let installError: unknown
    try {
      transaction.install({
        ...CONTEXT,
        configurationKey: transaction.configurationKey
      })
    } catch (error) {
      installError = error
    }
    expect(installError).toBeInstanceOf(Error)
    expect(
      transaction.onInstallFailure(installError, {
        ...CONTEXT,
        configurationKey: transaction.configurationKey
      })
    ).toEqual({
      outcome: 'restored-verified'
    })
    expect(files.get(CONFIG)).toBe(cliBytes)
    expect(files.get(MCP)).toBe(mcpBytes)
  })

  it('preserves divergent bytes from a failed install and reports unproven recovery', () => {
    const cliBytes = '{"permissions":{"allow":[],"deny":[]}}\n'
    const mcpBytes = '{"mcpServers":{"other":{"command":"x"}}}\n'
    const externalMcp = '{"mcpServers":{"external":{"command":"keep"}}}\n'
    const { fs, files, openFiles } = makeFakeFs({ [CONFIG]: cliBytes, [MCP]: mcpBytes })
    fs.mkdirSync(DIR, { recursive: true })
    const write = fs.writeSync.bind(fs)
    fs.writeSync = (file, buffer, offset, length, position) => {
      const path = openFiles.get(file)?.path
      if (path === MCP) {
        files.set(path, externalMcp)
        throw new Error('external writer won the race')
      }
      return write(file, buffer, offset, length, position)
    }
    const transaction = createVerifiedCursorWorkspaceConfigTransaction(
      fs,
      CONFIG,
      DIR,
      bridge(),
      transactionOptions()
    )

    let installError: unknown
    try {
      transaction.install({
        ...CONTEXT,
        configurationKey: transaction.configurationKey
      })
    } catch (error) {
      installError = error
    }
    expect(
      transaction.onInstallFailure(installError, {
        ...CONTEXT,
        configurationKey: transaction.configurationKey
      })
    ).toMatchObject({
      outcome: 'cleanup-failed',
      message: expect.stringContaining('Preserved external change')
    })
    expect(files.get(CONFIG)).toBe(cliBytes)
    expect(files.get(MCP)).toBe(externalMcp)
  })

  it('refuses cleanup through a replacement symlink', async () => {
    const { fs, files, links } = makeFakeFs()
    const transaction = createVerifiedCursorWorkspaceConfigTransaction(
      fs,
      CONFIG,
      DIR,
      undefined,
      transactionOptions()
    )
    const installation = transaction.install({
      ...CONTEXT,
      configurationKey: transaction.configurationKey
    })
    links.add(CONFIG)

    const receipt = await installation.onLastRelease()
    expect(receipt).toMatchObject({
      outcome: 'cleanup-failed',
      message: expect.stringContaining('symlinked')
    })
    expect(links.has(CONFIG)).toBe(true)
    expect(files.has(CONFIG)).toBe(true)
  })

  it('digest-binds immutable intent and ignores later caller mutation', async () => {
    const mutableBridge = {
      mcpConfigPath: MCP,
      serverEntry: {
        broker: {
          command: '/original-command',
          args: ['/original-arg']
        }
      },
      allowRules: ['Mcp(original:*)']
    }
    const { fs, files } = makeFakeFs()
    const transaction = createVerifiedCursorWorkspaceConfigTransaction(
      fs,
      CONFIG,
      DIR,
      mutableBridge,
      transactionOptions()
    )
    const differentIntent = createVerifiedCursorWorkspaceConfigTransaction(
      makeFakeFs().fs,
      CONFIG,
      DIR,
      { ...bridge(), allowRules: ['Mcp(different:*)'] },
      transactionOptions()
    )
    mutableBridge.allowRules.push('Mcp(mutated:*)')
    mutableBridge.serverEntry.broker.command = '/mutated-command'
    mutableBridge.serverEntry.broker.args[0] = '/mutated-arg'

    expect(transaction.configurationKey).not.toBe(differentIntent.configurationKey)
    const installation = transaction.install({
      ...CONTEXT,
      configurationKey: transaction.configurationKey
    })
    const cli = JSON.parse(files.get(CONFIG)!)
    const mcp = JSON.parse(files.get(MCP)!)
    expect(cli.permissions.allow).toContain('Mcp(original:*)')
    expect(cli.permissions.allow).not.toContain('Mcp(mutated:*)')
    expect(mcp.mcpServers.broker).toEqual({
      command: '/original-command',
      args: ['/original-arg']
    })
    expect(installation.onLastRelease()).toEqual({
      outcome: 'restored-verified'
    })
  })

  it('binds the physical workspace and digest key before any mutation', () => {
    const wrongResourceFs = makeFakeFs()
    const wrongResource = createVerifiedCursorWorkspaceConfigTransaction(
      wrongResourceFs.fs,
      CONFIG,
      DIR,
      undefined,
      transactionOptions()
    )
    expect(() =>
      wrongResource.install({
        resourceKey: '/different-workspace',
        configurationKey: wrongResource.configurationKey
      })
    ).toThrow('does not match the lease resource')
    expect(wrongResourceFs.dirs.has(DIR)).toBe(false)
    expect(wrongResourceFs.files.has(CONFIG)).toBe(false)
    expect(
      wrongResource.onInstallFailure(new Error('binding mismatch'), {
        resourceKey: '/different-workspace',
        configurationKey: wrongResource.configurationKey
      })
    ).toEqual({ outcome: 'restored-verified' })

    const wrongKeyFs = makeFakeFs()
    const wrongKey = createVerifiedCursorWorkspaceConfigTransaction(
      wrongKeyFs.fs,
      CONFIG,
      DIR,
      undefined,
      transactionOptions()
    )
    expect(() =>
      wrongKey.install({
        resourceKey: '/ws',
        configurationKey: CONTEXT.configurationKey
      })
    ).toThrow('does not match the lease configuration')
    expect(wrongKeyFs.dirs.has(DIR)).toBe(false)
    expect(wrongKeyFs.files.has(CONFIG)).toBe(false)
  })

  it('rejects relative, escaping, and mis-shaped transaction targets', () => {
    const fs = makeFakeFs().fs
    expect(() =>
      createVerifiedCursorWorkspaceConfigTransaction(
        fs,
        'relative/.cursor/cli.json',
        'relative/.cursor',
        undefined,
        transactionOptions()
      )
    ).toThrow('must be absolute')
    expect(() =>
      createVerifiedCursorWorkspaceConfigTransaction(
        fs,
        '/outside/cli.json',
        DIR,
        undefined,
        transactionOptions()
      )
    ).toThrow('directly inside')
    expect(() =>
      createVerifiedCursorWorkspaceConfigTransaction(
        fs,
        CONFIG,
        DIR,
        {
          allowRules: [],
          mcpConfigPath: '/ws/.cursor/./cli.json',
          serverEntry: {}
        },
        transactionOptions()
      )
    ).toThrow('mcp.json')
  })

  it('phase-gates recovery callbacks and returns immutable receipts', async () => {
    const { fs, files } = makeFakeFs()
    const transaction = createVerifiedCursorWorkspaceConfigTransaction(
      fs,
      CONFIG,
      DIR,
      undefined,
      transactionOptions()
    )
    const early = transaction.onInstallFailure(new Error('too early'), {
      ...CONTEXT,
      configurationKey: transaction.configurationKey
    })
    expect(early).toMatchObject({ outcome: 'cleanup-failed' })
    expect(Object.isFrozen(early)).toBe(true)

    const installation = transaction.install({
      ...CONTEXT,
      configurationKey: transaction.configurationKey
    })
    const overlay = files.get(CONFIG)
    const late = transaction.onInstallFailure(new Error('too late'), {
      ...CONTEXT,
      configurationKey: transaction.configurationKey
    })
    expect(late).toMatchObject({ outcome: 'cleanup-failed' })
    expect(files.get(CONFIG)).toBe(overlay)

    const cleanup = await installation.onLastRelease()
    expect(cleanup).toEqual({ outcome: 'restored-verified' })
    expect(Object.isFrozen(cleanup)).toBe(true)
    expect(() => Object.assign(cleanup, { outcome: 'cleanup-failed' })).toThrow()
    expect(installation.onLastRelease()).toBe(cleanup)
  })

  it('rejects hard-linked and non-regular config targets before mutation', () => {
    const original = '{"permissions":{"allow":[],"deny":[]}}\n'
    const hardLinkedFs = makeFakeFs({ [CONFIG]: original })
    hardLinkedFs.fs.mkdirSync(DIR, { recursive: true })
    hardLinkedFs.nlinks.set(CONFIG, 2)
    const hardLinked = createVerifiedCursorWorkspaceConfigTransaction(
      hardLinkedFs.fs,
      CONFIG,
      DIR,
      undefined,
      transactionOptions()
    )
    expect(() =>
      hardLinked.install({
        ...CONTEXT,
        configurationKey: hardLinked.configurationKey
      })
    ).toThrow('hard-linked')
    expect(hardLinkedFs.files.get(CONFIG)).toBe(original)

    const specialFs = makeFakeFs()
    specialFs.fs.mkdirSync(DIR, { recursive: true })
    specialFs.specialFiles.add(CONFIG)
    const special = createVerifiedCursorWorkspaceConfigTransaction(
      specialFs.fs,
      CONFIG,
      DIR,
      undefined,
      transactionOptions()
    )
    expect(() =>
      special.install({
        ...CONTEXT,
        configurationKey: special.configurationKey
      })
    ).toThrow('unsafe cli.json')
    expect(specialFs.specialFiles.has(CONFIG)).toBe(true)
  })

  it('refuses JSON numbers that cannot be rewritten losslessly', () => {
    const original = '{"unknownCounter":9007199254740993}\n'
    const { fs, files } = makeFakeFs({ [CONFIG]: original })
    fs.mkdirSync(DIR, { recursive: true })
    const transaction = createVerifiedCursorWorkspaceConfigTransaction(
      fs,
      CONFIG,
      DIR,
      undefined,
      transactionOptions()
    )

    expect(() =>
      transaction.install({
        ...CONTEXT,
        configurationKey: transaction.configurationKey
      })
    ).toThrow('cannot be losslessly rewritten')
    expect(files.get(CONFIG)).toBe(original)
    expect(
      transaction.onInstallFailure(new Error('lossless-number refusal'), {
        ...CONTEXT,
        configurationKey: transaction.configurationKey
      })
    ).toEqual({ outcome: 'restored-verified' })

    const negativeZeroFs = makeFakeFs({ [CONFIG]: '{"unknownCounter":-0}\n' })
    negativeZeroFs.fs.mkdirSync(DIR, { recursive: true })
    const negativeZero = createVerifiedCursorWorkspaceConfigTransaction(
      negativeZeroFs.fs,
      CONFIG,
      DIR,
      undefined,
      transactionOptions()
    )
    expect(() =>
      negativeZero.install({
        ...CONTEXT,
        configurationKey: negativeZero.configurationKey
      })
    ).toThrow('cannot be losslessly rewritten')
    expect(negativeZeroFs.files.get(CONFIG)).toBe('{"unknownCounter":-0}\n')
  })

  it('does not adopt or remove a directory that wins the exclusive mkdir race', () => {
    const { fs, files, dirs } = makeFakeFs()
    const mkdir = fs.mkdirSync.bind(fs)
    fs.mkdirSync = (path, options) => {
      if (path === DIR && !options.recursive) {
        mkdir(path, { recursive: true })
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      }
      mkdir(path, options)
    }
    const transaction = createVerifiedCursorWorkspaceConfigTransaction(
      fs,
      CONFIG,
      DIR,
      undefined,
      transactionOptions()
    )

    expect(() =>
      transaction.install({
        ...CONTEXT,
        configurationKey: transaction.configurationKey
      })
    ).toThrow('EEXIST')
    expect(files.has(CONFIG)).toBe(false)
    expect(dirs.has(DIR)).toBe(true)
    expect(
      transaction.onInstallFailure(new Error('mkdir race'), {
        ...CONTEXT,
        configurationKey: transaction.configurationKey
      })
    ).toEqual({ outcome: 'restored-verified' })
  })

  it('does not claim recovery when an owned directory identity cannot be captured', () => {
    const { fs, files, dirs } = makeFakeFs()
    const mkdir = fs.mkdirSync.bind(fs)
    const lstat = fs.lstatSync.bind(fs)
    let created = false
    fs.mkdirSync = (path, options) => {
      mkdir(path, options)
      if (path === DIR) created = true
    }
    fs.lstatSync = (path) => {
      if (path === DIR && created) {
        throw new Error('simulated post-mkdir identity failure')
      }
      return lstat(path)
    }
    const transaction = createVerifiedCursorWorkspaceConfigTransaction(
      fs,
      CONFIG,
      DIR,
      undefined,
      transactionOptions()
    )

    let installError: unknown
    try {
      transaction.install({
        ...CONTEXT,
        configurationKey: transaction.configurationKey
      })
    } catch (error) {
      installError = error
    }
    expect(installError).toBeInstanceOf(Error)
    expect(files.has(CONFIG)).toBe(false)
    expect(dirs.has(DIR)).toBe(true)
    expect(
      transaction.onInstallFailure(installError, {
        ...CONTEXT,
        configurationKey: transaction.configurationKey
      })
    ).toMatchObject({
      outcome: 'cleanup-failed',
      message: expect.stringContaining('safe removal is unproven')
    })
  })

  it('restores an exact original after an owned partial descriptor write', () => {
    const original = '{"permissions":{"allow":[],"deny":[]},"emoji":"😀"}\n'
    const { fs, files, openFiles } = makeFakeFs({ [CONFIG]: original })
    fs.mkdirSync(DIR, { recursive: true })
    const write = fs.writeSync.bind(fs)
    let failOnce = true
    fs.writeSync = (file, buffer, offset, length, position) => {
      if (openFiles.get(file)?.path === CONFIG && failOnce) {
        failOnce = false
        const partialLength = Math.max(1, Math.floor(length / 2))
        write(file, buffer, offset, partialLength, position)
        throw new Error('simulated partial descriptor write')
      }
      return write(file, buffer, offset, length, position)
    }
    const transaction = createVerifiedCursorWorkspaceConfigTransaction(
      fs,
      CONFIG,
      DIR,
      undefined,
      transactionOptions()
    )

    let installError: unknown
    try {
      transaction.install({
        ...CONTEXT,
        configurationKey: transaction.configurationKey
      })
    } catch (error) {
      installError = error
    }
    expect(installError).toBeInstanceOf(Error)
    expect(files.get(CONFIG)).toBe(original)
    expect(
      transaction.onInstallFailure(installError, {
        ...CONTEXT,
        configurationKey: transaction.configurationKey
      })
    ).toEqual({ outcome: 'restored-verified' })
  })

  it('keeps a final-component symlink swap from overwriting its outside target', () => {
    if (process.platform === 'win32') return
    const workspace = nodeFs.mkdtempSync(join(tmpdir(), 'taskwraith-cursor-config-'))
    const dir = join(workspace, '.cursor')
    const config = join(dir, 'cli.json')
    const displaced = join(dir, 'cli.displaced.json')
    const outside = join(workspace, 'outside.json')
    const original = '{"permissions":{"allow":[],"deny":[]}}\n'
    nodeFs.mkdirSync(dir)
    nodeFs.writeFileSync(config, original)
    nodeFs.writeFileSync(outside, 'EXTERNAL-SAFE')
    let swapped = false
    const raceFs: CursorConfigFs = {
      existsSync: nodeFs.existsSync,
      lstatSync: nodeFs.lstatSync,
      fstatSync: nodeFs.fstatSync,
      realpathSync: nodeFs.realpathSync,
      readFileSync: nodeFs.readFileSync as CursorConfigFs['readFileSync'],
      writeFileSync: nodeFs.writeFileSync,
      openSync: nodeFs.openSync,
      writeSync: (file, buffer, offset, length, position) => {
        if (!swapped) {
          swapped = true
          nodeFs.renameSync(config, displaced)
          nodeFs.symlinkSync(outside, config)
        }
        return nodeFs.writeSync(file, buffer, offset, length, position)
      },
      ftruncateSync: nodeFs.ftruncateSync,
      fsyncSync: nodeFs.fsyncSync,
      closeSync: nodeFs.closeSync,
      mkdirSync: nodeFs.mkdirSync,
      rmSync: nodeFs.rmSync,
      rmdirSync: nodeFs.rmdirSync
    }
    try {
      const baseKey = cursorWorkspaceConfigurationKey('write')
      const transaction = createVerifiedCursorWorkspaceConfigTransaction(
        raceFs,
        config,
        dir,
        undefined,
        { configurationKey: baseKey }
      )
      let installError: unknown
      try {
        transaction.install({
          resourceKey: nodeFs.realpathSync(workspace),
          configurationKey: transaction.configurationKey
        })
      } catch (error) {
        installError = error
      }

      expect(installError).toBeInstanceOf(Error)
      expect(nodeFs.readFileSync(outside, 'utf8')).toBe('EXTERNAL-SAFE')
      expect(
        transaction.onInstallFailure(installError, {
          resourceKey: nodeFs.realpathSync(workspace),
          configurationKey: transaction.configurationKey
        })
      ).toMatchObject({ outcome: 'cleanup-failed' })
    } finally {
      nodeFs.rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('ensureGlobalCursorBrokerRegistered (B mode)', () => {
  const GLOBAL_DIR = '/home/.cursor'
  const GLOBAL_MCP = '/home/.cursor/mcp.json'
  const broker = buildCursorMcpServerEntry({
    command: '/x/electron',
    args: ['/s.cjs', '--token', 'T1']
  })
  // buildCursorMcpServerEntry also emits the legacy alias; for the global path the
  // caller passes buildCursorBrokerMcpServerEntry, but any Record works here.
  const brokerOnly = {
    'taskwraith-broker': (broker as Record<string, unknown>)['taskwraith-broker']
  }

  it('writes the broker into a fresh global mcp.json and creates ~/.cursor', () => {
    const { fs, files, dirs } = makeFakeFs()
    const wrote = ensureGlobalCursorBrokerRegistered(fs, GLOBAL_MCP, GLOBAL_DIR, brokerOnly)
    expect(wrote).toBe(true)
    expect(dirs.has(GLOBAL_DIR)).toBe(true)
    const cfg = JSON.parse(files.get(GLOBAL_MCP)!)
    expect(cfg.mcpServers['taskwraith-broker']).toBeDefined()
  })

  it("PRESERVES the user's own global servers (never removes them)", () => {
    const { fs, files } = makeFakeFs({
      [GLOBAL_MCP]: JSON.stringify({
        mcpServers: {
          taskwraith: { command: 'node', args: ['/web.cjs'] },
          agbench: { command: 'node', args: ['/a.cjs'] }
        }
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
    const rotated = {
      'taskwraith-broker': { command: '/x/electron', args: ['/s.cjs', '--token', 'T2'] }
    }
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

  it.each([
    ['global .cursor directory', GLOBAL_DIR],
    ['global mcp.json', GLOBAL_MCP]
  ])('rejects a symlinked %s before durable broker registration', (_label, symlinkPath) => {
    const { fs, files } = makeFakeFs({}, [symlinkPath])

    expect(() =>
      ensureGlobalCursorBrokerRegistered(fs, GLOBAL_MCP, GLOBAL_DIR, brokerOnly)
    ).toThrow(/symlinked/)
    expect(files.has(GLOBAL_MCP)).toBe(false)
  })
})
