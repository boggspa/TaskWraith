import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { linkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  MUSE_EMPTY_TRUST_DOCUMENT,
  MUSE_PROBE_ENV_ALLOWLIST,
  createMuseIsolatedHome,
  museLaunchEnvPathsStayInsideLease,
  projectMuseAuthJson,
  scrubMuseDurableSeatHome,
  projectMuseKeychainAccessIfRequired,
  verifyMuseIsolatedHome,
  type MuseIsolatedHomeLease
} from './MuseIsolatedHome'
import { MUSE_LISTABLE_BUNDLED_SKILL_NAMES, museBundledSkillUri } from './MuseSkillPin'
import { buildMuseTaskWraithMcpSettings } from './MuseMcpConfig'

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'taskwraith-muse-isolated-home-test-'))
const leases: MuseIsolatedHomeLease[] = []

afterAll(() => {
  for (const lease of leases) lease.cleanup()
  rmSync(TEMP_ROOT, { recursive: true, force: true })
})

function create(runId = 'run-1', sourceEnvironment?: NodeJS.ProcessEnv): MuseIsolatedHomeLease {
  const lease = createMuseIsolatedHome({
    temporaryRoot: TEMP_ROOT,
    runId,
    sourceEnvironment
  })
  leases.push(lease)
  return lease
}

describe('Muse isolated home', () => {
  it('uses collision-resistant mkdtemp paths and relocates HOME plus all XDG roots', () => {
    const first = create('same-run')
    const second = create('same-run')

    expect(first.path).not.toBe(second.path)
    expect(first.path).toMatch(/taskwraith-muse-home-[a-f0-9]{16}-[^/]+$/)
    expect(lstatSync(first.path).isDirectory()).toBe(true)
    expect(lstatSync(first.path).isSymbolicLink()).toBe(false)
    expect(verifyMuseIsolatedHome(first)).toEqual(first.authority)

    expect(first.homePath).toBe(join(first.path, 'home'))
    expect(first.xdgConfigHome).toBe(join(first.path, 'xdg-config'))
    expect(first.xdgDataHome).toBe(join(first.path, 'xdg-data'))
    expect(first.xdgCacheHome).toBe(join(first.path, 'xdg-cache'))
    expect(first.xdgStateHome).toBe(join(first.path, 'xdg-state'))
    expect(first.xdgRuntimeDir).toBe(join(first.path, 'xdg-runtime'))
    expect(first.tmpDir).toBe(join(first.path, 'tmp'))

    expect(first.env).toMatchObject({
      HOME: first.homePath,
      USERPROFILE: first.homePath,
      TMPDIR: first.tmpDir,
      XDG_CONFIG_HOME: first.xdgConfigHome,
      XDG_DATA_HOME: first.xdgDataHome,
      XDG_CACHE_HOME: first.xdgCacheHome,
      XDG_STATE_HOME: first.xdgStateHome,
      XDG_RUNTIME_DIR: first.xdgRuntimeDir,
      MUSE_NO_AUTO_UPDATE: '1'
    })
    expect(museLaunchEnvPathsStayInsideLease(first.path, first.env)).toBe(true)

    if (process.platform === 'win32') {
      expect(first.authority).toMatchObject({
        ownerVerification: 'unsupported-platform',
        modeVerification: 'unsupported-platform',
        fileIdentityVerification: 'device-inode-best-effort'
      })
    } else {
      const info = lstatSync(first.path)
      expect(info.mode & 0o777).toBe(0o700)
      expect(first.authority).toMatchObject({
        ownerVerification: 'process-uid-match',
        modeVerification: 'posix-0700',
        fileIdentityVerification: 'device-inode-match'
      })
    }
  })

  it('seeds skill-pin settings and empty trust without inheriting user trust', () => {
    const lease = create('seed')
    expect(existsSync(lease.settingsPath)).toBe(true)
    expect(existsSync(lease.trustPath)).toBe(true)

    const settings = JSON.parse(readFileSync(lease.settingsPath, 'utf8')) as {
      skills: { activation: { bundled: Record<string, string> } }
    }
    for (const name of MUSE_LISTABLE_BUNDLED_SKILL_NAMES) {
      expect(settings.skills.activation.bundled[museBundledSkillUri(name)]).toBe('off')
    }
    expect(settings.skills.activation.bundled[museBundledSkillUri('create-plugin')]).toBe('off')

    const trust = JSON.parse(
      readFileSync(lease.trustPath, 'utf8')
    ) as typeof MUSE_EMPTY_TRUST_DOCUMENT
    expect(trust).toEqual(MUSE_EMPTY_TRUST_DOCUMENT)
    expect(trust.projects).toEqual({})
  })

  it('writes app-owned MCP route authority only into the disposable settings document', () => {
    const lease = createMuseIsolatedHome({
      temporaryRoot: TEMP_ROOT,
      runId: 'mcp-settings',
      mcpSettings: buildMuseTaskWraithMcpSettings({
        command: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
        args: ['--taskwraith-gemini-mcp-bridge', '--taskwraith-mcp-route-from-env'],
        env: {
          TASKWRAITH_PARENT_PROVIDER: 'muse',
          TASKWRAITH_MCP_BROKER_TOKEN: 'a'.repeat(64)
        }
      })
    })
    leases.push(lease)

    const settings = JSON.parse(readFileSync(lease.settingsPath, 'utf8')) as {
      mcp_servers?: Record<string, { command?: string; env?: Record<string, string> }>
    }
    expect(settings.mcp_servers?.taskwraith).toMatchObject({
      command: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
      env: { TASKWRAITH_PARENT_PROVIDER: 'muse' }
    })
    expect(lease.env.TASKWRAITH_MCP_BROKER_TOKEN).toBeUndefined()

    expect(lease.cleanup()).toEqual({ ok: true, alreadyAbsent: false })
    expect(existsSync(lease.settingsPath)).toBe(false)
  })

  it('projects Muse OAuth into a private run-local auth.json and removes it at teardown', () => {
    const authJsonText = JSON.stringify({
      schema_version: 1,
      providers: {
        meta: {
          mechanism: 'oauth',
          access_token: 'oauth-access-secret',
          refresh_token: 'oauth-refresh-secret',
          expires_at: 1_900_000_000
        }
      }
    })
    const lease = create('oauth-projection')
    const authPath = projectMuseAuthJson(lease, authJsonText)

    expect(readFileSync(authPath, 'utf8')).toBe(authJsonText)
    expect(Object.values(lease.env).join('\n')).not.toContain('oauth-access-secret')
    expect(Object.values(lease.env).join('\n')).not.toContain('oauth-refresh-secret')
    if (process.platform !== 'win32') {
      expect(lstatSync(authPath).mode & 0o777).toBe(0o600)
    }

    expect(lease.cleanup()).toEqual({ ok: true, alreadyAbsent: false })
    expect(existsSync(authPath)).toBe(false)
  })

  it('refuses malformed or credential-free auth.json projections', () => {
    const lease = create('bad-auth-json')
    expect(() => projectMuseAuthJson(lease, '{')).toThrow(/valid JSON/i)
    expect(() =>
      projectMuseAuthJson(lease, JSON.stringify({ schema_version: 1, providers: {} }))
    ).toThrow(/no supported Meta credential/i)
  })

  // Subscription-era `muse login` (Muse 1.x) writes a schema-v2 locator whose
  // OAuth secret lives in the macOS login keychain. The CLI resolves that
  // keychain through `$HOME/Library/Keychains`, so the relocated seat HOME
  // needs a keychain graft or the run fails with "missing meta credentials"
  // despite a projected auth.json (confirmed against Muse Code 1.0.1).
  const KEYCHAIN_LOCATOR_AUTH_JSON = JSON.stringify({
    schema_version: 2,
    providers: {
      meta: {
        mechanism: 'oauth',
        storage: 'keychain',
        obtained_via: 'device_code'
      }
    }
  })

  it('grafts real-keychain access for a schema-v2 keychain locator without copying a secret', () => {
    const realKeychainsDir = join(TEMP_ROOT, 'real-keychains')
    mkdirSync(realKeychainsDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(realKeychainsDir, 'login.keychain-db'), 'sentinel-not-a-real-keychain')

    const lease = create('keychain-locator')
    const authPath = projectMuseAuthJson(lease, KEYCHAIN_LOCATOR_AUTH_JSON, {
      platform: 'darwin',
      realKeychainsDir
    })
    expect(readFileSync(authPath, 'utf8')).toBe(KEYCHAIN_LOCATOR_AUTH_JSON)

    const linkPath = join(lease.homePath, 'Library', 'Keychains')
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(linkPath)).toBe(realKeychainsDir)
    // The projection itself never reads or copies the keychain secret.
    expect(readFileSync(authPath, 'utf8')).not.toContain('sentinel')

    // Teardown removes only the symlink; the real keychain directory and its
    // contents survive untouched.
    expect(lease.cleanup()).toEqual({ ok: true, alreadyAbsent: false })
    expect(existsSync(lease.path)).toBe(false)
    expect(lstatSync(realKeychainsDir).isDirectory()).toBe(true)
    expect(readFileSync(join(realKeychainsDir, 'login.keychain-db'), 'utf8')).toBe(
      'sentinel-not-a-real-keychain'
    )
  })

  it('does not graft keychain access for inline credentials or non-darwin platforms', () => {
    const realKeychainsDir = join(TEMP_ROOT, 'real-keychains-unused')
    mkdirSync(realKeychainsDir, { recursive: true, mode: 0o700 })

    const inlineLease = create('keychain-not-needed-inline')
    projectMuseAuthJson(
      inlineLease,
      JSON.stringify({
        schema_version: 1,
        providers: { meta: { mechanism: 'oauth', access_token: 'inline-token' } }
      }),
      { platform: 'darwin', realKeychainsDir }
    )
    expect(existsSync(join(inlineLease.homePath, 'Library'))).toBe(false)

    const linuxLease = create('keychain-not-darwin')
    projectMuseAuthJson(linuxLease, KEYCHAIN_LOCATOR_AUTH_JSON, {
      platform: 'linux',
      realKeychainsDir
    })
    expect(existsSync(join(linuxLease.homePath, 'Library'))).toBe(false)
  })

  it('skips the keychain graft when the real keychain directory is absent', () => {
    const lease = create('keychain-absent')
    const authPath = projectMuseAuthJson(lease, KEYCHAIN_LOCATOR_AUTH_JSON, {
      platform: 'darwin',
      realKeychainsDir: join(TEMP_ROOT, 'no-such-keychains-dir')
    })
    expect(readFileSync(authPath, 'utf8')).toBe(KEYCHAIN_LOCATOR_AUTH_JSON)
    expect(existsSync(join(lease.homePath, 'Library'))).toBe(false)
  })

  it('scrubs credential and Muse auth env keys from the parent process', () => {
    const lease = create('scrub', {
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
      LANG: 'en_US.UTF-8',
      HOME: '/Users/someone',
      MUSE_AUTH_PATH: '/Users/someone/.config/muse/auth.json',
      META_API_KEY: 'must-not-leak',
      CURSOR_API_KEY: 'must-not-leak',
      CURSOR_AUTH_TOKEN: 'must-not-leak',
      OPENAI_API_KEY: 'must-not-leak',
      XDG_CONFIG_HOME: '/Users/someone/.config'
    })

    // @portability-ok: verifies opaque caller-supplied shell environment values are preserved.
    expect(lease.env.PATH).toBe('/usr/bin')
    expect(lease.env.SHELL).toBe('/bin/zsh')
    expect(lease.env.HOME).toBe(lease.homePath)
    expect(lease.env.XDG_CONFIG_HOME).toBe(lease.xdgConfigHome)
    expect(lease.env.MUSE_AUTH_PATH).toBeUndefined()
    expect(lease.env.META_API_KEY).toBeUndefined()
    expect(lease.env.CURSOR_API_KEY).toBeUndefined()
    expect(lease.env.CURSOR_AUTH_TOKEN).toBeUndefined()
    expect(lease.env.OPENAI_API_KEY).toBeUndefined()

    for (const key of Object.keys(lease.env)) {
      if ((MUSE_PROBE_ENV_ALLOWLIST as readonly string[]).includes(key)) continue
      expect([
        'HOME',
        'USERPROFILE',
        'TMPDIR',
        'TMP',
        'TEMP',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_CACHE_HOME',
        'XDG_STATE_HOME',
        'XDG_RUNTIME_DIR',
        'APPDATA',
        'LOCALAPPDATA',
        'MUSE_NO_AUTO_UPDATE',
        'FORCE_COLOR',
        'NO_COLOR'
      ]).toContain(key)
    }
  })


  it('forwards MUSE_LOG when museLogLevel is provided and omits it otherwise', () => {
    const leaseWithLog = createMuseIsolatedHome({
      temporaryRoot: TEMP_ROOT,
      runId: 'log-enabled',
      museLogLevel: 'debug'
    })
    leases.push(leaseWithLog)
    expect(leaseWithLog.env.MUSE_LOG).toBe('debug')

    const leaseWithoutLog = createMuseIsolatedHome({
      temporaryRoot: TEMP_ROOT,
      runId: 'log-disabled'
    })
    leases.push(leaseWithoutLog)
    expect(leaseWithoutLog.env.MUSE_LOG).toBeUndefined()
  })
  it('refuses a mode-weakened directory where POSIX mode semantics are available', () => {
    if (process.platform === 'win32') return
    const lease = create('mode-change')
    chmodSync(lease.path, 0o755)
    expect(() => verifyMuseIsolatedHome(lease)).toThrow(/0700/i)
    const cleanup = lease.cleanup()
    expect(cleanup.ok).toBe(false)
    chmodSync(lease.path, 0o700)
    expect(lease.cleanup()).toEqual({ ok: true, alreadyAbsent: false })
  })

  it('refuses to attest or recursively remove an identity-swapped directory', () => {
    const lease = create('identity-swap')
    const path = lease.path
    const replacement = join(TEMP_ROOT, 'identity-swap-replacement')
    mkdirSync(replacement, { mode: 0o700 })
    rmSync(path, { recursive: true, force: true })
    renameSync(replacement, path)

    expect(() => verifyMuseIsolatedHome(lease)).toThrow(/identity/i)
    expect(lease.cleanup()).toMatchObject({ ok: false })
    expect(lstatSync(path).isDirectory()).toBe(true)
    rmSync(path, { recursive: true, force: true })
  })

  it.runIf(process.platform !== 'win32')(
    'refuses a symlink replacement and leaves its target untouched',
    () => {
      const lease = create('symlink-swap')
      const path = lease.path
      const target = join(TEMP_ROOT, 'symlink-target')
      mkdirSync(target, { mode: 0o700 })
      rmSync(path, { recursive: true, force: true })
      symlinkSync(target, path)

      expect(() => verifyMuseIsolatedHome(lease)).toThrow(/canonical real path|real directory/i)
      expect(lease.cleanup()).toMatchObject({ ok: false })
      expect(lstatSync(path).isSymbolicLink()).toBe(true)
      expect(lstatSync(target).isDirectory()).toBe(true)
      rmSync(path, { force: true })
      rmSync(target, { recursive: true, force: true })
    }
  )

  it('cleans only the issued identity and is idempotent after success', () => {
    const lease = create('cleanup')
    writeFileSync(join(lease.museDataDir, 'marker.txt'), 'x')
    expect(lease.cleanup()).toEqual({ ok: true, alreadyAbsent: false })
    expect(lease.cleanup()).toEqual({ ok: true, alreadyAbsent: true })
    expect(() => verifyMuseIsolatedHome(lease)).toThrow(/already been cleaned/i)
    expect(existsSync(lease.path)).toBe(false)
  })

  it('rejects forged lease-shaped objects', () => {
    const issued = create('forgery-source')
    const forged = {
      ...issued,
      verify: () => issued.authority,
      cleanup: () => ({ ok: true as const, alreadyAbsent: false })
    }
    expect(() => verifyMuseIsolatedHome(forged)).toThrow(/main-issued/i)
  })
})

describe('Muse durable per-chat seat home', () => {
  const seatRoots: string[] = []

  function seat(name: string): { boundaryRoot: string; path: string } {
    const boundaryRoot = join(TEMP_ROOT, `seats-${name}`)
    seatRoots.push(boundaryRoot)
    return { boundaryRoot, path: join(boundaryRoot, `seat-${name}`) }
  }

  function attach(
    durableSeat: { boundaryRoot: string; path: string },
    input: Partial<Parameters<typeof createMuseIsolatedHome>[0]> = {}
  ): MuseIsolatedHomeLease {
    return createMuseIsolatedHome({
      temporaryRoot: TEMP_ROOT,
      runId: 'durable-run',
      ...input,
      durableSeat
    })
  }

  /** Stand in for what Muse writes into the seat during a turn. */
  function seedProviderResidue(lease: MuseIsolatedHomeLease): void {
    const sessions = join(lease.museDataDir, 'sessions', '.msp-view-v1', 'session-a')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'HEAD.json'), '{"turn":1}')
    writeFileSync(join(lease.museDataDir, 'session-index.db'), 'index-bytes')
    mkdirSync(join(lease.museDataDir, 'local-tracing', 'bootstrap'), { recursive: true })
    writeFileSync(join(lease.museDataDir, 'local-tracing', 'bootstrap', 'cli.log'), 'trace')
    writeFileSync(join(lease.museConfigDir, '.auth.json.lock'), 'lock')
    // A sibling of muse/ inside XDG_DATA_HOME: not on the continuity list at
    // any depth, so it must not survive either.
    writeFileSync(join(lease.xdgDataHome, 'stray-provider-state'), 'stray')
    writeFileSync(join(lease.tmpDir, 'scratch.bin'), 'temp')
  }

  afterAll(() => {
    for (const root of seatRoots) rmSync(root, { recursive: true, force: true })
  })

  it('attests a durable posture distinct from the disposable mkdtemp home', () => {
    const target = seat('posture')
    const lease = attach(target)

    expect(lease.authority.strategy).toBe('node-durable-seat-verified-v1')
    expect(lease.authority.cleanupPolicy).toBe('identity-match-scrub-to-continuity')
    expect(lease.path).toBe(realpathSync(target.path))
    expect(verifyMuseIsolatedHome(lease).fileIdentity).toEqual(lease.authority.fileIdentity)
    if (process.platform !== 'win32') {
      expect(lstatSync(target.boundaryRoot).mode & 0o777).toBe(0o700)
      expect(lstatSync(lease.path).mode & 0o777).toBe(0o700)
    }
    lease.cleanup()
  })

  it('keeps the session log across a turn boundary and scrubs everything else', () => {
    const target = seat('continuity')
    const first = attach(target)
    seedProviderResidue(first)
    projectMuseAuthJson(
      first,
      JSON.stringify({
        schema_version: 1,
        providers: {
          meta: { mechanism: 'oauth', access_token: 'secret-token', expires_at: 1_900_000_000 }
        }
      })
    )
    expect(existsSync(join(first.museConfigDir, 'auth.json'))).toBe(true)

    expect(first.cleanup()).toEqual({ ok: true, alreadyAbsent: false })

    // The seat itself survives — that is the whole point of the durable lane.
    expect(existsSync(target.path)).toBe(true)
    expect(
      existsSync(join(first.museDataDir, 'sessions', '.msp-view-v1', 'session-a', 'HEAD.json'))
    ).toBe(true)
    expect(readFileSync(join(first.museDataDir, 'session-index.db'), 'utf8')).toBe('index-bytes')
    // ...and nothing else does.
    expect(existsSync(join(first.museDataDir, 'local-tracing'))).toBe(false)
    expect(existsSync(join(first.xdgDataHome, 'stray-provider-state'))).toBe(false)
    expect(existsSync(join(first.museConfigDir, 'auth.json'))).toBe(false)
    expect(existsSync(join(first.museConfigDir, '.auth.json.lock'))).toBe(false)
    expect(existsSync(first.settingsPath)).toBe(false)
    expect(existsSync(first.trustPath)).toBe(false)
    expect(existsSync(join(first.tmpDir, 'scratch.bin'))).toBe(false)
    expect(existsSync(first.homePath)).toBe(false)

    const second = attach(target)
    expect(readFileSync(join(second.museDataDir, 'session-index.db'), 'utf8')).toBe('index-bytes')
    expect(existsSync(second.settingsPath)).toBe(true)
    second.cleanup()
  })

  it('never serves a later turn the MCP broker token minted for an earlier one', () => {
    const target = seat('broker')
    const first = attach(target, {
      mcpSettings: buildMuseTaskWraithMcpSettings({
        command: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
        args: ['--taskwraith-gemini-mcp-bridge'],
        env: {
          TASKWRAITH_PARENT_PROVIDER: 'muse',
          TASKWRAITH_MCP_BROKER_TOKEN: 'turn-one-token'
        }
      })
    })
    expect(readFileSync(first.settingsPath, 'utf8')).toContain('turn-one-token')
    // A crashed turn never reaches cleanup; the attach scrub still has to hold.
    const second = attach(target)

    const settings = JSON.parse(readFileSync(second.settingsPath, 'utf8')) as {
      mcp_servers?: Record<string, unknown>
    }
    expect(readFileSync(second.settingsPath, 'utf8')).not.toContain('turn-one-token')
    expect(settings.mcp_servers).toBeUndefined()
    second.cleanup()
  })

  it('gives a reused seat a private settings document and empty trust', () => {
    const target = seat('reuse')
    const first = attach(target)
    writeFileSync(
      first.trustPath,
      JSON.stringify({ schema_version: 1, projects: { '/etc': true } })
    )
    if (process.platform !== 'win32') chmodSync(first.settingsPath, 0o644)

    const second = attach(target)
    expect(JSON.parse(readFileSync(second.trustPath, 'utf8'))).toEqual(MUSE_EMPTY_TRUST_DOCUMENT)
    if (process.platform !== 'win32') {
      expect(lstatSync(second.settingsPath).mode & 0o777).toBe(0o600)
    }
    second.cleanup()
  })

  it('refuses a symlinked seat root or seat home before writing anything', () => {
    if (process.platform === 'win32') return
    const elsewhere = join(TEMP_ROOT, 'seat-decoy')
    mkdirSync(elsewhere, { recursive: true, mode: 0o700 })

    const linkedRoot = join(TEMP_ROOT, 'seats-linked-root')
    seatRoots.push(linkedRoot)
    symlinkSync(elsewhere, linkedRoot)
    expect(() => attach({ boundaryRoot: linkedRoot, path: join(linkedRoot, 'seat') })).toThrow(
      /seat root is not a real directory/
    )

    const realRoot = join(TEMP_ROOT, 'seats-linked-home')
    seatRoots.push(realRoot)
    mkdirSync(realRoot, { recursive: true, mode: 0o700 })
    const linkedHome = join(realRoot, 'seat')
    symlinkSync(elsewhere, linkedHome)
    expect(() => attach({ boundaryRoot: realRoot, path: linkedHome })).toThrow(
      /seat home is not a real directory/
    )
    expect(existsSync(join(elsewhere, 'xdg-config'))).toBe(false)
  })

  it('drops the whole session log when a hard link is planted inside it', () => {
    if (process.platform === 'win32') return
    const target = seat('tampered')
    const first = attach(target)
    seedProviderResidue(first)
    const secretTarget = join(TEMP_ROOT, 'seat-secret.txt')
    writeFileSync(secretTarget, 'not-muse-material')

    const sessions = join(first.museDataDir, 'sessions')
    symlinkSync(secretTarget, join(sessions, 'redirect'))
    first.cleanup()
    expect(existsSync(sessions)).toBe(false)

    const relinked = attach(target)
    seedProviderResidue(relinked)
    const hardLinked = join(relinked.museDataDir, 'sessions', 'hardlink')
    linkSync(secretTarget, hardLinked)
    expect(lstatSync(hardLinked).nlink).toBe(2)
    relinked.cleanup()

    // The whole entry goes, not just the offending leaf: a session log we
    // cannot fully re-prove is not one we hand back to a provider process.
    expect(existsSync(sessions)).toBe(false)
    expect(readFileSync(secretTarget, 'utf8')).toBe('not-muse-material')
    // An untampered sibling on the continuity list is unaffected.
    expect(existsSync(join(first.museDataDir, 'session-index.db'))).toBe(true)
  })

  it('scrubs residue on attach when the previous turn never reached cleanup', () => {
    const target = seat('crashed')
    const first = attach(target)
    seedProviderResidue(first)
    projectMuseAuthJson(
      first,
      JSON.stringify({
        schema_version: 1,
        providers: {
          meta: {
            mechanism: 'oauth',
            access_token: 'crashed-turn-secret',
            expires_at: 1_900_000_000
          }
        }
      })
    )
    // No cleanup(): the host died mid-turn. The next attach is the only thing
    // between that credential and the next provider process.
    expect(existsSync(join(first.museConfigDir, 'auth.json'))).toBe(true)
    expect(existsSync(join(first.tmpDir, 'scratch.bin'))).toBe(true)

    const second = attach(target)
    expect(existsSync(join(second.museConfigDir, 'auth.json'))).toBe(false)
    expect(existsSync(join(second.museDataDir, 'local-tracing'))).toBe(false)
    expect(existsSync(join(second.museConfigDir, '.auth.json.lock'))).toBe(false)
    expect(existsSync(join(second.tmpDir, 'scratch.bin'))).toBe(false)
    // ...while the session log the crashed turn produced is still resumable.
    expect(readFileSync(join(second.museDataDir, 'session-index.db'), 'utf8')).toBe('index-bytes')
    second.cleanup()
  })

  it('evicts material the provider stashed inside the retained session log', () => {
    const target = seat('stash')
    const first = attach(target)
    seedProviderResidue(first)
    const sessions = join(first.museDataDir, 'sessions')
    // The provider owns this tree and can write anything into it, so a copied
    // credential would otherwise be retained permanently — the settings
    // rewrite cannot reach it.
    writeFileSync(join(sessions, 'stashed-auth.json'), 'access_token')
    first.cleanup()

    expect(existsSync(join(sessions, 'stashed-auth.json'))).toBe(false)
    // ...while the real log shape is untouched.
    expect(existsSync(join(sessions, '.msp-view-v1', 'session-a', 'HEAD.json'))).toBe(true)
    expect(existsSync(join(first.museDataDir, 'session-index.db'))).toBe(true)
  })

  it('refuses to retain an allowlisted name recreated as the wrong type', () => {
    const target = seat('typeconfusion')
    const first = attach(target)
    seedProviderResidue(first)
    // A directory wearing the index's name would be unbounded permanent
    // storage under a name the allowlist blesses.
    rmSync(join(first.museDataDir, 'session-index.db'), { force: true })
    mkdirSync(join(first.museDataDir, 'session-index.db', 'stash'), { recursive: true })
    writeFileSync(join(first.museDataDir, 'session-index.db', 'stash', 'payload'), 'x')
    first.cleanup()

    expect(existsSync(join(first.museDataDir, 'session-index.db'))).toBe(false)
    expect(existsSync(join(first.museDataDir, 'sessions'))).toBe(true)
  })

  it('destroys a seat it cannot reduce rather than handing it to a provider', () => {
    if (process.platform === 'win32') return
    const target = seat('unreducible')
    const first = attach(target)
    seedProviderResidue(first)
    // An unreadable directory makes the recursive delete of xdg-config throw.
    const locked = join(first.museConfigDir, 'locked')
    mkdirSync(locked, { recursive: true })
    writeFileSync(join(locked, 'inner'), 'x')
    chmodSync(locked, 0o000)

    // Fails closed, and says whether the seat was actually discarded — an
    // unreadable directory defeats the destroy for the same reason it defeated
    // the scrub, and "may still hold run material" is a different problem.
    expect(() => attach(target)).toThrow(
      /could not be reduced to session continuity and was left in place/
    )

    // The best-effort destroy takes the session log with it — that is the
    // accepted cost of failing closed, and it is why this seat cannot resume.
    expect(existsSync(join(first.museDataDir, 'session-index.db'))).toBe(false)

    // Self-healing: once the obstruction is gone the next attach reduces the
    // seat and proceeds, so the chat is not permanently unusable.
    chmodSync(locked, 0o700)
    const recovered = attach(target)
    expect(existsSync(locked)).toBe(false)
    expect(existsSync(recovered.settingsPath)).toBe(true)
    recovered.cleanup()
  })

  it('re-points a keychain graft that no longer resolves where it should', () => {
    if (process.platform !== 'darwin') return
    const realKeychainsDir = join(TEMP_ROOT, 'real-keychains')
    const decoy = join(TEMP_ROOT, 'decoy-keychains')
    mkdirSync(realKeychainsDir, { recursive: true })
    mkdirSync(decoy, { recursive: true })
    const lease = attach(seat('keychain'))
    const authJsonText = JSON.stringify({
      schema_version: 2,
      providers: { meta: { mechanism: 'oauth', storage: 'keychain', account: 'a' } }
    })

    const linkPath = projectMuseKeychainAccessIfRequired(lease, authJsonText, {
      platform: 'darwin',
      realKeychainsDir
    })
    expect(linkPath).toBeTruthy()
    expect(readlinkSync(linkPath as string)).toBe(realKeychainsDir)

    // Someone re-pointed the graft between turns.
    rmSync(linkPath as string, { force: true })
    symlinkSync(decoy, linkPath as string)
    projectMuseKeychainAccessIfRequired(lease, authJsonText, {
      platform: 'darwin',
      realKeychainsDir
    })
    expect(readlinkSync(linkPath as string)).toBe(realKeychainsDir)
    lease.cleanup()
  })

  it('refuses to scrub through a root that is not the verified seat', () => {
    if (process.platform === 'win32') return
    // readdirSync FOLLOWS a symlink-to-directory and rmSync(recursive) deletes
    // THROUGH one, so a scrub that trusted its argument would turn a swapped
    // seat into a recursive delete of whatever the link points at. The
    // disposable lane cannot do this: there the destructive step is one rmSync
    // on the leaf, which merely unlinks the link.
    const victim = join(TEMP_ROOT, 'scrub-victim')
    mkdirSync(join(victim, 'precious'), { recursive: true })
    writeFileSync(join(victim, 'precious', 'keep.txt'), 'do not delete')
    const swapped = join(TEMP_ROOT, 'scrub-swapped-seat')
    symlinkSync(victim, swapped)

    const result = scrubMuseDurableSeatHome(swapped)
    expect(result.ok).toBe(false)
    expect(result.failures.join(' ')).toContain('refused')
    expect(readFileSync(join(victim, 'precious', 'keep.txt'), 'utf8')).toBe('do not delete')
  })

  it('refuses to scrub a real directory outside the seat root', () => {
    const outside = join(TEMP_ROOT, 'scrub-outside')
    mkdirSync(outside, { recursive: true, mode: 0o700 })
    writeFileSync(join(outside, 'keep.txt'), 'still here')
    const target = seat('containment')
    const lease = attach(target)

    // Same identity checks pass — it is a real 0700 directory owned by us —
    // but it is not inside the seat root this lease was issued against.
    const result = scrubMuseDurableSeatHome(outside, { boundaryRoot: target.boundaryRoot })
    expect(result.ok).toBe(false)
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
    lease.cleanup()
  })

  it('preserves the seat when creation fails after the home is established', () => {
    const target = seat('failure')
    const first = attach(target)
    seedProviderResidue(first)
    first.cleanup()

    // A skill-pin document that cannot be serialized fails the attach after
    // establishMuseDurableSeat has already run.
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => attach(target, { skillPinSettings: circular as never })).toThrow()

    expect(existsSync(target.path)).toBe(true)
    expect(existsSync(join(first.museDataDir, 'session-index.db'))).toBe(true)
  })
})
