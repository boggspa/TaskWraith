import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES,
  TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES,
  TRANSCRIPT_MEDIA_MAX_PDF_BYTES,
  TRANSCRIPT_MEDIA_MAX_VIDEO_BYTES,
  TRANSCRIPT_MEDIA_OWNERSHIP_FILE,
  TRANSCRIPT_MEDIA_OWNERSHIP_MAX_ASSETS,
  TRANSCRIPT_MEDIA_OWNERSHIP_MAX_CHATS_PER_ASSET,
  TRANSCRIPT_MEDIA_OWNERSHIP_MAX_FILE_BYTES,
  TranscriptMediaAssetStore,
  maxTranscriptMediaBytesForMime,
  transcriptMediaAssetPath
} from './TranscriptMediaAssetStore'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-media-assets-'))
  roots.push(root)
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
  while (roots.length) {
    const root = roots.pop()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  }
})
describe('TranscriptMediaAssetStore', () => {
  it('durably binds an optional write owner to the exact asset and chat', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const persisted = store.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('owned-image'),
      appChatId: 'chat-1'
    })
    expect(persisted.ok).toBe(true)
    if (!persisted.ok) return

    expect(
      store.owns({ sha256: persisted.sha256, mimeType: 'image/png', appChatId: 'chat-1' })
    ).toBe(true)
    expect(
      store.owns({ sha256: persisted.sha256, mimeType: 'image/png', appChatId: 'chat-10' })
    ).toBe(false)
    expect(
      store.owns({ sha256: persisted.sha256, mimeType: 'image/jpeg', appChatId: 'chat-1' })
    ).toBe(false)

    const restarted = new TranscriptMediaAssetStore(root)
    expect(
      restarted.owns({ sha256: persisted.sha256, mimeType: 'image/png', appChatId: 'chat-1' })
    ).toBe(true)
    const ledgerPath = path.join(root, TRANSCRIPT_MEDIA_OWNERSHIP_FILE)
    expect(fs.lstatSync(ledgerPath).isSymbolicLink()).toBe(false)
    expect(fs.statSync(ledgerPath).mode & 0o077).toBe(0)
    expect(fs.readdirSync(root).some((entry) => entry.endsWith('.tmp'))).toBe(false)
  })

  it('grants existing assets directly and persists duplicate content owners idempotently', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const persisted = store.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('shared-image')
    })
    expect(persisted.ok).toBe(true)
    if (!persisted.ok) return

    expect(
      store.grant({ sha256: persisted.sha256, mimeType: 'image/png', appChatId: 'chat-1' })
    ).toEqual({ ok: true })
    expect(
      store.write({
        sha256: persisted.sha256,
        mimeType: 'image/png',
        buffer: Buffer.from('shared-image'),
        appChatId: 'chat-2'
      })
    ).toEqual({ ok: true })
    expect(
      new TranscriptMediaAssetStore(root).owns({
        sha256: persisted.sha256,
        mimeType: 'image/png',
        appChatId: 'chat-2'
      })
    ).toBe(true)
    expect(
      store.grant({
        sha256: 'missingHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ',
        mimeType: 'image/png',
        appChatId: 'chat-1'
      })
    ).toEqual({ ok: false, reason: 'missing' })
    expect(
      store.grant({
        sha256: persisted.sha256,
        mimeType: 'image/png',
        appChatId: 'x'.repeat(513)
      })
    ).toEqual({ ok: false, reason: 'invalid_chat' })
  })

  it('backfills canonical ownership in one atomic write and skips an idempotent replay', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const first = store.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('bulk-first')
    })
    const second = store.writeContentAddressed({
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF bulk-second')
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(
      store.grant({ sha256: first.sha256, mimeType: first.mimeType, appChatId: 'chat-a' })
    ).toEqual({ ok: true })

    const inputs = [
      { sha256: first.sha256, mimeType: first.mimeType, appChatId: 'chat-a' },
      { sha256: first.sha256, mimeType: first.mimeType, appChatId: 'chat-b' },
      { sha256: first.sha256, mimeType: first.mimeType, appChatId: 'chat-b' },
      { sha256: second.sha256, mimeType: second.mimeType, appChatId: 'chat-c' }
    ]
    const rename = vi.spyOn(fs, 'renameSync')

    expect(store.backfillOwnership(inputs)).toEqual({
      ok: true,
      requestedGrants: 4,
      distinctGrants: 3,
      assetsChecked: 2,
      addedGrants: 2,
      existingGrants: 1,
      duplicateRequests: 1,
      persisted: true
    })
    expect(rename).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fs.readFileSync(path.join(root, TRANSCRIPT_MEDIA_OWNERSHIP_FILE), 'utf8')))
      .toMatchObject({ version: 1 })
    const restarted = new TranscriptMediaAssetStore(root)
    expect(
      restarted.owns({ sha256: first.sha256, mimeType: first.mimeType, appChatId: 'chat-b' })
    ).toBe(true)
    expect(
      restarted.owns({ sha256: second.sha256, mimeType: second.mimeType, appChatId: 'chat-c' })
    ).toBe(true)

    rename.mockClear()
    expect(store.backfillOwnership(inputs)).toEqual({
      ok: true,
      requestedGrants: 4,
      distinctGrants: 3,
      assetsChecked: 2,
      addedGrants: 0,
      existingGrants: 3,
      duplicateRequests: 1,
      persisted: false
    })
    expect(rename).not.toHaveBeenCalled()
  })

  it('rejects invalid or missing bulk inputs without partially granting earlier entries', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const persisted = store.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('bulk-valid')
    })
    expect(persisted.ok).toBe(true)
    if (!persisted.ok) return
    const valid = { sha256: persisted.sha256, mimeType: persisted.mimeType, appChatId: 'chat-a' }

    expect(
      store.backfillOwnership([
        valid,
        {
          sha256: 'missingBulk_abcdefghijklmnopqrstuvwxyz0123456789-XYZ',
          mimeType: 'image/png',
          appChatId: 'chat-b'
        }
      ])
    ).toEqual({ ok: false, reason: 'missing', failedAt: 1 })
    expect(store.owns(valid)).toBe(false)

    expect(
      store.backfillOwnership([
        valid,
        { ...valid, appChatId: 'x'.repeat(513) }
      ])
    ).toEqual({ ok: false, reason: 'invalid_chat', failedAt: 1 })
    expect(store.owns(valid)).toBe(false)
    expect(
      store.backfillOwnership([{ ...valid, mimeType: 'image/svg+xml' }])
    ).toEqual({ ok: false, reason: 'invalid_asset', failedAt: 0 })
    expect(fs.existsSync(path.join(root, TRANSCRIPT_MEDIA_OWNERSHIP_FILE))).toBe(false)
  })

  it('enforces per-asset and total-asset ownership limits before persisting', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const persisted = store.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('bounded-bulk')
    })
    expect(persisted.ok).toBe(true)
    if (!persisted.ok) return
    expect(
      store.backfillOwnership(
        Array.from({ length: TRANSCRIPT_MEDIA_OWNERSHIP_MAX_CHATS_PER_ASSET }, (_, index) => ({
          sha256: persisted.sha256,
          mimeType: persisted.mimeType,
          appChatId: `chat-${index}`
        }))
      ).ok
    ).toBe(true)
    const ledgerPath = path.join(root, TRANSCRIPT_MEDIA_OWNERSHIP_FILE)
    const boundedLedger = fs.readFileSync(ledgerPath)
    expect(
      store.backfillOwnership([
        {
          sha256: persisted.sha256,
          mimeType: persisted.mimeType,
          appChatId: 'one-chat-too-many'
        }
      ])
    ).toEqual({ ok: false, reason: 'ownership_limit', failedAt: 0 })
    expect(fs.readFileSync(ledgerPath).equals(boundedLedger)).toBe(true)

    const assetLimitRoot = makeRoot()
    fs.writeFileSync(
      path.join(assetLimitRoot, TRANSCRIPT_MEDIA_OWNERSHIP_FILE),
      JSON.stringify({
        version: 1,
        grants: Array.from({ length: TRANSCRIPT_MEDIA_OWNERSHIP_MAX_ASSETS }, (_, index) => ({
          asset: `a${String(index).padStart(31, '0')}.png`,
          appChatIds: ['existing-chat']
        }))
      }),
      { mode: 0o600 }
    )
    const fullStore = new TranscriptMediaAssetStore(assetLimitRoot)
    const newHash = 'z'.repeat(32)
    expect(
      fullStore.write({ sha256: newHash, mimeType: 'image/png', buffer: Buffer.from('new-asset') })
    ).toEqual({ ok: true })
    const fullLedger = fs.readFileSync(path.join(assetLimitRoot, TRANSCRIPT_MEDIA_OWNERSHIP_FILE))
    expect(
      fullStore.backfillOwnership([
        { sha256: newHash, mimeType: 'image/png', appChatId: 'new-chat' }
      ])
    ).toEqual({ ok: false, reason: 'ownership_limit' })
    expect(
      fs
        .readFileSync(path.join(assetLimitRoot, TRANSCRIPT_MEDIA_OWNERSHIP_FILE))
        .equals(fullLedger)
    ).toBe(true)
  })

  it('enforces the ledger byte cap and retains in-memory state after persistence failure', () => {
    const root = makeRoot()
    const grantCount = 48_000
    const grants = Array.from({ length: grantCount }, (_, index) => ({
      asset: `a${String(index).padStart(31, '0')}.png`,
      appChatIds: [`c${String(index).padStart(5, '0')}-${'x'.repeat(100)}`]
    }))
    const baseLength = Buffer.byteLength(JSON.stringify({ version: 1, grants }))
    const targetLength = TRANSCRIPT_MEDIA_OWNERSHIP_MAX_FILE_BYTES - 256
    const paddingCount = targetLength - baseLength
    expect(paddingCount).toBeGreaterThan(0)
    expect(paddingCount).toBeLessThan(grantCount)
    for (let index = 0; index < paddingCount; index += 1) {
      grants[index].appChatIds[0] += 'x'
    }
    const nearLimitLedger = JSON.stringify({ version: 1, grants })
    expect(Buffer.byteLength(nearLimitLedger)).toBe(targetLength)
    const ledgerPath = path.join(root, TRANSCRIPT_MEDIA_OWNERSHIP_FILE)
    fs.writeFileSync(ledgerPath, nearLimitLedger, { mode: 0o600 })
    const store = new TranscriptMediaAssetStore(root)
    const sha256 = grants[0].asset.slice(0, -4)
    expect(
      store.write({ sha256, mimeType: 'image/png', buffer: Buffer.from('near-limit-asset') })
    ).toEqual({ ok: true })
    expect(
      store.backfillOwnership([
        { sha256, mimeType: 'image/png', appChatId: 'z'.repeat(512) }
      ])
    ).toEqual({ ok: false, reason: 'ownership_limit' })
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(nearLimitLedger)
    expect(store.owns({ sha256, mimeType: 'image/png', appChatId: 'z'.repeat(512) })).toBe(false)

    const failureRoot = makeRoot()
    const failureStore = new TranscriptMediaAssetStore(failureRoot)
    const retained = failureStore.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('retained-owner'),
      appChatId: 'retained-chat'
    })
    const pending = failureStore.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('pending-owner')
    })
    expect(retained.ok).toBe(true)
    expect(pending.ok).toBe(true)
    if (!retained.ok || !pending.ok) return
    const failureLedgerPath = path.join(failureRoot, TRANSCRIPT_MEDIA_OWNERSHIP_FILE)
    fs.unlinkSync(failureLedgerPath)
    fs.mkdirSync(failureLedgerPath)
    expect(
      failureStore.backfillOwnership([
        { sha256: pending.sha256, mimeType: pending.mimeType, appChatId: 'pending-chat' }
      ])
    ).toEqual({ ok: false, reason: 'persistence_failed' })
    expect(
      failureStore.owns({
        sha256: retained.sha256,
        mimeType: retained.mimeType,
        appChatId: 'retained-chat'
      })
    ).toBe(true)
    expect(
      failureStore.owns({
        sha256: pending.sha256,
        mimeType: pending.mimeType,
        appChatId: 'pending-chat'
      })
    ).toBe(false)
  })

  it('transfers a grant only from an owner after the trusted relation verifier passes', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const persisted = store.writeContentAddressed({
      mimeType: 'video/mp4',
      buffer: Buffer.from('owned-video'),
      appChatId: 'parent-chat'
    })
    expect(persisted.ok).toBe(true)
    if (!persisted.ok) return
    const verifier = vi.fn(() => true)

    expect(
      store.grantVerifiedTransfer(
        {
          sha256: persisted.sha256,
          mimeType: 'video/mp4',
          sourceAppChatId: 'not-an-owner',
          targetAppChatId: 'child-chat'
        },
        verifier
      )
    ).toEqual({ ok: false, reason: 'not_owner' })
    expect(verifier).not.toHaveBeenCalled()

    verifier.mockReturnValueOnce(false)
    expect(
      store.grantVerifiedTransfer(
        {
          sha256: persisted.sha256,
          mimeType: 'video/mp4',
          sourceAppChatId: 'parent-chat',
          targetAppChatId: 'child-chat'
        },
        verifier
      )
    ).toEqual({ ok: false, reason: 'unverified' })
    expect(
      store.owns({ sha256: persisted.sha256, mimeType: 'video/mp4', appChatId: 'child-chat' })
    ).toBe(false)

    expect(
      store.grantVerifiedTransfer(
        {
          sha256: persisted.sha256,
          mimeType: 'video/mp4',
          sourceAppChatId: 'parent-chat',
          targetAppChatId: 'child-chat'
        },
        verifier
      )
    ).toEqual({ ok: true })
    const restarted = new TranscriptMediaAssetStore(root)
    expect(
      restarted.owns({ sha256: persisted.sha256, mimeType: 'video/mp4', appChatId: 'parent-chat' })
    ).toBe(true)
    expect(
      restarted.owns({ sha256: persisted.sha256, mimeType: 'video/mp4', appChatId: 'child-chat' })
    ).toBe(true)
  })

  it('fails a chat-bound write closed when its durable ownership grant cannot persist', () => {
    const root = makeRoot()
    const ownershipPath = path.join(root, TRANSCRIPT_MEDIA_OWNERSHIP_FILE)
    fs.mkdirSync(ownershipPath)
    const store = new TranscriptMediaAssetStore(root)
    const buffer = Buffer.from('unowned-on-ledger-failure')
    const sha256 = 'ledgerFailure_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'

    expect(store.write({ sha256, mimeType: 'image/png', buffer, appChatId: 'chat-1' })).toEqual({
      ok: false,
      reason: 'persistence_failed'
    })
    expect(store.owns({ sha256, mimeType: 'image/png', appChatId: 'chat-1' })).toBe(false)
    expect(fs.readdirSync(root).some((entry) => entry.endsWith('.tmp'))).toBe(false)
  })

  it('ignores hostile or over-budget ownership ledgers and never follows a ledger symlink', () => {
    const root = makeRoot()
    const outside = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const persisted = store.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('symlink-ledger-image')
    })
    expect(persisted.ok).toBe(true)
    if (!persisted.ok) return
    const ledgerPath = path.join(root, TRANSCRIPT_MEDIA_OWNERSHIP_FILE)
    const outsideLedger = path.join(outside, 'outside.json')
    const outsideContents = JSON.stringify({
      version: 1,
      grants: [{ asset: `${persisted.sha256}.png`, appChatIds: ['attacker-chat'] }]
    })
    fs.writeFileSync(outsideLedger, outsideContents, { mode: 0o600 })
    fs.symlinkSync(outsideLedger, ledgerPath)

    const linked = new TranscriptMediaAssetStore(root)
    expect(
      linked.owns({
        sha256: persisted.sha256,
        mimeType: 'image/png',
        appChatId: 'attacker-chat'
      })
    ).toBe(false)
    expect(
      linked.grant({ sha256: persisted.sha256, mimeType: 'image/png', appChatId: 'chat-1' })
    ).toEqual({ ok: true })
    expect(fs.lstatSync(ledgerPath).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(outsideLedger, 'utf8')).toBe(outsideContents)

    fs.writeFileSync(
      ledgerPath,
      Buffer.alloc(TRANSCRIPT_MEDIA_OWNERSHIP_MAX_FILE_BYTES + 1),
      { mode: 0o600 }
    )
    expect(
      new TranscriptMediaAssetStore(root).owns({
        sha256: persisted.sha256,
        mimeType: 'image/png',
        appChatId: 'chat-1'
      })
    ).toBe(false)
  })

  it('rejects an ownership ledger whose per-asset chat bound is exceeded', () => {
    const root = makeRoot()
    const sha256 = 'boundedLedger_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'
    fs.writeFileSync(
      path.join(root, TRANSCRIPT_MEDIA_OWNERSHIP_FILE),
      JSON.stringify({
        version: 1,
        grants: [
          {
            asset: `${sha256}.png`,
            appChatIds: Array.from(
              { length: TRANSCRIPT_MEDIA_OWNERSHIP_MAX_CHATS_PER_ASSET + 1 },
              (_, index) => `chat-${index}`
            )
          }
        ]
      }),
      { mode: 0o600 }
    )

    expect(
      new TranscriptMediaAssetStore(root).owns({
        sha256,
        mimeType: 'image/png',
        appChatId: 'chat-0'
      })
    ).toBe(false)
  })

  it('writes and reads original image bytes by content hash', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const sha256 = 'abcDEF1234567890_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'
    const buffer = Buffer.from('image-bytes')

    expect(store.write({ sha256, mimeType: 'image/png', buffer })).toEqual({ ok: true })
    expect(transcriptMediaAssetPath(root, sha256, 'image/png')).toBe(
      path.join(root, 'ab', `${sha256}.png`)
    )
    expect(store.read({ sha256, mimeType: 'image/png' })).toMatchObject({
      ok: true,
      byteLength: buffer.length
    })
    const read = store.read({ sha256, mimeType: 'image/png' })
    expect(read.ok && read.buffer.equals(buffer)).toBe(true)
  })

  it('treats duplicate writes as successful idempotent writes', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const sha256 = 'duplicateHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'
    const buffer = Buffer.from('same-bytes')

    expect(store.write({ sha256, mimeType: 'image/jpeg', buffer })).toEqual({ ok: true })
    expect(store.write({ sha256, mimeType: 'image/jpeg', buffer })).toEqual({ ok: true })
  })

  it('rejects invalid hashes, unsupported MIME types, and over-budget reads', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const sha256 = 'sizeHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'
    const buffer = Buffer.from('image-bytes')

    expect(store.write({ sha256: '../bad', mimeType: 'image/png', buffer }).ok).toBe(false)
    expect(store.write({ sha256, mimeType: 'image/svg+xml', buffer })).toEqual({
      ok: false,
      reason: 'unsupported'
    })
    expect(store.write({ sha256, mimeType: 'image/png', buffer })).toEqual({ ok: true })
    expect(store.read({ sha256, mimeType: 'image/png', maxBytes: 4 })).toEqual({
      ok: false,
      reason: 'too_large'
    })
    expect(
      store.write({
        sha256: 'largeHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ',
        mimeType: 'image/png',
        buffer: Buffer.alloc(TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES + 1)
      })
    ).toEqual({ ok: false, reason: 'too_large' })
  })

  it('stores audio + video assets by content hash with the right extension (S0a)', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const wav = {
      sha256: 'wavHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ',
      mimeType: 'audio/wav',
      buffer: Buffer.from('RIFF....WAVEdata')
    }
    expect(store.write(wav)).toEqual({ ok: true })
    expect(transcriptMediaAssetPath(root, wav.sha256, 'audio/wav')).toBe(
      path.join(root, 'wa', `${wav.sha256}.wav`)
    )
    const readWav = store.read({ sha256: wav.sha256, mimeType: 'audio/wav' })
    expect(readWav.ok && readWav.buffer.equals(wav.buffer)).toBe(true)

    const mp4 = {
      sha256: 'mp4Hash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ',
      mimeType: 'video/mp4',
      buffer: Buffer.from('ftypisomMOOV')
    }
    expect(store.write(mp4)).toEqual({ ok: true })
    expect(transcriptMediaAssetPath(root, mp4.sha256, 'video/mp4')).toBe(
      path.join(root, 'mp', `${mp4.sha256}.mp4`)
    )
  })

  it('stores PDF snapshots by content hash with the PDF byte budget', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const pdf = Buffer.from('%PDF-1.7\nfixture\n%%EOF\n')
    const persisted = store.writeContentAddressed({ mimeType: 'application/pdf', buffer: pdf })

    expect(persisted).toMatchObject({
      ok: true,
      byteLength: pdf.length,
      path: expect.stringMatching(/\.pdf$/)
    })
    if (!persisted.ok) return
    expect(transcriptMediaAssetPath(root, persisted.sha256, 'application/pdf')).toBe(
      path.join(root, persisted.sha256.slice(0, 2), `${persisted.sha256}.pdf`)
    )
    const read = store.read({ sha256: persisted.sha256, mimeType: 'application/pdf' })
    expect(read.ok && read.buffer.equals(pdf)).toBe(true)
    expect(
      store.resolvePersistedAttachment({
        persistenceVersion: 1,
        path: persisted.path,
        sha256: persisted.sha256,
        mimeType: 'application/pdf',
        byteLength: persisted.byteLength
      })
    ).toEqual({
      ok: true,
      attachment: {
        persistenceVersion: 1,
        path: persisted.path,
        sha256: persisted.sha256,
        mimeType: 'application/pdf',
        byteLength: pdf.length
      }
    })
    expect(maxTranscriptMediaBytesForMime('application/pdf')).toBe(
      TRANSCRIPT_MEDIA_MAX_PDF_BYTES
    )
  })

  it('fails closed when a durable ref points outside the store or its bytes do not match the hash', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const persisted = store.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('original')
    })
    expect(persisted.ok).toBe(true)
    if (!persisted.ok) return

    expect(
      store.resolvePersistedAttachment({
        persistenceVersion: 1,
        path: path.join(makeRoot(), 'outside.png'),
        sha256: persisted.sha256,
        mimeType: 'image/png',
        byteLength: persisted.byteLength
      })
    ).toEqual({ ok: false, reason: 'missing' })

    fs.writeFileSync(persisted.path, Buffer.from('replaced'))
    expect(
      store.resolvePersistedAttachment({
        persistenceVersion: 1,
        path: persisted.path,
        sha256: persisted.sha256,
        mimeType: 'image/png',
        byteLength: Buffer.byteLength('replaced')
      })
    ).toEqual({ ok: false, reason: 'content_mismatch' })
  })

  it('refuses symlink replacement and symlink shard escapes on reads and writes', () => {
    const root = makeRoot()
    const outside = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const persisted = store.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('image-bytes')
    })
    expect(persisted.ok).toBe(true)
    if (!persisted.ok) return

    const outsideFile = path.join(outside, 'outside.png')
    fs.writeFileSync(outsideFile, 'replacement')
    fs.unlinkSync(persisted.path)
    fs.symlinkSync(outsideFile, persisted.path)
    expect(store.read({ sha256: persisted.sha256, mimeType: 'image/png' })).toEqual({
      ok: false,
      reason: 'missing'
    })

    const escapedHash = 'abHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'
    const escapedRoot = makeRoot()
    const escapedOutside = makeRoot()
    fs.symlinkSync(escapedOutside, path.join(escapedRoot, 'ab'), 'dir')
    expect(
      new TranscriptMediaAssetStore(escapedRoot).write({
        sha256: escapedHash,
        mimeType: 'image/png',
        buffer: Buffer.from('must-not-escape')
      })
    ).toEqual({ ok: false, reason: 'unsafe_asset_path' })
    expect(fs.readdirSync(escapedOutside)).toEqual([])
  })

  it('refuses a symlinked asset-store root without writing bytes outside it', () => {
    const container = makeRoot()
    const outside = makeRoot()
    const linkedRoot = path.join(container, 'linked-media-root')
    fs.symlinkSync(outside, linkedRoot, 'dir')

    expect(
      new TranscriptMediaAssetStore(linkedRoot).write({
        sha256: 'rootEscape_abcdefghijklmnopqrstuvwxyz0123456789-XYZ',
        mimeType: 'image/png',
        buffer: Buffer.from('must-not-escape'),
        appChatId: 'chat-1'
      })
    ).toEqual({ ok: false, reason: 'unsafe_asset_path' })
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('keys byte caps off the MIME kind (audio/video far exceed the image cap)', () => {
    expect(maxTranscriptMediaBytesForMime('image/png')).toBe(TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES)
    expect(maxTranscriptMediaBytesForMime('audio/wav')).toBe(TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES)
    expect(maxTranscriptMediaBytesForMime('video/mp4')).toBe(TRANSCRIPT_MEDIA_MAX_VIDEO_BYTES)
    expect(maxTranscriptMediaBytesForMime('application/pdf')).toBe(
      TRANSCRIPT_MEDIA_MAX_PDF_BYTES
    )
    expect(maxTranscriptMediaBytesForMime('application/octet-stream')).toBe(
      TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES
    )
    expect(TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES).toBeGreaterThan(TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES)
    expect(TRANSCRIPT_MEDIA_MAX_VIDEO_BYTES).toBeGreaterThan(TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES)
  })

  it('reads back an audio asset larger than the 8MB image cap without truncating', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const sha256 = 'bigAudioHash_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'
    // 9MB > the legacy 8MB image read-clamp — must NOT be rejected or truncated for audio.
    const buffer = Buffer.alloc(TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES + 1024 * 1024, 7)
    expect(store.write({ sha256, mimeType: 'audio/wav', buffer })).toEqual({ ok: true })
    const read = store.read({ sha256, mimeType: 'audio/wav' })
    expect(read.ok && read.byteLength).toBe(buffer.length)
  })
})
