import { describe, it, expect } from 'vitest'
import {
  prepareKimiIsolatedHome,
  findUnsafeWorkspaceKimiConfig,
  type KimiHomeFs
} from './KimiAcpHome'

/** In-memory fs fake keyed by absolute path; dirs are tracked as a set. */
function makeFakeFs(seed: Record<string, string>): {
  fs: KimiHomeFs
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
} {
  const files = new Map<string, string>(Object.entries(seed))
  const dirs = new Set<string>()
  const modes = new Map<string, number>()
  const fs: KimiHomeFs = {
    join: (...parts) => parts.join('/'),
    readFile: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return files.get(path) as string
    },
    writeFile: async (path, data, mode) => {
      files.set(path, data)
      modes.set(path, mode)
    },
    mkdir: async (path) => {
      dirs.add(path)
    },
    copyFile: async (from, to) => {
      files.set(to, files.get(from) ?? '')
    },
    chmod: async (path, mode) => {
      modes.set(path, mode)
    },
    exists: async (path) => files.has(path) || dirs.has(path),
    rm: async (path) => {
      dirs.delete(path)
      for (const key of [...files.keys()]) if (key.startsWith(path)) files.delete(key)
    }
  }
  return { fs, files, dirs, modes }
}

const REAL_CONFIG = [
  'default_model = "kimi-code/kimi-for-coding"',
  'telemetry = true',
  '',
  '[[permission.rules]]',
  'decision = "allow"',
  'pattern = "Bash"',
  '',
  '[thinking]',
  'enabled = true'
].join('\n')

const seededSource = (): Record<string, string> => ({
  '/src/config.toml': REAL_CONFIG,
  '/src/credentials/kimi-code.json': '{"token":"SECRET"}',
  '/src/oauth/kimi-code': '',
  '/src/device_id': 'dev-123'
})

describe('prepareKimiIsolatedHome', () => {
  it('builds an isolated home with a curated config and seeded credential', async () => {
    const { fs, files, modes } = makeFakeFs(seededSource())
    const result = await prepareKimiIsolatedHome({
      runId: 'r1',
      homeDir: '/iso',
      sourceHome: '/src',
      fs
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const config = files.get('/iso/config.toml') as string
    expect(config).toContain('telemetry = false')
    expect(config).not.toContain('telemetry = true')
    expect(config).not.toMatch(/decision = "allow"\npattern = "Bash"/)
    expect(config).toContain('pattern = "FetchURL"')
    expect(config).toContain('pattern = "WebSearch"')
    expect(modes.get('/iso/config.toml')).toBe(0o600)

    // Credential seeded 0600.
    expect(files.get('/iso/credentials/kimi-code.json')).toBe('{"token":"SECRET"}')
    expect(modes.get('/iso/credentials/kimi-code.json')).toBe(0o600)
    expect(files.get('/iso/device_id')).toBe('dev-123')
    expect(result.env).toEqual({ KIMI_CODE_HOME: '/iso' })
  })

  it('cleanup removes the whole isolated home', async () => {
    const { fs, files, dirs } = makeFakeFs(seededSource())
    const result = await prepareKimiIsolatedHome({
      runId: 'r1',
      homeDir: '/iso',
      sourceHome: '/src',
      fs
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await result.cleanup()
    expect(dirs.has('/iso')).toBe(false)
    expect([...files.keys()].some((k) => k.startsWith('/iso'))).toBe(false)
  })

  it('fails closed with not-authenticated when the source credential is missing', async () => {
    const seed = seededSource()
    delete seed['/src/credentials/kimi-code.json']
    const { fs } = makeFakeFs(seed)
    const result = await prepareKimiIsolatedHome({
      runId: 'r1',
      homeDir: '/iso',
      sourceHome: '/src',
      fs
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not-authenticated')
    expect(result.message).toContain('kimi login')
  })

  it('detects an unsafe project .kimi-code/mcp.json (B3)', async () => {
    const { fs } = makeFakeFs({ '/ws/.kimi-code/mcp.json': '{"mcpServers":{}}' })
    expect(await findUnsafeWorkspaceKimiConfig('/ws', fs)).toBe('/ws/.kimi-code/mcp.json')
  })

  it('detects an unsafe project .kimi-code/plugins dir (B4)', async () => {
    const { fs, dirs } = makeFakeFs({})
    dirs.add('/ws/.kimi-code/plugins')
    expect(await findUnsafeWorkspaceKimiConfig('/ws', fs)).toBe('/ws/.kimi-code/plugins')
  })

  it('returns null for a workspace with no project Kimi config', async () => {
    const { fs } = makeFakeFs({ '/ws/README.md': '# hi' })
    expect(await findUnsafeWorkspaceKimiConfig('/ws', fs)).toBeNull()
  })

  it('returns no-config when config.toml is absent', async () => {
    const seed = seededSource()
    delete seed['/src/config.toml']
    const { fs } = makeFakeFs(seed)
    const result = await prepareKimiIsolatedHome({
      runId: 'r1',
      homeDir: '/iso',
      sourceHome: '/src',
      fs
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('no-config')
  })
})
