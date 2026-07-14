import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  copyResolvedScheduledAttachments,
  createMainOwnedScheduledAttachmentPersistence,
  isDurableScheduledAttachmentRef
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
})
