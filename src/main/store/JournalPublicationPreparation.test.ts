import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import {
  JournalPublicationCapacity,
  startJournalPublicationPreparation
} from './JournalPublicationPreparation'
import {
  CHAT_RECORD_MUTATION_FORMAT,
  CHAT_RECORD_MUTATION_VERSION,
  deriveChatRecordMutation
} from './ChatRecordMutation'
import { createIncrementalChatJournal } from './IncrementalChatJournal'
import { IncrementalChatJournalDescriptorCache } from './IncrementalChatJournalDescriptorCache'
import { MainDurabilityFlusher } from './MainDurabilityFlusher'
import type { ChatRecord } from './types'
import { checkpointFileReference } from './CheckpointPreparationProtocol'
import { prepareJournalPublication } from './CheckpointPreparationCore'
import {
  INCREMENTAL_CHAT_CHECKPOINT_FORMAT,
  INCREMENTAL_CHAT_CHECKPOINT_VERSION
} from './IncrementalChatJournal'

describe('publication pinned prefix replay', () => {
  it('releases source custody on synchronous constructor and cleanup failure without unlinking replacement', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-constructor-'))
    const source = path.join(root, 'source')
    const output = path.join(root, 'output')
    fs.writeFileSync(source, '{}')
    fs.writeFileSync(output, '')
    const original = checkpointFileReference(output)
    fs.renameSync(output, output + '.original')
    fs.writeFileSync(output, 'replacement')
    const reference = checkpointFileReference(source)
    const fd = fs.openSync(source, 'r')
    let credits = 0
    const capacity = new JournalPublicationCapacity()
    const release = vi.fn(() => fs.closeSync(fd))
    try {
      expect(() =>
        startJournalPublicationPreparation({
          workerEntryPath: path.join(root, 'invalid\u0000.cjs'),
          createWorker: () => {
            throw new Error('constructor refused')
          },
          capture: () => ({
            chatId: 'chat',
            revision: 1,
            generation: 1,
            checkpoint: { file: reference, fd, prefixBytes: 2, mutablePrefix: false },
            sealed: null,
            active: null,
            isCurrent: () => true,
            release,
            cancel: release
          }),
          output: original,
          maxOutputBytes: 100,
          capacity,
          reservationBytes: 100,
          releaseCredit: () => {
            credits++
          }
        })
      ).toThrow('output cleanup refused')
      expect(release).toHaveBeenCalledOnce()
      expect(credits).toBe(1)
      expect(capacity.snapshot().jobs).toBe(0)
      expect(fs.readFileSync(output, 'utf8')).toBe('replacement')
    } finally {
      if (!release.mock.calls.length) fs.closeSync(fd)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('prepares exact R2 from the production journal lease after subsequent append and rotation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-real-lease-'))
    const entry = path.join(root, 'worker.cjs')
    await build({
      entryPoints: ['src/main/store/JournalPublicationPreparationWorker.ts'],
      outfile: entry,
      platform: 'node',
      format: 'cjs',
      bundle: true,
      target: 'node22'
    })
    const flusher = new MainDurabilityFlusher({
      now: () => 0,
      setTimer: () => 0,
      clearTimer: () => {},
      fsync: (fd, done) => ({
        joinSync: () => {
          fs.fsyncSync(fd)
          done()
        }
      }),
      fsyncSync: fs.fsyncSync,
      close: fs.closeSync
    })
    const cache = new IncrementalChatJournalDescriptorCache(flusher)
    const journal = createIncrementalChatJournal(root, {
      descriptorCache: cache,
      descriptorDrainSync: () => flusher.drainSync(),
      rotationEnabled: true
    })
    const first: ChatRecord = {
      appChatId: 'chat',
      title: 'one',
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      runs: [],
      persistenceRevision: 1
    }
    const second = { ...first, title: 'two', persistenceRevision: 2 }
    const third = { ...second, title: 'three', persistenceRevision: 3 }
    const output = path.join(root, 'output')
    fs.writeFileSync(output, '')
    let job: ReturnType<typeof startJournalPublicationPreparation> = null
    let credits = 0
    try {
      journal.initialize('chat', first)
      journal.append(deriveChatRecordMutation(first, second))
      job = startJournalPublicationPreparation({
        workerEntryPath: entry,
        capture: () => {
          const lease = journal.captureSource?.('chat', 2) ?? null
          if (!lease) return null
          journal.append(deriveChatRecordMutation(second, third))
          journal.rotateForPreparation?.('chat')
          expect(lease.isCurrent()).toBe(true)
          return lease
        },
        output: checkpointFileReference(output),
        maxOutputBytes: 1024 * 1024,
        capacity: new JournalPublicationCapacity(),
        reservationBytes: 2 * 1024 * 1024,
        releaseCredit: () => {
          credits++
        }
      })
      expect(job).not.toBeNull()
      const artifact = await job!.result
      const bytes = Buffer.from(JSON.stringify(second))
      expect(fs.readFileSync(output)).toEqual(bytes)
      expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(credits).toBe(0)
      job!.release()
      expect(credits).toBe(1)
    } finally {
      job?.cancel()
      cache.retireSync()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it.each(['error', 'cancel', 'malformed'] as const)(
    'keeps real-thread custody until exit and identity-bound cleanup on %s',
    async (kind) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-custody-'))
      const entry = path.join(root, 'worker.cjs')
      const output = path.join(root, 'output')
      const source = path.join(root, 'source')
      fs.writeFileSync(output, '')
      fs.writeFileSync(source, '{}')
      const reference = checkpointFileReference(source)
      const fd = fs.openSync(source, 'r')
      let closed = false
      let credits = 0
      const capacity = new JournalPublicationCapacity(1, 100)
      const close = () => {
        if (!closed) {
          fs.closeSync(fd)
          closed = true
        }
      }
      const lease = {
        chatId: 'chat',
        revision: 1,
        generation: 1,
        checkpoint: { file: reference, fd, prefixBytes: 2, mutablePrefix: false },
        sealed: null,
        active: null,
        isCurrent: () => !closed,
        release: close,
        cancel: close
      }
      fs.writeFileSync(
        entry,
        kind === 'error'
          ? `throw new Error('actual worker failed')`
          : kind === 'cancel'
            ? `require('node:fs').writeFileSync(require('node:worker_threads').workerData.output.path, 'partial'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)`
            : `const {parentPort,workerData:r}=require('node:worker_threads'); require('node:fs').writeFileSync(r.output.path,'partial'); parentPort.postMessage({ok:true,artifact:{chatId:r.chatId,revision:r.revision,generation:r.generation,artifactPath:r.output.path,sha256:'bad',byteLength:7,identity:r.output.identity}}); parentPort.close()`
      )
      try {
        const job = startJournalPublicationPreparation({
          workerEntryPath: entry,
          capture: () => lease,
          output: checkpointFileReference(output),
          maxOutputBytes: 100,
          capacity,
          reservationBytes: 100,
          releaseCredit: () => {
            credits++
          }
        })!
        const rejection = expect(job.result).rejects.toThrow()
        expect(capacity.snapshot()).toEqual({ jobs: 1, bytes: 100 })
        expect(
          startJournalPublicationPreparation({
            workerEntryPath: entry,
            capture: () => {
              throw new Error('capacity refusal must precede capture')
            },
            output: checkpointFileReference(output),
            maxOutputBytes: 100,
            capacity,
            reservationBytes: 1,
            releaseCredit: () => {}
          })
        ).toBeNull()
        if (kind === 'cancel') {
          const deadline = Date.now() + 2000
          while (fs.statSync(output).size === 0) {
            if (Date.now() > deadline) throw new Error('Worker did not enter held preparation')
            await new Promise<void>((resolve) => setTimeout(resolve, 5))
          }
          job.cancel()
          // terminate() is asynchronous: no fd or reservation may close in this turn.
          expect(closed).toBe(false)
          expect(credits).toBe(0)
          expect(() => job.release()).toThrow('until worker exit')
        }
        await rejection
        expect(closed).toBe(true)
        expect(credits).toBe(1)
        expect(capacity.snapshot()).toEqual({ jobs: 0, bytes: 0 })
        expect(fs.existsSync(output)).toBe(false)
      } finally {
        close()
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )
  it('bounds aggregate bytes independently of job slots', () => {
    const capacity = new JournalPublicationCapacity(3, 10)
    const release = capacity.reserve(8)!
    expect(capacity.reserve(3)).toBeNull()
    const second = capacity.reserve(2)!
    expect(capacity.snapshot()).toEqual({ jobs: 2, bytes: 10 })
    release()
    release()
    second()
    expect(capacity.snapshot()).toEqual({ jobs: 0, bytes: 0 })
  })
  it('never unlinks a replacement inode and retains cleanup credit until identity-bound retry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-replaced-'))
    const entry = path.join(root, 'worker.cjs')
    const output = path.join(root, 'output')
    const source = path.join(root, 'source')
    fs.writeFileSync(output, '')
    fs.writeFileSync(source, '{}')
    const outputReference = checkpointFileReference(output)
    const reference = checkpointFileReference(source)
    const fd = fs.openSync(source, 'r')
    let closed = false
    let credits = 0
    const close = () => {
      if (!closed) {
        closed = true
        fs.closeSync(fd)
      }
    }
    const capacity = new JournalPublicationCapacity(1, 100)
    fs.writeFileSync(
      entry,
      `const fs=require('node:fs'); const {workerData:r}=require('node:worker_threads'); fs.renameSync(r.output.path,r.output.path+'.original'); fs.writeFileSync(r.output.path,'replacement'); throw new Error('after replacement')`
    )
    try {
      const job = startJournalPublicationPreparation({
        workerEntryPath: entry,
        capture: () => ({
          chatId: 'chat',
          revision: 1,
          generation: 1,
          checkpoint: { file: reference, fd, prefixBytes: 2, mutablePrefix: false },
          sealed: null,
          active: null,
          isCurrent: () => true,
          release: close,
          cancel: close
        }),
        output: outputReference,
        maxOutputBytes: 100,
        capacity,
        reservationBytes: 100,
        releaseCredit: () => {
          credits++
        }
      })!
      await expect(job.result).rejects.toThrow('cleanup retains custody')
      expect(fs.readFileSync(output, 'utf8')).toBe('replacement')
      expect(closed).toBe(false)
      expect(credits).toBe(0)
      expect(capacity.snapshot().jobs).toBe(1)
      // Restore the owned inode; cleanup can now safely settle retained custody.
      fs.unlinkSync(output)
      fs.renameSync(output + '.original', output)
      job.release()
      expect(closed).toBe(true)
      expect(credits).toBe(1)
      expect(fs.existsSync(output)).toBe(false)
    } finally {
      close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('runs actual thread at R2 with sealed+growing active and retains reservation until explicit adoption release', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-thread-'))
    const entry = path.join(root, 'worker.cjs')
    await build({
      entryPoints: ['src/main/store/JournalPublicationPreparationWorker.ts'],
      outfile: entry,
      platform: 'node',
      format: 'cjs',
      bundle: true,
      target: 'node22'
    })
    const record = {
      appChatId: 'chat',
      persistenceRevision: 0,
      messages: [],
      runs: [],
      title: 'base',
      createdAt: 1,
      updatedAt: 1,
      scope: 'global',
      archived: false
    }
    const checkpoint = path.join(root, 'checkpoint')
    const sealed = path.join(root, 'sealed')
    const active = path.join(root, 'active')
    const output = path.join(root, 'output')
    fs.writeFileSync(
      checkpoint,
      JSON.stringify({
        format: INCREMENTAL_CHAT_CHECKPOINT_FORMAT,
        version: INCREMENTAL_CHAT_CHECKPOINT_VERSION,
        chatId: 'chat',
        revision: 0,
        savedAt: new Date().toISOString(),
        reason: 'idle',
        record
      })
    )
    const batch = (revision: number, title: string) =>
      JSON.stringify({
        format: CHAT_RECORD_MUTATION_FORMAT,
        version: CHAT_RECORD_MUTATION_VERSION,
        chatId: 'chat',
        baseRevision: revision - 1,
        revision,
        savedAt: '2026-10-02T00:00:00.000Z',
        operations: [{ type: 'record_patch', set: { title }, clear: [] }]
      }) + '\n'
    fs.writeFileSync(sealed, batch(1, 'one'))
    fs.writeFileSync(active, batch(2, 'two'))
    fs.writeFileSync(output, '')
    const fds: number[] = []
    const ref = (filePath: string, mutablePrefix: boolean) => {
      const file = checkpointFileReference(filePath)
      const fd = fs.openSync(filePath, 'r')
      fds.push(fd)
      return { file, fd, prefixBytes: file.identity.size, mutablePrefix }
    }
    let credits = 0
    let closed = false
    const lease = {
      chatId: 'chat',
      revision: 2,
      generation: 1,
      checkpoint: ref(checkpoint, false),
      sealed: ref(sealed, false),
      active: ref(active, true),
      isCurrent: () => !closed,
      release: () => {
        closed = true
        for (const fd of fds) fs.closeSync(fd)
      },
      cancel: () => {}
    }
    try {
      fs.renameSync(active, path.join(root, 'rotated'))
      fs.appendFileSync(path.join(root, 'rotated'), batch(3, 'later'))
      const job = startJournalPublicationPreparation({
        workerEntryPath: entry,
        capture: () => lease,
        output: checkpointFileReference(output),
        maxOutputBytes: 1024 * 1024,
        capacity: new JournalPublicationCapacity(),
        reservationBytes: 1024 * 1024,
        releaseCredit: () => {
          credits++
        }
      })!
      const result = await job.result
      const bytes = fs.readFileSync(output)
      expect(JSON.parse(bytes.toString()).title).toBe('two')
      expect(JSON.parse(bytes.toString()).persistenceRevision).toBe(2)
      expect(bytes.toString()).toBe(
        JSON.stringify({ ...record, title: 'two', persistenceRevision: 2 })
      )
      expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(credits).toBe(0)
      expect(job.isCurrent()).toBe(true)
      job.release()
      expect(credits).toBe(1)
    } finally {
      if (!closed) lease.release()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it.each([false, true])(
    'orders file then directory fsync before acknowledgement and preserves borrowed fds (directory failure=%s)',
    (directoryFailure) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publication-prefix-'))
      const baseline = path.join(root, 'checkpoint')
      const active = path.join(root, 'active')
      const output = path.join(root, 'output')
      fs.writeFileSync(
        baseline,
        JSON.stringify({
          format: INCREMENTAL_CHAT_CHECKPOINT_FORMAT,
          version: INCREMENTAL_CHAT_CHECKPOINT_VERSION,
          chatId: 'chat',
          revision: 0,
          savedAt: new Date().toISOString(),
          reason: 'idle',
          record: {
            appChatId: 'chat',
            persistenceRevision: 0,
            messages: [],
            runs: [],
            title: 'captured',
            createdAt: 1,
            updatedAt: 1,
            scope: 'global',
            archived: false
          }
        })
      )
      fs.writeFileSync(active, '')
      fs.writeFileSync(output, '')
      const checkpoint = checkpointFileReference(baseline)
      const journal = checkpointFileReference(active)
      const checkpointFd = fs.openSync(baseline, 'r')
      const activeFd = fs.openSync(active, 'r')
      const syncOriginal = fs.fsyncSync
      const ordering: string[] = []
      const failure = new Error('directory durability failed')
      const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        const directory = fs.fstatSync(fd).isDirectory()
        ordering.push(directory ? 'directory' : 'file')
        if (directory && directoryFailure) throw failure
        syncOriginal(fd)
      })
      try {
        fs.renameSync(active, path.join(root, 'sealed'))
        fs.appendFileSync(path.join(root, 'sealed'), 'later bytes deliberately excluded')
        const prepare = () =>
          prepareJournalPublication({
            chatId: 'chat',
            revision: 0,
            generation: 1,
            checkpoint: {
              fd: checkpointFd,
              identity: checkpoint.identity,
              prefixBytes: checkpoint.identity.size,
              mutablePrefix: false
            },
            sealed: null,
            active: {
              fd: activeFd,
              identity: journal.identity,
              prefixBytes: 0,
              mutablePrefix: true
            },
            output: checkpointFileReference(output),
            outputDirectory: {
              path: root,
              dev: String(fs.statSync(root, { bigint: true }).dev),
              ino: String(fs.statSync(root, { bigint: true }).ino)
            },
            maxOutputBytes: 1024 * 1024
          })
        if (directoryFailure && process.platform !== 'win32') expect(prepare).toThrow(failure)
        else {
          const artifact = prepare()
          expect(JSON.parse(fs.readFileSync(output, 'utf8')).title).toBe('captured')
          expect(artifact.byteLength).toBe(fs.statSync(output).size)
        }
        expect(ordering).toEqual(process.platform === 'win32' ? ['file'] : ['file', 'directory'])
        expect(fs.fstatSync(activeFd).isFile()).toBe(true)
        expect(fs.fstatSync(checkpointFd).isFile()).toBe(true)
      } finally {
        sync.mockRestore()
        fs.closeSync(activeFd)
        fs.closeSync(checkpointFd)
        fs.rmSync(root, { recursive: true, force: true })
      }
    }
  )
})
