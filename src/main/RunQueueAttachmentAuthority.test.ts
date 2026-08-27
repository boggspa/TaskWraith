import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createMainOwnedRunQueueAttachmentStager,
  queuedRunAttachmentProviderRerouteAllowed,
  resolveMainOwnedQueuedComposerAttachmentAuthority,
  resolveMainOwnedQueuedComposerAttachments,
  resolveMainOwnedQueuedRunAttachmentPayload,
  resolveMainOwnedQueuedRunAttachmentPayloadAuthority,
  resolveMainOwnedQueuedSteerImagePaths,
  resolveOwnedPersistedRunQueueAttachment
} from './RunQueueAttachmentAuthority'
import { MAX_DURABLE_ATTACHMENT_REFS } from './ScheduledAttachmentDurability'
import {
  signRunQueueDirectoryAttachmentReceipt,
  verifyRunQueueDirectoryAttachmentReceipt
} from './RunQueueDirectoryAttachmentReceipt'
import { TranscriptMediaAssetStore } from './services/TranscriptMediaAssetStore'
import type { ExternalPathGrant, RunQueueImageAttachmentSnapshot, RunQueueJob } from './store/types'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('queuedRunAttachmentProviderRerouteAllowed', () => {
  it('accepts exact providers, durable chat switches, and signed pause reroutes only', () => {
    expect(
      queuedRunAttachmentProviderRerouteAllowed({
        jobProvider: 'claude',
        jobChatId: 'chat-owner',
        payloadProvider: 'claude',
        payloadChatId: 'chat-owner'
      })
    ).toBe(true)
    expect(
      queuedRunAttachmentProviderRerouteAllowed({
        jobProvider: 'claude',
        jobChatId: 'chat-owner',
        payloadProvider: 'codex',
        payloadChatId: 'chat-owner',
        authority: { durableChat: { appChatId: 'chat-owner', provider: 'codex' } }
      })
    ).toBe(true)
    expect(
      queuedRunAttachmentProviderRerouteAllowed({
        jobProvider: 'claude',
        jobChatId: 'chat-owner',
        payloadProvider: 'codex',
        payloadChatId: 'chat-owner',
        authority: {
          rerouteProof: {
            providerReroute: { from: 'claude', to: 'codex', reason: 'provider-paused' },
            postureVerified: true
          }
        }
      })
    ).toBe(true)
    expect(
      queuedRunAttachmentProviderRerouteAllowed({
        jobProvider: 'claude',
        jobChatId: 'chat-owner',
        payloadProvider: 'codex',
        payloadChatId: 'chat-owner',
        authority: {
          durableChat: { appChatId: 'chat-other', provider: 'codex' }
        }
      })
    ).toBe(false)
    expect(
      queuedRunAttachmentProviderRerouteAllowed({
        jobProvider: 'claude',
        jobChatId: 'chat-owner',
        payloadProvider: 'claude',
        payloadChatId: 'chat-other'
      })
    ).toBe(false)
  })
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
  return { root, store, persisted }
}

function queuedJob(
  attachments: RunQueueImageAttachmentSnapshot | RunQueueImageAttachmentSnapshot[],
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
      imageAttachments: Array.isArray(attachments) ? attachments : [attachments]
    },
    ...overrides
  }
}

function externalDirectoryGrant(
  directoryPath: string,
  overrides: Partial<ExternalPathGrant> = {}
): ExternalPathGrant {
  return {
    id: 'grant-directory-1',
    provider: 'pi',
    bindingVersion: 2,
    workspaceId: 'workspace-owner',
    chatId: 'chat-owner',
    path: directoryPath,
    kind: 'directory',
    access: 'read',
    duration: 'thisThread',
    issuedBy: 'main',
    signature: 'a'.repeat(64),
    createdAt: '2026-08-25T14:30:00.000Z',
    ...overrides
  }
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

  it('keeps invalid exact queue authority distinct from an unrelated compose', () => {
    const { store, persisted } = ownedFixture()

    expect(
      resolveMainOwnedQueuedComposerAttachmentAuthority({
        store,
        job: queuedJob({ ...persisted, path: '/forged/path.png' }),
        appRunId: 'run-queued',
        appChatId: 'chat-owner',
        provider: 'pi'
      })
    ).toEqual({ kind: 'invalid' })
    expect(
      resolveMainOwnedQueuedComposerAttachmentAuthority({
        store,
        job: queuedJob(persisted, { status: 'queued' }),
        appRunId: 'run-queued',
        appChatId: 'chat-owner',
        provider: 'pi'
      })
    ).toEqual({ kind: 'not-applicable' })
  })

  it('retains a mixed file/directory queue in its exact main-authenticated order', () => {
    const { root, store, persisted } = ownedFixture()
    const workspacePath = path.join(root, 'workspace')
    const directoryPath = path.join(workspacePath, 'reference-folder')
    fs.mkdirSync(directoryPath, { recursive: true })
    const canonicalDirectoryPath = fs.realpathSync.native(directoryPath)
    const directory = {
      kind: 'directory' as const,
      id: 'folder-1',
      path: directoryPath,
      name: 'reference-folder'
    }

    expect(
      resolveMainOwnedQueuedComposerAttachments({
        store,
        job: queuedJob([directory, { ...persisted, id: 'image-1', name: 'screen.png' }], {
          workspacePath
        }),
        appRunId: 'run-queued',
        appChatId: 'chat-owner',
        provider: 'pi'
      })
    ).toEqual({
      imageAttachments: [
        { ...directory, path: canonicalDirectoryPath },
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

  it('re-derives an external directory from the live picker receipt and fails closed without it', () => {
    const { root, store } = ownedFixture()
    const workspacePath = path.join(root, 'workspace')
    const directoryPath = path.join(root, 'external-reference')
    fs.mkdirSync(workspacePath)
    fs.mkdirSync(directoryPath)
    const job = queuedJob({ kind: 'directory', path: directoryPath }, { workspacePath })
    const resolve = (authorizedDirectoryPickerPaths?: string[]) =>
      resolveMainOwnedQueuedComposerAttachmentAuthority({
        store,
        job,
        appRunId: job.runId,
        appChatId: 'chat-owner',
        provider: 'pi',
        directoryAuthority: { authorizedDirectoryPickerPaths }
      })

    expect(resolve()).toEqual({ kind: 'invalid' })
    expect(resolve([directoryPath])).toEqual({
      kind: 'resolved',
      provider: 'pi',
      imageAttachments: [{ kind: 'directory', path: fs.realpathSync.native(directoryPath) }]
    })
  })

  it('replays a picked external directory after restart through its exact persistent receipt', () => {
    const { root, store } = ownedFixture()
    const workspacePath = path.join(root, 'workspace')
    const directoryPath = path.join(root, 'external-reference')
    fs.mkdirSync(workspacePath)
    fs.mkdirSync(directoryPath)
    const receiptSecret = Buffer.alloc(32, 0x5a)
    const stage = createMainOwnedRunQueueAttachmentStager({
      getAssetStore: () => store,
      signDirectoryReceipt: (binding) =>
        signRunQueueDirectoryAttachmentReceipt(receiptSecret, binding)
    })
    const staged = stage({
      runId: 'run-queued',
      chatId: 'chat-owner',
      provider: 'pi',
      workspaceId: 'workspace-owner',
      workspacePath,
      externalPathGrants: [],
      authorizedFilePaths: [directoryPath],
      authorizedDirectoryPickerPaths: [directoryPath],
      attachments: [{ kind: 'directory', path: directoryPath }]
    })
    expect(staged.ok).toBe(true)
    if (!staged.ok) return
    const attachment = staged.attachments[0]
    expect(attachment).toMatchObject({
      kind: 'directory',
      path: fs.realpathSync.native(directoryPath),
      queueReceipt: {
        schemaVersion: 1,
        runId: 'run-queued',
        chatId: 'chat-owner',
        workspaceId: 'workspace-owner',
        provider: 'pi'
      }
    })
    const restartedAttachment = JSON.parse(JSON.stringify(attachment)) as typeof attachment
    const job = queuedJob(restartedAttachment, {
      workspaceId: 'workspace-owner',
      workspacePath
    })

    expect(
      resolveMainOwnedQueuedComposerAttachmentAuthority({
        store,
        job,
        appRunId: 'run-queued',
        appChatId: 'chat-owner',
        provider: 'pi',
        directoryAuthority: {
          verifyQueueReceipt: (receipt, expected) =>
            verifyRunQueueDirectoryAttachmentReceipt(receiptSecret, receipt, expected)
        }
      })
    ).toMatchObject({
      kind: 'resolved',
      provider: 'pi',
      imageAttachments: [
        {
          kind: 'directory',
          path: fs.realpathSync.native(directoryPath),
          queueReceipt: { runId: 'run-queued' }
        }
      ]
    })

    expect(
      resolveMainOwnedQueuedComposerAttachmentAuthority({
        store,
        job,
        appRunId: 'run-queued',
        appChatId: 'chat-owner',
        provider: 'codex',
        providerAuthority: {
          durableChat: { appChatId: 'chat-owner', provider: 'codex' }
        },
        directoryAuthority: {
          verifyQueueReceipt: (receipt, expected) =>
            verifyRunQueueDirectoryAttachmentReceipt(receiptSecret, receipt, expected)
        }
      })
    ).toMatchObject({ kind: 'resolved', provider: 'codex' })
  })

  it('rejects a durable directory receipt when any exact queued binding changes', () => {
    const { root, store } = ownedFixture()
    const workspacePath = path.join(root, 'workspace')
    const directoryPath = path.join(root, 'external-reference')
    fs.mkdirSync(workspacePath)
    fs.mkdirSync(directoryPath)
    const receiptSecret = Buffer.alloc(32, 0x5a)
    const canonicalPath = fs.realpathSync.native(directoryPath)
    const queueReceipt = signRunQueueDirectoryAttachmentReceipt(receiptSecret, {
      canonicalPath,
      runId: 'run-queued',
      chatId: 'chat-owner',
      workspaceId: 'workspace-owner',
      workspacePath: fs.realpathSync.native(workspacePath),
      provider: 'pi'
    })
    const resolve = (overrides: Partial<RunQueueJob> = {}) => {
      const job = queuedJob(
        { kind: 'directory', path: directoryPath, queueReceipt },
        { workspaceId: 'workspace-owner', workspacePath, ...overrides }
      )
      return resolveMainOwnedQueuedComposerAttachmentAuthority({
        store,
        job,
        appRunId: job.runId,
        appChatId: job.chatId!,
        provider: job.provider,
        directoryAuthority: {
          verifyQueueReceipt: (receipt, expected) =>
            verifyRunQueueDirectoryAttachmentReceipt(receiptSecret, receipt, expected)
        }
      })
    }

    expect(resolve({ runId: 'run-other', id: 'run-other' })).toEqual({ kind: 'invalid' })
    expect(resolve({ chatId: 'chat-other' })).toEqual({ kind: 'invalid' })
    expect(resolve({ workspaceId: 'workspace-other' })).toEqual({ kind: 'invalid' })
    expect(resolve({ scope: 'global' })).toEqual({ kind: 'invalid' })
    expect(resolve({ provider: 'codex' })).toEqual({ kind: 'invalid' })
    expect(
      resolve({
        request: {
          ...queuedJob([]).request!,
          imageAttachments: [
            {
              kind: 'directory',
              path: directoryPath,
              queueReceipt: { ...queueReceipt, signature: '0'.repeat(64) }
            }
          ]
        }
      })
    ).toEqual({ kind: 'invalid' })
  })

  it('requires the same exact main-verified queued grant for external directory replay', () => {
    const { root, store } = ownedFixture()
    const workspacePath = path.join(root, 'workspace')
    const directoryPath = path.join(root, 'external-reference')
    fs.mkdirSync(workspacePath)
    fs.mkdirSync(directoryPath)
    const grant = externalDirectoryGrant(directoryPath)
    const job = queuedJob(
      { kind: 'directory', path: directoryPath },
      { workspacePath, workspaceId: 'workspace-owner' }
    )
    job.request!.externalPathGrants = [grant]
    const resolve = (verifiedExternalPathGrants: ExternalPathGrant[]) =>
      resolveMainOwnedQueuedComposerAttachmentAuthority({
        store,
        job,
        appRunId: job.runId,
        appChatId: 'chat-owner',
        provider: 'pi',
        directoryAuthority: { verifiedExternalPathGrants }
      })

    expect(resolve([grant])).toMatchObject({
      kind: 'resolved',
      provider: 'pi',
      imageAttachments: [{ kind: 'directory', path: fs.realpathSync.native(directoryPath) }]
    })
    expect(resolve([{ ...grant, signature: 'b'.repeat(64) }])).toEqual({ kind: 'invalid' })
    expect(resolve([{ ...grant, provider: 'codex' }])).toEqual({ kind: 'invalid' })
    expect(resolve([{ ...grant, bindingVersion: undefined }])).toEqual({ kind: 'invalid' })
  })

  it('rejects non-leased, cross-chat, wrong-run, raw-path, and malformed directory authority', () => {
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
    expect(resolve(queuedJob({ path: '   ', kind: 'directory' }))).toBeNull()
    expect(
      resolveMainOwnedQueuedComposerAttachments({
        store,
        job: queuedJob(persisted),
        appRunId: 'run-other',
        appChatId: 'chat-owner',
        provider: 'pi'
      })
    ).toBeNull()
  })
})

describe('resolveMainOwnedQueuedRunAttachmentPayload', () => {
  const payload = (overrides: Record<string, unknown> = {}) => ({
    provider: 'pi',
    appRunId: 'run-queued',
    appChatId: 'chat-owner',
    imagePaths: ['/renderer/forged.png'],
    composer: {
      imagePaths: ['/renderer/also-forged.png'],
      applicationLog: 'preserve this metadata'
    },
    ...overrides
  })

  it('overwrites forged renderer paths at both payload levels without mutating its input', () => {
    const { store, persisted } = ownedFixture()
    const unrelated = store.writeContentAddressed({
      buffer: Buffer.from('unrelated but owned queue image'),
      mimeType: 'image/png',
      appChatId: 'chat-owner'
    })
    if (!unrelated.ok) throw new Error(unrelated.reason)
    const original = payload({
      imagePaths: [unrelated.path, '/renderer/forged.png'],
      composer: {
        imagePaths: [unrelated.path, '/renderer/also-forged.png'],
        applicationLog: 'preserve this metadata'
      }
    })
    const job = queuedJob({ ...persisted, id: 'image-1', name: 'screen.png' })

    const resolved = resolveMainOwnedQueuedRunAttachmentPayload({ store, job, payload: original })
    const authority = resolveMainOwnedQueuedRunAttachmentPayloadAuthority({
      store,
      job,
      payload: original
    })

    expect(resolved).toEqual({
      ...original,
      imagePaths: [persisted.path],
      composer: {
        applicationLog: 'preserve this metadata',
        imagePaths: [persisted.path]
      }
    })
    expect(resolved).not.toBe(original)
    expect(resolved?.imagePaths).not.toBe(original.imagePaths)
    expect(resolved?.composer).not.toBe(original.composer)
    expect(original.imagePaths).toEqual([unrelated.path, '/renderer/forged.png'])
    expect(original.composer.imagePaths).toEqual([unrelated.path, '/renderer/also-forged.png'])
    expect(authority).toEqual({ kind: 'resolved', payload: resolved })
  })

  it('uses only owned file snapshots from a mixed queue and never turns directories into images', () => {
    const { store, persisted } = ownedFixture()
    const second = store.writeContentAddressed({
      buffer: Buffer.from('second owned queue image'),
      mimeType: 'image/png',
      appChatId: 'chat-owner'
    })
    if (!second.ok) throw new Error(second.reason)
    const job = queuedJob([
      { ...persisted, id: 'first' },
      { kind: 'directory', id: 'folder', path: '/repo/reference-folder' },
      { ...second, id: 'second' }
    ])

    const resolved = resolveMainOwnedQueuedRunAttachmentPayload({
      store,
      job,
      payload: payload({ imagePaths: ['/renderer/extra.png', second.path] })
    })

    expect(resolved?.imagePaths).toEqual([persisted.path, second.path])
    expect(resolved?.composer?.imagePaths).toEqual([persisted.path, second.path])
  })

  it('authoritatively clears forged image paths for a directory-only queued request', () => {
    const { store } = ownedFixture()
    const resolved = resolveMainOwnedQueuedRunAttachmentPayload({
      store,
      job: queuedJob({ kind: 'directory', path: '/repo/reference-folder' }),
      payload: payload()
    })

    expect(resolved?.imagePaths).toEqual([])
    expect(resolved?.composer?.imagePaths).toEqual([])
  })

  it('does not synthesize composer metadata when the payload did not carry it', () => {
    const { store, persisted } = ownedFixture()
    const withoutComposer = {
      provider: 'pi',
      appRunId: 'run-queued',
      appChatId: 'chat-owner',
      imagePaths: []
    }

    expect(
      resolveMainOwnedQueuedRunAttachmentPayload({
        store,
        job: queuedJob(persisted),
        payload: withoutComposer
      })
    ).toEqual({ ...withoutComposer, imagePaths: [persisted.path] })
  })

  it('classifies unrelated identity or lifecycle as not applicable to queued authority', () => {
    const { store, persisted } = ownedFixture()
    const validPayload = payload()
    const cases: Array<[string, RunQueueJob | null, ReturnType<typeof payload>]> = [
      ['missing job', null, validPayload],
      ['not leased', queuedJob(persisted, { status: 'queued' }), validPayload],
      ['never enqueued', queuedJob(persisted, { enqueuedAt: undefined }), validPayload],
      ['run mismatch', queuedJob(persisted), payload({ appRunId: 'run-other' })],
      ['chat mismatch', queuedJob(persisted), payload({ appChatId: 'chat-other' })]
    ]

    for (const [label, job, candidate] of cases) {
      expect(
        resolveMainOwnedQueuedRunAttachmentPayloadAuthority({
          store,
          job,
          payload: candidate
        }),
        label
      ).toEqual({ kind: 'not-applicable' })
    }
  })

  it('preserves exact chat/run attachment authority across a main-composed provider reroute', () => {
    const { store, persisted } = ownedFixture()
    const rerouted = payload({ provider: 'codex' })

    expect(
      resolveMainOwnedQueuedRunAttachmentPayloadAuthority({
        store,
        job: queuedJob(persisted),
        payload: rerouted
      })
    ).toEqual({ kind: 'invalid' })

    expect(
      resolveMainOwnedQueuedRunAttachmentPayloadAuthority({
        store,
        job: queuedJob(persisted),
        payload: rerouted,
        providerAuthority: {
          durableChat: { appChatId: 'chat-owner', provider: 'codex' }
        }
      })
    ).toEqual({
      kind: 'resolved',
      payload: {
        ...rerouted,
        imagePaths: [persisted.path],
        composer: { ...rerouted.composer, imagePaths: [persisted.path] }
      }
    })

    expect(
      resolveMainOwnedQueuedRunAttachmentPayloadAuthority({
        store,
        job: queuedJob(persisted),
        payload: rerouted,
        providerAuthority: {
          rerouteProof: {
            providerReroute: { from: 'pi', to: 'codex', reason: 'provider-paused' },
            postureVerified: true
          }
        }
      })
    ).toMatchObject({ kind: 'resolved', payload: { provider: 'codex' } })

    expect(
      resolveMainOwnedQueuedRunAttachmentPayloadAuthority({
        store,
        job: queuedJob(persisted),
        payload: rerouted,
        providerAuthority: {
          durableChat: { appChatId: 'chat-other', provider: 'codex' }
        }
      })
    ).toEqual({ kind: 'invalid' })
  })

  it('classifies malformed or unowned refs on an exact queued candidate as invalid', () => {
    const { store, persisted } = ownedFixture()
    const validPayload = payload()
    const cases: Array<[string, RunQueueJob, ReturnType<typeof payload>]> = [
      ['raw path', queuedJob({ path: '/tmp/raw.png' }), validPayload],
      [
        'forged persisted locator',
        queuedJob({ ...persisted, path: '/tmp/forged-cas.png' }),
        validPayload
      ],
      ['malformed directory', queuedJob({ kind: 'directory', path: '' }), validPayload],
      ['missing request', queuedJob(persisted, { request: undefined }), validPayload],
      [
        'wrong chat ownership',
        queuedJob(persisted, { chatId: 'chat-attacker' }),
        payload({ appChatId: 'chat-attacker' })
      ]
    ]

    for (const [label, job, candidate] of cases) {
      expect(
        resolveMainOwnedQueuedRunAttachmentPayloadAuthority({ store, job, payload: candidate }),
        label
      ).toEqual({ kind: 'invalid' })
    }
  })

  it('classifies an attachment-store failure as invalid instead of falling through', () => {
    const { store, persisted } = ownedFixture()
    vi.spyOn(store, 'resolvePersistedAttachment').mockImplementation(() => {
      throw new Error('asset store unavailable')
    })

    expect(
      resolveMainOwnedQueuedRunAttachmentPayloadAuthority({
        store,
        job: queuedJob(persisted),
        payload: payload()
      })
    ).toEqual({ kind: 'invalid' })
  })

  it('requires exact non-empty payload identity before queue authority applies', () => {
    const { store, persisted } = ownedFixture()
    const job = queuedJob(persisted)
    for (const candidate of [
      payload({ appRunId: '' }),
      payload({ appChatId: '' }),
      payload({ provider: '' }),
      payload({ appRunId: ' run-queued' }),
      payload({ appChatId: 'chat-owner ' })
    ]) {
      expect(
        resolveMainOwnedQueuedRunAttachmentPayloadAuthority({ store, job, payload: candidate })
      ).toEqual({ kind: 'not-applicable' })
    }
  })

  it('rejects a hand-edited queue above the durable attachment ceiling', () => {
    const { store } = ownedFixture()
    const attachments = Array.from({ length: MAX_DURABLE_ATTACHMENT_REFS + 1 }, (_, index) => ({
      kind: 'directory' as const,
      path: `/repo/folder-${index}`
    }))

    expect(
      resolveMainOwnedQueuedRunAttachmentPayloadAuthority({
        store,
        job: queuedJob(attachments),
        payload: payload()
      })
    ).toEqual({ kind: 'invalid' })
  })
})

describe('resolveMainOwnedQueuedSteerImagePaths', () => {
  it('returns only canonical owned file paths in queue order', () => {
    const { store, persisted } = ownedFixture()
    const second = store.writeContentAddressed({
      buffer: Buffer.from('second native steer image'),
      mimeType: 'image/png',
      appChatId: 'chat-owner'
    })
    if (!second.ok) throw new Error(second.reason)

    expect(
      resolveMainOwnedQueuedSteerImagePaths({
        store,
        job: queuedJob(
          [
            { ...persisted, id: 'first' },
            { ...second, id: 'second' }
          ],
          { status: 'steer_promoting' }
        ),
        appChatId: 'chat-owner'
      })
    ).toEqual({ ok: true, imagePaths: [persisted.path, second.path] })
  })

  it('accepts an attachment-free native steer as an exact empty set', () => {
    const { store } = ownedFixture()

    expect(
      resolveMainOwnedQueuedSteerImagePaths({
        store,
        job: queuedJob([], { status: 'steer_promoting' }),
        appChatId: 'chat-owner'
      })
    ).toEqual({ ok: true, imagePaths: [] })
  })

  it('keeps PDFs on the durable compose boundary instead of sending them as localImage', () => {
    const { store } = ownedFixture()
    const pdf = store.writeContentAddressed({
      buffer: Buffer.from('%PDF-1.7 queued reference'),
      mimeType: 'application/pdf',
      appChatId: 'chat-owner'
    })
    if (!pdf.ok) throw new Error(pdf.reason)

    expect(
      resolveMainOwnedQueuedSteerImagePaths({
        store,
        job: queuedJob(pdf, { status: 'steer_promoting' }),
        appChatId: 'chat-owner'
      })
    ).toEqual({ ok: false, reason: 'invalid_attachment_authority' })
  })

  it('requires the native steer lifecycle state explicitly', () => {
    const { store, persisted } = ownedFixture()

    expect(
      resolveMainOwnedQueuedSteerImagePaths({
        store,
        job: queuedJob(persisted, { status: 'starting' }),
        appChatId: 'chat-owner'
      })
    ).toEqual({ ok: false, reason: 'not_steer_promoting' })
  })

  it('rejects renderer paths, directories, forged locators, and unowned files', () => {
    const { store, persisted } = ownedFixture()
    const jobs: Array<[string, RunQueueJob, string]> = [
      [
        'renderer raw path',
        queuedJob({ path: '/renderer/selected-but-not-queued.png' }, { status: 'steer_promoting' }),
        'chat-owner'
      ],
      [
        'directory',
        queuedJob(
          { kind: 'directory', path: '/repo/reference-folder' },
          { status: 'steer_promoting' }
        ),
        'chat-owner'
      ],
      [
        'forged persisted locator',
        queuedJob(
          { ...persisted, path: '/tmp/forged-steer-cas.png' },
          { status: 'steer_promoting' }
        ),
        'chat-owner'
      ],
      ['wrong chat ownership', queuedJob(persisted, { status: 'steer_promoting' }), 'chat-attacker']
    ]

    for (const [label, job, appChatId] of jobs) {
      expect(resolveMainOwnedQueuedSteerImagePaths({ store, job, appChatId }), label).toEqual({
        ok: false,
        reason: 'invalid_attachment_authority'
      })
    }
  })

  it('fails explicitly for malformed jobs, over-limit refs, or ownership-store errors', () => {
    const { store, persisted } = ownedFixture()
    const overLimit = Array.from({ length: MAX_DURABLE_ATTACHMENT_REFS + 1 }, () => persisted)
    const invalidJobs = [
      queuedJob(persisted, { status: 'steer_promoting', request: undefined }),
      queuedJob(overLimit, { status: 'steer_promoting' })
    ]
    for (const job of invalidJobs) {
      expect(
        resolveMainOwnedQueuedSteerImagePaths({ store, job, appChatId: 'chat-owner' })
      ).toEqual({ ok: false, reason: 'invalid_attachment_authority' })
    }

    expect(
      resolveMainOwnedQueuedSteerImagePaths({
        store: {
          owns: vi.fn(() => true),
          resolvePersistedAttachment: vi.fn(() => {
            throw new Error('store unavailable')
          })
        },
        job: queuedJob(persisted, { status: 'steer_promoting' }),
        appChatId: 'chat-owner'
      })
    ).toEqual({ ok: false, reason: 'invalid_attachment_authority' })
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
    return { root, store, workspacePath, firstPath, secondPath }
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

  it('never launders a context-free external grant into durable file ownership', () => {
    const { root, store, workspacePath } = freshFixture()
    const outsidePath = path.join(root, 'outside.png')
    fs.writeFileSync(
      outsidePath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x33])
    )
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore: () => store })
    const externalPathGrants: ExternalPathGrant[] = [
      {
        id: 'context-free-grant',
        provider: 'pi',
        path: outsidePath,
        kind: 'file',
        access: 'read',
        duration: 'thisThread',
        createdAt: '2026-08-25T14:30:00.000Z'
      }
    ]

    expect(
      stage({
        chatId: 'chat-owner',
        workspacePath,
        externalPathGrants,
        authorizedFilePaths: [],
        attachments: [{ path: outsidePath }]
      })
    ).toEqual({ ok: false, reason: 'Attachment snapshot failed.' })

    const selected = stage({
      chatId: 'chat-owner',
      workspacePath,
      externalPathGrants,
      authorizedFilePaths: [outsidePath],
      attachments: [{ id: 'selected', path: outsidePath }]
    })
    expect(selected).toMatchObject({
      ok: true,
      attachments: [expect.objectContaining({ id: 'selected', persistenceVersion: 1 })]
    })
  })

  it('requires an exact picker receipt for an external PDF snapshot', () => {
    const { root, store, workspacePath } = freshFixture()
    const outsidePath = path.join(root, 'outside.pdf')
    fs.writeFileSync(outsidePath, '%PDF-1.7\nexternal queue document')
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore: () => store })

    expect(
      stage({
        chatId: 'chat-owner',
        workspacePath,
        externalPathGrants: [],
        authorizedFilePaths: [],
        attachments: [{ path: outsidePath }]
      })
    ).toEqual({ ok: false, reason: 'Attachment snapshot failed.' })
    expect(
      stage({
        chatId: 'chat-owner',
        workspacePath,
        externalPathGrants: [],
        authorizedFilePaths: [outsidePath],
        attachments: [{ path: outsidePath }]
      })
    ).toMatchObject({
      ok: true,
      attachments: [expect.objectContaining({ mimeType: 'application/pdf' })]
    })
  })

  it('preserves an authorized folder as a live reference without snapshotting bytes', () => {
    const { store, workspacePath } = freshFixture()
    const folderPath = path.join(workspacePath, 'reference-folder')
    fs.mkdirSync(folderPath)
    const canonicalFolderPath = fs.realpathSync.native(folderPath)
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
          path: canonicalFolderPath,
          kind: 'directory'
        }
      ]
    })
    expect(writeOwnedMany).not.toHaveBeenCalled()
  })

  it('refuses a folder reference that was not selected by the requesting renderer', () => {
    const { store, workspacePath } = freshFixture()
    const folderPath = path.join(path.dirname(workspacePath), 'unselected-folder')
    fs.mkdirSync(folderPath)
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore: () => store })

    expect(
      stage({
        chatId: 'chat-owner',
        workspacePath,
        externalPathGrants: [externalDirectoryGrant(folderPath)],
        authorizedFilePaths: [],
        attachments: [{ path: folderPath, kind: 'directory' }]
      })
    ).toEqual({ ok: false, reason: 'Attachment snapshot failed.' })
  })

  it('refuses to persist an external picked folder when main receipt signing is unavailable', () => {
    const { root, store, workspacePath } = freshFixture()
    const folderPath = path.join(root, 'selected-external-folder')
    fs.mkdirSync(folderPath)
    const stage = createMainOwnedRunQueueAttachmentStager({ getAssetStore: () => store })

    expect(
      stage({
        runId: 'run-queued',
        chatId: 'chat-owner',
        provider: 'pi',
        workspaceId: 'workspace-owner',
        workspacePath,
        externalPathGrants: [],
        authorizedFilePaths: [folderPath],
        authorizedDirectoryPickerPaths: [folderPath],
        attachments: [{ path: folderPath, kind: 'directory' }]
      })
    ).toEqual({ ok: false, reason: 'Attachment snapshot failed.' })
  })

  it('does not treat the process-wide main path fallback as directory picker provenance', () => {
    const { root, store, workspacePath } = freshFixture()
    const folderPath = path.join(root, 'other-chat-main-folder')
    fs.mkdirSync(folderPath)
    const stage = createMainOwnedRunQueueAttachmentStager({
      getAssetStore: () => store,
      getAuthorizedFilePaths: () => [folderPath],
      signDirectoryReceipt: (binding) =>
        signRunQueueDirectoryAttachmentReceipt(Buffer.alloc(32, 0x6b), binding)
    })

    expect(
      stage({
        runId: 'run-queued',
        chatId: 'chat-owner',
        provider: 'pi',
        workspaceId: 'workspace-owner',
        workspacePath,
        externalPathGrants: [],
        attachments: [{ path: folderPath, kind: 'directory' }]
      })
    ).toEqual({ ok: false, reason: 'Attachment snapshot failed.' })
    expect(
      stage({
        runId: 'run-queued',
        chatId: 'chat-owner',
        provider: 'pi',
        workspaceId: 'workspace-owner',
        workspacePath,
        externalPathGrants: [],
        // This mirrors the current main-renderer callsite's merged sender +
        // process-wide main capability list. It is valid for file copying,
        // but cannot prove which chat's picker selected this directory.
        authorizedFilePaths: [folderPath],
        attachments: [{ path: folderPath, kind: 'directory' }]
      })
    ).toEqual({ ok: false, reason: 'Attachment snapshot failed.' })
  })

  it('never accepts a renderer-supplied directory receipt without exact picker authority', () => {
    const { root, store, workspacePath } = freshFixture()
    const folderPath = path.join(root, 'unselected-receipted-folder')
    fs.mkdirSync(folderPath)
    const canonicalWorkspacePath = fs.realpathSync.native(workspacePath)
    const forgedReceipt = signRunQueueDirectoryAttachmentReceipt(Buffer.alloc(32, 0x7a), {
      canonicalPath: fs.realpathSync.native(folderPath),
      runId: 'run-queued',
      chatId: 'chat-owner',
      workspaceId: 'workspace-owner',
      workspacePath: canonicalWorkspacePath,
      provider: 'pi'
    })
    const stage = createMainOwnedRunQueueAttachmentStager({
      getAssetStore: () => store,
      signDirectoryReceipt: (binding) =>
        signRunQueueDirectoryAttachmentReceipt(Buffer.alloc(32, 0x7a), binding)
    })

    expect(
      stage({
        runId: 'run-queued',
        chatId: 'chat-owner',
        provider: 'pi',
        workspaceId: 'workspace-owner',
        workspacePath,
        externalPathGrants: [],
        authorizedFilePaths: [],
        attachments: [{ path: folderPath, kind: 'directory', queueReceipt: forgedReceipt }]
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
        attachments: Array.from({ length: MAX_DURABLE_ATTACHMENT_REFS + 1 }, (_, index) => ({
          path: `/repo/${index}.png`
        }))
      })
    ).toEqual({ ok: false, reason: 'Attachment snapshot failed.' })
    expect(getAssetStore).not.toHaveBeenCalled()
  })
})
