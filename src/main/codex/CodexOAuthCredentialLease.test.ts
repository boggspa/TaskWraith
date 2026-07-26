import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CodexOAuthCredentialAuthority,
  acquireCodexOAuthCredentialLease
} from './CodexOAuthCredentialLease'
import { taskWraithCodexHomePath } from './CodexHome'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function authCredential(refresh: string, lastRefresh = '2026-07-26T00:00:00Z'): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { refresh_token: refresh, account_id: 'acct' },
    last_refresh: lastRefresh
  })
}

async function fixture(refresh = 'R0'): Promise<{ userDataPath: string; sourceHome: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'tw-codex-lease-'))
  roots.push(root)
  await fs.chmod(root, 0o700)
  const userDataPath = join(root, 'userData')
  const sourceHome = join(root, 'dot-codex')
  await fs.mkdir(taskWraithCodexHomePath(userDataPath), { recursive: true, mode: 0o700 })
  await fs.mkdir(sourceHome, { recursive: true, mode: 0o700 })
  await fs.writeFile(join(sourceHome, 'auth.json'), authCredential(refresh), { mode: 0o600 })
  return { userDataPath, sourceHome }
}

describe('acquireCodexOAuthCredentialLease', () => {
  it('seeds the user credential into the private home without moving it', async () => {
    const { userDataPath, sourceHome } = await fixture()
    const result = await acquireCodexOAuthCredentialLease({ userDataPath, sourceHome })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    await result.lease.seedIntoIsolatedHome()

    const privateHome = taskWraithCodexHomePath(userDataPath)
    expect(await fs.readFile(join(privateHome, 'auth.json'), 'utf8')).toBe(authCredential('R0'))
    // Borrowed, not taken — the user's CLI and ChatGPT app keep working.
    expect(await fs.readFile(join(sourceHome, 'auth.json'), 'utf8')).toBe(authCredential('R0'))
    await result.lease.commitAndRelease()
  })

  it('commits a rotated token back so ~/.codex does not go stale', async () => {
    // The whole point of leasing instead of copying: ChatGPT OAuth rotates its
    // refresh token on use, so a rotation TaskWraith performs must land back in
    // the user's home or their own app is next to be revoked.
    const { userDataPath, sourceHome } = await fixture('R0')
    const result = await acquireCodexOAuthCredentialLease({ userDataPath, sourceHome })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await result.lease.seedIntoIsolatedHome()

    const privateHome = taskWraithCodexHomePath(userDataPath)
    // Codex stamps freshness as an ISO `last_refresh`, and the authority
    // refuses a writeback that does not advance it — so a real rotation must
    // move it forward.
    await fs.writeFile(
      join(privateHome, 'auth.json'),
      authCredential('R1', '2026-07-26T01:00:00Z'),
      { mode: 0o600 }
    )

    expect(await result.lease.commitAndRelease()).toBe('rotated')
    expect(await fs.readFile(join(sourceHome, 'auth.json'), 'utf8')).toBe(
      authCredential('R1', '2026-07-26T01:00:00Z')
    )
  })

  it('reports unchanged when no rotation happened', async () => {
    const { userDataPath, sourceHome } = await fixture()
    const result = await acquireCodexOAuthCredentialLease({ userDataPath, sourceHome })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await result.lease.seedIntoIsolatedHome()
    expect(await result.lease.commitAndRelease()).toBe('unchanged')
  })

  it('refuses a second concurrent borrower rather than racing the rotation', async () => {
    // Two live holders of one rotating refresh token is exactly the failure
    // this replaces; the second must be told to wait, not handed a copy.
    const { userDataPath, sourceHome } = await fixture()
    const first = await acquireCodexOAuthCredentialLease({
      userDataPath,
      sourceHome,
      authority: new CodexOAuthCredentialAuthority({ pid: 4001, instanceId: 'a' })
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = await acquireCodexOAuthCredentialLease({
      userDataPath,
      sourceHome,
      authority: new CodexOAuthCredentialAuthority({
        pid: 4002,
        instanceId: 'b',
        isProcessAlive: (pid) => pid === 4001
      })
    })
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.reason).toBe('busy')

    await first.lease.commitAndRelease()
  })

  it('says the credential is unavailable when the user has never signed in', async () => {
    const { userDataPath, sourceHome } = await fixture()
    await fs.rm(join(sourceHome, 'auth.json'))

    const result = await acquireCodexOAuthCredentialLease({ userDataPath, sourceHome })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toMatch(/unavailable|could not/i)
  })

  it('uses only auth.json — Codex keeps its whole grant in one file', async () => {
    // A layout that seeded extra artefacts would copy unrelated Codex state
    // (sessions, config, history) into the private home, which is precisely the
    // containment this feature must not quietly discard.
    const { userDataPath, sourceHome } = await fixture()
    await fs.writeFile(join(sourceHome, 'config.toml'), 'model = "gpt-5.5"', { mode: 0o600 })
    await fs.mkdir(join(sourceHome, 'sessions'), { recursive: true, mode: 0o700 })

    const result = await acquireCodexOAuthCredentialLease({ userDataPath, sourceHome })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await result.lease.seedIntoIsolatedHome()

    const privateHome = taskWraithCodexHomePath(userDataPath)
    const seeded = await fs.readdir(privateHome)
    expect(seeded).toContain('auth.json')
    expect(seeded).not.toContain('config.toml')
    expect(seeded).not.toContain('sessions')
    await result.lease.commitAndRelease()
  })
})
