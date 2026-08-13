import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  STUDIO_PROPOSAL_SCHEMA_VERSION,
  STUDIO_TRANSCRIPT_SCHEMA_VERSION,
  type StudioInsertRangeOp,
  type StudioTranscript
} from './StudioProtocol'
import {
  STUDIO_DOCUMENT_FORMAT_VERSION,
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

function transcript(overrides: Partial<StudioTranscript> = {}): StudioTranscript {
  return {
    schemaVersion: STUDIO_TRANSCRIPT_SCHEMA_VERSION,
    transcriptId: 'transcript-1',
    assetId: 'asset-1',
    localeIdentifier: 'en-US',
    segments: [
      {
        segmentId: 'segment-1',
        text: 'First exact phrase',
        sourceIn: { n: 0, d: 30_000 },
        sourceOut: { n: 30_030, d: 30_000 },
        confidence: 0.97
      },
      {
        segmentId: 'segment-2',
        text: 'Second exact phrase',
        sourceIn: { n: 60_060, d: 30_000 },
        sourceOut: { n: 90_090, d: 30_000 },
        confidence: 0.91
      }
    ],
    ...overrides
  }
}

async function openTranscriptAsset(store: StudioRevisionStore, directory: string): Promise<void> {
  const mediaPath = nodePath.join(directory, 'transcript-source.mov')
  await fsPromises.writeFile(mediaPath, 'fixture', 'utf8')
  const outcome = await store.openMedia(0, {
    assetId: 'asset-1',
    path: mediaPath,
    mediaKind: 'video'
  })
  if (!outcome.ok) throw new Error(outcome.message)
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

  it('persists exact transcript ranges and replays them with their asset identity', async () => {
    const directory = await makeStoreDirectory()
    const first = await StudioRevisionStore.open(directory, { allowedMediaRoots: [directory] })
    await openTranscriptAsset(first, directory)

    const stored = await first.setTranscript(1, transcript())
    expect(stored).toMatchObject({
      ok: true,
      revision: 2,
      transcript: {
        schemaVersion: STUDIO_TRANSCRIPT_SCHEMA_VERSION,
        transcriptId: 'transcript-1',
        assetId: 'asset-1'
      }
    })
    if (!stored.ok) throw new Error(stored.message)
    expect(stored.transcript.segments[0]).toMatchObject({
      segmentId: 'segment-1',
      sourceIn: { n: 0, d: 1 },
      sourceOut: { n: 1001, d: 1000 }
    })
    const expected = first.getDocument()
    await first.close()

    const reopened = await StudioRevisionStore.open(directory, {
      allowedMediaRoots: [directory]
    })
    expect(reopened.revision).toBe(2)
    expect(reopened.recovery.replayedJournalOps).toBe(2)
    expect(reopened.getDocument()).toEqual(expected)
    await reopened.close()
  })

  it('keeps exact transcript segments in a compacted v3 snapshot', async () => {
    const directory = await makeStoreDirectory()
    const first = await StudioRevisionStore.open(directory, {
      allowedMediaRoots: [directory],
      compactEveryOps: 2
    })
    await openTranscriptAsset(first, directory)
    await first.setTranscript(1, transcript())
    await first.close()

    const snapshot = JSON.parse(
      await fsPromises.readFile(nodePath.join(directory, STUDIO_SNAPSHOT_FILENAME), 'utf8')
    ) as { document: { formatVersion: number; transcripts: unknown[] } }
    expect(snapshot.document.formatVersion).toBe(STUDIO_DOCUMENT_FORMAT_VERSION)
    expect(snapshot.document.transcripts).toHaveLength(1)
    expect(snapshot.document.transcripts[0]).toMatchObject({ transcriptId: 'transcript-1' })

    const reopened = await StudioRevisionStore.open(directory, {
      allowedMediaRoots: [directory]
    })
    expect(reopened.recovery.replayedJournalOps).toBe(0)
    const transcripts = reopened.getDocument().transcripts
    expect(transcripts).toHaveLength(1)
    expect(transcripts[0].transcriptId).toBe('transcript-1')
    expect(transcripts[0].segments[0].segmentId).toBe('segment-1')
    await reopened.close()
  })

  it('replaces a transcript by stable id without duplicating selection units', async () => {
    const directory = await makeStoreDirectory()
    const store = await StudioRevisionStore.open(directory, { allowedMediaRoots: [directory] })
    await openTranscriptAsset(store, directory)
    await store.setTranscript(1, transcript())

    const replacement = transcript({
      localeIdentifier: 'en-GB',
      segments: [
        {
          segmentId: 'replacement',
          text: 'Replacement phrase',
          sourceIn: { n: 0, d: 1 },
          sourceOut: { n: 2, d: 1 }
        }
      ]
    })
    await expect(store.setTranscript(2, replacement)).resolves.toMatchObject({
      ok: true,
      revision: 3,
      transcript: { localeIdentifier: 'en-GB', segments: [{ segmentId: 'replacement' }] }
    })
    expect(store.getDocument().transcripts).toHaveLength(1)
    await store.close()
  })

  it('rejects unknown assets, duplicate ids, overlaps and invalid confidence atomically', async () => {
    const directory = await makeStoreDirectory()
    const store = await StudioRevisionStore.open(directory, { allowedMediaRoots: [directory] })
    await expect(store.setTranscript(0, transcript())).resolves.toMatchObject({
      ok: false,
      code: 'invalid_op',
      currentRevision: 0
    })
    await openTranscriptAsset(store, directory)

    const duplicate = transcript({
      segments: [
        {
          segmentId: 'same',
          text: 'One',
          sourceIn: { n: 0, d: 1 },
          sourceOut: { n: 1, d: 1 }
        },
        {
          segmentId: 'same',
          text: 'Two',
          sourceIn: { n: 2, d: 1 },
          sourceOut: { n: 3, d: 1 }
        }
      ]
    })
    await expect(store.setTranscript(1, duplicate)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_params',
      currentRevision: 1
    })

    const overlapping = transcript({
      segments: [
        {
          segmentId: 'one',
          text: 'One',
          sourceIn: { n: 0, d: 1 },
          sourceOut: { n: 2, d: 1 }
        },
        {
          segmentId: 'two',
          text: 'Two',
          sourceIn: { n: 1, d: 1 },
          sourceOut: { n: 3, d: 1 }
        }
      ]
    })
    await expect(store.setTranscript(1, overlapping)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_op',
      currentRevision: 1
    })

    const invalidConfidence = transcript({
      segments: [
        {
          segmentId: 'confidence',
          text: 'Confidence',
          sourceIn: { n: 0, d: 1 },
          sourceOut: { n: 1, d: 1 },
          confidence: 1.1
        }
      ]
    })
    await expect(store.setTranscript(1, invalidConfidence)).resolves.toMatchObject({
      ok: false,
      code: 'invalid_params',
      currentRevision: 1
    })
    expect(store.revision).toBe(1)
    expect(store.getDocument().transcripts).toEqual([])
    await store.close()
  })

  it('rejects stale transcript replacement without changing durable data', async () => {
    const directory = await makeStoreDirectory()
    const store = await StudioRevisionStore.open(directory, { allowedMediaRoots: [directory] })
    await openTranscriptAsset(store, directory)
    await store.setTranscript(1, transcript())

    await expect(
      store.setTranscript(1, transcript({ localeIdentifier: 'fr-FR' }))
    ).resolves.toMatchObject({ ok: false, code: 'stale_base', currentRevision: 2 })
    expect(store.getDocument().transcripts[0].localeIdentifier).toBe('en-US')
    await store.close()
  })

  it('persists a ghost proposal without touching the timeline, then accepts it atomically', async () => {
    const store = await StudioRevisionStore.open(await makeStoreDirectory())
    const proposed = await store.proposeEdit(0, 'proposal-1', insertRange())
    expect(proposed).toMatchObject({
      ok: true,
      revision: 1,
      proposal: {
        schemaVersion: STUDIO_PROPOSAL_SCHEMA_VERSION,
        proposalId: 'proposal-1',
        createdRevision: 1
      }
    })
    expect(store.getDocument()).toMatchObject({
      proposals: [{ proposalId: 'proposal-1' }],
      tracks: []
    })

    const accepted = await store.resolveProposal(1, 'proposal-1', 'accept')
    expect(accepted).toMatchObject({
      ok: true,
      revision: 2,
      proposalId: 'proposal-1',
      decision: 'accept',
      appliedOp: { type: 'insert_range', itemId: 'item-1' }
    })
    const document = store.getDocument()
    expect(document.proposals).toEqual([])
    expect(document.tracks[0].items[0].itemId).toBe('item-1')
    await store.close()
  })

  it('replays open proposals after restart and rejects them without changing the timeline', async () => {
    const directory = await makeStoreDirectory()
    const first = await StudioRevisionStore.open(directory)
    await first.proposeEdit(0, 'proposal-replay', insertRange())
    await first.close()

    const reopened = await StudioRevisionStore.open(directory)
    expect(reopened.recovery.replayedJournalOps).toBe(1)
    expect(reopened.getDocument().proposals).toMatchObject([
      { proposalId: 'proposal-replay', createdRevision: 1 }
    ])
    const rejected = await reopened.resolveProposal(1, 'proposal-replay', 'reject')
    expect(rejected).toEqual({
      ok: true,
      revision: 2,
      proposalId: 'proposal-replay',
      decision: 'reject'
    })
    expect(reopened.getDocument()).toMatchObject({ proposals: [], tracks: [] })
    await reopened.close()
  })

  it('rejects stale, duplicate and unknown proposal transitions without advancing revision', async () => {
    const store = await StudioRevisionStore.open(await makeStoreDirectory())
    await store.proposeEdit(0, 'proposal-1', insertRange())

    await expect(
      store.proposeEdit(0, 'stale-proposal', insertRange({ itemId: 'stale' }))
    ).resolves.toMatchObject({ ok: false, code: 'stale_base', currentRevision: 1 })
    await expect(
      store.proposeEdit(1, 'proposal-1', insertRange({ itemId: 'duplicate' }))
    ).resolves.toMatchObject({ ok: false, code: 'duplicate_proposal', currentRevision: 1 })
    await expect(store.resolveProposal(1, 'missing', 'accept')).resolves.toMatchObject({
      ok: false,
      code: 'proposal_not_found',
      currentRevision: 1
    })
    expect(store.revision).toBe(1)
    await store.close()
  })

  it('keeps a proposal open when acceptance no longer applies atomically', async () => {
    const store = await StudioRevisionStore.open(await makeStoreDirectory())
    await store.proposeEdit(0, 'proposal-conflict', insertRange({ itemId: 'shared-item' }))
    await store.applyEdit(1, insertRange({ itemId: 'shared-item' }))

    const accepted = await store.resolveProposal(2, 'proposal-conflict', 'accept')
    expect(accepted).toMatchObject({
      ok: false,
      code: 'duplicate_item',
      currentRevision: 2
    })
    expect(store.revision).toBe(2)
    expect(store.getDocument().proposals).toMatchObject([{ proposalId: 'proposal-conflict' }])
    expect(store.getDocument().tracks[0].items).toHaveLength(1)
    await store.close()
  })

  it('keeps open proposals in a compacted v3 snapshot', async () => {
    const directory = await makeStoreDirectory()
    const first = await StudioRevisionStore.open(directory, { compactEveryOps: 1 })
    await first.proposeEdit(0, 'proposal-snapshot', insertRange())
    await first.close()

    const snapshot = JSON.parse(
      await fsPromises.readFile(nodePath.join(directory, STUDIO_SNAPSHOT_FILENAME), 'utf8')
    ) as { document: { formatVersion: number; proposals: unknown[] } }
    expect(snapshot.document).toMatchObject({
      formatVersion: STUDIO_DOCUMENT_FORMAT_VERSION,
      proposals: [{ proposalId: 'proposal-snapshot' }]
    })

    const reopened = await StudioRevisionStore.open(directory)
    expect(reopened.recovery.replayedJournalOps).toBe(0)
    expect(reopened.getDocument().proposals).toMatchObject([{ proposalId: 'proposal-snapshot' }])
    await reopened.close()
  })

  it('migrates document-format v2 snapshots while preserving open proposals', async () => {
    const directory = await makeStoreDirectory()
    const openProposal = {
      schemaVersion: STUDIO_PROPOSAL_SCHEMA_VERSION,
      proposalId: 'v2-proposal',
      createdRevision: 3,
      op: insertRange()
    }
    await fsPromises.writeFile(
      nodePath.join(directory, STUDIO_SNAPSHOT_FILENAME),
      JSON.stringify({
        format: STUDIO_SNAPSHOT_FORMAT,
        v: 1,
        revision: 3,
        document: {
          formatVersion: 2,
          assets: [],
          proposals: [openProposal],
          tracks: []
        }
      }),
      'utf8'
    )

    const store = await StudioRevisionStore.open(directory)
    expect(store.getDocument()).toMatchObject({
      formatVersion: STUDIO_DOCUMENT_FORMAT_VERSION,
      proposals: [{ proposalId: 'v2-proposal' }],
      transcripts: []
    })
    await store.close()
  })

  it('migrates document-format v1 snapshots with no proposals or transcripts into v3', async () => {
    const directory = await makeStoreDirectory()
    await fsPromises.writeFile(
      nodePath.join(directory, STUDIO_SNAPSHOT_FILENAME),
      JSON.stringify({
        format: STUDIO_SNAPSHOT_FORMAT,
        v: 1,
        revision: 4,
        document: { formatVersion: 1, assets: [], tracks: [] }
      }),
      'utf8'
    )

    const store = await StudioRevisionStore.open(directory)
    expect(store.revision).toBe(4)
    expect(store.getDocument()).toEqual({
      formatVersion: STUDIO_DOCUMENT_FORMAT_VERSION,
      assets: [],
      proposals: [],
      transcripts: [],
      tracks: []
    })
    await store.close()
  })

  it('exposes a pure apply function that never mutates its input document', () => {
    const document = createEmptyStudioDocument()
    const next = applyStudioEditOp(document, insertRange())
    expect(document.tracks).toHaveLength(0)
    expect(next.tracks).toHaveLength(1)
  })
})
