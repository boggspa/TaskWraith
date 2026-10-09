import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  HostThreadPublicationGuard,
  threadPublicationAuthorityWitness,
  THREAD_PUBLICATION_BUSY,
  type HostThreadPublicationCommit,
  type HostThreadPublicationPermit
} from './HostThreadPublicationGuard'

const binding = { owner: null, isCurrent: () => true }

describe('inert thread publication permits', () => {
  it('off, commits once without consulting ownership', async () => {
    const guard = new HostThreadPublicationGuard(null)
    const current = vi.fn(() => false)
    const permit = guard.capture('thread', { owner: null, isCurrent: current })
    const commit = vi.fn(() => 42)
    expect(await guard.publish(permit, commit)).toEqual({ kind: 'published', value: 42 })
    expect(await guard.publish(permit, commit)).toEqual(THREAD_PUBLICATION_BUSY)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(current).not.toHaveBeenCalled()
  })

  it('rejects forged permits and permits from another guard', async () => {
    const first = new HostThreadPublicationGuard(null)
    const second = new HostThreadPublicationGuard(null)
    const commit = vi.fn()
    expect(await second.publish(first.capture('thread', binding), commit)).toEqual(
      THREAD_PUBLICATION_BUSY
    )
    expect(await second.publish({} as HostThreadPublicationPermit, commit)).toEqual(
      THREAD_PUBLICATION_BUSY
    )
    expect(commit).not.toHaveBeenCalled()
  })

  it('snapshots the grant even when its caller later mutates the input objects', async () => {
    const epoch = { host: 'before', grant: 1 }
    const owner = { writerId: 'original', epoch }
    const guard = new HostThreadPublicationGuard({
      async publishFullCopy(_threadId, captured, commit) {
        expect(captured.owner).toEqual({
          writerId: 'original',
          epoch: { host: 'before', grant: 1 }
        })
        return { kind: 'published', value: commit() }
      }
    })
    const permit = guard.capture('thread', { owner, isCurrent: () => true })
    owner.writerId = 'replacement'
    epoch.grant = 2
    epoch.host = 'after'
    expect(await guard.publish(permit, () => 'saved')).toEqual({
      kind: 'published',
      value: 'saved'
    })
  })

  it('consumes a refused permit before any retry or concurrent call', async () => {
    let finish!: () => void
    const waiting = new Promise<void>((resolve) => {
      finish = resolve
    })
    const decide = vi.fn(async () => {
      await waiting
      return THREAD_PUBLICATION_BUSY
    })
    const guard = new HostThreadPublicationGuard({ publishFullCopy: decide })
    const permit = guard.capture('thread', binding)
    const commit = vi.fn()
    const first = guard.publish(permit, commit)
    expect(await guard.publish(permit, commit)).toEqual(THREAD_PUBLICATION_BUSY)
    finish()
    expect(await first).toEqual(THREAD_PUBLICATION_BUSY)
    expect(decide).toHaveBeenCalledTimes(1)
    expect(commit).not.toHaveBeenCalled()
  })

  it('does not retry a throwing callback or report a thenable as committed', async () => {
    const guard = new HostThreadPublicationGuard(null)
    const permit = guard.capture('thread', binding)
    const commit = vi.fn(() => {
      throw new Error('CAS rejected')
    })
    await expect(guard.publish(permit, commit)).rejects.toThrow('CAS rejected')
    expect(await guard.publish(permit, commit)).toEqual(THREAD_PUBLICATION_BUSY)
    // Runtime assertion only: it cannot cancel effects in an arbitrary async callback.
    const dishonest = (() => Promise.resolve()) as unknown as HostThreadPublicationCommit<void>
    await expect(guard.publish(guard.capture('thread', binding), dishonest)).rejects.toThrow(
      'must be synchronous'
    )
    const _typeOnly = () => {
      // @ts-expect-error A concrete adoption callback must not be asynchronous.
      void guard.publish(guard.capture('thread', binding), async () => 1)
    }
    void _typeOnly
  })
})

describe('authority metadata witness', () => {
  const prefix = 'host-publication-witness-'
  function fixture(run: (profile: string, file: string) => void): void {
    const profile = mkdtempSync(path.join(os.tmpdir(), prefix))
    if (
      path.dirname(profile) !== os.tmpdir() ||
      !path.basename(profile).startsWith(prefix) ||
      path.basename(profile).length <= prefix.length
    ) {
      throw new Error('Not a fixture folder')
    }
    try {
      mkdirSync(path.join(profile, 'thread-authority'))
      run(profile, path.join(profile, 'thread-authority', 'thread.json'))
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  }

  it('accepts stable regular files and stable absence', () =>
    fixture((profile, file) => {
      expect(threadPublicationAuthorityWitness(profile, 'thread')()).toBe(true)
      writeFileSync(file, 'authority')
      expect(threadPublicationAuthorityWitness(profile, 'thread')()).toBe(true)
    }))

  it.each(['replace', 'resize', 'delete', 'metadata'] as const)(
    'rejects %s after capture',
    (change) =>
      fixture((profile, file) => {
        writeFileSync(file, 'authority')
        const unchanged = threadPublicationAuthorityWitness(profile, 'thread')
        if (change === 'replace') {
          writeFileSync(file + '.tmp', 'authority')
          renameSync(file + '.tmp', file)
        } else if (change === 'resize') {
          // This is a metadata witness for atomic protocol writes. Equal-size
          // in-place writes can retain the same timestamp on Windows.
          writeFileSync(file, 'authority with a changed size')
        } else if (change === 'delete') unlinkSync(file)
        else utimesSync(file, new Date(0), new Date(0))
        expect(unchanged()).toBe(false)
      })
  )

  it('rejects a name created after capture', () =>
    fixture((profile, file) => {
      const unchanged = threadPublicationAuthorityWitness(profile, 'thread')
      writeFileSync(file, 'authority')
      expect(unchanged()).toBe(false)
    }))

  it('rejects directories, symlinks and unreadable metadata', () =>
    fixture((profile, file) => {
      mkdirSync(file)
      expect(threadPublicationAuthorityWitness(profile, 'thread')()).toBe(false)
      const target = path.join(profile, 'target')
      writeFileSync(target, 'authority')
      symlinkSync(target, path.join(profile, 'thread-authority', 'link.json'))
      expect(threadPublicationAuthorityWitness(profile, 'link')()).toBe(false)
      // ENOTDIR is a portable unreadable-path case, even when running with elevated privileges.
      expect(threadPublicationAuthorityWitness(target, 'thread')()).toBe(false)
    }))
})
