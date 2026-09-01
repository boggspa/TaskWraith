import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  HOST_PROFILE_CHATS_DIRECTORY,
  HOST_PROFILE_WORKSPACES_FILENAME,
  HostProfileDomainStore
} from '../host-runtime/HostProfileDomainStore'
import {
  HostFullAccessGrantRegistry,
  HostPermissionConsentAuthority
} from '../host-runtime/HostPermissionConsent'
import type { HostProviderRunEvent } from '../host-runtime/HostProviderRunPort'
import { HostNodeProfileRunPort } from './HostNodeProfileRunPort'
import { resolveHostNodeCodexPosture } from './HostNodeCodexProvider'

const paths: string[] = []

function openStore() {
  const profile = mkdtempSync(join(tmpdir(), 'host-node-profile-run-'))
  const workspace = mkdtempSync(join(tmpdir(), 'host-node-profile-workspace-'))
  paths.push(profile, workspace)
  let id = 0
  const store = new HostProfileDomainStore({
    profilePath: profile,
    authority: {
      assertProfileAuthority() {
        return undefined
      }
    },
    now: () => Date.UTC(2026, 7, 24, 5, 0, 0),
    idFactory: () => `id-${++id}`
  })
  const registered = store.registerWorkspace({ path: workspace })
  const created = store.createThread({ scope: 'workspace', workspaceId: registered.id })
  store.configureThread({
    threadId: created.appChatId,
    providerId: 'muse',
    modelId: 'muse-spark-1.2',
    reasoningId: 'high',
    postureId: 'workspace_write',
    postureConsent: true
  })
  return { profile, workspace, store, threadId: created.appChatId }
}

afterEach(() => {
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true })
})

describe('HostNodeProfileRunPort', () => {
  it('maps only configured canonical Muse workspace threads and persists idempotent lifecycle state', () => {
    const { store, threadId } = openStore()
    const events: HostProviderRunEvent[] = []
    const port = new HostNodeProfileRunPort({
      store,
      events: { publish: (_target, event) => events.push(event) }
    })
    const thread = port.getThread(threadId)
    expect(thread).toMatchObject({
      threadId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      posture: { postureId: 'workspace_write', explicitConsentAcknowledged: true }
    })

    expect(
      port.beginRun({
        runId: 'run-1',
        threadId,
        providerId: 'muse',
        modelId: 'muse-spark-1.2',
        startedAt: '2026-08-24T05:00:00.000Z'
      })
    ).toEqual({ kind: 'started' })
    expect(() =>
      port.beginRun({
        runId: 'run-3',
        threadId,
        providerId: 'muse',
        modelId: 'muse-spark-1.2',
        startedAt: '2026-08-24T05:00:00.000Z'
      })
    ).toThrow('active')
    expect(
      port.beginRun({
        runId: 'run-1',
        threadId,
        providerId: 'muse',
        modelId: 'muse-spark-1.2',
        startedAt: '2026-08-24T05:00:00.000Z'
      })
    ).toEqual({ kind: 'duplicate' })
    port.appendTranscript({
      threadId,
      runId: 'run-1',
      role: 'user',
      text: 'Multiline\nMuse prompt',
      createdAt: '2026-08-24T05:00:00.000Z'
    })
    port.updateRun({ runId: 'run-1', phase: 'streaming', updatedAt: '2026-08-24T05:00:00.000Z' })
    port.updateRun({ runId: 'run-1', phase: 'streaming', updatedAt: '2026-08-24T05:00:00.000Z' })
    expect(port.registerCancel('run-1', () => {})).toEqual({ kind: 'registered' })
    expect(port.registerCancel('run-1', () => {})).toEqual({ kind: 'duplicate' })
    port.publishRunEvent(
      { id: 'host-client-1' },
      {
        type: 'run.content',
        runId: 'run-1',
        threadId,
        text: 'bounded output',
        at: '2026-08-24T05:00:00.000Z'
      }
    )
    port.publishRunEvent(
      { id: 'host-client-1' },
      {
        type: 'run.tool',
        runId: 'run-1',
        threadId,
        toolId: 'tool-edit',
        toolName: 'Edit',
        file: 'src/example.ts',
        additions: 4,
        deletions: 2,
        diff: {
          hunks: [
            {
              header: '@@ -1,1 +1,2 @@',
              lines: [
                { type: 'del', text: 'old', oldLine: 1 },
                { type: 'add', text: 'new', newLine: 1 }
              ]
            }
          ]
        },
        phase: 'started',
        at: '2026-08-24T05:00:00.000Z'
      }
    )
    port.publishRunEvent(
      { id: 'host-client-1' },
      {
        type: 'run.tool',
        runId: 'run-1',
        threadId,
        toolId: 'tool-edit',
        phase: 'finished',
        status: 'success',
        at: '2026-08-24T05:00:00.000Z'
      }
    )
    port.finishRun({
      runId: 'run-1',
      status: 'completed',
      finishedAt: '2026-08-24T05:00:00.000Z',
      providerSessionId: '11111111-1111-4111-8111-111111111111',
      warningSummaries: []
    })
    port.finishRun({
      runId: 'run-1',
      status: 'completed',
      finishedAt: '2026-08-24T05:00:00.000Z',
      providerSessionId: '11111111-1111-4111-8111-111111111111',
      warningSummaries: []
    })
    port.clearCancel('run-1')
    const restartedPort = new HostNodeProfileRunPort({
      store,
      events: { publish: (_target, _event) => undefined }
    })
    expect(() =>
      restartedPort.finishRun({
        runId: 'run-1',
        status: 'completed',
        finishedAt: '2026-08-24T05:00:00.000Z',
        providerSessionId: '11111111-1111-4111-8111-111111111111',
        warningSummaries: []
      })
    ).not.toThrow()
    expect(() =>
      restartedPort.finishRun({
        runId: 'run-1',
        status: 'cancelled',
        finishedAt: '2026-08-24T05:00:00.000Z',
        warningSummaries: []
      })
    ).toThrow('Terminal')

    expect(restartedPort.getThread(threadId)).toMatchObject({
      providerSessionId: '11111111-1111-4111-8111-111111111111'
    })

    expect(store.getThread(threadId)?.runs).toEqual([
      expect.objectContaining({ runId: 'run-1', status: 'completed' })
    ])
    expect(events).toEqual([
      expect.objectContaining({ type: 'run.content' }),
      expect.objectContaining({ type: 'run.tool', phase: 'started' }),
      expect.objectContaining({ type: 'run.tool', phase: 'finished' })
    ])
    expect(store.getThread(threadId)?.runs?.[0]?.toolActivities).toEqual([
      expect.objectContaining({
        id: 'tool-edit',
        name: 'Edit File',
        category: 'write',
        status: 'success',
        file: 'src/example.ts',
        additions: 4,
        deletions: 2,
        diff: {
          hunks: [
            {
              header: '@@ -1,1 +1,2 @@',
              lines: [
                { type: 'del', text: 'old', oldLine: 1 },
                { type: 'add', text: 'new', newLine: 1 }
              ]
            }
          ]
        }
      })
    ])
  })

  it('fails closed for global, unconfigured, or unconsented threads and cancels exact active thread once', () => {
    const { store, threadId } = openStore()
    const global = store.createThread({ scope: 'global' })
    const port = new HostNodeProfileRunPort({
      store,
      events: { publish: (_target, _event) => undefined }
    })
    expect(port.getThread(global.appChatId)).toBeNull()
    store.configureThread({ threadId, postureId: 'read_only' })
    expect(port.getThread(threadId)).toMatchObject({ posture: { postureId: 'read_only' } })
    expect(
      port.beginRun({
        runId: 'run-2',
        threadId,
        providerId: 'muse',
        modelId: 'muse-spark-1.2',
        startedAt: '2026-08-24T05:00:00.000Z'
      })
    ).toEqual({ kind: 'started' })
    let calls = 0
    expect(
      port.registerCancel('run-2', () => {
        calls += 1
      })
    ).toEqual({ kind: 'registered' })
    expect(port.cancelThread(threadId)).toBe('cancelled')
    expect(port.cancelThread(threadId)).toBe('not_cancellable')
    expect(calls).toBe(1)
  })

  it('never lets a stale cancel identity stop a newer run on the same thread', () => {
    const { store, threadId } = openStore()
    const port = new HostNodeProfileRunPort({
      store,
      events: { publish: (_target, _event) => undefined }
    })
    port.beginRun({
      runId: 'run-old',
      threadId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      startedAt: '2026-08-24T05:00:00.000Z'
    })
    port.registerCancel('run-old', () => {})
    port.finishRun({
      runId: 'run-old',
      status: 'completed',
      finishedAt: '2026-08-24T05:00:01.000Z',
      warningSummaries: []
    })
    port.clearCancel('run-old')

    port.beginRun({
      runId: 'run-new',
      threadId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      startedAt: '2026-08-24T05:00:02.000Z'
    })
    let cancelled = 0
    port.registerCancel('run-new', () => {
      cancelled += 1
    })
    expect(port.cancelThread(threadId, 'run-old')).toBe('identity_mismatch')
    expect(cancelled).toBe(0)
    expect(port.cancelThread(threadId, 'run-new')).toBe('cancelled')
    expect(cancelled).toBe(1)
  })

  it('accepts any live-selectable provider and rejects provider mismatches', () => {
    const { store, workspace } = openStore()
    const registered = store.registerWorkspace({ path: workspace })
    const claudeThread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    store.configureThread({
      threadId: claudeThread.appChatId,
      providerId: 'claude',
      modelId: 'claude-sonnet-4',
      postureId: 'workspace_write',
      postureConsent: true
    })
    const port = new HostNodeProfileRunPort({
      store,
      events: { publish: (_target, _event) => undefined }
    })
    expect(port.getThread(claudeThread.appChatId)).toMatchObject({
      providerId: 'claude',
      modelId: 'claude-sonnet-4'
    })
    expect(
      port.beginRun({
        runId: 'run-claude',
        threadId: claudeThread.appChatId,
        providerId: 'claude',
        modelId: 'claude-sonnet-4',
        startedAt: '2026-08-24T05:00:00.000Z'
      })
    ).toEqual({ kind: 'started' })
    expect(() =>
      port.beginRun({
        runId: 'run-muse-mismatch',
        threadId: claudeThread.appChatId,
        providerId: 'muse',
        modelId: 'muse-spark-1.2',
        startedAt: '2026-08-24T05:00:00.000Z'
      })
    ).toThrow('provider does not match')
  })

  it('retains the conditionally admitted AntiGravity identity for registry-gated runs', () => {
    const { store } = openStore()
    const registered = store.listWorkspaces()[0]!
    const thread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    store.configureThread({
      threadId: thread.appChatId,
      providerId: 'antigravity',
      modelId: 'gemini-3.7-flash',
      postureId: 'read_only'
    })
    const port = new HostNodeProfileRunPort({
      store,
      events: { publish: (_target, _event) => undefined }
    })
    expect(port.getThread(thread.appChatId)).toMatchObject({
      providerId: 'antigravity',
      modelId: 'gemini-3.7-flash',
      posture: { postureId: 'read_only' }
    })
  })

  it('runs a desktop-authored thread whose permission posture is implicit default', () => {
    // Desktop chat records with no explicit permission preset carry neither
    // `permissionPresetId` nor `approvalMode` in providerMetadata — the desktop
    // treats that as its standard default posture. The run port must map it the
    // same way instead of hiding the thread (composer.send would deny it as
    // `standalone_thread_required` even though the thread visibly exists).
    const { store } = openStore()
    const registered = store.listWorkspaces()[0]!
    const thread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    store.configureThread({
      threadId: thread.appChatId,
      providerId: 'mistral',
      modelId: 'mistral-medium-3.5'
    })
    const port = new HostNodeProfileRunPort({
      store,
      events: { publish: (_target, _event) => undefined }
    })
    expect(port.getThread(thread.appChatId)).toMatchObject({
      providerId: 'mistral',
      modelId: 'mistral-medium-3.5',
      posture: {
        postureId: 'default',
        approvalMode: 'default',
        requiresExplicitConsent: false,
        explicitConsentAcknowledged: false
      }
    })
  })

  it('keeps failing closed when posture metadata is present but unrecognized', () => {
    const { store } = openStore()
    const registered = store.listWorkspaces()[0]!
    const thread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    store.configureThread({
      threadId: thread.appChatId,
      providerId: 'mistral',
      modelId: 'mistral-medium-3.5'
    })
    const current = store.getThread(thread.appChatId)!
    store.persistThreadRecord({
      threadId: thread.appChatId,
      expectedRevision: current.persistenceRevision ?? 0,
      record: {
        ...current,
        providerMetadata: {
          ...(current.providerMetadata ?? {}),
          approvalMode: 'yolo-unknown'
        }
      }
    })
    const port = new HostNodeProfileRunPort({
      store,
      events: { publish: (_target, _event) => undefined }
    })
    expect(port.getThread(thread.appChatId)).toBeNull()
  })

  it('falls back to the desktop provider-family reasoning key when the host key is absent', () => {
    const { store } = openStore()
    const registered = store.listWorkspaces()[0]!
    const thread = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    store.configureThread({
      threadId: thread.appChatId,
      providerId: 'mistral',
      modelId: 'mistral-medium-3.5'
    })
    const current = store.getThread(thread.appChatId)!
    store.persistThreadRecord({
      threadId: thread.appChatId,
      expectedRevision: current.persistenceRevision ?? 0,
      record: {
        ...current,
        providerMetadata: {
          ...(current.providerMetadata ?? {}),
          mistralReasoningEffort: 'high'
        }
      }
    })
    const port = new HostNodeProfileRunPort({
      store,
      events: { publish: (_target, _event) => undefined }
    })
    expect(port.getThread(thread.appChatId)).toMatchObject({ reasoningId: 'high' })
  })

  it('projects Full Access only after exact signed consent and live-grant verification', () => {
    const { store } = openStore()
    const registered = store.listWorkspaces()[0]!
    const created = store.createThread({ scope: 'workspace', workspaceId: registered.id })
    const consentAuthority = new HostPermissionConsentAuthority(
      Buffer.alloc(32, 6),
      () => '2026-08-29T23:30:00.000Z'
    )
    const selection = {
      threadId: created.appChatId,
      providerId: 'codex',
      modelId: 'gpt-5.6-terra',
      postureId: 'full_access' as const,
      offerRevision: 'codex-offer-revision'
    }
    const consent = consentAuthority.issue({
      commandId: '11111111-1111-4111-8111-111111111111',
      commandFingerprint: 'c'.repeat(64),
      actor: { actorId: 'tui-user', clientId: 'tui-client', clientClass: 'tui' },
      ...selection,
      workspaceId: registered.id,
      workspacePath: registered.realPath,
      issuedAt: '2026-08-29T23:29:59.000Z'
    })
    store.configureThread({ ...selection, postureConsent: consent })
    const events = { publish: (_target: unknown, _event: HostProviderRunEvent) => undefined }
    const expected = {
      threadId: created.appChatId,
      providerId: 'codex',
      workspaceId: registered.id,
      workspacePath: registered.realPath,
      modelId: 'gpt-5.6-terra',
      postureId: 'full_access' as const,
      offerRevision: 'codex-offer-revision'
    }
    const verifiedConsent = consentAuthority.verify(consent, expected)!
    const fullAccessGrants = new HostFullAccessGrantRegistry()
    fullAccessGrants.activateVerified(consent, verifiedConsent)

    const verified = new HostNodeProfileRunPort({
      store,
      events,
      permissionConsentAuthority: consentAuthority,
      fullAccessGrants
    }).getThread(created.appChatId)
    expect(verified).toMatchObject({
      providerId: 'codex',
      modelId: 'gpt-5.6-terra',
      posture: {
        postureId: 'full_access',
        approvalMode: 'auto_edit',
        explicitConsentAcknowledged: true,
        verifiedConsent: {
          authority: 'host-signed',
          commandId: '11111111-1111-4111-8111-111111111111'
        }
      }
    })
    expect(resolveHostNodeCodexPosture(verified!)).toEqual({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' }
    })
    expect(new HostNodeProfileRunPort({ store, events }).getThread(created.appChatId)).toBeNull()
    expect(
      new HostNodeProfileRunPort({
        store,
        events,
        permissionConsentAuthority: consentAuthority,
        fullAccessGrants: new HostFullAccessGrantRegistry()
      }).getThread(created.appChatId)
    ).toBeNull()
    expect(
      new HostNodeProfileRunPort({
        store,
        events,
        permissionConsentAuthority: new HostPermissionConsentAuthority(Buffer.alloc(32, 5)),
        fullAccessGrants
      }).getThread(created.appChatId)
    ).toBeNull()

    const current = store.getThread(created.appChatId)!
    store.persistThreadRecord({
      threadId: created.appChatId,
      expectedRevision: current.persistenceRevision ?? 0,
      record: {
        ...current,
        providerMetadata: {
          ...current.providerMetadata,
          selectedModelType: 'gpt-5.6-sol'
        }
      }
    })
    expect(
      new HostNodeProfileRunPort({
        store,
        events,
        permissionConsentAuthority: consentAuthority,
        fullAccessGrants
      }).getThread(created.appChatId)
    ).toBeNull()
  })

  it('accepts a valid legacy workspace path alias when the store-owned realPath matches', () => {
    const { profile, workspace, store, threadId } = openStore()
    const workspaceFile = join(profile, HOST_PROFILE_WORKSPACES_FILENAME)
    const records = JSON.parse(readFileSync(workspaceFile, 'utf8')) as Array<
      Record<string, unknown>
    >
    records[0].path = `${workspace}/.`
    writeFileSync(workspaceFile, JSON.stringify(records))
    chmodSync(workspaceFile, 0o600)
    const chatFile = join(profile, HOST_PROFILE_CHATS_DIRECTORY, `${threadId}.json`)
    const chat = JSON.parse(readFileSync(chatFile, 'utf8')) as Record<string, unknown>
    chat.workspacePath = records[0].path
    writeFileSync(chatFile, JSON.stringify(chat))
    chmodSync(chatFile, 0o600)
    const port = new HostNodeProfileRunPort({
      store,
      events: { publish: (_target, _event) => undefined }
    })

    expect(port.getThread(threadId)).toMatchObject({
      workspace: { canonicalPath: store.listWorkspaces()[0].realPath }
    })

    records[0].realPath = join(workspace, 'replaced-directory')
    writeFileSync(workspaceFile, JSON.stringify(records))
    chmodSync(workspaceFile, 0o600)
    expect(port.getThread(threadId)).toBeNull()
  })

  it('writes a readable system transcript row when a run finishes failed with a reason', () => {
    // A failed run used to leave only FAILED in the status bar; the reason
    // sat in warningSummaries, which no client renders. The transcript is the
    // surface the user reads, so the reason lands there as a Host notice.
    const { store, threadId } = openStore()
    const port = new HostNodeProfileRunPort({
      store,
      events: { publish: () => undefined }
    })
    port.beginRun({
      runId: 'run-failed',
      threadId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      startedAt: '2026-08-24T05:00:00.000Z'
    })
    port.finishRun({
      runId: 'run-failed',
      status: 'failed',
      finishedAt: '2026-08-24T05:00:01.000Z',
      warningSummaries: ['ACP session does not offer "codestral-2508" for config option "model"'],
      errorCode: 'provider_failed'
    })
    expect(store.getThread(threadId)?.messages).toEqual([
      expect.objectContaining({
        role: 'system',
        runId: 'run-failed',
        content:
          'Run failed · ACP session does not offer "codestral-2508" for config option "model"'
      })
    ])
    expect(store.getThread(threadId)?.runs).toEqual([
      expect.objectContaining({
        runId: 'run-failed',
        status: 'failed',
        errorCode: 'provider_failed'
      })
    ])

    // A clean completion adds nothing, even when it carries a non-fatal warning.
    port.beginRun({
      runId: 'run-ok',
      threadId,
      providerId: 'muse',
      modelId: 'muse-spark-1.2',
      startedAt: '2026-08-24T05:00:02.000Z'
    })
    port.finishRun({
      runId: 'run-ok',
      status: 'completed',
      finishedAt: '2026-08-24T05:00:03.000Z',
      warningSummaries: ['non-fatal warning']
    })
    expect(store.getThread(threadId)?.messages).toHaveLength(1)
  })
})
