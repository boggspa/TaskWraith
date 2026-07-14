import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
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

function interceptIngestTempWrites(
  hook: (input: { call: number; phase: 'before' | 'after' }) => void | Promise<void>
): void {
  const realOpen = fs.promises.open.bind(fs.promises)
  vi.spyOn(fs.promises, 'open').mockImplementation(
    (async (file: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
      const handle = await realOpen(file, flags ?? 'r', mode)
      if (typeof file !== 'string' || !path.basename(file).startsWith('.ingest-')) {
        return handle
      }
      const originalWrite = handle.write.bind(handle)
      let call = 0
      Object.defineProperty(handle, 'write', {
        configurable: true,
        value: async (
          buffer: Uint8Array,
          offset?: number,
          length?: number,
          position?: number | null
        ) => {
          call += 1
          await hook({ call, phase: 'before' })
          const result = await originalWrite(buffer, offset, length, position)
          await hook({ call, phase: 'after' })
          return result
        }
      })
      return handle
    }) as typeof fs.promises.open
  )
}

function limitDescriptorReads(filePaths: ReadonlySet<string>, maxBytesPerRead: number): void {
  const realOpen = fs.promises.open.bind(fs.promises)
  vi.spyOn(fs.promises, 'open').mockImplementation(
    (async (file: fs.PathLike, flags?: string | number, mode?: fs.Mode) => {
      const handle = await realOpen(file, flags ?? 'r', mode)
      if (typeof file !== 'string' || !filePaths.has(file)) return handle
      const originalRead = handle.read.bind(handle)
      Object.defineProperty(handle, 'read', {
        configurable: true,
        value: (
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number | null
        ) => originalRead(buffer, offset, Math.min(length, maxBytesPerRead), position)
      })
      return handle
    }) as typeof fs.promises.open
  )
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

  it('grants many distinct owners in one durable replacement and skips duplicate replays', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const first = store.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('grant-many-first')
    })
    const second = store.writeContentAddressed({
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF grant-many-second')
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    const inputs = [
      { sha256: first.sha256, mimeType: first.mimeType, appChatId: 'chat-a' },
      { sha256: first.sha256, mimeType: first.mimeType, appChatId: 'chat-b' },
      { sha256: first.sha256, mimeType: first.mimeType, appChatId: 'chat-b' },
      { sha256: second.sha256, mimeType: second.mimeType, appChatId: 'chat-c' }
    ]
    const rename = vi.spyOn(fs, 'renameSync')

    expect(store.grantMany(inputs)).toEqual({ ok: true })
    expect(rename).toHaveBeenCalledTimes(1)
    expect(store.owns(inputs[0])).toBe(true)
    expect(store.owns(inputs[1])).toBe(true)
    expect(store.owns(inputs[3])).toBe(true)

    const restarted = new TranscriptMediaAssetStore(root)
    expect(restarted.owns(inputs[0])).toBe(true)
    expect(restarted.owns(inputs[1])).toBe(true)
    expect(restarted.owns(inputs[3])).toBe(true)

    rename.mockClear()
    expect(store.grantMany(inputs)).toEqual({ ok: true })
    expect(store.grantMany([])).toEqual({ ok: true })
    expect(rename).not.toHaveBeenCalled()
  })

  it('leaves the ownership ledger and memory unchanged when a batch replacement fails', () => {
    const root = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const retained = store.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('grant-many-retained'),
      appChatId: 'retained-chat'
    })
    const pending = store.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from('grant-many-pending')
    })
    expect(retained.ok).toBe(true)
    expect(pending.ok).toBe(true)
    if (!retained.ok || !pending.ok) return
    const ledgerPath = path.join(root, TRANSCRIPT_MEDIA_OWNERSHIP_FILE)
    const originalLedger = fs.readFileSync(ledgerPath)
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('simulated atomic replacement failure')
    })

    const firstGrant = {
      sha256: retained.sha256,
      mimeType: retained.mimeType,
      appChatId: 'pending-chat-a'
    }
    const secondGrant = {
      sha256: pending.sha256,
      mimeType: pending.mimeType,
      appChatId: 'pending-chat-b'
    }
    expect(store.grantMany([firstGrant, secondGrant])).toEqual({
      ok: false,
      reason: 'persistence_failed'
    })
    expect(store.owns(firstGrant)).toBe(false)
    expect(store.owns(secondGrant)).toBe(false)
    expect(
      store.owns({
        sha256: retained.sha256,
        mimeType: retained.mimeType,
        appChatId: 'retained-chat'
      })
    ).toBe(true)
    expect(fs.readFileSync(ledgerPath).equals(originalLedger)).toBe(true)
    expect(fs.readdirSync(root).some((entry) => entry.endsWith('.tmp'))).toBe(false)

    const restarted = new TranscriptMediaAssetStore(root)
    expect(restarted.owns(firstGrant)).toBe(false)
    expect(restarted.owns(secondGrant)).toBe(false)
    expect(
      restarted.owns({
        sha256: retained.sha256,
        mimeType: retained.mimeType,
        appChatId: 'retained-chat'
      })
    ).toBe(true)
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
      store.grantMany([
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
    expect(store.grantMany([{ ...valid, mimeType: 'image/svg+xml' }])).toEqual({
      ok: false,
      reason: 'invalid_asset',
      failedAt: 0
    })
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
      store.grantMany([
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
      fullStore.grantMany([
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

  it.each([
    {
      name: 'invalid JSON',
      ledger: (_asset: string) => Buffer.from('{"version":1,"grants":[', 'utf8')
    },
    {
      name: 'a malformed entry',
      ledger: (asset: string) =>
        Buffer.from(
          JSON.stringify({
            version: 1,
            grants: [
              { asset, appChatIds: ['source-chat'] },
              { asset: '../../outside.png', appChatIds: ['attacker-chat'] }
            ]
          }),
          'utf8'
        )
    }
  ])(
    'locks every ownership mutation after loading $name without replacing its bytes',
    ({ ledger }) => {
      const root = makeRoot()
      const seed = new TranscriptMediaAssetStore(root)
      const buffer = Buffer.from('corrupt-ledger-image')
      const persisted = seed.writeContentAddressed({ mimeType: 'image/png', buffer })
      expect(persisted.ok).toBe(true)
      if (!persisted.ok) return
      const ledgerPath = path.join(root, TRANSCRIPT_MEDIA_OWNERSHIP_FILE)
      const ledgerBytes = ledger(`${persisted.sha256}.png`)
      fs.writeFileSync(ledgerPath, ledgerBytes, { mode: 0o600 })

      const store = new TranscriptMediaAssetStore(root)
      expect(
        store.owns({
          sha256: persisted.sha256,
          mimeType: persisted.mimeType,
          appChatId: 'source-chat'
        })
      ).toBe(false)
      expect(
        store.grant({
          sha256: persisted.sha256,
          mimeType: persisted.mimeType,
          appChatId: 'new-owner'
        })
      ).toEqual({ ok: false, reason: 'persistence_failed' })
      expect(
        store.backfillOwnership([
          {
            sha256: persisted.sha256,
            mimeType: persisted.mimeType,
            appChatId: 'backfilled-owner'
          }
        ])
      ).toEqual({ ok: false, reason: 'persistence_failed' })
      const verifyTransfer = vi.fn(() => true)
      expect(
        store.grantVerifiedTransfer(
          {
            sha256: persisted.sha256,
            mimeType: persisted.mimeType,
            sourceAppChatId: 'source-chat',
            targetAppChatId: 'child-chat'
          },
          verifyTransfer
        )
      ).toEqual({ ok: false, reason: 'persistence_failed' })
      expect(verifyTransfer).not.toHaveBeenCalled()
      expect(
        store.write({
          sha256: persisted.sha256,
          mimeType: persisted.mimeType,
          buffer,
          appChatId: 'write-owner'
        })
      ).toEqual({ ok: false, reason: 'persistence_failed' })
      const newHash = 'lockedWrite_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'
      expect(
        store.write({
          sha256: newHash,
          mimeType: 'image/png',
          buffer: Buffer.from('must-not-write'),
          appChatId: 'write-owner'
        })
      ).toEqual({ ok: false, reason: 'persistence_failed' })
      expect(fs.existsSync(transcriptMediaAssetPath(root, newHash, 'image/png'))).toBe(false)
      const unownedHash = 'unownedWrite_abcdefghijklmnopqrstuvwxyz0123456789-XYZ'
      expect(
        store.write({
          sha256: unownedHash,
          mimeType: 'image/png',
          buffer: Buffer.from('unowned-write-remains-available')
        })
      ).toEqual({ ok: true })
      expect(fs.readFileSync(ledgerPath).equals(ledgerBytes)).toBe(true)

      const restarted = new TranscriptMediaAssetStore(root)
      expect(
        restarted.grant({
          sha256: persisted.sha256,
          mimeType: persisted.mimeType,
          appChatId: 'restart-owner'
        })
      ).toEqual({ ok: false, reason: 'persistence_failed' })
      expect(fs.readFileSync(ledgerPath).equals(ledgerBytes)).toBe(true)
    }
  )

  it.each(['openSync', 'readSync'] as const)(
    'locks ownership mutations after a transient %s failure and recovers only on restart',
    (method) => {
      const root = makeRoot()
      const seed = new TranscriptMediaAssetStore(root)
      const persisted = seed.writeContentAddressed({
        mimeType: 'image/png',
        buffer: Buffer.from('transient-ledger-image'),
        appChatId: 'existing-owner'
      })
      expect(persisted.ok).toBe(true)
      if (!persisted.ok) return
      const ledgerPath = path.join(root, TRANSCRIPT_MEDIA_OWNERSHIP_FILE)
      const ledgerBytes = fs.readFileSync(ledgerPath)
      const transientError = Object.assign(new Error('transient ledger I/O failure'), {
        code: 'EIO'
      })
      let store: TranscriptMediaAssetStore
      if (method === 'openSync') {
        const failure = vi.spyOn(fs, 'openSync').mockImplementationOnce(() => {
          throw transientError
        })
        store = new TranscriptMediaAssetStore(root)
        failure.mockRestore()
      } else {
        const failure = vi.spyOn(fs, 'readSync').mockImplementationOnce(() => {
          throw transientError
        })
        store = new TranscriptMediaAssetStore(root)
        failure.mockRestore()
      }

      expect(
        store.owns({
          sha256: persisted.sha256,
          mimeType: persisted.mimeType,
          appChatId: 'existing-owner'
        })
      ).toBe(false)
      expect(
        store.grant({
          sha256: persisted.sha256,
          mimeType: persisted.mimeType,
          appChatId: 'new-owner'
        })
      ).toEqual({ ok: false, reason: 'persistence_failed' })
      expect(fs.readFileSync(ledgerPath).equals(ledgerBytes)).toBe(true)

      const restarted = new TranscriptMediaAssetStore(root)
      expect(
        restarted.owns({
          sha256: persisted.sha256,
          mimeType: persisted.mimeType,
          appChatId: 'existing-owner'
        })
      ).toBe(true)
      expect(
        restarted.owns({
          sha256: persisted.sha256,
          mimeType: persisted.mimeType,
          appChatId: 'new-owner'
        })
      ).toBe(false)
    }
  )

  it('locks hostile or over-budget ownership ledgers and never follows a ledger symlink', () => {
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
    ).toEqual({ ok: false, reason: 'persistence_failed' })
    expect(fs.lstatSync(ledgerPath).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(outsideLedger, 'utf8')).toBe(outsideContents)

    fs.unlinkSync(ledgerPath)
    const oversizedLedger = Buffer.alloc(TRANSCRIPT_MEDIA_OWNERSHIP_MAX_FILE_BYTES + 1, 0x61)
    fs.writeFileSync(ledgerPath, oversizedLedger, { mode: 0o600 })
    const oversized = new TranscriptMediaAssetStore(root)
    expect(
      oversized.owns({
        sha256: persisted.sha256,
        mimeType: 'image/png',
        appChatId: 'chat-1'
      })
    ).toBe(false)
    expect(
      oversized.grant({
        sha256: persisted.sha256,
        mimeType: 'image/png',
        appChatId: 'chat-1'
      })
    ).toEqual({ ok: false, reason: 'persistence_failed' })
    expect(fs.readFileSync(ledgerPath).equals(oversizedLedger)).toBe(true)
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

  it('ingests a file in bounded async chunks and returns its canonical durable asset', async () => {
    const root = makeRoot()
    const sourceRoot = makeRoot()
    const sourcePath = path.join(sourceRoot, 'clip.mp4')
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 137, 0x5a)
    fs.writeFileSync(sourcePath, bytes)
    const expectedSha256 = createHash('sha256').update(bytes).digest('base64url')
    const readSync = vi.spyOn(fs, 'readSync')
    const writeSync = vi.spyOn(fs, 'writeSync')

    const result = await new TranscriptMediaAssetStore(root).writeContentAddressedFromFile({
      sourcePath,
      mimeType: 'video/mp4'
    })

    expect(result).toEqual({
      ok: true,
      persistenceVersion: 1,
      sha256: expectedSha256,
      path: transcriptMediaAssetPath(fs.realpathSync(root), expectedSha256, 'video/mp4'),
      mimeType: 'video/mp4',
      byteLength: bytes.length
    })
    expect(readSync).not.toHaveBeenCalled()
    expect(writeSync).not.toHaveBeenCalled()
    if (!result.ok) return
    expect(fs.readFileSync(result.path).equals(bytes)).toBe(true)
    expect(fs.statSync(result.path).mode & 0o077).toBe(0)
    expect(fs.readFileSync(sourcePath).equals(bytes)).toBe(true)
    expect(fs.readdirSync(root).some((entry) => entry.startsWith('.ingest-'))).toBe(false)
  })

  it('rejects unsafe, empty, oversized, and unsupported file-backed inputs before publishing', async () => {
    const root = makeRoot()
    const sourceRoot = makeRoot()
    const store = new TranscriptMediaAssetStore(root)
    const realSource = path.join(sourceRoot, 'real.mp4')
    const linkedSource = path.join(sourceRoot, 'linked.mp4')
    const emptySource = path.join(sourceRoot, 'empty.mp4')
    const oversizedSource = path.join(sourceRoot, 'oversized.png')
    fs.writeFileSync(realSource, 'video-bytes')
    fs.symlinkSync(realSource, linkedSource)
    fs.writeFileSync(emptySource, '')
    fs.writeFileSync(oversizedSource, 'x')
    fs.truncateSync(oversizedSource, TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES + 1)

    await expect(
      store.writeContentAddressedFromFile({ sourcePath: linkedSource, mimeType: 'video/mp4' })
    ).resolves.toEqual({ ok: false, reason: 'unsafe_source_path' })
    await expect(
      store.writeContentAddressedFromFile({ sourcePath: emptySource, mimeType: 'video/mp4' })
    ).resolves.toEqual({ ok: false, reason: 'too_large' })
    await expect(
      store.writeContentAddressedFromFile({ sourcePath: oversizedSource, mimeType: 'image/png' })
    ).resolves.toEqual({ ok: false, reason: 'too_large' })
    await expect(
      store.writeContentAddressedFromFile({ sourcePath: realSource, mimeType: 'image/svg+xml' })
    ).resolves.toEqual({ ok: false, reason: 'unsupported' })
    await expect(
      store.writeContentAddressedFromFile({ sourcePath: 'relative.mp4', mimeType: 'video/mp4' })
    ).resolves.toEqual({ ok: false, reason: 'unsafe_source_path' })
    await expect(
      store.writeContentAddressedFromFile({
        sourcePath: path.join(sourceRoot, 'missing.mp4'),
        mimeType: 'video/mp4'
      })
    ).resolves.toEqual({ ok: false, reason: 'missing' })
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('deduplicates identical file ingests and preserves a mismatched existing target', async () => {
    const root = makeRoot()
    const sourceRoot = makeRoot()
    const sourcePath = path.join(sourceRoot, 'same.wav')
    const bytes = Buffer.from('RIFF....WAVE-same-content')
    fs.writeFileSync(sourcePath, bytes)
    const store = new TranscriptMediaAssetStore(root)

    const first = await store.writeContentAddressedFromFile({
      sourcePath,
      mimeType: 'audio/wav'
    })
    const second = await store.writeContentAddressedFromFile({
      sourcePath,
      mimeType: 'audio/wav'
    })
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    if (!first.ok) return

    const collisionBytes = Buffer.alloc(bytes.length, 0x21)
    fs.writeFileSync(first.path, collisionBytes)
    await expect(
      store.writeContentAddressedFromFile({ sourcePath, mimeType: 'audio/wav' })
    ).resolves.toEqual({ ok: false, reason: 'content_address_collision' })
    expect(fs.readFileSync(first.path).equals(collisionBytes)).toBe(true)
    expect(fs.readdirSync(root).some((entry) => entry.startsWith('.ingest-'))).toBe(false)
  })

  it('publishes concurrent identical ingests atomically without transient collisions', async () => {
    const root = makeRoot()
    const sourceRoot = makeRoot()
    const sourcePath = path.join(sourceRoot, 'concurrent.mp4')
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 41, 0x33)
    fs.writeFileSync(sourcePath, bytes)
    const firstStore = new TranscriptMediaAssetStore(root)
    const secondStore = new TranscriptMediaAssetStore(root)

    const [first, second] = await Promise.all([
      firstStore.writeContentAddressedFromFile({ sourcePath, mimeType: 'video/mp4' }),
      secondStore.writeContentAddressedFromFile({ sourcePath, mimeType: 'video/mp4' })
    ])

    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
    if (!first.ok) return
    expect(fs.readFileSync(first.path).equals(bytes)).toBe(true)
    expect(fs.readdirSync(root).filter((entry) => entry.startsWith('.ingest-'))).toEqual([])
  })

  it('never rolls back a published target after a concurrent ingest adopts it', async () => {
    const root = makeRoot()
    const sourceRoot = makeRoot()
    const sourcePath = path.join(sourceRoot, 'adopted.mp4')
    const bytes = Buffer.alloc(1024 * 1024 + 29, 0x34)
    fs.writeFileSync(sourcePath, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('base64url')
    const target = transcriptMediaAssetPath(fs.realpathSync(root), sha256, 'video/mp4')
    const realLink = fs.promises.link.bind(fs.promises)
    const realLstat = fs.promises.lstat.bind(fs.promises)
    let announcePublished!: () => void
    let releasePublisher!: () => void
    const published = new Promise<void>((resolve) => {
      announcePublished = resolve
    })
    const publisherRelease = new Promise<void>((resolve) => {
      releasePublisher = resolve
    })
    let firstLink = true
    vi.spyOn(fs.promises, 'link').mockImplementation(async (existingPath, newPath) => {
      await realLink(existingPath, newPath)
      if (!firstLink) return
      firstLink = false
      announcePublished()
      await publisherRelease
    })
    let failPublisherValidation = false
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (file) => {
      if (failPublisherValidation && file === target) {
        failPublisherValidation = false
        throw new Error('simulated_post_link_validation_failure')
      }
      return realLstat(file)
    })

    const publisher = new TranscriptMediaAssetStore(root).writeContentAddressedFromFile({
      sourcePath,
      mimeType: 'video/mp4'
    })
    await published
    const adopter = await new TranscriptMediaAssetStore(root).writeContentAddressedFromFile({
      sourcePath,
      mimeType: 'video/mp4'
    })
    expect(adopter.ok).toBe(true)

    failPublisherValidation = true
    releasePublisher()
    await expect(publisher).resolves.toEqual({
      ok: false,
      reason: 'simulated_post_link_validation_failure'
    })
    expect(fs.readFileSync(target).equals(bytes)).toBe(true)
    await expect(
      new TranscriptMediaAssetStore(root).writeContentAddressedFromFile({
        sourcePath,
        mimeType: 'video/mp4'
      })
    ).resolves.toEqual(adopter)
  })

  it('reads source and collision descriptors exactly across short asynchronous reads', async () => {
    const root = makeRoot()
    const sourceRoot = makeRoot()
    const sourcePath = path.join(sourceRoot, 'short-reads.wav')
    const bytes = Buffer.alloc(4097, 0x35)
    fs.writeFileSync(sourcePath, bytes)
    const limitedPaths = new Set([sourcePath])
    limitDescriptorReads(limitedPaths, 17)
    const store = new TranscriptMediaAssetStore(root)

    const first = await store.writeContentAddressedFromFile({
      sourcePath,
      mimeType: 'audio/wav'
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    limitedPaths.add(first.path)
    await expect(
      store.writeContentAddressedFromFile({ sourcePath, mimeType: 'audio/wav' })
    ).resolves.toEqual(first)
    expect(fs.readFileSync(first.path).equals(bytes)).toBe(true)
  })

  it('reclaims only sufficiently old exact-name temps from definitely dead processes', async () => {
    const root = makeRoot()
    const sourceRoot = makeRoot()
    const sourcePath = path.join(sourceRoot, 'cleanup.wav')
    fs.writeFileSync(sourcePath, 'cleanup-source')
    const livePid = process.pid + 100_000
    const deadPid = livePid + 1
    const exactTemp = (pid: number) => path.join(root, `.ingest-${pid}-${randomUUID()}.tmp`)
    const currentTemp = exactTemp(process.pid)
    const liveTemp = exactTemp(livePid)
    const staleDeadTemp = exactTemp(deadPid)
    const freshDeadTemp = exactTemp(deadPid)
    const symlinkTemp = exactTemp(deadPid)
    const symlinkTarget = path.join(root, 'symlink-target')
    const malformedTemp = path.join(root, `.ingest-${deadPid}-not-a-uuid.tmp`)
    for (const file of [currentTemp, liveTemp, staleDeadTemp, freshDeadTemp, symlinkTarget, malformedTemp]) {
      fs.writeFileSync(file, 'temp', { mode: 0o600 })
      fs.chmodSync(file, 0o600)
    }
    fs.symlinkSync(symlinkTarget, symlinkTemp)
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    for (const file of [currentTemp, liveTemp, staleDeadTemp, symlinkTemp, malformedTemp]) {
      fs.utimesSync(file, old, old)
    }
    vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === livePid) return true
      if (pid === deadPid) {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      }
      throw new Error(`unexpected pid check: ${pid}`)
    }) as typeof process.kill)

    const result = await new TranscriptMediaAssetStore(root).writeContentAddressedFromFile({
      sourcePath,
      mimeType: 'audio/wav'
    })

    expect(result.ok).toBe(true)
    expect(fs.existsSync(staleDeadTemp)).toBe(false)
    for (const file of [currentTemp, liveTemp, freshDeadTemp, symlinkTemp, malformedTemp]) {
      expect(fs.existsSync(file)).toBe(true)
    }
  })

  it('removes a stale post-publication temp link without removing the canonical asset', async () => {
    const root = makeRoot()
    const sourceRoot = makeRoot()
    const sourcePath = path.join(sourceRoot, 'cleanup-published.wav')
    fs.writeFileSync(sourcePath, 'cleanup-trigger')
    const deadPid = process.pid + 200_000
    const staleTemp = path.join(root, `.ingest-${deadPid}-${randomUUID()}.tmp`)
    const canonicalDir = path.join(root, 'aa')
    const canonicalPath = path.join(canonicalDir, 'published.wav')
    fs.mkdirSync(canonicalDir, { mode: 0o700 })
    fs.writeFileSync(staleTemp, 'published-bytes', { mode: 0o600 })
    fs.linkSync(staleTemp, canonicalPath)
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
    fs.utimesSync(staleTemp, old, old)
    vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid === deadPid) {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      }
      throw new Error(`unexpected pid check: ${pid}`)
    }) as typeof process.kill)

    const result = await new TranscriptMediaAssetStore(root).writeContentAddressedFromFile({
      sourcePath,
      mimeType: 'audio/wav'
    })

    expect(result.ok).toBe(true)
    expect(fs.existsSync(staleTemp)).toBe(false)
    expect(fs.readFileSync(canonicalPath, 'utf8')).toBe('published-bytes')
    expect(fs.statSync(canonicalPath).nlink).toBe(1)
  })

  it.each(['mutation', 'replacement'] as const)(
    'rejects a source $mode during ingestion and removes its unpublished temp file',
    async (mode) => {
      const root = makeRoot()
      const sourceRoot = makeRoot()
      const sourcePath = path.join(sourceRoot, 'changing.mp4')
      const movedPath = path.join(sourceRoot, 'changing-original.mp4')
      const bytes = Buffer.alloc(2 * 1024 * 1024 + 19, 0x44)
      fs.writeFileSync(sourcePath, bytes)
      let changed = false
      interceptIngestTempWrites(({ call, phase }) => {
        if (changed || call !== 1 || phase !== 'after') return
        changed = true
        if (mode === 'mutation') {
          fs.writeFileSync(sourcePath, Buffer.alloc(bytes.length, 0x45))
        } else {
          fs.renameSync(sourcePath, movedPath)
          fs.writeFileSync(sourcePath, Buffer.alloc(bytes.length, 0x46))
        }
      })

      await expect(
        new TranscriptMediaAssetStore(root).writeContentAddressedFromFile({
          sourcePath,
          mimeType: 'video/mp4'
        })
      ).resolves.toEqual({ ok: false, reason: 'source_changed' })
      expect(changed).toBe(true)
      expect(fs.readdirSync(root)).toEqual([])
    }
  )

  it('removes a partially-written temp file after an asynchronous write failure', async () => {
    const root = makeRoot()
    const sourceRoot = makeRoot()
    const sourcePath = path.join(sourceRoot, 'partial.mp4')
    fs.writeFileSync(sourcePath, Buffer.alloc(2 * 1024 * 1024 + 7, 0x55))
    interceptIngestTempWrites(({ call, phase }) => {
      if (call === 2 && phase === 'before') throw new Error('simulated_write_failure')
    })

    await expect(
      new TranscriptMediaAssetStore(root).writeContentAddressedFromFile({
        sourcePath,
        mimeType: 'video/mp4'
      })
    ).resolves.toEqual({ ok: false, reason: 'simulated_write_failure' })
    expect(fs.readdirSync(root)).toEqual([])
  })
})
