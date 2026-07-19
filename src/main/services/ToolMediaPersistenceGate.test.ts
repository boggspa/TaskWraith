import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { TranscriptMediaAssetStore } from './TranscriptMediaAssetStore'
import {
  projectAndCommitToolMediaPersistence,
  rollbackPendingToolMediaPersistence,
  settleToolMediaPersistence,
  stripPendingToolMediaPersistence,
  toolMediaPublicationAuthorized
} from './ToolMediaPersistenceGate'

describe('ToolMediaPersistenceGate', () => {
  it('authorizes and synchronously commits only a publishable live result', () => {
    const commit = vi.fn(() => true)
    expect(toolMediaPublicationAuthorized({ publish: true, isAuthorized: () => true })).toBe(true)
    const settled = settleToolMediaPersistence({
      pending: { commit, rollback: async () => undefined },
      publish: true,
      isAuthorized: () => true
    })
    expect(settled).toEqual({ authorityLive: true, committed: true })
    expect(commit).toHaveBeenCalledOnce()
  })

  it.each([
    { publish: false, authorized: true },
    { publish: true, authorized: false }
  ])(
    'strictly rolls back when the result or authority is invalid: %o',
    async ({ publish, authorized }) => {
      const rollback = vi.fn(async () => undefined)
      expect(toolMediaPublicationAuthorized({ publish, isAuthorized: () => authorized })).toBe(
        false
      )
      await expect(
        settleToolMediaPersistence({
          pending: { commit: () => true, rollback },
          publish,
          isAuthorized: () => authorized
        })
      ).resolves.toEqual({ authorityLive: authorized, committed: false })
      expect(rollback).toHaveBeenCalledOnce()
    }
  )

  it('fails closed when commit authority or strict rollback fails', async () => {
    expect(() =>
      settleToolMediaPersistence({
        pending: { commit: () => false, rollback: async () => undefined },
        publish: true,
        isAuthorized: () => true
      })
    ).toThrow('receipt was no longer active')

    await expect(
      settleToolMediaPersistence({
        pending: {
          commit: () => true,
          rollback: async () => {
            throw new Error('authority-loss rollback fsync failed')
          }
        },
        publish: true,
        isAuthorized: () => false
      })
    ).rejects.toThrow('authority-loss rollback fsync failed')

    await expect(
      rollbackPendingToolMediaPersistence({
        commit: () => true,
        rollback: async () => {
          throw new Error('strict rollback fsync failed')
        }
      })
    ).rejects.toThrow('strict rollback fsync failed')
  })

  it('keeps rollback authority live when a pre-commit projection step throws', async () => {
    const commit = vi.fn(() => true)
    const rollback = vi.fn(async () => undefined)
    const pending = { commit, rollback }

    expect(() =>
      projectAndCommitToolMediaPersistence({
        pending,
        isAuthorized: () => true,
        project: () => {
          throw new Error('injected transcript projection failure')
        }
      })
    ).toThrow('injected transcript projection failure')
    expect(commit).not.toHaveBeenCalled()

    await expect(rollbackPendingToolMediaPersistence(pending)).resolves.toBeUndefined()
    expect(rollback).toHaveBeenCalledOnce()
  })

  it('removes exact owned bytes and grant after an injected projection failure', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-tool-media-projection-'))
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-tool-media-source-'))
    try {
      const sourcePath = path.join(sourceRoot, 'produced.wav')
      fs.writeFileSync(sourcePath, Buffer.from('owned-before-projection-failure'))
      const store = new TranscriptMediaAssetStore(root)
      const owned = await store.writeOwnedContentAddressedFromFile({
        sourcePath,
        mimeType: 'audio/wav',
        appChatId: 'chat-a'
      })
      expect(owned.ok).toBe(true)
      if (!owned.ok) return
      const pending = {
        commit: () => store.commitOwnedFileWrite(owned.ownershipReceipt),
        rollback: async () => {
          const rolledBack = await store.rollbackOwnedFileWriteStrict(owned.ownershipReceipt)
          if (!rolledBack) throw new Error('owned receipt was inactive')
        }
      }

      try {
        projectAndCommitToolMediaPersistence({
          pending,
          isAuthorized: () => true,
          project: () => {
            throw new Error('injected sendAgentCompatLine failure')
          }
        })
      } catch {
        await rollbackPendingToolMediaPersistence(pending)
      }

      expect(fs.existsSync(owned.path)).toBe(false)
      expect(
        store.owns({
          sha256: owned.sha256,
          mimeType: owned.mimeType,
          appChatId: 'chat-a'
        })
      ).toBe(false)
      expect(store.commitOwnedFileWrite(owned.ownershipReceipt)).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(sourceRoot, { recursive: true, force: true })
    }
  })

  it('rechecks authority after projection before committing the receipt', () => {
    const commit = vi.fn(() => true)
    let authorityChecks = 0

    expect(
      projectAndCommitToolMediaPersistence({
        pending: { commit, rollback: async () => undefined },
        isAuthorized: () => {
          authorityChecks += 1
          return authorityChecks === 1
        },
        project: () => 'projected'
      })
    ).toEqual({ authorityLive: false, committed: false })
    expect(commit).not.toHaveBeenCalled()
  })

  it('strips the function-valued receipt capability before provider projection', () => {
    const internal = {
      text: 'done',
      pendingToolMediaPersistence: {
        commit: () => true,
        rollback: async () => undefined
      }
    }

    const projected = stripPendingToolMediaPersistence(internal)

    expect(projected).toEqual({ text: 'done' })
    expect('pendingToolMediaPersistence' in projected).toBe(false)
    expect(internal.pendingToolMediaPersistence).toBeDefined()
  })
})
