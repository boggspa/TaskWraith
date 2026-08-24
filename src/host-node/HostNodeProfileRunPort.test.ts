import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  HOST_PROFILE_CHATS_DIRECTORY,
  HOST_PROFILE_WORKSPACES_FILENAME,
  HostProfileDomainStore
} from '../host-runtime/HostProfileDomainStore'
import type { HostProviderRunEvent } from '../host-runtime/HostProviderRunPort'
import { HostNodeProfileRunPort } from './HostNodeProfileRunPort'

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
    expect(events).toEqual([expect.objectContaining({ type: 'run.content' })])
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
})
