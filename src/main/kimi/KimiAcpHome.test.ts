import { describe, it, expect, vi } from 'vitest'
import {
  prepareKimiIsolatedHome,
  findUnsafeWorkspaceKimiConfig,
  hasConfiguredKimiApiKey,
  detectKimiManagedAuthState,
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
  let oauthLeaseHeld = false
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
      for (const key of [...dirs]) if (key.startsWith(`${path}/`)) dirs.delete(key)
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) files.delete(key)
      }
    },
    readdir: async (path) => {
      const prefix = `${path}/`
      return [
        ...new Set(
          [...files.keys(), ...dirs]
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length).split('/')[0])
            .filter(Boolean)
        )
      ]
    },
    lstat: async (path) => {
      if (!files.has(path) && !dirs.has(path)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return {
        isDirectory: () => dirs.has(path),
        isFile: () => files.has(path),
        isSymbolicLink: () => false,
        mode: modes.get(path) ?? (dirs.has(path) ? 0o700 : 0o600)
      }
    },
    realpath: async (path) => path,
    acquireOAuthCredentialLease: async ({ sourceHome, isolatedHome }) => {
      if (oauthLeaseHeld) {
        return {
          ok: false,
          reason: 'busy',
          message: 'Another managed Kimi OAuth seat owns the single-use refresh credential.'
        }
      }
      const primary = `${sourceHome}/credentials/kimi-code.json`
      const expected = files.get(primary)
      if (expected === undefined) {
        return { ok: false, reason: 'error', message: 'OAuth credential unavailable.' }
      }
      const artefacts = ['credentials/kimi-code.json', 'oauth/kimi-code', 'device_id']
      const snapshots = new Map(
        artefacts
          .filter((rel) => files.has(`${sourceHome}/${rel}`))
          .map((rel) => [rel, files.get(`${sourceHome}/${rel}`) as string])
      )
      oauthLeaseHeld = true
      let released: 'unchanged' | 'rotated' | 'stale-rejected' | null = null
      let seeded = false
      return {
        ok: true,
        lease: {
          seedIntoIsolatedHome: async () => {
            for (const [rel, data] of snapshots) {
              files.set(`${isolatedHome}/${rel}`, data)
              modes.set(`${isolatedHome}/${rel}`, 0o600)
            }
            seeded = true
          },
          noteProviderProcess: async () => {},
          commitAndRelease: async () => {
            if (released) return released
            const candidate = files.get(`${isolatedHome}/credentials/kimi-code.json`)
            const current = files.get(primary)
            if (!seeded || candidate === expected) {
              released = 'unchanged'
            } else if (current !== expected) {
              released = 'stale-rejected'
            } else {
              const expiry = (raw: string | undefined): number => {
                try {
                  const value = JSON.parse(raw || '') as { expires_at?: unknown }
                  return typeof value.expires_at === 'number' ? value.expires_at : 0
                } catch {
                  return 0
                }
              }
              if (!candidate || expiry(candidate) <= expiry(current)) {
                throw new Error('Non-monotonic fake OAuth rotation.')
              }
              for (const rel of artefacts) {
                const data = files.get(`${isolatedHome}/${rel}`)
                if (data === undefined) continue
                files.set(`${sourceHome}/${rel}`, data)
                modes.set(`${sourceHome}/${rel}`, 0o600)
              }
              released = 'rotated'
            }
            for (const entry of await fs.readdir!(isolatedHome)) {
              if (entry === 'sessions' || entry === 'session_index.jsonl') continue
              await fs.rm(`${isolatedHome}/${entry}`)
            }
            oauthLeaseHeld = false
            return released
          }
        }
      }
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
  it('rejects a symlinked isolated home before writing credentials or config', async () => {
    const { fs, files, dirs } = makeFakeFs(seededSource())
    dirs.add('/iso')
    const baseLstat = fs.lstat!
    fs.lstat = async (path) =>
      path === '/iso'
        ? {
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => true,
            mode: 0o700
          }
        : baseLstat(path)

    const result = await prepareKimiIsolatedHome({
      runId: 'symlink-home',
      homeDir: '/iso',
      sourceHome: '/src',
      fs
    })

    expect(result.ok).toBe(false)
    expect(files.has('/iso/config.toml')).toBe(false)
    expect(files.has('/iso/credentials/kimi-code.json')).toBe(false)
  })

  it('rejects a symlinked v2 root before chmod or home writes', async () => {
    const { fs, files, dirs } = makeFakeFs(seededSource())
    dirs.add('/v2')
    const baseLstat = fs.lstat!
    fs.lstat = async (path) =>
      path === '/v2'
        ? {
            isDirectory: () => true,
            isFile: () => false,
            isSymbolicLink: () => true,
            mode: 0o777
          }
        : baseLstat(path)
    const chmod = vi.fn(fs.chmod)
    fs.chmod = chmod

    const result = await prepareKimiIsolatedHome({
      runId: 'symlink-root',
      homeDir: '/v2/seat',
      boundaryRoot: '/v2',
      sourceHome: '/src',
      fs
    })

    expect(result.ok).toBe(false)
    expect(chmod).not.toHaveBeenCalledWith('/v2', expect.anything())
    expect(files.has('/v2/seat/config.toml')).toBe(false)
    expect(files.has('/v2/seat/credentials/kimi-code.json')).toBe(false)
  })

  it('recognizes only a non-empty API key in a kimi provider table', () => {
    expect(hasConfiguredKimiApiKey('[providers.kimi]\ntype = "kimi"\napi_key = "sk-test"\n')).toBe(
      true
    )
    expect(
      hasConfiguredKimiApiKey('[providers."kimi"]\ntype = "kimi"\napi_key = "sk-test"\n')
    ).toBe(true)
    expect(hasConfiguredKimiApiKey('# [providers.kimi]\n# api_key = "sk-test"\n')).toBe(false)
    expect(hasConfiguredKimiApiKey('[providers.kimi]\ntype = "kimi"\napi_key = ""\n')).toBe(false)
    expect(hasConfiguredKimiApiKey('[providers.other]\ntype = "kimi"\napi_key = "sk-test"\n')).toBe(
      false
    )
  })

  it('derives managed auth only from the current Kimi Code home', async () => {
    const oauth = makeFakeFs({
      '/current/config.toml': REAL_CONFIG,
      '/current/credentials/kimi-code.json': '{"access_token":"current"}',
      '/legacy/credentials/kimi-code.json': '{"access_token":"legacy"}'
    })
    expect(await detectKimiManagedAuthState('/current', oauth.fs)).toBe('oauth')

    const providerKey = makeFakeFs({
      '/current/config.toml': `${REAL_CONFIG}\n[providers.kimi]\ntype = "kimi"\napi_key = "sk-managed"\n`,
      '/legacy/credentials/kimi-code.json': '{"access_token":"legacy"}'
    })
    expect(await detectKimiManagedAuthState('/current', providerKey.fs)).toBe('api-key')

    const legacyOnly = makeFakeFs({
      '/current/config.toml': REAL_CONFIG,
      '/legacy/credentials/kimi-code.json': '{"access_token":"legacy"}'
    })
    expect(await detectKimiManagedAuthState('/current', legacyOnly.fs)).toBe('unknown')
  })

  it('builds an isolated home from a non-rotating Kimi provider API key', async () => {
    const { fs, files } = makeFakeFs({
      '/src/config.toml': `${REAL_CONFIG}\n\n[providers.kimi]\ntype = "kimi"\napi_key = "sk-hosted"\n`
    })
    const result = await prepareKimiIsolatedHome({
      runId: 'hosted-api-key',
      homeDir: '/iso',
      sourceHome: '/src',
      strictCleanup: true,
      fs
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(files.get('/iso/config.toml')).toContain('api_key = "sk-hosted"')
    expect(files.has('/iso/credentials/kimi-code.json')).toBe(false)
    await result.cleanup()
    expect([...files.keys()].some((key) => key.startsWith('/iso'))).toBe(false)
  })

  it('creates an empty skills dir by default and skips it for allow-native posture', async () => {
    const suppressed = makeFakeFs({
      '/src/config.toml': `${REAL_CONFIG}\n\n[providers.kimi]\ntype = "kimi"\napi_key = "sk-hosted"\n`
    })
    const suppressedHome = await prepareKimiIsolatedHome({
      runId: 'skills-suppress',
      homeDir: '/iso-suppress',
      sourceHome: '/src',
      harnessPosture: { skills: 'suppress', hooks: 'suppress' },
      fs: suppressed.fs
    })
    expect(suppressedHome.ok).toBe(true)
    expect(suppressed.dirs.has('/iso-suppress/skills')).toBe(true)

    const allowed = makeFakeFs({
      '/src/config.toml': `${REAL_CONFIG}\n\n[providers.kimi]\ntype = "kimi"\napi_key = "sk-hosted"\n`
    })
    const allowedHome = await prepareKimiIsolatedHome({
      runId: 'skills-allow',
      homeDir: '/iso-allow',
      sourceHome: '/src',
      harnessPosture: { skills: 'allow-native', hooks: 'allow-native' },
      fs: allowed.fs
    })
    expect(allowedHome.ok).toBe(true)
    expect(allowed.dirs.has('/iso-allow/skills')).toBe(false)
    expect(allowed.dirs.has('/iso-allow/plugins')).toBe(true)
  })

  it('allows API-key seats to prepare concurrently without the OAuth lease', async () => {
    const { fs } = makeFakeFs({
      '/src/config.toml': `${REAL_CONFIG}\n\n[providers.kimi]\ntype = "kimi"\napi_key = "sk-hosted"\n`
    })
    const [first, second] = await Promise.all([
      prepareKimiIsolatedHome({ runId: 'api-a', homeDir: '/api-a', sourceHome: '/src', fs }),
      prepareKimiIsolatedHome({ runId: 'api-b', homeDir: '/api-b', sourceHome: '/src', fs })
    ])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok) await first.cleanup()
    if (second.ok) await second.cleanup()
  })

  it('allows OAuth seats to prepare concurrently through a shared credential projection', async () => {
    const { fs, files, dirs, modes } = makeFakeFs(seededSource())
    fs.prepareOAuthCredentialProjection = async ({ sourceHome, isolatedHome }) => {
      dirs.add(`${isolatedHome}/credentials`)
      dirs.add(`${isolatedHome}/oauth`)
      for (const relative of ['credentials/kimi-code.json', 'oauth/kimi-code', 'device_id']) {
        const source = `${sourceHome}/${relative}`
        if (!files.has(source)) continue
        const destination = `${isolatedHome}/${relative}`
        files.set(destination, files.get(source) as string)
        modes.set(destination, 0o600)
      }
    }

    const [first, second] = await Promise.all([
      prepareKimiIsolatedHome({ runId: 'oauth-a', homeDir: '/oauth-a', sourceHome: '/src', fs }),
      prepareKimiIsolatedHome({ runId: 'oauth-b', homeDir: '/oauth-b', sourceHome: '/src', fs })
    ])

    expect(first).toMatchObject({ ok: true })
    expect(second).toMatchObject({ ok: true })
    if (first.ok) await first.cleanup()
    if (second.ok) await second.cleanup()
  })

  it('keeps the legacy lease-only fallback serial for older integration adapters', async () => {
    const { fs } = makeFakeFs(seededSource())
    const first = await prepareKimiIsolatedHome({
      runId: 'oauth-a',
      homeDir: '/oauth-a',
      sourceHome: '/src',
      fs
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const blocked = await prepareKimiIsolatedHome({
      runId: 'oauth-b',
      homeDir: '/oauth-b',
      sourceHome: '/src',
      fs
    })
    expect(blocked).toMatchObject({ ok: false, reason: 'error' })
    if (!blocked.ok) expect(blocked.message).toContain('owns the single-use refresh credential')

    await first.cleanup()
    await expect(
      prepareKimiIsolatedHome({
        runId: 'oauth-b-retry',
        homeDir: '/oauth-b',
        sourceHome: '/src',
        fs
      })
    ).resolves.toMatchObject({ ok: true })
  })

  it('builds an isolated home with a curated config and seeded credential', async () => {
    const { fs, files, modes } = makeFakeFs(seededSource())
    const result = await prepareKimiIsolatedHome({
      runId: 'r1',
      homeDir: '/iso',
      sourceHome: '/src',
      thinkingEnabled: true,
      thinkingEffort: 'high',
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
    expect(config).toContain('[thinking]\neffort = "high"\nenabled = true')
    expect(modes.get('/iso/config.toml')).toBe(0o600)

    // Credential seeded 0600.
    expect(files.get('/iso/credentials/kimi-code.json')).toBe('{"token":"SECRET"}')
    expect(modes.get('/iso/credentials/kimi-code.json')).toBe(0o600)
    expect(files.get('/iso/device_id')).toBe('dev-123')
    expect(result.env).toEqual({ KIMI_CODE_HOME: '/iso' })
  })

  it('returns the selected model effective context window from the copied config', async () => {
    const seed = seededSource()
    seed['/src/config.toml'] += [
      '',
      '[models."kimi-code/k3"]',
      'max_context_size = 262144',
      '',
      '[models."kimi-code/k3".overrides]',
      'max_context_size = 1048576'
    ].join('\n')
    const { fs } = makeFakeFs(seed)
    const result = await prepareKimiIsolatedHome({
      runId: 'r1',
      homeDir: '/iso',
      sourceHome: '/src',
      selectedModelAlias: 'kimi-code/k3',
      fs
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.modelContextWindow).toBe(1_048_576)
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

  it('strict cleanup rejects a swallowed removal failure for canary evidence', async () => {
    const { fs, files } = makeFakeFs(seededSource())
    const result = await prepareKimiIsolatedHome({
      runId: 'strict-canary',
      homeDir: '/iso',
      sourceHome: '/src',
      strictCleanup: true,
      fs
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const remove = fs.rm
    fs.rm = async (path) => {
      if (path === '/iso') throw new Error('deterministic removal failure')
      await remove(path)
    }

    await expect(result.cleanup()).rejects.toThrow('Strict Kimi canary cleanup')
    // The durable OAuth authority scrubs credentials before the outer home
    // removal. A later failure removing the now-empty home must still reject
    // strict qualification, but must not recreate credential residue.
    expect(files.has('/iso/credentials/kimi-code.json')).toBe(false)
  })

  it('durable cleanup preserves native session state but strips every runtime secret', async () => {
    const seed = {
      ...seededSource(),
      '/iso/sessions/session-1/context.jsonl': '{"role":"user"}',
      '/iso/session_index.jsonl': '{"id":"session-1"}\n',
      '/iso/future-autoload/hooks/launch.js': 'run()',
      // Model a credential residue left by a prior crashed process. Preparation
      // must replace it before the new process starts.
      '/iso/credentials/kimi-code.json': '{"token":"STALE"}',
      // An obsolete global TaskWraith registration must never survive in the
      // isolated user-level MCP slot between durable seat turns.
      '/iso/mcp.json': '{"mcpServers":{"TaskWraith":{}}}'
    }
    const { fs, files, dirs } = makeFakeFs(seed)
    dirs.add('/iso')
    dirs.add('/iso/sessions')
    dirs.add('/iso/sessions/session-1')
    dirs.add('/iso/future-autoload')
    dirs.add('/iso/future-autoload/hooks')
    dirs.add('/iso/credentials')
    const result = await prepareKimiIsolatedHome({
      runId: 'r1',
      homeDir: '/iso',
      sourceHome: '/src',
      preserveSessionState: true,
      fs
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(files.get('/iso/credentials/kimi-code.json')).toBe('{"token":"SECRET"}')
    expect(files.has('/iso/mcp.json')).toBe(false)
    expect(files.has('/iso/future-autoload/hooks/launch.js')).toBe(false)

    await result.cleanup()

    expect(dirs.has('/iso')).toBe(true)
    expect(files.get('/iso/sessions/session-1/context.jsonl')).toBe('{"role":"user"}')
    expect(files.get('/iso/session_index.jsonl')).toBe('{"id":"session-1"}\n')
    expect(files.has('/iso/credentials/kimi-code.json')).toBe(false)
    expect(files.has('/iso/oauth/kimi-code')).toBe(false)
    expect(files.has('/iso/device_id')).toBe(false)
    expect(files.has('/iso/config.toml')).toBe(false)
    expect(files.has('/iso/mcp.json')).toBe(false)
    expect(files.has('/iso/future-autoload/hooks/launch.js')).toBe(false)
  })

  it('strict durable cleanup rejects residue and succeeds on a joined retry', async () => {
    const { fs, files, dirs } = makeFakeFs({
      ...seededSource(),
      '/iso/sessions/session-1/context.jsonl': '{}',
      '/iso/session_index.jsonl': '{"id":"session-1"}\n'
    })
    dirs.add('/iso')
    dirs.add('/iso/sessions')
    dirs.add('/iso/sessions/session-1')
    const result = await prepareKimiIsolatedHome({
      runId: 'strict-durable',
      homeDir: '/iso',
      sourceHome: '/src',
      preserveSessionState: true,
      strictCleanup: true,
      fs
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const remove = fs.rm
    let failCredentialRemoval = true
    fs.rm = async (path) => {
      if (path === '/iso/credentials' && failCredentialRemoval) {
        failCredentialRemoval = false
        throw new Error('injected durable credential removal failure')
      }
      await remove(path)
    }

    await expect(result.cleanup()).rejects.toThrow('OAuth credential writeback did not complete')
    expect(files.has('/iso/credentials/kimi-code.json')).toBe(true)
    await result.cleanup()
    expect(files.has('/iso/credentials/kimi-code.json')).toBe(false)
    expect(files.get('/iso/sessions/session-1/context.jsonl')).toBe('{}')
    expect(files.get('/iso/session_index.jsonl')).toContain('session-1')
  })

  it('drops continuity state containing a nested symlink or hardlinked index', async () => {
    const { fs, files, dirs } = makeFakeFs({
      ...seededSource(),
      '/iso/sessions/session-1/context.jsonl': '{}',
      '/iso/sessions/session-1/escape': 'link',
      '/iso/session_index.jsonl': '{"id":"session-1"}\n'
    })
    dirs.add('/iso')
    dirs.add('/iso/sessions')
    dirs.add('/iso/sessions/session-1')
    const baseLstat = fs.lstat!
    fs.lstat = async (path) => {
      const stat = await baseLstat(path)
      if (path === '/iso/sessions/session-1/escape') {
        return { ...stat, isSymbolicLink: () => true }
      }
      if (path === '/iso/session_index.jsonl') return { ...stat, nlink: 2 }
      return { ...stat, nlink: stat.isFile() ? 1 : undefined }
    }

    const result = await prepareKimiIsolatedHome({
      runId: 'unsafe-continuity',
      homeDir: '/iso',
      sourceHome: '/src',
      preserveSessionState: true,
      fs
    })

    expect(result.ok).toBe(true)
    expect(files.has('/iso/sessions/session-1/context.jsonl')).toBe(false)
    expect(files.has('/iso/sessions/session-1/escape')).toBe(false)
    expect(files.has('/iso/session_index.jsonl')).toBe(false)
  })

  it('fails closed when crash residue cannot be scrubbed from a durable seat', async () => {
    const { fs, dirs } = makeFakeFs({
      ...seededSource(),
      '/iso/credentials/kimi-code.json': '{"token":"STALE"}'
    })
    dirs.add('/iso')
    dirs.add('/iso/credentials')
    const remove = fs.rm
    fs.rm = async (path) => {
      if (path === '/iso/credentials') throw new Error('permission denied')
      await remove(path)
    }

    const result = await prepareKimiIsolatedHome({
      runId: 'r1',
      homeDir: '/iso',
      sourceHome: '/src',
      preserveSessionState: true,
      fs
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('error')
    expect(result.message).toContain('permission denied')
    expect(result.message).toContain('Private OAuth recovery state was preserved')
  })

  it('persists a refreshed (rotated) credential back to the real home on cleanup', async () => {
    const seed = seededSource()
    seed['/src/credentials/kimi-code.json'] = JSON.stringify({
      expires_at: 1000,
      refresh_token: 'R0'
    })
    const { fs, files } = makeFakeFs(seed)
    const result = await prepareKimiIsolatedHome({
      runId: 'r1',
      homeDir: '/iso',
      sourceHome: '/src',
      fs
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Kimi Code refreshed during the run: newer expires_at + a ROTATED refresh
    // token, written into the throwaway home. Without write-back this is lost and
    // the real-home refresh token is invalidated server-side (forces re-login).
    const refreshed = JSON.stringify({ expires_at: 2000, refresh_token: 'R1' })
    await fs.writeFile('/iso/credentials/kimi-code.json', refreshed, 0o600)
    await fs.writeFile('/iso/oauth/kimi-code', 'oauth-R1', 0o600)
    await result.cleanup()
    expect(files.get('/src/credentials/kimi-code.json')).toBe(refreshed)
    expect(files.get('/src/oauth/kimi-code')).toBe('oauth-R1')
    expect([...files.keys()].some((k) => k.startsWith('/iso'))).toBe(false) // still torn down
  })

  it('never regresses the real home to an older credential (concurrency safety)', async () => {
    const seed = seededSource()
    seed['/src/credentials/kimi-code.json'] = JSON.stringify({
      expires_at: 1000,
      refresh_token: 'R0'
    })
    const { fs, files } = makeFakeFs(seed)
    const result = await prepareKimiIsolatedHome({
      runId: 'r1',
      homeDir: '/iso',
      sourceHome: '/src',
      fs
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // A concurrent run already advanced the real home to a fresher token...
    const fresher = JSON.stringify({ expires_at: 3000, refresh_token: 'R2' })
    await fs.writeFile('/src/credentials/kimi-code.json', fresher, 0o600)
    // ...while THIS run only refreshed to an older expiry.
    await fs.writeFile(
      '/iso/credentials/kimi-code.json',
      JSON.stringify({ expires_at: 2000, refresh_token: 'R1' }),
      0o600
    )
    await result.cleanup()
    expect(files.get('/src/credentials/kimi-code.json')).toBe(fresher) // preserved, not clobbered
  })

  it('leaves the real home untouched when no refresh happened', async () => {
    const seed = seededSource()
    const original = JSON.stringify({ expires_at: 1000, refresh_token: 'R0' })
    seed['/src/credentials/kimi-code.json'] = original
    const { fs, files } = makeFakeFs(seed)
    const result = await prepareKimiIsolatedHome({
      runId: 'r1',
      homeDir: '/iso',
      sourceHome: '/src',
      fs
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // No refresh: the seeded isolated credential is identical to the real one.
    await result.cleanup()
    expect(files.get('/src/credentials/kimi-code.json')).toBe(original)
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
    expect(result.message).toContain('no current OAuth login or provider API key')
    expect(result.message).toContain('~/.kimi-code/config.toml')
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
