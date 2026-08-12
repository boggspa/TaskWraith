import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  MUSE_EMPTY_TRUST_DOCUMENT,
  MUSE_PROBE_ENV_ALLOWLIST,
  createMuseIsolatedHome,
  museLaunchEnvPathsStayInsideLease,
  projectMuseAuthJson,
  verifyMuseIsolatedHome,
  type MuseIsolatedHomeLease
} from './MuseIsolatedHome'
import { MUSE_LISTABLE_BUNDLED_SKILL_NAMES, museBundledSkillUri } from './MuseSkillPin'

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
