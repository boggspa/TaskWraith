import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ThreadCatalogueDurability } from './ThreadCatalogueDurability'
import { ThreadCatalogue } from './ThreadCatalogue'

describe('catalogue atomic visibility and durability', () => {
  it('keeps Host publication and Desktop hold/erasure controls on the strict route', () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'catalogue-strict-controls-'))
    const writes: string[] = []
    const make = (writer: 'desktop' | 'host') =>
      new ThreadCatalogue({
        profilePath: root,
        writer,
        writerId: writer,
        canWrite: () => true,
        writerLifecycle: () => 'active',
        canPublishResolution: () => false,
        canErase: () => true,
        canManageRecoveryHolds: () => true,
        isSourceWitnessCurrent: () => true,
        isIndexedGenerationCommitted: () => false,
        deferredDurability: {
          write: (target) => {
            writes.push(target)
          },
          awaitDurable: async () => {}
        }
      })
    try {
      make('host').beginPublication('host-chat')
      const desktop = make('desktop')
      desktop.beginErasure('erased')
      desktop.holdRecovery({ chatId: 'held', token: 'token', hostIncarnation: 'incarnation' })
      expect(writes).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('renames visible bytes before barrier completion and retains the exact inode until durable', async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'catalogue-durability-'))
    let resolve!: () => void
    const held = new Promise<void>((done) => {
      resolve = done
    })
    const opened: number[] = []
    const events: string[] = []
    const durability = new ThreadCatalogueDurability<number>({
      open: (_dev, _ino, fd) => {
        opened.push(fd)
        return fd
      },
      noteWrite: () => {
        events.push('noted')
      },
      awaitDurable: () => held,
      forget: async (fds) => {
        for (const fd of fds) fs.closeSync(fd)
        events.push('closed')
      },
      acquire: () => ({
        noteMutation: () => ({ file: -1, offset: 1 }),
        release: async () => {
          events.push('directory-released')
        }
      })
    })
    try {
      const target = join(root, 'head.json')
      durability.write(
        target,
        '{"phase":"pending"}',
        () => events.push('before'),
        () => events.push('renamed')
      )
      expect(fs.readFileSync(target, 'utf8')).toContain('pending')
      expect(fs.fstatSync(opened[0]).ino).toBe(fs.statSync(target).ino)
      expect(events).toEqual(['before', 'noted', 'renamed'])
      let durable = false
      const wait = durability.awaitDurable().then(() => {
        durable = true
      })
      await Promise.resolve()
      expect(durable).toBe(false)
      resolve()
      await wait
      expect(events.slice(-2)).toEqual(['closed', 'directory-released'])
      await durability.retire()
    } finally {
      resolve()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('preserves registered descriptor ownership after synchronous rename failure for explicit retirement', async () => {
    const root = fs.mkdtempSync(join(tmpdir(), 'catalogue-durability-failure-'))
    const fds = new Set<number>()
    const durability = new ThreadCatalogueDurability<number>({
      open: (_dev, _ino, fd) => {
        fds.add(fd)
        return fd
      },
      noteWrite: () => {},
      awaitDurable: async () => {},
      forget: async (files) => {
        for (const fd of files) {
          fs.closeSync(fd)
          fds.delete(fd)
        }
      },
      acquire: () => ({ noteMutation: () => ({ file: -1, offset: 1 }), release: async () => {} })
    })
    try {
      expect(() =>
        durability.write(join(root, 'head'), '{}', () => {
          throw new Error('rename refused')
        })
      ).toThrow('rename refused')
      expect(fds.size).toBe(1)
      await expect(durability.awaitDurable()).rejects.toThrow('rename refused')
      await durability.retire()
      expect(fds.size).toBe(0)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
