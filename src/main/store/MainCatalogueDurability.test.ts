import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MainCatalogueDurability } from './MainCatalogueDurability'
import { createMainDurabilityRuntime } from './MainDurabilityRuntime'
import type { DurabilityFlusherPorts } from './MainDurabilityFlusher'

describe('shared catalogue durability participant', () => {
  it.each([false, true])(
    'flushes visible publication debt before exit even when afterRename throws (%s)',
    async (callbackThrows) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogue-participant-'))
      const entry = path.join(root, 'worker.cjs')
      fs.writeFileSync(entry, '// emitted entry')
      const events: string[] = []
      const adapter: DurabilityFlusherPorts & { dispose(): Promise<void> } = {
        now: () => 0,
        setTimer: () => 0,
        clearTimer: () => {},
        fsync: (fd, done) => ({
          joinSync: () => {
            fs.fsyncSync(fd)
            events.push('sync')
            done()
          }
        }),
        fsyncSync: (fd) => {
          fs.fsyncSync(fd)
          events.push('sync')
        },
        close: (fd) => {
          fs.closeSync(fd)
          events.push('close')
        },
        dispose: async () => {
          events.push('dispose')
        }
      }
      const createAdapter = vi.fn(() => adapter)
      const runtime = createMainDurabilityRuntime({
        runEventsDir: path.join(root, 'events'),
        runArtifactsDir: path.join(root, 'artifacts'),
        workerEntryPath: entry,
        env: { TASKWRAITH_CATALOGUE_DEFERRED_DURABILITY: '1' },
        createAdapter
      })
      let participant!: MainCatalogueDurability
      try {
        expect(
          runtime.attachCatalogue((ports) => {
            participant = new MainCatalogueDurability(ports)
            return participant
          })
        ).toBe(true)
        expect(createAdapter).toHaveBeenCalledOnce()
        expect(runtime.snapshot()).toMatchObject({
          runEvents: { requested: false, mode: 'legacy' },
          journal: { requested: false, mode: 'legacy' },
          catalogue: { requested: true, mode: 'worker', attached: true }
        })
        const head = path.join(root, 'head.json')
        const original = new Error('post-rename callback failed')
        const write = () =>
          participant.publication.write(head, '{"pending":true}', undefined, () => {
            if (callbackThrows) throw original
          })
        if (callbackThrows) {
          expect(write).toThrow(original)
          await expect(participant.publication.awaitDurable()).rejects.toBe(original)
        } else write()
        expect(fs.readFileSync(head, 'utf8')).toBe('{"pending":true}')
        expect(participant.snapshot()).toMatchObject({ visibleWrites: 1, durableWrites: 0 })
        await runtime.shutdown()
        const syncs = process.platform === 'win32' ? 1 : 2
        expect(events.filter((event) => event === 'sync')).toHaveLength(syncs)
        expect(events.slice(0, syncs)).toEqual(Array(syncs).fill('sync'))
        expect(events.filter((event) => event === 'close')).toHaveLength(syncs)
        expect(participant.snapshot()).toMatchObject({
          durableWrites: 1,
          descriptors: 0,
          fenced: true
        })
        expect(events.at(-1)).toBe('dispose')
        expect(() => participant.publication.write(head, '{}')).toThrow(
          callbackThrows ? original : 'fenced'
        )
      } finally {
        await runtime.shutdown()
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
