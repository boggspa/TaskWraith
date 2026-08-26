import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createMainOwnedRunQueueAttachmentStager,
  resolveMainOwnedQueuedComposerAttachments,
  resolveOwnedPersistedRunQueueAttachment
} from './RunQueueAttachmentAuthority'
import { MAX_DURABLE_ATTACHMENT_REFS } from './ScheduledAttachmentDurability'
import { TranscriptMediaAssetStore } from './services/TranscriptMediaAssetStore'
import type { RunQueueImageAttachmentSnapshot, RunQueueJob } from './store/types'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function ownedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-queue-attachment-authority-'))
  roots.push(root)
  const store = new TranscriptMediaAssetStore(root)
  const persisted = store.writeContentAddressed({
    buffer: Buffer.from('owned queue image'),
    mimeType: 'image/png',
    appChatId: 'chat-owner'
  })
  if (!persisted.ok) throw new Error(persisted.reason)
  return { store, persisted }
}

describe('resolveOwnedPersistedRunQueueAttachment', () => {
  it('accepts a valid persisted ref for the chat that already owns it', () => {
    const { store, persisted } = ownedFixture()
    expect(
      resolveOwnedPersistedRunQueueAttachment({
        store,
        attachment: persisted,
        appChatId: 'chat-owner'
      })
    ).toMatchObject({
      ok: true,
      attachment: {
        persistenceVersion: 1,
        sha256: persisted.sha256,
        mimeType: persisted.mimeType,
        byteLength: persisted.byteLength,
        path: persisted.path
      }
    })
  })

  it('denies cross-chat replay without minting ownership for the target chat', () => {
    const { store, persisted } = ownedFixture()
    expect(
      resolveOwnedPersistedRunQueueAttachment({
        store,
        attachment: persisted,
        appChatId: 'chat-attacker'
      })
    ).toEqual({ ok: false, reason: 'not_owner' })
    expect(
      store.owns({
        sha256: persisted.sha256,
        mimeType: persisted.mimeType,
        appChatId: 'chat-attacker'
      })
    ).toBe(false)
  })
})

describe('resolveMainOwnedQueuedComposerAttachments', () => {
  function queuedJob(
    attachment: RunQueueImageAttachmentSnapshot,
    overrides: Partial<RunQueueJob> = {}
  ): RunQueueJob {
    return {
      id: 'run-queued',
      runId: 'run-queued',
      provider: 'pi',
      source: 'manual',
      status: 'starting',
      priority: 0,
      attempt: 1,
      chatId: 'chat-owner',
      enqueuedAt: '2026-08-25T14:32:52.031Z',
      createdAt: '2026-08-25T14:32:52.031Z',
      updatedAt: '2026-08-25T14:36:02.719Z',
      request: {
        prompt: 'Inspect this screenshot.',
        selectedModelType: 'openrouter/stealth/ox-alpha',
        customModel: '',
        approvalMode: 'default',
        sessionTrust: false,
        imageAttachments: [attachment]
      },
      ...overrides
    }
  }

  it('restores exact chat-owned snapshots for a leased queued run', () => {
    const { store, persisted } = ownedFixture()
    const job = queuedJob({ ...persisted, id: 'image-1', name: 'screen.png' })

    expect(
      resolveMainOwnedQueuedComposerAttachments({
        store,
        job,
        appRunId: 'run-queued',
        appChatId: 'chat-owner',
        provider: 'pi'
      })
    ).toMatchObject({
      imageAttachments: [
        {
          persistenceVersion: 1,
          id: 'image-1',
          path: persisted.path,
          name: 'screen.png',
          sha256: persisted.sha256,
          mimeType: persisted.mimeType,
          byteLength: persisted.byteLength
        }
      ]
    })
  })

  it('rejects non-leased, cross-chat, raw-path, and directory attachments', () => {
    const { store, persisted } = ownedFixture()
    const resolve = (job: RunQueueJob, appChatId = 'chat-owner') =>
      resolveMainOwnedQueuedComposerAttachments({
        store,
        job,
        appRunId: 'run-queued',
        appChatId,
        provider: 'pi'
      })

    expect(resolve(queuedJob(persisted, { status: 'queued' }))).toBeNull()
    expect(resolve(queuedJob(persisted), 'chat-other')).toBeNull()
    expect(resolve(queuedJob({ path: '/tmp/raw.png' }))).toBeNull()
    expect(resolve(queuedJob({ path: '/tmp/folder', kind: 'directory' }))).toBeNull()
    expect(
      resolveMainOwnedQueuedComposerAttachments({
        store,
        job: queuedJob(persisted),
        appRunId: 'run-other',
        appChatId: 'chat-owner',
        provider: 'pi'
      })
    ).toBeNull()
    expect(
      resolveMainOwnedQueuedComposerAttachments({
        store,
        job: queuedJob(persisted),
        appRunId: 'run-queued',
        appChatId: 'chat-owner',
        provider: 'codex'
      })
    ).toBeNull()
  })
})

describe('createMainOwnedRunQueueAttachmentStager', () => {
  function freshFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-queue-attachment-stage-'))
    roots.push(root)
    const workspacePath = path.join(root, 'workspace')
    fs.mkdirSync(workspacePath, { recursive: true })
    const firstPath = path.join(workspacePath, 'first.png')
    const secondPath = path.join(workspacePath, 'second.png')
    const pngHeader = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    fs.writeFileSync(firstPath, Buffer.from([...pngHeader, 0x11]))
    fs.writeFileSync(secondPath, Buffer.from([...pngHeader, 0x22]))
    const store = new TranscriptMediaAssetStore(path.join(root, 'assets'))
    return { store, workspacePath, firstPath, secondPath }
  }

  it('grants a fresh multi-attachment set in one batch before returning it', () => {
    const { store, workspacePath, firstPath, secondPath } = freshFixture()
    const grantMany = vi.spyOn(store, 'grantMany')
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore: () => store })

    const result = stage({
      chatId: 'chat-owner',
      workspacePath,
      externalPathGrants: [],
      attachments: [
        { id: 'first', name: 'first.png', path: firstPath },
        { id: 'second', name: 'second.png', path: secondPath }
      ]
    })

    expect(result.ok).toBe(true)
    expect(grantMany).toHaveBeenCalledTimes(1)
    expect(grantMany).toHaveBeenCalledWith([
      expect.objectContaining({ appChatId: 'chat-owner' }),
      expect.objectContaining({ appChatId: 'chat-owner' })
    ])
    if (!result.ok) return
    for (const attachment of result.attachments) {
      if (!('sha256' in attachment) || !('mimeType' in attachment)) {
        throw new Error('Expected staged file attachment metadata.')
      }
      expect(
        store.owns({
          sha256: attachment.sha256,
          mimeType: attachment.mimeType,
          appChatId: 'chat-owner'
        })
      ).toBe(true)
    }
  })

  it('preserves global no-chat staging without minting ownership', () => {
    const { store, workspacePath, firstPath } = freshFixture()
    const grantMany = vi.spyOn(store, 'grantMany')
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore: () => store })

    expect(
      stage({
        workspacePath,
        externalPathGrants: [],
        attachments: [{ id: 'first', name: 'first.png', path: firstPath }]
      })
    ).toMatchObject({ ok: true, attachments: [expect.objectContaining({ id: 'first' })] })
    expect(grantMany).not.toHaveBeenCalled()
  })

  it('preserves an authorized folder as a live reference without snapshotting bytes', () => {
    const { store, workspacePath } = freshFixture()
    const folderPath = path.join(workspacePath, 'reference-folder')
    fs.mkdirSync(folderPath)
    const writeOwnedMany = vi.spyOn(store, 'writeOwnedMany')
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore: () => store })

    expect(
      stage({
        chatId: 'chat-owner',
        workspacePath,
        externalPathGrants: [],
        authorizedFilePaths: [folderPath],
        attachments: [
          {
            id: 'folder-1',
            name: 'reference-folder',
            path: folderPath,
            kind: 'directory'
          }
        ]
      })
    ).toEqual({
      ok: true,
      attachments: [
        {
          id: 'folder-1',
          name: 'reference-folder',
          path: folderPath,
          kind: 'directory'
        }
      ]
    })
    expect(writeOwnedMany).not.toHaveBeenCalled()
  })

  it('refuses a folder reference that was not selected by the requesting renderer', () => {
    const { store, workspacePath } = freshFixture()
    const folderPath = path.join(workspacePath, 'unselected-folder')
    fs.mkdirSync(folderPath)
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore: () => store })

    expect(
      stage({
        chatId: 'chat-owner',
        workspacePath,
        externalPathGrants: [],
        authorizedFilePaths: [],
        attachments: [{ path: folderPath, kind: 'directory' }]
      })
    ).toEqual({ ok: false, reason: 'Attachment snapshot failed.' })
  })

  it('returns no durable refs when the ownership batch fails', () => {
    const { store, workspacePath, firstPath } = freshFixture()
    vi.spyOn(store, 'grantMany').mockReturnValue({ ok: false, reason: 'persistence_failed' })
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore: () => store })

    expect(
      stage({
        chatId: 'chat-owner',
        workspacePath,
        externalPathGrants: [],
        attachments: [{ id: 'first', name: 'first.png', path: firstPath }]
      })
    ).toEqual({ ok: false, reason: 'Attachment snapshot failed.' })
  })

  it('does not grant an earlier snapshot when a later queue attachment is invalid', () => {
    const { store, workspacePath, firstPath } = freshFixture()
    const invalidPath = path.join(workspacePath, 'invalid.txt')
    fs.writeFileSync(invalidPath, 'not an image')
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore: () => store })

    expect(
      stage({
        chatId: 'chat-owner',
        workspacePath,
        externalPathGrants: [],
        attachments: [
          { id: 'first', name: 'first.png', path: firstPath },
          { id: 'invalid', name: 'invalid.txt', path: invalidPath }
        ]
      })
    ).toEqual({ ok: false, reason: 'Attachment snapshot failed.' })
    const first = store.writeContentAddressed({
      buffer: fs.readFileSync(firstPath),
      mimeType: 'image/png'
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(
      store.owns({
        sha256: first.sha256,
        mimeType: first.mimeType,
        appChatId: 'chat-owner'
      })
    ).toBe(false)
  })

  it('rejects arrays above the main-authority ceiling before opening the store', () => {
    const getAssetStore = vi.fn()
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore })

    expect(
      stage({
        workspacePath: '/repo',
        externalPathGrants: [],
        attachments: Array.from(
          { length: MAX_DURABLE_ATTACHMENT_REFS + 1 },
          (_, index) => ({ path: `/repo/${index}.png` })
        )
      })
    ).toEqual({ ok: false, reason: 'Attachment snapshot failed.' })
    expect(getAssetStore).not.toHaveBeenCalled()
  })
})
