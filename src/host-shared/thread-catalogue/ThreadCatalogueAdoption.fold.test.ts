import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { adoptFoldedThreadRecord, type FoldedAdoptionGuard } from './ThreadCatalogueAdoption'
import { preparedThreadDirectory } from './ThreadCataloguePreparedPath'
import {
  captureThreadCatalogueWitness,
  type ThreadCatalogueReaderOptions
} from './ThreadCatalogueWitness'
import type { FoldedLogOutcome } from '../../shared/threadCatalogueTypes'

const CHAT = 'chat-adopt-fold'
const FOLD_ID = 'fold-1'
const HEAD = 7
const UPDATED_AT = '2026-04-01T12:00:00.000Z'
const EPOCH = { global: 'g', chat: 'c' }

describe('adoptFoldedThreadRecord', () => {
  let profile: string
  let options: ThreadCatalogueReaderOptions
  let guard: { [K in keyof FoldedAdoptionGuard]: Mock<FoldedAdoptionGuard[K]> }

  const canonical = (): string => join(profile, 'chats', `${CHAT}.json`)
  const staged = (): string =>
    join(preparedThreadDirectory(profile, CHAT), `${FOLD_ID}.record.json`)

  /** Stages a fold by hand, so the adoption is tested apart from the decoder that normally writes it. */
  function stage(
    overrides: Partial<FoldedLogOutcome> = {},
    body = foldedRecord()
  ): FoldedLogOutcome {
    fs.mkdirSync(preparedThreadDirectory(profile, CHAT), { recursive: true })
    const bytes = Buffer.from(JSON.stringify(body))
    fs.writeFileSync(staged(), bytes)
    const stat = fs.statSync(staged(), { bigint: true })
    return {
      foldId: FOLD_ID,
      chatId: CHAT,
      epoch: EPOCH,
      heads: { desktop: null, host: null },
      sourceWitness: captureThreadCatalogueWitness(options, CHAT).witness,
      profileAuthority: 'authority-1',
      previousRevision: 3,
      headRevision: HEAD,
      updatedAt: UPDATED_AT,
      projection: {
        revision: HEAD,
        summary: { chatId: CHAT, updatedAt: Date.parse(UPDATED_AT) }
      } as never,
      record: {
        name: `${FOLD_ID}.record.json`,
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        device: String(stat.dev),
        inode: String(stat.ino),
        modified: String(stat.mtimeNs),
        changed: String(stat.ctimeNs)
      },
      checkpoint: {} as never,
      ...overrides
    }
  }
  const foldedRecord = (): unknown => ({
    appChatId: CHAT,
    persistenceRevision: HEAD,
    updatedAt: Date.parse(UPDATED_AT),
    messages: []
  })

  beforeEach(() => {
    profile = fs.mkdtempSync(join(tmpdir(), 'thread-adopt-fold-'))
    options = { profilePath: profile, runtimeInstanceId: 'rt', segmented: false }
    fs.mkdirSync(join(profile, 'chats'), { recursive: true })
    fs.writeFileSync(canonical(), JSON.stringify({ appChatId: CHAT, persistenceRevision: 3 }))
    guard = {
      authority: vi.fn<FoldedAdoptionGuard['authority']>(),
      epoch: vi.fn<FoldedAdoptionGuard['epoch']>(),
      witness: vi.fn<FoldedAdoptionGuard['witness']>(),
      headRevision: vi.fn<FoldedAdoptionGuard['headRevision']>(),
      updatedAt: vi.fn<FoldedAdoptionGuard['updatedAt']>()
    }
  })
  afterEach(() => fs.rmSync(profile, { recursive: true, force: true }))

  it('renames the staged record into place when every assertion holds', () => {
    const folded = stage()
    const staged_bytes = fs.readFileSync(staged(), 'utf8')
    adoptFoldedThreadRecord(options, folded, guard)
    expect(fs.readFileSync(canonical(), 'utf8')).toBe(staged_bytes)
    expect(fs.existsSync(staged())).toBe(false)
    expect(guard.epoch).toHaveBeenCalledWith(EPOCH)
    expect(guard.witness).toHaveBeenCalledWith(folded.sourceWitness)
    expect(guard.headRevision).toHaveBeenCalledWith(HEAD)
    expect(guard.updatedAt).toHaveBeenCalledWith(UPDATED_AT)
    // Authority is confirmed again immediately before the rename, not only up front.
    expect(guard.authority.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('refuses, and leaves the canonical file and the staged record, when the head assertion fails', () => {
    const folded = stage()
    const before = fs.readFileSync(canonical(), 'utf8')
    guard.headRevision.mockImplementation(() => {
      throw new Error('head moved')
    })
    expect(() => adoptFoldedThreadRecord(options, folded, guard)).toThrow('head moved')
    expect(fs.readFileSync(canonical(), 'utf8')).toBe(before)
    expect(fs.existsSync(staged())).toBe(true)
  })

  it('refuses when the timestamp assertion fails, which is what an incremented clock looks like', () => {
    const folded = stage()
    const before = fs.readFileSync(canonical(), 'utf8')
    guard.updatedAt.mockImplementation(() => {
      throw new Error('clock moved')
    })
    expect(() => adoptFoldedThreadRecord(options, folded, guard)).toThrow('clock moved')
    expect(fs.readFileSync(canonical(), 'utf8')).toBe(before)
  })

  it.each([
    [
      'a projection past the log head',
      {
        projection: {
          revision: HEAD + 1,
          summary: { chatId: CHAT, updatedAt: Date.parse(UPDATED_AT) }
        } as never
      }
    ],
    [
      'a projection stamped with another clock',
      {
        projection: {
          revision: HEAD,
          summary: { chatId: CHAT, updatedAt: Date.parse(UPDATED_AT) + 1 }
        } as never
      }
    ],
    ['a head that did not advance the full copy', { previousRevision: HEAD }]
  ])('refuses a fold that moved a clock: %s', (_name, overrides) => {
    const folded = stage(overrides)
    expect(() => adoptFoldedThreadRecord(options, folded, guard)).toThrow(/clock/)
    expect(fs.existsSync(staged())).toBe(true)
  })

  it('refuses staged bytes that are not the ones the decoder described', () => {
    const folded = stage()
    fs.writeFileSync(
      staged(),
      JSON.stringify({ ...(foldedRecord() as object), persistenceRevision: HEAD + 1 })
    )
    expect(() => adoptFoldedThreadRecord(options, folded, guard)).toThrow(
      'Folded history file changed'
    )
    expect(fs.existsSync(staged())).toBe(true)
  })

  it('refuses when authority, the epoch or the source witness is no longer current', () => {
    const folded = stage()
    for (const method of ['authority', 'epoch', 'witness'] as const) {
      guard[method].mockImplementationOnce(() => {
        throw new Error(`${method} lost`)
      })
      expect(() => adoptFoldedThreadRecord(options, folded, guard)).toThrow(`${method} lost`)
      expect(fs.existsSync(staged())).toBe(true)
    }
  })

  it('refuses an identity that is not the fold the outcome names', () => {
    const folded = stage()
    expect(() =>
      adoptFoldedThreadRecord(
        options,
        { ...folded, record: { ...folded.record, name: '../escape.json' } },
        guard
      )
    ).toThrow('Invalid folded history identity')
    expect(() => adoptFoldedThreadRecord(options, { ...folded, foldId: 'other' }, guard)).toThrow(
      'Invalid folded history identity'
    )
  })
})
