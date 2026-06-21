import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LaunchAttemptStore } from './LaunchAttemptStore'
import type { LaunchAttempt } from './types'

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-store-'))
  return path.join(dir, 'launch-attempts.json')
}

function attempt(overrides: Partial<LaunchAttempt> = {}): LaunchAttempt {
  return {
    schemaVersion: 1,
    id: overrides.id || 'attempt-1',
    targetId: 'target-1',
    targetLabel: 'npm run dev',
    targetSource: 'package-script',
    targetKind: 'dev-server',
    targetSnapshot: {
      id: 'target-1',
      label: 'npm run dev',
      subtitle: 'package.json',
      workspacePath: '/ws',
      source: 'package-script',
      kind: 'dev-server',
      platform: 'web',
      confidence: 0.9,
      evidence: [],
      blockers: []
    },
    targetSnapshotHash: 'hash',
    provider: 'codex',
    workspacePath: '/ws',
    cwd: '/ws',
    commandRaw: 'npm run dev',
    argv: ['npm', 'run', 'dev'],
    status: 'running',
    startedAt: '2026-06-21T11:00:00.000Z',
    updatedAt: '2026-06-21T11:00:00.000Z',
    outputTail: '',
    outputTailBytes: 0,
    outputTruncated: false,
    ...overrides
  }
}

describe('LaunchAttemptStore', () => {
  it('round-trips records and serves reads from memory, sorted newest-first', async () => {
    const store = new LaunchAttemptStore(await tempFile())
    store.save(attempt({ id: 'a', updatedAt: '2026-06-21T11:00:00.000Z' }))
    store.save(attempt({ id: 'b', updatedAt: '2026-06-21T12:00:00.000Z' }))

    expect(store.get('a')?.id).toBe('a')
    expect(store.list().map((item) => item.id)).toEqual(['b', 'a'])
  })

  it('persists save/update synchronously so a fresh instance observes them', async () => {
    const storagePath = await tempFile()
    const store = new LaunchAttemptStore(storagePath)
    store.save(attempt({ id: 'a', status: 'starting' }))
    store.update('a', { status: 'running', pid: 1234 })

    const fresh = new LaunchAttemptStore(storagePath)
    expect(fresh.get('a')).toMatchObject({ status: 'running', pid: 1234 })
  })

  it('coalesces output writes but persists them on the next synchronous flush', async () => {
    const storagePath = await tempFile()
    const store = new LaunchAttemptStore(storagePath)
    store.save(attempt({ id: 'a', status: 'running' }))

    // Output append updates memory immediately...
    store.appendOutputState('a', { outputTail: 'ready on http://localhost:5173\n' })
    expect(store.get('a')?.outputTail).toBe('ready on http://localhost:5173\n')

    // ...but is not yet on disk (debounced).
    expect(new LaunchAttemptStore(storagePath).get('a')?.outputTail).toBe('')

    // A status transition flushes the whole cache, including buffered output.
    store.update('a', { status: 'stopped' })
    const fresh = new LaunchAttemptStore(storagePath)
    expect(fresh.get('a')).toMatchObject({
      status: 'stopped',
      outputTail: 'ready on http://localhost:5173\n'
    })
  })

  it('flushNow forces a pending output write to disk', async () => {
    const storagePath = await tempFile()
    const store = new LaunchAttemptStore(storagePath)
    store.save(attempt({ id: 'a', status: 'running' }))
    store.appendOutputState('a', { outputTail: 'line\n' })

    expect(new LaunchAttemptStore(storagePath).get('a')?.outputTail).toBe('')
    store.flushNow()
    expect(new LaunchAttemptStore(storagePath).get('a')?.outputTail).toBe('line\n')
  })

  it('recovers active attempts as interrupted and persists the transition', async () => {
    const storagePath = await tempFile()
    const store = new LaunchAttemptStore(storagePath)
    store.save(attempt({ id: 'a', status: 'running' }))

    const recovered = store.recoverInterrupted('2026-06-21T12:00:00.000Z')

    expect(recovered.map((item) => item.id)).toEqual(['a'])
    expect(new LaunchAttemptStore(storagePath).get('a')).toMatchObject({
      status: 'interrupted',
      endedAt: '2026-06-21T12:00:00.000Z'
    })
  })

  it('caps retained terminal attempts while keeping every active one', async () => {
    const store = new LaunchAttemptStore(await tempFile())
    // One active attempt that must always survive.
    store.save(attempt({ id: 'active', status: 'running' }))
    // 60 terminal attempts, increasing recency.
    for (let i = 0; i < 60; i += 1) {
      const stamp = `2026-06-21T13:${String(i).padStart(2, '0')}:00.000Z`
      store.save(
        attempt({ id: `done-${i}`, status: 'stopped', startedAt: stamp, updatedAt: stamp })
      )
    }

    const ids = store.list().map((item) => item.id)
    const terminalIds = ids.filter((id) => id !== 'active')
    expect(ids).toContain('active')
    expect(terminalIds).toHaveLength(50)
    // Oldest terminal attempts are dropped; newest are kept.
    expect(terminalIds).toContain('done-59')
    expect(terminalIds).not.toContain('done-0')
  })

  it('ignores malformed records on disk', async () => {
    const storagePath = await tempFile()
    await fs.mkdir(path.dirname(storagePath), { recursive: true })
    await fs.writeFile(
      storagePath,
      JSON.stringify([{ id: 'bad' }, attempt({ id: 'good' })]),
      'utf8'
    )

    const store = new LaunchAttemptStore(storagePath)
    expect(store.list().map((item) => item.id)).toEqual(['good'])
  })
})
