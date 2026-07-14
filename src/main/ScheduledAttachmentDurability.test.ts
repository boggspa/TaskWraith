import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  copyResolvedScheduledAttachments,
  createMainOwnedScheduledAttachmentPersistence,
  isDurableScheduledAttachmentRef,
  MAX_DURABLE_ATTACHMENT_REFS,
  SCHEDULED_ATTACHMENT_RESELECT_REASON
} from './ScheduledAttachmentDurability'
import { TranscriptMediaAssetStore } from './services/TranscriptMediaAssetStore'

const persisted = {
  persistenceVersion: 1 as const,
  id: 'image-1',
  path: '/tmp/taskwraith-assets/image.png',
  name: 'proof.png',
  sha256: 'a'.repeat(43),
  mimeType: 'image/png',
  byteLength: 12
}

describe('ScheduledAttachmentDurability', () => {
  const temporaryRoots: string[] = []

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires both durable content identity and non-empty display identity', () => {
    expect(isDurableScheduledAttachmentRef(persisted)).toBe(true)
    expect(
      isDurableScheduledAttachmentRef({ id: 'image-1', name: 'proof.png', path: '/tmp/raw.png' })
    ).toBe(false)
    expect(isDurableScheduledAttachmentRef({ ...persisted, id: '' })).toBe(false)
    expect(isDurableScheduledAttachmentRef({ ...persisted, name: '' })).toBe(false)
  })

  it('keeps source id/name while accepting a canonical resolved asset path', () => {
    expect(
      copyResolvedScheduledAttachments(
        [persisted],
        [
          {
            ...persisted,
            id: undefined,
            name: undefined,
            path: '/tmp/taskwraith-assets/canonical.png'
          }
        ]
      )
    ).toEqual([
      {
        ...persisted,
        path: '/tmp/taskwraith-assets/canonical.png'
      }
    ])
    expect(copyResolvedScheduledAttachments([persisted], [])).toBeNull()
  })

  it('snapshots a fresh raw path but never falls back to that path for a broken v1 ref', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-scheduled-attachment-'))
    temporaryRoots.push(root)
    const workspacePath = path.join(root, 'workspace')
    const assetPath = path.join(root, 'assets')
    fs.mkdirSync(workspacePath, { recursive: true })
    const sourcePath = path.join(workspacePath, 'proof.png')
    fs.writeFileSync(
      sourcePath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    )
    const assetStore = new TranscriptMediaAssetStore(assetPath)
    const persistence = createMainOwnedScheduledAttachmentPersistence({
      getAssetStore: () => assetStore
    })

    const staged = persistence.stage({
      appChatId: 'chat-1',
      workspaceId: 'workspace-1',
      workspacePath,
      externalPathGrants: [],
      attachments: [{ id: 'image-1', name: 'proof.png', path: sourcePath }]
    })
    expect(staged.ok).toBe(true)
    if (!staged.ok) throw new Error(staged.reason)
    expect(staged.attachments[0]).toMatchObject({
      persistenceVersion: 1,
      id: 'image-1',
      name: 'proof.png',
      mimeType: 'image/png'
    })

    fs.unlinkSync(sourcePath)
    expect(
      persistence.resolve({
        source: 'scheduled-task',
        recordId: 'task-1',
        appChatId: 'chat-1',
        workspaceId: 'workspace-1',
        workspacePath,
        externalPathGrants: [],
        attachments: staged.attachments as typeof persisted[]
      })
    ).toMatchObject({ ok: true })

    fs.writeFileSync(sourcePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
    const brokenV1 = {
      ...staged.attachments[0],
      path: sourcePath
    } as typeof persisted
    expect(
      persistence.stage({
        appChatId: 'chat-1',
        workspaceId: 'workspace-1',
        workspacePath,
        externalPathGrants: [],
        attachments: [brokenV1]
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('Re-select') })
  })

  it('rejects a persisted asset replay from another chat while preserving same-chat reuse', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-scheduled-owner-'))
    temporaryRoots.push(root)
    const workspacePath = path.join(root, 'workspace')
    const assetPath = path.join(root, 'assets')
    fs.mkdirSync(workspacePath, { recursive: true })
    const assetStore = new TranscriptMediaAssetStore(assetPath)
    const written = assetStore.writeContentAddressed({
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
      appChatId: 'victim-chat'
    })
    expect(written.ok).toBe(true)
    if (!written.ok) return
    const persistence = createMainOwnedScheduledAttachmentPersistence({
      getAssetStore: () => assetStore
    })
    const attachment = {
      persistenceVersion: 1 as const,
      id: 'image-1',
      path: written.path,
      name: 'proof.png',
      sha256: written.sha256,
      mimeType: written.mimeType,
      byteLength: written.byteLength
    }
    const context = {
      workspaceId: 'workspace-1',
      workspacePath,
      externalPathGrants: [],
      attachments: [attachment]
    }

    expect(persistence.stage({ ...context, appChatId: 'attacker-chat' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Re-select')
    })
    expect(persistence.stage({ ...context, appChatId: 'victim-chat' })).toMatchObject({
      ok: true,
      attachments: [expect.objectContaining({ sha256: written.sha256 })]
    })
    expect(
      persistence.resolve({
        ...context,
        source: 'scheduled-task',
        recordId: 'task-1',
        appChatId: 'attacker-chat'
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('Re-select') })
  })

  it('establishes exact chat ownership while staging a newly selected raw attachment', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-scheduled-fresh-owner-'))
    temporaryRoots.push(root)
    const workspacePath = path.join(root, 'workspace')
    const assetPath = path.join(root, 'assets')
    fs.mkdirSync(workspacePath, { recursive: true })
    const sourcePath = path.join(workspacePath, 'proof.png')
    fs.writeFileSync(
      sourcePath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    )
    const assetStore = new TranscriptMediaAssetStore(assetPath)
    const persistence = createMainOwnedScheduledAttachmentPersistence({
      getAssetStore: () => assetStore
    })

    const staged = persistence.stage({
      appChatId: 'chat-1',
      workspaceId: 'workspace-1',
      workspacePath,
      externalPathGrants: [],
      attachments: [{ id: 'image-1', name: 'proof.png', path: sourcePath }]
    })
    expect(staged.ok).toBe(true)
    if (!staged.ok) return
    expect(
      assetStore.owns({
        sha256: staged.attachments[0].sha256,
        mimeType: staged.attachments[0].mimeType,
        appChatId: 'chat-1'
      })
    ).toBe(true)
    expect(
      assetStore.owns({
        sha256: staged.attachments[0].sha256,
        mimeType: staged.attachments[0].mimeType,
        appChatId: 'chat-2'
      })
    ).toBe(false)
  })

  it('persists a fresh attachment set before granting its ownership in one batch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-scheduled-batch-owner-'))
    temporaryRoots.push(root)
    const workspacePath = path.join(root, 'workspace')
    const assetPath = path.join(root, 'assets')
    fs.mkdirSync(workspacePath, { recursive: true })
    const firstPath = path.join(workspacePath, 'first.png')
    const secondPath = path.join(workspacePath, 'second.png')
    const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    fs.writeFileSync(firstPath, Buffer.from([...pngHeader, 0x01]))
    fs.writeFileSync(secondPath, Buffer.from([...pngHeader, 0x02]))
    const assetStore = new TranscriptMediaAssetStore(assetPath)
    const grantMany = vi.spyOn(assetStore, 'grantMany')
    const persistence = createMainOwnedScheduledAttachmentPersistence({
      getAssetStore: () => assetStore
    })

    const staged = persistence.stage({
      appChatId: 'chat-batch',
      workspaceId: 'workspace-1',
      workspacePath,
      externalPathGrants: [],
      attachments: [
        { id: 'image-1', name: 'first.png', path: firstPath },
        { id: 'image-2', name: 'second.png', path: secondPath }
      ]
    })

    expect(staged.ok).toBe(true)
    expect(grantMany).toHaveBeenCalledTimes(1)
    expect(grantMany).toHaveBeenCalledWith([
      expect.objectContaining({ appChatId: 'chat-batch' }),
      expect.objectContaining({ appChatId: 'chat-batch' })
    ])
    if (!staged.ok) return
    for (const attachment of staged.attachments) {
      expect(
        assetStore.owns({
          sha256: attachment.sha256,
          mimeType: attachment.mimeType,
          appChatId: 'chat-batch'
        })
      ).toBe(true)
    }
  })

  it('returns no durable refs when the single ownership batch fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-scheduled-batch-fail-'))
    temporaryRoots.push(root)
    const workspacePath = path.join(root, 'workspace')
    const assetPath = path.join(root, 'assets')
    fs.mkdirSync(workspacePath, { recursive: true })
    const sourcePath = path.join(workspacePath, 'proof.png')
    fs.writeFileSync(
      sourcePath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x03])
    )
    const assetStore = new TranscriptMediaAssetStore(assetPath)
    const grantMany = vi
      .spyOn(assetStore, 'grantMany')
      .mockReturnValue({ ok: false, reason: 'persistence_failed' })
    const persistence = createMainOwnedScheduledAttachmentPersistence({
      getAssetStore: () => assetStore
    })

    expect(
      persistence.stage({
        appChatId: 'chat-batch',
        workspaceId: 'workspace-1',
        workspacePath,
        externalPathGrants: [],
        attachments: [{ id: 'image-1', name: 'proof.png', path: sourcePath }]
      })
    ).toEqual({ ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON })
    expect(grantMany).toHaveBeenCalledTimes(1)
  })

  it('does not grant an earlier snapshot when a later attachment is invalid', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-scheduled-late-fail-'))
    temporaryRoots.push(root)
    const workspacePath = path.join(root, 'workspace')
    const assetPath = path.join(root, 'assets')
    fs.mkdirSync(workspacePath, { recursive: true })
    const firstPath = path.join(workspacePath, 'first.png')
    const invalidPath = path.join(workspacePath, 'invalid.txt')
    const firstBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x44])
    fs.writeFileSync(firstPath, firstBytes)
    fs.writeFileSync(invalidPath, 'not an image')
    const assetStore = new TranscriptMediaAssetStore(assetPath)
    const persistence = createMainOwnedScheduledAttachmentPersistence({
      getAssetStore: () => assetStore
    })

    expect(
      persistence.stage({
        appChatId: 'chat-late-fail',
        workspaceId: 'workspace-1',
        workspacePath,
        externalPathGrants: [],
        attachments: [
          { id: 'image-1', name: 'first.png', path: firstPath },
          { id: 'image-2', name: 'invalid.txt', path: invalidPath }
        ]
      })
    ).toEqual({ ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON })
    const first = assetStore.writeContentAddressed({ mimeType: 'image/png', buffer: firstBytes })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(
      assetStore.owns({
        sha256: first.sha256,
        mimeType: first.mimeType,
        appChatId: 'chat-late-fail'
      })
    ).toBe(false)
  })

  it('rejects attachment arrays above the main-authority ceiling before opening files', () => {
    const getAssetStore = vi.fn()
    const persistence = createMainOwnedScheduledAttachmentPersistence({ getAssetStore })
    const attachments = Array.from({ length: MAX_DURABLE_ATTACHMENT_REFS + 1 }, (_, index) => ({
      id: `image-${index}`,
      name: `image-${index}.png`,
      path: `/repo/image-${index}.png`
    }))

    expect(
      persistence.stage({
        appChatId: 'chat-overflow',
        workspaceId: 'workspace-1',
        workspacePath: '/repo',
        externalPathGrants: [],
        attachments
      })
    ).toEqual({ ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON })
    expect(
      persistence.resolve({
        appChatId: 'chat-overflow',
        workspaceId: 'workspace-1',
        workspacePath: '/repo',
        externalPathGrants: [],
        source: 'scheduled-task',
        recordId: 'task-overflow',
        attachments
      })
    ).toEqual({ ok: false, reason: SCHEDULED_ATTACHMENT_RESELECT_REASON })
    expect(getAssetStore).not.toHaveBeenCalled()
  })
})
