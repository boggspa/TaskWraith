/**
 * Independent Threads M4 slice 13c1 (design §23.6): the thread-record file
 * model. `modelHostThreadRecordFile` reads `chats/<id>.json` and answers
 * `absent` (no file), `invalid` (unreadable, not JSON, refused by the
 * decoder, another thread's record, an unsafe id or file) or `modelled` with
 * the record's revision and exactly the effect model the store's decoder and
 * `modelHostThreadRecordEffects` produce for the same bytes.
 *
 * The worker's `model` request dispatches to it: in process through
 * `handleHostThreadRecordTransferRequest`, and through a compiled entry on a
 * real worker thread, where the reply round-trips equal to the in-process
 * model. The off-loop helper has no synchronous fallback: with no compiled
 * entry it rejects.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import {
  decodeHostProfileThread,
  HOST_PROFILE_CHATS_DIRECTORY,
  HostProfileDomainStore
} from './HostProfileDomainStore'
import { modelHostThreadRecordEffects } from './HostThreadRecordEffectModel'
import { modelHostThreadRecordFile, type HostThreadRecordFileModel } from './HostThreadRecordModel'
import { HostThreadRecordTransferError } from './HostThreadRecordTransfer'
import {
  handleHostThreadRecordTransferRequest,
  HostThreadRecordTransferWorker,
  modelHostThreadRecordOffLoop,
  type HostThreadRecordTransferWorkerRequest
} from './HostThreadRecordTransferWorker'

const NOW = 1_760_000_000_000
const STARTED_AT = new Date(NOW).toISOString()
const POSIX = process.platform !== 'win32'

let directory: string
let entryPath: string
const workers: HostThreadRecordTransferWorker[] = []

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'thread-record-model-'))
  entryPath = join(directory, 'HostThreadRecordTransferWorkerEntry.cjs')
  await build({
    entryPoints: ['src/host-runtime/HostThreadRecordTransferWorkerEntry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: entryPath,
    logLevel: 'silent'
  })
})

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()))
})
afterAll(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

interface Profile {
  profilePath: string
  store: HostProfileDomainStore
  chatPath(threadId: string): string
  /** Writes raw bytes as a chat file, owner-only, as the store would. */
  writeRaw(threadId: string, body: string): void
}

function profile(): Profile {
  const profilePath = mkdtempSync(join(directory, 'profile-'))
  let sequence = 0
  const store = new HostProfileDomainStore({
    profilePath,
    authority: { assertProfileAuthority: () => undefined },
    now: () => NOW,
    idFactory: () => `thread-${++sequence}`
  })
  const chatPath = (threadId: string): string =>
    join(profilePath, HOST_PROFILE_CHATS_DIRECTORY, `${threadId}.json`)
  return {
    profilePath,
    store,
    chatPath,
    writeRaw: (threadId, body) => {
      mkdirSync(join(profilePath, HOST_PROFILE_CHATS_DIRECTORY), { recursive: true, mode: 0o700 })
      writeFileSync(chatPath(threadId), body, { mode: 0o600 })
    }
  }
}

/** A thread with a configured provider, a run and two messages: every family is populated. */
function seedRichThread(p: Profile): string {
  const created = p.store.createThread({ scope: 'global', title: 'Modelled' })
  const threadId = created.appChatId
  p.store.configureThread({ threadId, providerId: 'codex', modelId: 'gpt-5-codex' })
  p.store.appendTranscript({ threadId, role: 'user', content: 'hello there' })
  p.store.updateRun({
    threadId,
    runId: 'run-1',
    status: 'running',
    provider: 'codex',
    phase: 'streaming',
    startedAt: STARTED_AT
  })
  p.store.appendTranscript({ threadId, runId: 'run-1', role: 'assistant', content: 'general' })
  p.store.updateRun({
    threadId,
    runId: 'run-1',
    status: 'completed',
    endedAt: new Date(NOW + 1000).toISOString()
  })
  return threadId
}

/** The model the contract defines: the decoder over the file's JSON, then the effect model. */
function expectedModel(p: Profile, threadId: string): HostThreadRecordFileModel {
  const record = JSON.parse(readFileSync(p.chatPath(threadId), 'utf8')) as {
    persistenceRevision?: number
  }
  const decoded = decodeHostProfileThread(record)
  return {
    kind: 'modelled',
    revision: record.persistenceRevision ?? 0,
    effects: modelHostThreadRecordEffects(decoded)
  }
}

function fixture() {
  const worker = new HostThreadRecordTransferWorker(entryPath)
  workers.push(worker)
  return worker
}

describe('modelHostThreadRecordFile (M4 slice 13c1)', () => {
  describe('absent', () => {
    it('a profile with no chats directory', () => {
      const profilePath = mkdtempSync(join(directory, 'bare-'))
      expect(existsSync(join(profilePath, HOST_PROFILE_CHATS_DIRECTORY))).toBe(false)
      expect(modelHostThreadRecordFile({ profilePath, threadId: 'nobody' })).toEqual({
        kind: 'absent'
      })
    })

    it('a chats directory without the file, and a thread deleted after it was written', () => {
      const p = profile()
      const created = p.store.createThread({ scope: 'global', title: 'Gone' })
      expect(modelHostThreadRecordFile({ profilePath: p.profilePath, threadId: 'other' })).toEqual({
        kind: 'absent'
      })
      expect(p.store.deleteThreadRecord({ threadId: created.appChatId, expectedRevision: 0 })).toBe(
        true
      )
      expect(
        modelHostThreadRecordFile({ profilePath: p.profilePath, threadId: created.appChatId })
      ).toEqual({ kind: 'absent' })
    })
  })

  describe('invalid', () => {
    it('a file that is not JSON', () => {
      const p = profile()
      p.writeRaw('broken', '{"appChatId": "broken", "title": ')
      expect(modelHostThreadRecordFile({ profilePath: p.profilePath, threadId: 'broken' })).toEqual(
        { kind: 'invalid' }
      )
    })

    it('JSON the decoder refuses', () => {
      const p = profile()
      p.writeRaw('refused', JSON.stringify({ appChatId: 'refused', title: 'x', messages: 'no' }))
      expect(() =>
        decodeHostProfileThread({ appChatId: 'refused', title: 'x', messages: 'no' })
      ).toThrow()
      expect(
        modelHostThreadRecordFile({ profilePath: p.profilePath, threadId: 'refused' })
      ).toEqual({ kind: 'invalid' })
      p.writeRaw('array', '[]')
      expect(modelHostThreadRecordFile({ profilePath: p.profilePath, threadId: 'array' })).toEqual({
        kind: 'invalid'
      })
    })

    it("a valid record that carries another thread's id", () => {
      const p = profile()
      const created = p.store.createThread({ scope: 'global', title: 'Mine' })
      const bytes = readFileSync(p.chatPath(created.appChatId), 'utf8')
      expect(decodeHostProfileThread(JSON.parse(bytes))).toBeTruthy()
      p.writeRaw('impostor', bytes)
      expect(
        modelHostThreadRecordFile({ profilePath: p.profilePath, threadId: 'impostor' })
      ).toEqual({ kind: 'invalid' })
    })

    it('an id that is not a profile id, even when a file by that name exists', () => {
      const p = profile()
      writeFileSync(join(p.profilePath, 'escape.json'), '{}', { mode: 0o600 })
      for (const threadId of ['', '../escape', 'a/b', ' padded', 'x'.repeat(513)]) {
        expect(modelHostThreadRecordFile({ profilePath: p.profilePath, threadId })).toEqual({
          kind: 'invalid'
        })
      }
      expect(readdirSync(join(p.profilePath, HOST_PROFILE_CHATS_DIRECTORY))).toEqual([])
    })

    it.skipIf(!POSIX)('a symlink where the record should be', () => {
      const p = profile()
      const created = p.store.createThread({ scope: 'global', title: 'Target' })
      symlinkSync(p.chatPath(created.appChatId), p.chatPath('linked'))
      expect(modelHostThreadRecordFile({ profilePath: p.profilePath, threadId: 'linked' })).toEqual(
        {
          kind: 'invalid'
        }
      )
      // The target itself still models.
      expect(
        modelHostThreadRecordFile({ profilePath: p.profilePath, threadId: created.appChatId }).kind
      ).toBe('modelled')
    })
  })

  describe('modelled', () => {
    it('equals the decoder plus the effect model over the committed bytes, at the file revision', () => {
      const p = profile()
      const threadId = seedRichThread(p)
      const expected = expectedModel(p, threadId)
      expect(expected.kind).toBe('modelled')
      if (expected.kind !== 'modelled') return
      expect(expected.revision).toBeGreaterThan(0)
      expect(expected.effects.kind).toBe('modelled')
      if (expected.effects.kind !== 'modelled') return
      expect(expected.effects.runs.candidates.map((candidate) => candidate.runId)).toEqual([
        'run-1'
      ])
      expect(expected.effects.thread.title).toBe('Modelled')

      const modelled = modelHostThreadRecordFile({ profilePath: p.profilePath, threadId })
      expect(modelled).toEqual(expected)
      expect(modelled.kind === 'modelled' && modelled.revision).toBe(
        p.store.threadRecordState(threadId)?.revision
      )
    })

    it('tracks a later write: the model follows the file, not a cache', () => {
      const p = profile()
      const threadId = seedRichThread(p)
      const first = modelHostThreadRecordFile({ profilePath: p.profilePath, threadId })
      p.store.configureThread({ threadId, title: 'Renamed' })
      const second = modelHostThreadRecordFile({ profilePath: p.profilePath, threadId })
      expect(first.kind).toBe('modelled')
      expect(second.kind).toBe('modelled')
      if (first.kind !== 'modelled' || second.kind !== 'modelled') return
      expect(second.revision).toBe(first.revision + 1)
      expect(second.effects.kind === 'modelled' && second.effects.thread.title).toBe('Renamed')
      expect(second).toEqual(expectedModel(p, threadId))
    })

    it('a legacy record without a persistence revision models at revision 0', () => {
      const p = profile()
      p.writeRaw(
        'legacy',
        `${JSON.stringify({
          appChatId: 'legacy',
          scope: 'global',
          title: 'Legacy',
          messages: [],
          updatedAt: 20
        })}\n`
      )
      const modelled = modelHostThreadRecordFile({ profilePath: p.profilePath, threadId: 'legacy' })
      expect(modelled).toEqual(expectedModel(p, 'legacy'))
      expect(modelled.kind === 'modelled' && modelled.revision).toBe(0)
    })
  })

  describe('the worker request', () => {
    it('the entry dispatches model to modelHostThreadRecordFile in process', () => {
      const p = profile()
      const threadId = seedRichThread(p)
      const reply = handleHostThreadRecordTransferRequest({
        id: 7,
        kind: 'model',
        input: { profilePath: p.profilePath, threadId }
      })
      expect(reply).toEqual({ id: 7, ok: true, value: expectedModel(p, threadId) })
      const absent = handleHostThreadRecordTransferRequest({
        id: 8,
        kind: 'model',
        input: { profilePath: p.profilePath, threadId: 'nobody' }
      })
      expect(absent).toEqual({ id: 8, ok: true, value: { kind: 'absent' } })
    })

    it('through a compiled entry, model round-trips equal to the in-process model, every kind', async () => {
      const kindsPath = join(directory, `kinds-${process.hrtime.bigint()}.txt`)
      const wrapper = join(directory, `kinds-worker-${process.hrtime.bigint()}.cjs`)
      writeFileSync(
        wrapper,
        `require('node:worker_threads').parentPort.on('message', (message) => require('node:fs').appendFileSync(${JSON.stringify(kindsPath)}, message.kind + '\\n')); require(${JSON.stringify(entryPath)})`
      )
      const worker = new HostThreadRecordTransferWorker(wrapper)
      workers.push(worker)
      const p = profile()
      const threadId = seedRichThread(p)
      p.writeRaw('broken', 'not json')

      const [modelled, absent, invalid] = await Promise.all([
        worker.model({ profilePath: p.profilePath, threadId }),
        worker.model({ profilePath: p.profilePath, threadId: 'nobody' }),
        worker.model({ profilePath: p.profilePath, threadId: 'broken' })
      ])
      expect(modelled).toEqual(expectedModel(p, threadId))
      expect(modelled.kind).toBe('modelled')
      expect(absent).toEqual({ kind: 'absent' })
      expect(invalid).toEqual({ kind: 'invalid' })
      await worker.close()
      // Every request reached the worker as a `model` job.
      const kinds = readFileSync(kindsPath, 'utf8').trim().split('\n')
      expect(kinds).toEqual(['model', 'model', 'model'])
    })

    it('a closed worker rejects a model, and a model in flight never counts toward the publish cap', async () => {
      const worker = fixture()
      const p = profile()
      const threadId = seedRichThread(p)
      const inFlight = Array.from({ length: 6 }, () =>
        worker.model({ profilePath: p.profilePath, threadId })
      )
      // Six models pending: a publish still goes to the worker rather than
      // capturing synchronously, so its artifact is not on disk yet.
      const published = worker.publish({
        profilePath: p.profilePath,
        transferId: 'after-models',
        record: { captured: true }
      })
      const results = await Promise.all(inFlight)
      expect(results).toHaveLength(6)
      for (const result of results) expect(result).toEqual(expectedModel(p, threadId))
      await published
      await worker.close()
      await expect(worker.model({ profilePath: p.profilePath, threadId })).rejects.toBeInstanceOf(
        HostThreadRecordTransferError
      )
    })

    it('a request whose input the worker cannot serve answers invalid rather than crashing', async () => {
      const worker = fixture()
      const p = profile()
      const request: HostThreadRecordTransferWorkerRequest = {
        id: 1,
        kind: 'model',
        input: { profilePath: p.profilePath, threadId: '../escape' }
      }
      expect(handleHostThreadRecordTransferRequest(request)).toEqual({
        id: 1,
        ok: true,
        value: { kind: 'invalid' }
      })
      expect(await worker.model(request.input)).toEqual({ kind: 'invalid' })
    })
  })

  it('modelHostThreadRecordOffLoop rejects with no compiled entry and never models inline', async () => {
    // The shared worker looks for the sibling of the worker module; in the
    // source tree no compiled entry exists, which is the case under test.
    expect(existsSync(join(__dirname, 'HostThreadRecordTransferWorkerEntry.js'))).toBe(false)
    const p = profile()
    const threadId = seedRichThread(p)
    const pending = modelHostThreadRecordOffLoop({ profilePath: p.profilePath, threadId })
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).rejects.toBeInstanceOf(HostThreadRecordTransferError)
  })
})
