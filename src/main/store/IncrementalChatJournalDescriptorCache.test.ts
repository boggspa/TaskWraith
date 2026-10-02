import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import { IncrementalChatJournalDescriptorCache } from './IncrementalChatJournalDescriptorCache'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
function fixture(write?: (fd: number, bytes: Buffer) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-fd-'))
  roots.push(root)
  const syncs: string[] = []
  const pending: Array<() => void> = []
  const flusher = new MainDurabilityFlusher({
    now: () => 0,
    setTimer: () => 0,
    clearTimer: () => {},
    fsync: (fd, complete) => {
      const finish = () => {
        fs.fsyncSync(fd)
        complete()
      }
      pending.push(finish)
      return {
        joinSync: () => {
          pending.splice(pending.indexOf(finish), 1)
          finish()
        }
      }
    },
    fsyncSync: (fd) => {
      syncs.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file')
      fs.fsyncSync(fd)
    },
    close: (fd) => fs.closeSync(fd)
  })
  const cache = new IncrementalChatJournalDescriptorCache(flusher, { write })
  return { root, cache, syncs, pending }
}
describe('journal descriptor adapter', () => {
  it('retains create-name debt after directory registration fails and closes all registered fds', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-init-'))
    roots.push(root)
    let generation = 0
    let fail = true
    const descriptors = new Map<number, number>()
    const strictDependencies: number[] = []
    const port = {
      open(dev: number, ino: number, fd: number) {
        const file = { dev, ino, generation: ++generation }
        descriptors.set(file.generation, fd)
        return file
      },
      noteWrite(
        file: { generation: number },
        _end: number,
        durability: 'soft' | 'sync',
        options?: { after?: readonly { file: { generation: number } }[] }
      ) {
        if (fs.fstatSync(descriptors.get(file.generation)!).isDirectory() && fail) {
          fail = false
          throw new Error('directory registration failed')
        }
        if (durability === 'sync') strictDependencies.push(options?.after?.length ?? 0)
      },
      awaitDurable: () => Promise.resolve(),
      async forget(files: readonly { generation: number }[]) {
        for (const file of files) {
          const fd = descriptors.get(file.generation)
          if (fd !== undefined) {
            fs.closeSync(fd)
            descriptors.delete(file.generation)
          }
        }
      }
    }
    const cache = new IncrementalChatJournalDescriptorCache(port)
    const file = path.join(root, 'cold', 'nested', 'chat.jsonl')
    expect(() => cache.append('chat', file, 'first\n', 'immediate')).toThrow(
      'directory registration failed'
    )
    expect(fs.readFileSync(file, 'utf8')).toBe('')
    await expect(cache.awaitDurable('chat')).rejects.toThrow('dependencies incomplete')
    cache.append('chat', file, 'retry\n', 'immediate')
    expect(strictDependencies).toEqual([3])
    expect(fs.readFileSync(file, 'utf8')).toBe('retry\n')
    await cache.retire()
    expect(descriptors.size).toBe(0)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['chat.jsonl'])
  })
  it('strict append joins an outstanding D1 fsync and covers the newer offset', async () => {
    const { root, cache, pending } = fixture()
    const file = path.join(root, 'chat.jsonl')
    cache.append('chat', file, 'one\n', 'deferred')
    const barrier = cache.awaitDurable('chat')
    expect(pending.length).toBeGreaterThan(0)
    cache.append('chat', file, 'two\n', 'immediate')
    await barrier
    await cache.awaitDurable('chat')
    expect(fs.readFileSync(file, 'utf8')).toBe('one\ntwo\n')
    expect(pending).toHaveLength(0)
    await cache.retire()
  })

  it('refuses inode replacement until explicit retirement then reopens at its own offset', async () => {
    const { root, cache } = fixture()
    const file = path.join(root, 'chat.jsonl')
    cache.append('chat', file, 'one\n', 'immediate')
    fs.renameSync(file, `${file}.old`)
    fs.writeFileSync(file, 'replacement\n')
    expect(() => cache.append('chat', file, 'two\n', 'immediate')).toThrow('inode replaced')
    await cache.retire(['chat'])
    cache.append('chat', file, 'two\n', 'immediate')
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement\ntwo\n')
    expect(fs.readFileSync(`${file}.old`, 'utf8')).toBe('one\n')
    await cache.retire()
  })

  it('global retirement includes an earlier scoped retirement and prevents every admission', async () => {
    const { root, cache, pending } = fixture()
    cache.append('a', path.join(root, 'a.jsonl'), 'x\n', 'deferred')
    const barrier = cache.awaitDurable('a')
    void barrier.catch(() => {})
    const scoped = cache.retire(['a'])
    const global = cache.retire()
    expect(() => cache.append('other', path.join(root, 'other.jsonl'), 'x\n', 'deferred')).toThrow()
    while (pending.length) pending.shift()!()
    await Promise.all([scoped, global])
    cache.append('other', path.join(root, 'other.jsonl'), 'new\n', 'immediate')
    await cache.retire()
  })

  it('synchronous retirement refuses an adapter without a sync join contract', () => {
    const { cache } = fixture()
    const legacyPort = {
      open: () => ({ dev: 0, ino: 0, generation: 1 }),
      noteWrite: () => {},
      awaitDurable: () => Promise.resolve(),
      forget: () => Promise.resolve()
    }
    const legacy = new IncrementalChatJournalDescriptorCache(legacyPort)
    expect(() => legacy.retireSync()).toThrow('adapter unavailable')
    void cache.retire()
  })
  it('writes real bytes and covers recursively created directory names before strict acknowledgement', async () => {
    const { root, cache, syncs } = fixture()
    const file = path.join(root, 'a', 'b', 'chat.jsonl')
    cache.append('chat', file, 'one\n', 'immediate')
    expect(fs.readFileSync(file, 'utf8')).toBe('one\n')
    expect(syncs).toEqual(['directory', 'directory', 'directory', 'file'])
    await cache.awaitDurable('chat')
    await cache.retire()
  })
  it('D1 retains an inode-offset barrier until controlled completion', async () => {
    const { root, cache, pending } = fixture()
    cache.append('chat', path.join(root, 'chat.jsonl'), 'one\n', 'deferred')
    let done = false
    const barrier = cache.awaitDurable('chat').then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    while (pending.length) pending.shift()!()
    await barrier
    expect(done).toBe(true)
    await cache.retire()
  })
  it('notes a partial written extent and preserves the original write error', async () => {
    const failure = new Error('partial ENOSPC')
    const { root, cache, pending } = fixture((fd, bytes) => {
      fs.writeSync(fd, bytes, 0, 2)
      throw failure
    })
    const file = path.join(root, 'chat.jsonl')
    expect(() => cache.append('chat', file, 'abcd\n', 'deferred')).toThrow(failure)
    expect(fs.statSync(file).size).toBe(2)
    let done = false
    const barrier = cache.awaitDurable('chat').then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    while (pending.length) pending.shift()!()
    await barrier
    await cache.retire()
  })
  it('overlapping scoped retirement covers both scopes without blocking an unrelated chat', async () => {
    const { root, cache, pending } = fixture()
    for (const id of ['a', 'b']) cache.append(id, path.join(root, `${id}.jsonl`), 'x\n', 'deferred')
    const first = cache.retire(['a'])
    const both = cache.retire(['a', 'b'])
    expect(() => cache.append('a', path.join(root, 'a.jsonl'), 'x\n', 'deferred')).toThrow()
    cache.append('c', path.join(root, 'c.jsonl'), 'x\n', 'deferred')
    while (pending.length) pending.shift()!()
    await Promise.all([first, both])
    fs.unlinkSync(path.join(root, 'a.jsonl'))
    cache.append('a', path.join(root, 'a.jsonl'), 'new\n', 'immediate')
    expect(fs.readFileSync(path.join(root, 'a.jsonl'), 'utf8')).toBe('new\n')
    await cache.retire()
  })
})
