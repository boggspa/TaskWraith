/**
 * The port is tested against a file system whose calls complete only when the
 * test lets them, to place requests around a sync that has or has not started,
 * and against real files for what the operating system itself must do.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createThreadDurabilityDebt } from './ThreadDurabilityDebt'
import {
  THREAD_DURABILITY_SYNCS_IN_FLIGHT,
  createThreadDurabilityDebtFs,
  type ThreadDurabilityDebtFsCalls
} from './ThreadDurabilityDebtFs'

/**
 * The prefix of every folder this file makes in the system's temporary folder.
 * A folder is removed only through the function below, which refuses anything
 * that is not one of them.
 */
const TEMPORARY_PREFIX = 'log-durability-port-'

/** Remove, with all it holds, a folder made here by `mkdtempSync` with TEMPORARY_PREFIX. */
function removeTemporaryDirectory(directory: string): void {
  const temporary = os.tmpdir()
  const made = temporary + path.sep + TEMPORARY_PREFIX
  if (
    directory === temporary ||
    !directory.startsWith(made) ||
    directory.length <= made.length ||
    path.dirname(directory) !== temporary
  )
    throw new Error(`Refusing to remove ${directory}: not a folder this file made`)
  fs.rmSync(directory, { recursive: true, force: true })
}

type Done = (error: NodeJS.ErrnoException | null) => void

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: injected`), { code })
}

/** File calls that are recorded and complete only when the test says. */
class HeldCalls implements ThreadDurabilityDebtFsCalls {
  readonly constants = { O_RDONLY: 0, O_RDWR: 2 }
  /** Every call made, in order: `open <path> <flags>`, `fsync <path>`, `close <path>`. */
  log: string[] = []
  /** What `open` answers for a path; a path not listed opens. */
  openFailures = new Map<string, string>()
  private nextFd = 100
  private paths = new Map<number, string>()
  private syncs: Array<{ path: string; done: Done }> = []
  private closes: Array<{ path: string; done: Done }> = []

  open(
    target: string,
    flags: number,
    callback: (error: NodeJS.ErrnoException | null, fd: number) => void
  ): void {
    this.log.push(`open ${target} ${flags}`)
    const code = this.openFailures.get(target)
    if (code) {
      queueMicrotask(() => callback(failure(code), -1))
      return
    }
    const fd = this.nextFd
    this.nextFd += 1
    this.paths.set(fd, target)
    queueMicrotask(() => callback(null, fd))
  }

  fsync(fd: number, callback: Done): void {
    const target = this.paths.get(fd)!
    this.log.push(`fsync ${target}`)
    this.syncs.push({ path: target, done: callback })
  }

  close(fd: number, callback: Done): void {
    const target = this.paths.get(fd)!
    this.log.push(`close ${target}`)
    this.paths.delete(fd)
    this.closes.push({ path: target, done: callback })
  }

  openDescriptors(): number {
    return this.paths.size
  }

  syncing(): string[] {
    return this.syncs.map((sync) => sync.path)
  }

  /** Let the sync of a path finish, then its close. */
  async finish(
    target: string,
    syncError: string | null = null,
    closeError: string | null = null
  ): Promise<void> {
    const index = this.syncs.findIndex((sync) => sync.path === target)
    if (index < 0) throw new Error(`no sync of ${target} is in flight`)
    this.syncs.splice(index, 1)[0].done(syncError ? failure(syncError) : null)
    const closing = this.closes.findIndex((close) => close.path === target)
    this.closes.splice(closing, 1)[0].done(closeError ? failure(closeError) : null)
    await settle()
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function watch<T>(promise: Promise<T>): { state: string } {
  const seen = { state: 'waiting' }
  promise.then(
    (value) => {
      seen.state = String(value)
    },
    (error: NodeJS.ErrnoException) => {
      seen.state = `rejected ${error.code}`
    }
  )
  return seen
}

describe('thread durability port', () => {
  let calls: HeldCalls

  beforeEach(() => {
    calls = new HeldCalls()
  })

  describe('one sync', () => {
    it('opens the path for reading, syncs it and closes it', async () => {
      const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin' })
      const file = watch(port.syncFile('/p/a.jsonl'))
      await settle()
      expect(calls.log).toEqual(['open /p/a.jsonl 0', 'fsync /p/a.jsonl'])
      expect(file.state).toBe('waiting')

      await calls.finish('/p/a.jsonl')
      expect(calls.log).toEqual(['open /p/a.jsonl 0', 'fsync /p/a.jsonl', 'close /p/a.jsonl'])
      expect(file.state).toBe('synced')
      expect(calls.openDescriptors()).toBe(0)
    })

    it('syncs a directory the same way', async () => {
      const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin' })
      const directory = watch(port.syncDirectory('/p'))
      await settle()
      await calls.finish('/p')
      expect(calls.log).toEqual(['open /p 0', 'fsync /p', 'close /p'])
      expect(directory.state).toBe('synced')
    })

    it('makes no file call before it returns', () => {
      const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin' })
      const pending = port.syncFile('/p/a.jsonl')
      // The open has been asked for, and nothing has been waited on.
      expect(calls.log).toEqual(['open /p/a.jsonl 0'])
      expect(pending).toBeInstanceOf(Promise)
    })
  })

  describe('what settles a request and what fails it', () => {
    it('settles a path with nothing at it as missing, file or directory', async () => {
      calls.openFailures.set('/p/gone.jsonl', 'ENOENT')
      calls.openFailures.set('/p/gone', 'ENOENT')
      const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin' })
      const file = watch(port.syncFile('/p/gone.jsonl'))
      const directory = watch(port.syncDirectory('/p/gone'))
      await settle()
      expect([file.state, directory.state]).toEqual(['missing', 'missing'])
      expect(calls.log).toEqual(['open /p/gone.jsonl 0', 'open /p/gone 0'])
    })

    it.each(['EACCES', 'EMFILE', 'ENOTDIR', 'EIO'])(
      'rejects when the open fails with %s',
      async (code) => {
        calls.openFailures.set('/p/a.jsonl', code)
        const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin' })
        const file = watch(port.syncFile('/p/a.jsonl'))
        await settle()
        expect(file.state).toBe(`rejected ${code}`)
      }
    )

    it('rejects when the sync fails, and still closes the descriptor', async () => {
      const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin' })
      const file = watch(port.syncFile('/p/a.jsonl'))
      await settle()
      await calls.finish('/p/a.jsonl', 'EIO')
      expect(file.state).toBe('rejected EIO')
      expect(calls.log.at(-1)).toBe('close /p/a.jsonl')
      expect(calls.openDescriptors()).toBe(0)
    })

    it('rejects when only the close fails', async () => {
      const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin' })
      const file = watch(port.syncFile('/p/a.jsonl'))
      await settle()
      await calls.finish('/p/a.jsonl', null, 'EIO')
      expect(file.state).toBe('rejected EIO')
    })

    it.each(['EINVAL', 'ENOTSUP', 'ENOSYS'])(
      'settles a directory whose file system does not offer the sync (%s)',
      async (code) => {
        const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'linux' })
        const directory = watch(port.syncDirectory('/p'))
        const file = watch(port.syncFile('/p/a.jsonl'))
        await settle()
        await calls.finish('/p', code)
        await calls.finish('/p/a.jsonl', code)
        // A file must be synced; only a directory may go without.
        expect([directory.state, file.state]).toEqual(['synced', `rejected ${code}`])
      }
    )

    it('rejects a directory sync that fails for any other reason', async () => {
      const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'linux' })
      const directory = watch(port.syncDirectory('/p'))
      await settle()
      await calls.finish('/p', 'EIO')
      expect(directory.state).toBe('rejected EIO')
    })

    it('settles a directory on Windows without a call, and opens a file there for writing', async () => {
      const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'win32' })
      const directory = watch(port.syncDirectory('C:\\p'))
      const file = watch(port.syncFile('C:\\p\\a.jsonl'))
      await settle()
      expect(directory.state).toBe('synced')
      expect(calls.log).toEqual(['open C:\\p\\a.jsonl 2', 'fsync C:\\p\\a.jsonl'])
      await calls.finish('C:\\p\\a.jsonl')
      expect(file.state).toBe('synced')
    })
  })

  describe('how many run at once', () => {
    it('keeps to the limit and starts the rest in the order they were asked for', async () => {
      const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin', maxInFlight: 2 })
      const names = ['a', 'b', 'c', 'd', 'e'].map((name) => `/p/${name}`)
      const watched = names.map((name) => watch(port.syncFile(name)))
      await settle()
      expect(calls.syncing()).toEqual(['/p/a', '/p/b'])
      expect(port.snapshot()).toEqual({
        started: 2,
        inFlight: 2,
        queued: 3,
        joined: 0,
        peakInFlight: 2,
        queuedUrgent: 0,
        queuedNormal: 3,
        startedUrgent: 0,
        promoted: 0,
        fairStarts: 0,
        urgencies: 0
      })

      await calls.finish('/p/b')
      expect(calls.syncing()).toEqual(['/p/a', '/p/c'])
      await calls.finish('/p/a')
      await calls.finish('/p/c')
      expect(calls.syncing()).toEqual(['/p/d', '/p/e'])
      await calls.finish('/p/d')
      await calls.finish('/p/e')

      expect(watched.map((each) => each.state)).toEqual(names.map(() => 'synced'))
      expect(port.snapshot()).toEqual({
        started: 5,
        inFlight: 0,
        queued: 0,
        joined: 0,
        peakInFlight: 2,
        queuedUrgent: 0,
        queuedNormal: 0,
        startedUrgent: 0,
        promoted: 0,
        fairStarts: 0,
        urgencies: 0
      })
    })

    it('keeps going after a sync fails', async () => {
      const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin', maxInFlight: 1 })
      const first = watch(port.syncFile('/p/a'))
      const second = watch(port.syncFile('/p/b'))
      await settle()
      await calls.finish('/p/a', 'EIO')
      expect(calls.syncing()).toEqual(['/p/b'])
      await calls.finish('/p/b')
      expect([first.state, second.state]).toEqual(['rejected EIO', 'synced'])
    })

    it('runs two at once unless told otherwise', async () => {
      expect(THREAD_DURABILITY_SYNCS_IN_FLIGHT).toBe(2)
      const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin' })
      for (const name of ['a', 'b', 'c']) void port.syncFile(`/p/${name}`)
      await settle()
      expect(port.snapshot()).toMatchObject({ inFlight: 2, queued: 1 })
    })

    it.each([0, -1, 1.5, Number.NaN])('refuses a limit of %s', (maxInFlight) => {
      expect(() => createThreadDurabilityDebtFs({ fs: calls, maxInFlight })).toThrow(RangeError)
    })
  })

  describe('requests for the same path', () => {
    it('join a sync that has not started, and get what it gets', async () => {
      const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin', maxInFlight: 1 })
      const busy = watch(port.syncFile('/p/busy'))
      const first = watch(port.syncDirectory('/p'))
      const second = watch(port.syncDirectory('/p'))
      const third = watch(port.syncDirectory('/p'))
      await settle()
      expect(port.snapshot()).toMatchObject({ started: 1, queued: 1, joined: 2 })

      await calls.finish('/p/busy')
      await calls.finish('/p', 'EIO')
      expect(busy.state).toBe('synced')
      expect([first.state, second.state, third.state]).toEqual([
        'rejected EIO',
        'rejected EIO',
        'rejected EIO'
      ])
      expect(calls.log.filter((entry) => entry === 'fsync /p')).toHaveLength(1)
    })

    it('do not join a sync that has started: it may have begun before the later write', async () => {
      const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'darwin', maxInFlight: 1 })
      const first = watch(port.syncFile('/p/a'))
      await settle()
      expect(calls.syncing()).toEqual(['/p/a'])

      const second = watch(port.syncFile('/p/a'))
      const third = watch(port.syncFile('/p/a'))
      await calls.finish('/p/a')
      expect([first.state, second.state, third.state]).toEqual(['synced', 'waiting', 'waiting'])

      await calls.finish('/p/a')
      expect([second.state, third.state]).toEqual(['synced', 'synced'])
      expect(calls.log.filter((entry) => entry === 'fsync /p/a')).toHaveLength(2)
      expect(port.snapshot()).toMatchObject({ started: 2, joined: 1 })
    })

    it('keep a file and a directory of the same name apart', async () => {
      const port = createThreadDurabilityDebtFs({ fs: calls, platform: 'linux', maxInFlight: 1 })
      void port.syncFile('/p/busy')
      const file = watch(port.syncFile('/p/x'))
      const directory = watch(port.syncDirectory('/p/x'))
      await settle()
      expect(port.snapshot()).toMatchObject({ queued: 2, joined: 0 })

      // What a directory may go without, a file may not.
      await calls.finish('/p/busy')
      await calls.finish('/p/x', 'EINVAL')
      await calls.finish('/p/x', 'EINVAL')
      expect([file.state, directory.state]).toEqual(['rejected EINVAL', 'synced'])
    })
  })
})

describe('thread durability port on real files', () => {
  let directory: string

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_PREFIX))
  })

  afterEach(() => {
    removeTemporaryDirectory(directory)
  })

  it('syncs a file and its directory, and finds a missing path missing', async () => {
    const file = path.join(directory, 'chat-1.mutations.jsonl')
    fs.writeFileSync(file, 'a line\n')
    const port = createThreadDurabilityDebtFs()

    await expect(port.syncFile(file)).resolves.toBe('synced')
    await expect(port.syncDirectory(directory)).resolves.toBe('synced')
    await expect(port.syncFile(path.join(directory, 'never-written'))).resolves.toBe('missing')
    // A directory is not looked at on Windows, where it cannot be synced.
    await expect(port.syncDirectory(path.join(directory, 'never-made'))).resolves.toBe(
      process.platform === 'win32' ? 'synced' : 'missing'
    )
    expect(fs.readFileSync(file, 'utf8')).toBe('a line\n')
    expect(port.snapshot()).toMatchObject({ inFlight: 0, queued: 0, joined: 0 })
  })

  it('pays a thread barrier: every file, then the directory, and a file removed meanwhile', async () => {
    const port = createThreadDurabilityDebtFs()
    const debt = createThreadDurabilityDebt({ port })
    const files = ['journal', 'run-events', 'detail'].map((name) =>
      path.join(directory, `${name}.jsonl`)
    )
    for (const file of files) fs.writeFileSync(file, 'written, not synced\n')
    debt.note('chat-1', { file: files[0], owner: 'journal' })
    debt.note('chat-1', { file: files[1], owner: 'run-events' })
    debt.note('chat-1', { file: files[2], owner: 'detail' })
    debt.note('chat-1', { directory })
    fs.unlinkSync(files[2])

    await expect(debt.barrier('chat-1')).resolves.toBeUndefined()

    expect(debt.snapshot().owners).toMatchObject({
      journal: { synced: 1, missing: 0, failed: 0 },
      'run-events': { synced: 1, missing: 0, failed: 0 },
      detail: { synced: 0, missing: 1, failed: 0 },
      directory: { synced: 1, missing: 0, failed: 0 }
    })
    expect(debt.snapshot().owed).toEqual({ threads: 0, files: 0, directories: 0 })
  })
})
