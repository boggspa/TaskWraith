import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ensureTaskWraithCodexHome,
  ensureTaskWraithCodexHomeForLaunch,
  ensureTaskWraithCodexHomeForProtectedRead,
  migrateLinkedCodexRollout,
  taskWraithCodexHomePath,
  withTaskWraithCodexHomeEnv
} from './CodexHome'

const THREAD_ID = '7b057c8b-33fa-4eca-9efe-3313a83669f4'

async function fixtureRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'taskwraith-codex-home-'))
}

function rollout(originator = 'taskwraith', id = THREAD_ID): string {
  return `${JSON.stringify({
    timestamp: '2026-07-24T12:00:00.000Z',
    type: 'session_meta',
    payload: { id, originator }
  })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } })}\n`
}

describe('TaskWraith Codex home', () => {
  it('resolves a stable direct CODEX_HOME and forces it over inherited/profile values', async () => {
    const root = await fixtureRoot()
    const codexHome = taskWraithCodexHomePath(root)

    expect(codexHome).toBe(join(root, 'codex-home'))
    expect(
      withTaskWraithCodexHomeEnv(
        { PATH: '/usr/bin', CODEX_HOME: '/shared-or-profile-home' },
        codexHome
      )
    ).toMatchObject({
      PATH: '/usr/bin',
      CODEX_HOME: codexHome
    })
    await expect(ensureTaskWraithCodexHome(codexHome)).resolves.toBe(codexHome)
    await expect(ensureTaskWraithCodexHome(codexHome)).resolves.toBe(codexHome)
  })

  it('rejects a symlink as the private home', async () => {
    const root = await fixtureRoot()
    const target = join(root, 'target')
    const linked = join(root, 'codex-home')
    await mkdir(target)
    await symlink(target, linked)

    await expect(ensureTaskWraithCodexHome(linked)).rejects.toThrow(/not a symlink/i)
  })

  it('rejects symlinks in protected Codex state before launch', async () => {
    const root = await fixtureRoot()
    const codexHome = join(root, 'codex-home')
    const outside = join(root, 'outside')
    await mkdir(codexHome)
    await mkdir(outside)
    await symlink(outside, join(codexHome, 'sessions'))

    await expect(ensureTaskWraithCodexHomeForLaunch(codexHome)).rejects.toThrow(
      /symlink.*sessions/i
    )
  })

  it('rejects a protected auth/config symlink without scanning unrelated plugin state', async () => {
    const root = await fixtureRoot()
    const codexHome = join(root, 'codex-home')
    const outside = join(root, 'outside-auth.json')
    await mkdir(codexHome)
    await writeFile(outside, '{}')
    await symlink(outside, join(codexHome, 'auth.json'))

    await expect(
      ensureTaskWraithCodexHomeForProtectedRead(codexHome, ['auth.json', 'config.toml'])
    ).rejects.toThrow(/symlink.*auth\.json/i)
  })

  it('rejects nested rollout-directory symlinks before launch', async () => {
    const root = await fixtureRoot()
    const codexHome = join(root, 'codex-home')
    const sessions = join(codexHome, 'sessions')
    const outside = join(root, 'outside')
    await mkdir(sessions, { recursive: true })
    await mkdir(outside)
    await symlink(outside, join(sessions, '2026'))

    await expect(ensureTaskWraithCodexHomeForLaunch(codexHome)).rejects.toThrow(
      /symlink.*sessions.*2026/i
    )
  })

  it('copies only the linked TaskWraith rollout and is idempotent', async () => {
    const root = await fixtureRoot()
    const legacyHome = join(root, 'legacy')
    const codexHome = join(root, 'owned')
    const sourceDir = join(legacyHome, 'sessions', '2026', '07', '24')
    const source = join(sourceDir, `rollout-2026-07-24T12-00-00-${THREAD_ID}.jsonl`)
    await mkdir(sourceDir, { recursive: true })
    await writeFile(source, rollout())

    await expect(
      migrateLinkedCodexRollout({ threadId: THREAD_ID, codexHome, legacyCodexHome: legacyHome })
    ).resolves.toBe('migrated')
    const destination = join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '24',
      `rollout-2026-07-24T12-00-00-${THREAD_ID}.jsonl`
    )
    await expect(readFile(destination, 'utf8')).resolves.toBe(rollout())
    await expect(
      migrateLinkedCodexRollout({
        threadId: `urn:uuid:${THREAD_ID}`,
        codexHome,
        legacyCodexHome: legacyHome
      })
    ).resolves.toBe('already-present')
  })

  it('refuses to import a Codex Desktop rollout', async () => {
    const root = await fixtureRoot()
    const legacyHome = join(root, 'legacy')
    const sourceDir = join(legacyHome, 'sessions')
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, `rollout-2026-07-24T12-00-00-${THREAD_ID}.jsonl`), rollout('Codex Desktop'))

    await expect(
      migrateLinkedCodexRollout({
        threadId: THREAD_ID,
        codexHome: join(root, 'owned'),
        legacyCodexHome: legacyHome
      })
    ).resolves.toBe('not-taskwraith')
  })

  it('publishes one complete rollout when concurrent migrations race', async () => {
    const root = await fixtureRoot()
    const legacyHome = join(root, 'legacy')
    const codexHome = join(root, 'owned')
    const sourceDir = join(legacyHome, 'sessions', '2026', '07', '24')
    const filename = `rollout-2026-07-24T12-00-00-${THREAD_ID}.jsonl`
    await mkdir(sourceDir, { recursive: true })
    await writeFile(join(sourceDir, filename), rollout())

    const results = await Promise.all([
      migrateLinkedCodexRollout({ threadId: THREAD_ID, codexHome, legacyCodexHome: legacyHome }),
      migrateLinkedCodexRollout({ threadId: THREAD_ID, codexHome, legacyCodexHome: legacyHome })
    ])

    expect(results.sort()).toEqual(['already-present', 'migrated'])
    const destinationDir = join(codexHome, 'sessions', '2026', '07', '24')
    await expect(readFile(join(destinationDir, filename), 'utf8')).resolves.toBe(rollout())
    expect((await readdir(destinationDir)).filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  })

  it('repairs a partial destination left by a pre-atomic migration', async () => {
    const root = await fixtureRoot()
    const legacyHome = join(root, 'legacy')
    const codexHome = join(root, 'owned')
    const relativeDir = join('sessions', '2026', '07', '24')
    const filename = `rollout-2026-07-24T12-00-00-${THREAD_ID}.jsonl`
    await mkdir(join(legacyHome, relativeDir), { recursive: true })
    await mkdir(join(codexHome, relativeDir), { recursive: true })
    await writeFile(join(legacyHome, relativeDir, filename), rollout())
    await writeFile(join(codexHome, relativeDir, filename), '{"type":"partial"}')

    await expect(
      migrateLinkedCodexRollout({ threadId: THREAD_ID, codexHome, legacyCodexHome: legacyHome })
    ).resolves.toBe('migrated')
    await expect(readFile(join(codexHome, relativeDir, filename), 'utf8')).resolves.toBe(rollout())
  })

  it('serializes concurrent repair of the same partial destination', async () => {
    const root = await fixtureRoot()
    const legacyHome = join(root, 'legacy')
    const codexHome = join(root, 'owned')
    const relativeDir = join('sessions', '2026', '07', '24')
    const filename = `rollout-2026-07-24T12-00-00-${THREAD_ID}.jsonl`
    await mkdir(join(legacyHome, relativeDir), { recursive: true })
    await mkdir(join(codexHome, relativeDir), { recursive: true })
    await writeFile(join(legacyHome, relativeDir, filename), rollout())
    await writeFile(join(codexHome, relativeDir, filename), '{"type":"partial"}')

    const results = await Promise.all([
      migrateLinkedCodexRollout({ threadId: THREAD_ID, codexHome, legacyCodexHome: legacyHome }),
      migrateLinkedCodexRollout({ threadId: THREAD_ID, codexHome, legacyCodexHome: legacyHome })
    ])

    expect(results.sort()).toEqual(['already-present', 'migrated'])
    await expect(readFile(join(codexHome, relativeDir, filename), 'utf8')).resolves.toBe(rollout())
  })

  it('searches prior runtime-profile homes before the default shared home', async () => {
    const root = await fixtureRoot()
    const unrelatedHome = join(root, 'unrelated')
    const profileHome = join(root, 'profile-home')
    const codexHome = join(root, 'owned')
    const filename = `rollout-2026-07-24T12-00-00-${THREAD_ID}.jsonl`
    await mkdir(join(unrelatedHome, 'sessions'), { recursive: true })
    await mkdir(join(profileHome, 'sessions'), { recursive: true })
    await writeFile(join(unrelatedHome, 'sessions', filename), rollout('Codex Desktop'))
    await writeFile(join(profileHome, 'sessions', filename), rollout())

    await expect(
      migrateLinkedCodexRollout({
        threadId: THREAD_ID,
        codexHome,
        legacyCodexHomes: [unrelatedHome, profileHome]
      })
    ).resolves.toBe('migrated')
  })
})
