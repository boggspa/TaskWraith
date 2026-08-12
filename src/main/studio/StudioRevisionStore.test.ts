import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StudioInsertRangeOp } from './StudioProtocol'
import {
  STUDIO_JOURNAL_FILENAME,
  STUDIO_SNAPSHOT_FILENAME,
  STUDIO_SNAPSHOT_FORMAT,
  StudioRevisionStore,
  applyStudioEditOp,
  createEmptyStudioDocument
} from './StudioRevisionStore'

const temporaryDirectories: string[] = []

async function makeStoreDirectory(): Promise<string> {
  const directory = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), 'studio-revision-store-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) await fsPromises.rm(directory, { recursive: true, force: true })
  }
})

function insertRange(overrides: Partial<StudioInsertRangeOp> = {}): StudioInsertRangeOp {
  return {
    type: 'insert_range',
    itemId: 'item-1',
    assetId: 'asset-1',
    sourceIn: { n: 0, d: 30000 },
    sourceOut: { n: 30030, d: 30000 },
    at: { n: 0, d: 1 },
    ...overrides
  }
}

describe('StudioRevisionStore', () => {
  it('opens fresh at revision 0 with an empty document', async () => {
    const store = await StudioRevisionStore.open(await makeStoreDirectory())
    expect(store.revision).toBe(0)
    expect(store.getDocument()).toEqual(createEmptyStudioDocument())
    expect(store.recovery).toMatchObject({
      revision: 0,
      replayedJournalOps: 0,
      discardedJournalLines: 0
    })
    await store.close()
  })

  it('applies insert_range, bumps the revision and stores exact rational times', async () => {
    const store = await StudioRevisionStore.open(await makeStoreDirectory())
    const outcome = await store.applyEdit(0, insertRange())
    expect(outcome).toEqual({ ok: true, revision: 1 })
    const document = store.getDocument()
    expect(document.tracks).toHaveLength(1)
    expect(document.tracks[0].items[0]).toMatchObject({
      itemId: 'item-1',
      position: { n: 0, d: 1 },
      duration: { n: 1001, d: 1000 }
    })
    await store.close()
  })

  it('returns copies of the document, never live host state', async () => {
    const store = await StudioRevisionStore.open(await makeStoreDirectory())
    await store.applyEdit(0, insertRange())
    const copy = store.getDocument()
    copy.tracks[0].items[0].itemId = 'mutated'
    expect(store.getDocument().tracks[0].items[0].itemId).toBe('item-1')
    await store.close()
  })

  it('rejects a stale baseRevision with the current revision attached', async () => {
    const store = await StudioRevisionStore.open(await makeStoreDirectory())
    await store.applyEdit(0, insertRange())
    const stale = await store.applyEdit(0, insertRange({ itemId: 'item-2', at: { n: 5, d: 1 } }))
    expect(stale).toMatchObject({ ok: false, code: 'stale_base', currentRevision: 1 })
    const future = await store.applyEdit(7, insertRange({ itemId: 'item-3' }))
    expect(future).toMatchObject({ ok: false, code: 'stale_base', currentRevision: 1 })
    expect(store.revision).toBe(1)
    await store.close()
  })

  it('serialises concurrent applyEdit calls: exactly one wins per base revision', async () => {
    const store = await StudioRevisionStore.open(await makeStoreDirectory())
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        store.applyEdit(0, insertRange({ itemId: `race-${index}`, at: { n: index, d: 1 } }))
      )
    )
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
    expect(store.revision).toBe(1)
    await store.close()
  })

  it('rejects invalid ranges, duplicate ids, interior insertions and misaligned frames', async () => {
    const store = await StudioRevisionStore.open(await makeStoreDirectory())
    const empty = await store.applyEdit(0, insertRange({ sourceOut: { n: 0, d: 30000 } }))
    expect(empty).toMatchObject({ ok: false, code: 'invalid_op' })

    const misaligned = await store.applyEdit(
      0,
      insertRange({ assetFrameRate: { n: 30000, d: 1001 }, sourceOut: { n: 30000, d: 30000 } })
    )
    expect(misaligned).toMatchObject({ ok: false, code: 'misaligned_time' })

    const aligned = await store.applyEdit(0, insertRange({ assetFrameRate: { n: 30000, d: 1001 } }))
    expect(aligned).toMatchObject({ ok: true, revision: 1 })

    const duplicate = await store.applyEdit(1, insertRange({ at: { n: 10, d: 1 } }))
    expect(duplicate).toMatchObject({ ok: false, code: 'duplicate_item' })

    const interior = await store.applyEdit(1, insertRange({ itemId: 'item-2', at: { n: 1, d: 2 } }))
    expect(interior).toMatchObject({ ok: false, code: 'insertion_inside_item' })
    expect(store.revision).toBe(1)
    await store.close()
  })

  it('ripples items at or after the insertion point by the exact inserted duration', async () => {
    const store = await StudioRevisionStore.open(await makeStoreDirectory())
    await store.applyEdit(0, insertRange({ itemId: 'first', at: { n: 0, d: 1 } }))
    const inserted = await store.applyEdit(
      1,
      insertRange({
        itemId: 'second',
        at: { n: 0, d: 1 },
        sourceIn: { n: 0, d: 48000 },
        sourceOut: { n: 24000, d: 48000 }
      })
    )
    expect(inserted).toMatchObject({ ok: true, revision: 2 })
    const items = store.getDocument().tracks[0].items
    expect(items.map((item) => item.itemId)).toEqual(['second', 'first'])
    expect(items[0].position).toEqual({ n: 0, d: 1 })
    expect(items[0].duration).toEqual({ n: 1, d: 2 })
    expect(items[1].position).toEqual({ n: 1, d: 2 })
    await store.close()
  })

  it('allows insertion exactly at an existing item end without rippling it', async () => {
    const store = await StudioRevisionStore.open(await makeStoreDirectory())
    await store.applyEdit(0, insertRange({ itemId: 'head', sourceOut: { n: 60060, d: 30000 } }))
    const tail = await store.applyEdit(1, insertRange({ itemId: 'tail', at: { n: 2002, d: 1000 } }))
    expect(tail).toMatchObject({ ok: true, revision: 2 })
    const items = store.getDocument().tracks[0].items
    expect(items[0].position).toEqual({ n: 0, d: 1 })
    expect(items[1].position).toEqual({ n: 1001, d: 500 })
    await store.close()
  })

  it('replays the journal into an identical document on reopen', async () => {
    const directory = await makeStoreDirectory()
    const first = await StudioRevisionStore.open(directory)
    await first.applyEdit(0, insertRange())
    await first.applyEdit(1, insertRange({ itemId: 'item-2', at: { n: 2, d: 1 } }))
    await first.applyEdit(2, insertRange({ itemId: 'item-3', at: { n: 4, d: 1 } }))
    const expected = first.getDocument()
    await first.close()

    const second = await StudioRevisionStore.open(directory)
    expect(second.revision).toBe(3)
    expect(second.recovery.replayedJournalOps).toBe(3)
    expect(second.getDocument()).toEqual(expected)
    await second.close()
  })

  it('compacts the journal into an atomic snapshot at the configured threshold', async () => {
    const directory = await makeStoreDirectory()
    const store = await StudioRevisionStore.open(directory, { compactEveryOps: 2 })
    await store.applyEdit(0, insertRange({ itemId: 'a', at: { n: 0, d: 1 } }))
    await store.applyEdit(1, insertRange({ itemId: 'b', at: { n: 10, d: 1 } }))
    const journalAfterCompaction = await fsPromises.readFile(
      nodePath.join(directory, STUDIO_JOURNAL_FILENAME),
      'utf8'
    )
    expect(journalAfterCompaction).toBe('')
    const snapshotRaw = await fsPromises.readFile(
      nodePath.join(directory, STUDIO_SNAPSHOT_FILENAME),
      'utf8'
    )
    expect(JSON.parse(snapshotRaw)).toMatchObject({ format: STUDIO_SNAPSHOT_FORMAT, revision: 2 })
    await store.applyEdit(2, insertRange({ itemId: 'c', at: { n: 20, d: 1 } }))
    const expected = store.getDocument()
    await store.close()

    const reopened = await StudioRevisionStore.open(directory)
    expect(reopened.revision).toBe(3)
    expect(reopened.recovery.replayedJournalOps).toBe(1)
    expect(reopened.getDocument()).toEqual(expected)
    await reopened.close()
  })

  it('discards a torn trailing journal line and re-compacts to a consistent disk state', async () => {
    const directory = await makeStoreDirectory()
    const store = await StudioRevisionStore.open(directory)
    await store.applyEdit(0, insertRange())
    await store.applyEdit(1, insertRange({ itemId: 'item-2', at: { n: 5, d: 1 } }))
    const expected = store.getDocument()
    await store.close()

    const journalPath = nodePath.join(directory, STUDIO_JOURNAL_FILENAME)
    await fsPromises.appendFile(
      journalPath,
      '{"format":"taskwraith-studio-journal","v":1,"rev',
      'utf8'
    )

    const recovered = await StudioRevisionStore.open(directory)
    expect(recovered.revision).toBe(2)
    expect(recovered.recovery.discardedJournalLines).toBe(1)
    expect(recovered.recovery.warnings.length).toBeGreaterThan(0)
    expect(recovered.getDocument()).toEqual(expected)
    await recovered.close()

    const clean = await StudioRevisionStore.open(directory)
    expect(clean.revision).toBe(2)
    expect(clean.recovery.discardedJournalLines).toBe(0)
    expect(clean.recovery.warnings).toEqual([])
    expect(clean.getDocument()).toEqual(expected)
    await clean.close()
  })

  it('skips journal lines already captured by the snapshot (compaction crash window)', async () => {
    const directory = await makeStoreDirectory()
    const store = await StudioRevisionStore.open(directory)
    await store.applyEdit(0, insertRange())
    await store.applyEdit(1, insertRange({ itemId: 'item-2', at: { n: 5, d: 1 } }))
    const document = store.getDocument()
    await store.close()

    // Simulate: the snapshot landed but the journal truncation never happened.
    const snapshot = { format: STUDIO_SNAPSHOT_FORMAT, v: 1, revision: 2, document }
    await fsPromises.writeFile(
      nodePath.join(directory, STUDIO_SNAPSHOT_FILENAME),
      JSON.stringify(snapshot, null, 2),
      'utf8'
    )

    const recovered = await StudioRevisionStore.open(directory)
    expect(recovered.revision).toBe(2)
    expect(recovered.recovery.skippedStaleJournalLines).toBe(2)
    expect(recovered.recovery.replayedJournalOps).toBe(0)
    expect(recovered.getDocument()).toEqual(document)
    await recovered.close()
  })

  it('opens a real media asset through a jailed root and replays its identity', async () => {
    const directory = await makeStoreDirectory()
    const mediaRoot = nodePath.join(directory, 'media')
    await fsPromises.mkdir(mediaRoot)
    const mediaPath = nodePath.join(mediaRoot, 'clip.mov')
    await fsPromises.writeFile(mediaPath, 'fixture', 'utf8')

    const store = await StudioRevisionStore.open(directory, { allowedMediaRoots: [mediaRoot] })
    const opened = await store.openMedia(0, {
      assetId: 'asset-clip',
      path: mediaPath,
      mediaKind: 'video'
    })
    const canonicalPath = await fsPromises.realpath(mediaPath)
    expect(opened).toEqual({
      ok: true,
      revision: 1,
      asset: { assetId: 'asset-clip', path: canonicalPath, mediaKind: 'video' }
    })
    expect(store.getDocument().assets).toEqual([opened.ok ? opened.asset : null])
    await store.close()

    const reopened = await StudioRevisionStore.open(directory, {
      allowedMediaRoots: [mediaRoot]
    })
    expect(reopened.revision).toBe(1)
    expect(reopened.recovery.replayedJournalOps).toBe(1)
    expect(reopened.getDocument().assets).toEqual([
      { assetId: 'asset-clip', path: canonicalPath, mediaKind: 'video' }
    ])
    await reopened.close()
  })

  it('rejects media paths that resolve outside the configured root', async () => {
    const directory = await makeStoreDirectory()
    const mediaRoot = nodePath.join(directory, 'media')
    const outsideRoot = await makeStoreDirectory()
    await fsPromises.mkdir(mediaRoot)
    const outsidePath = nodePath.join(outsideRoot, 'outside.mov')
    await fsPromises.writeFile(outsidePath, 'fixture', 'utf8')
    const symlinkPath = nodePath.join(mediaRoot, 'linked.mov')
    await fsPromises.symlink(outsidePath, symlinkPath)

    const store = await StudioRevisionStore.open(directory, { allowedMediaRoots: [mediaRoot] })
    const rejected = await store.openMedia(0, {
      assetId: 'asset-outside',
      path: symlinkPath,
      mediaKind: 'video'
    })
    expect(rejected).toMatchObject({ ok: false, code: 'invalid_params', currentRevision: 0 })
    expect(store.revision).toBe(0)
    await store.close()
  })

  it('exposes a pure apply function that never mutates its input document', () => {
    const document = createEmptyStudioDocument()
    const next = applyStudioEditOp(document, insertRange())
    expect(document.tracks).toHaveLength(0)
    expect(next.tracks).toHaveLength(1)
  })
})
