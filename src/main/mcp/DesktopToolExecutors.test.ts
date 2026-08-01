import { resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { TASKWRAITH_TOOL_ACTIONS } from '../../shared/providerActionTaxonomy'
import {
  createDesktopToolExecutors,
  type DesktopAttachedWindowState,
  type DesktopBridgeDaemon,
  type DesktopToolContext,
  type DesktopToolExecutorDeps
} from './DesktopToolExecutors'
import type {
  ScopedAttachedWindowRendererProjection,
  ScopedAttachedWindowSnapshot,
  ScopedAttachedWindowStreaming
} from '../nativeWindow/ScopedAttachedWindowState'
import type {
  AgenticWorkspaceGrant,
  AppSettings,
  ChatRecord,
  HandoffCard,
  RunEventFilter,
  RunEventRecord,
  RunEventReplay
} from '../store/types'

function chat(appChatId: string, runIds: string[]): ChatRecord {
  return {
    appChatId,
    title: appChatId,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: runIds.map((runId) => ({ runId, startedAt: '2026-07-18T00:00:00.000Z' }))
  }
}

function replay(runId: string, events: RunEventRecord[] = []): RunEventReplay {
  return {
    runId,
    events,
    count: events.length,
    lastSequence: events[events.length - 1]?.sequence || 0,
    hashChainValid: true,
    countsByKind: {},
    timeline: [],
    approvalIds: []
  }
}

function event(input: Partial<RunEventRecord> = {}): RunEventRecord {
  return {
    schemaVersion: 1,
    id: 'event-a',
    sequence: 1,
    runId: 'run-history',
    chatId: 'chat-a',
    kind: 'reference_context',
    phase: 'artifact',
    source: 'main',
    timestamp: '2026-07-18T00:00:00.000Z',
    ...input
  }
}

function attachedWindowSnapshot(
  chatID = 'chat-a',
  overrides: Partial<ScopedAttachedWindowSnapshot> = {}
): ScopedAttachedWindowSnapshot {
  return Object.freeze({
    handleID: 'handle-a',
    scopeID: 'scope-a',
    chatID,
    consentEpoch: 7,
    generation: 3,
    attachedAt: '2026-07-28T03:00:00.000Z',
    windowMeta: Object.freeze({
      windowID: 42,
      title: 'Scene.blend',
      bundleID: 'org.blenderfoundation.blender',
      applicationName: 'Blender',
      pid: 4242,
      identityQuality: 'exact' as const,
      processIdentity: Object.freeze({
        pid: 4242,
        launchTimeMicros: 123_456_789,
        source: 'procBSDInfo' as const
      }),
      processStartedAt: 'process-start-4242',
      bounds: Object.freeze({ x: 1, y: 2, width: 640, height: 480 })
    }),
    ...overrides
  })
}

function sameAttachedWindowAccess(
  left: ScopedAttachedWindowSnapshot,
  right: ScopedAttachedWindowSnapshot
): boolean {
  return (
    left.handleID === right.handleID &&
    left.scopeID === right.scopeID &&
    left.chatID === right.chatID &&
    left.consentEpoch === right.consentEpoch &&
    left.generation === right.generation
  )
}

function rendererProjection(
  snapshot: ScopedAttachedWindowSnapshot
): ScopedAttachedWindowRendererProjection {
  return Object.freeze({
    chatID: snapshot.chatID,
    generation: snapshot.generation,
    attachedAt: snapshot.attachedAt,
    windowMeta: Object.freeze({
      title: snapshot.windowMeta.title,
      bundleID: snapshot.windowMeta.bundleID,
      applicationName: snapshot.windowMeta.applicationName,
      identityQuality: snapshot.windowMeta.identityQuality
    }),
    ...(snapshot.streaming ? { streaming: snapshot.streaming } : {})
  })
}

function createAttachedWindowState(initial: ScopedAttachedWindowSnapshot | null = null): {
  state: DesktopAttachedWindowState
  active(): ScopedAttachedWindowSnapshot | null
  replace(snapshot: ScopedAttachedWindowSnapshot | null): void
  calls: {
    getForChat: Array<string | null | undefined>
    updateStreaming: Array<{
      exact: ScopedAttachedWindowSnapshot
      streaming: ScopedAttachedWindowStreaming | null
    }>
    clearExact: ScopedAttachedWindowSnapshot[]
    rendererProjectionForChat: Array<string | null | undefined>
  }
} {
  let active = initial
  const calls = {
    getForChat: [] as Array<string | null | undefined>,
    updateStreaming: [] as Array<{
      exact: ScopedAttachedWindowSnapshot
      streaming: ScopedAttachedWindowStreaming | null
    }>,
    clearExact: [] as ScopedAttachedWindowSnapshot[],
    rendererProjectionForChat: [] as Array<string | null | undefined>
  }
  const state: DesktopAttachedWindowState = {
    getForChat(appChatId) {
      calls.getForChat.push(appChatId)
      const current = active
      if (!current || current.chatID !== appChatId) return null
      return current
    },
    updateStreaming(exact, streaming) {
      calls.updateStreaming.push({ exact, streaming })
      if (!active || !sameAttachedWindowAccess(active, exact)) return null
      active = Object.freeze({
        handleID: active.handleID,
        scopeID: active.scopeID,
        chatID: active.chatID,
        consentEpoch: active.consentEpoch,
        generation: active.generation,
        attachedAt: active.attachedAt,
        windowMeta: active.windowMeta,
        ...(streaming ? { streaming } : {})
      })
      return active
    },
    clearExact(exact) {
      calls.clearExact.push(exact)
      if (!active || !sameAttachedWindowAccess(active, exact)) return null
      const cleared = active
      active = null
      return cleared
    },
    rendererProjectionForChat(appChatId) {
      calls.rendererProjectionForChat.push(appChatId)
      const current = active
      if (!current || current.chatID !== appChatId) return null
      return rendererProjection(current)
    }
  }
  return {
    state,
    active: () => active,
    replace: (snapshot) => {
      active = snapshot
    },
    calls
  }
}

function createExecutor(input: {
  chats: ChatRecord[]
  settings?: AppSettings
  replays?: Record<string, RunEventReplay>
  rawEvents?: RunEventRecord[]
  providerAuth?: DesktopToolExecutorDeps['providerAuth']
  attachedWindow?: DesktopAttachedWindowState
  daemon?: DesktopBridgeDaemon | null
  notifyRenderer?: NonNullable<DesktopToolExecutorDeps['notifyRenderer']>
  shell?: DesktopToolExecutorDeps['shell']
}) {
  const chats = new Map(input.chats.map((item) => [item.appChatId, item]))
  const getRunEventReplay = vi.fn((runId: string) => input.replays?.[runId] || replay(runId))
  const getRunEvents = vi.fn((_filter?: RunEventFilter) => input.rawEvents || [])
  const deps: DesktopToolExecutorDeps = {
    getBridgeDaemon: () => input.daemon ?? null,
    getCreativeApprovalGate: () => null,
    attachedWindow: input.attachedWindow ?? createAttachedWindowState().state,
    store: {
      getSettings: () => input.settings || ({} as AppSettings),
      getApprovalLedger: () => [],
      getProviderUsageSnapshot: () => null,
      getChat: (chatId) => chats.get(chatId) || null,
      saveChat: () => undefined,
      getHandoffCards: () => [],
      saveHandoffCard: (handoff) => handoff as HandoffCard
    },
    runRepository: { getRunEventReplay, getRunEvents },
    shell: input.shell ?? {
      showItemInFolder: () => undefined,
      openPath: async () => ''
    },
    ...(input.providerAuth ? { providerAuth: input.providerAuth } : {}),
    ...(input.notifyRenderer ? { notifyRenderer: input.notifyRenderer } : {})
  }
  return { executor: createDesktopToolExecutors(deps), getRunEventReplay, getRunEvents }
}

const activeContext: DesktopToolContext = {
  scope: 'workspace',
  cwd: '/workspace',
  workspacePath: '/workspace',
  appChatId: 'chat-a',
  appRunId: 'run-current'
}

const otherChatContext: DesktopToolContext = { ...activeContext, appChatId: 'chat-b' }
const missingChatContext: DesktopToolContext = { ...activeContext, appChatId: undefined }

describe('DesktopToolExecutors host application effects', () => {
  it('opens a workspace file through the host shell under application-mutation metadata', async () => {
    const openPath = vi.fn(async (_path: string) => '')
    const showItemInFolder = vi.fn()
    const { executor } = createExecutor({
      chats: [chat('chat-a', [])],
      shell: { openPath, showItemInFolder }
    })

    const result = await executor.executeOpenWorkspaceFile(
      { path: 'docs/report.html' },
      activeContext
    )
    const expectedPath = resolve(activeContext.cwd, 'docs/report.html')
    expect(result).toMatchObject({
      ok: true,
      action: 'open'
    })
    expect(result.path).toBe(expectedPath)
    expect(openPath).toHaveBeenCalledOnce()
    expect(openPath.mock.calls[0]?.[0]).toBe(expectedPath)
    expect(showItemInFolder).not.toHaveBeenCalled()
    // `orchestration`, matching open_in_ide / open_in_ide_at_position /
    // reveal_in_finder, which share this exact operation/mutation/lock triple.
    // Opening a file is a focus-change, not a state mutation — the reasoning
    // McpAutoAllowedTools already records for that family — so this tool must
    // NOT sit in the read-only deny set. User decision 2026-07-30, after this
    // assertion and ToolClassTaxonomy's "workspace_write is exactly the
    // read-only deny set" were found to contradict each other. The behavioural
    // assertions above are independent of the class; this block only mirrors the
    // taxonomy so a silent reclassification cannot slip through.
    expect(TASKWRAITH_TOOL_ACTIONS.open_workspace_file).toMatchObject({
      toolClass: 'orchestration',
      operation: 'application.mutate',
      mutation: 'attached-application',
      lock: 'application-resource'
    })
  })
})

function createRunningDaemon(
  respond: (method: string, params: unknown) => unknown | Promise<unknown>
): {
  daemon: DesktopBridgeDaemon
  calls: Array<{ method: string; params: unknown; timeoutMs: number | undefined }>
} {
  const calls: Array<{ method: string; params: unknown; timeoutMs: number | undefined }> = []
  const daemon: DesktopBridgeDaemon = {
    status: () => ({ running: true, startedAt: '2026-07-28T03:00:00.000Z', pid: 10 }),
    async request<T>(
      method: string,
      params?: unknown,
      options?: { timeoutMs?: number }
    ): Promise<T> {
      calls.push({ method, params, timeoutMs: options?.timeoutMs })
      return (await respond(method, params)) as T
    }
  }
  return { daemon, calls }
}

function expectNoPrivateAttachmentFields(value: unknown): void {
  const serialized = JSON.stringify(value)
  for (const field of [
    'handleID',
    'scopeID',
    'consentEpoch',
    'pid',
    'processIdentity',
    'processStartedAt',
    'pgid',
    'bounds'
  ]) {
    expect(serialized).not.toContain(`"${field}"`)
  }
}

describe('DesktopToolExecutors run history scope', () => {
  it('allows the current run and historical runs recorded by the active chat', () => {
    const { executor, getRunEventReplay } = createExecutor({
      chats: [chat('chat-a', ['run-history'])],
      replays: {
        'run-current': replay('run-current'),
        'run-history': replay('run-history')
      }
    })

    expect(executor.executeRunTimeline({}, activeContext)).toMatchObject({ runId: 'run-current' })
    expect(executor.executeRunTimeline({ runId: 'run-history' }, activeContext)).toMatchObject({
      runId: 'run-history'
    })
    expect(getRunEventReplay).toHaveBeenCalledTimes(2)
  })

  it('rejects cross-chat and unknown run ids before opening a replay', () => {
    const { executor, getRunEventReplay } = createExecutor({
      chats: [chat('chat-a', ['run-history']), chat('chat-b', ['run-other'])]
    })

    expect(() => executor.executeRunTimeline({ runId: 'run-other' }, activeContext)).toThrow(
      'run_timeline can only inspect the active run or a run from the active chat.'
    )
    expect(() => executor.executeRunTimeline({ runId: 'run-unknown' }, activeContext)).toThrow(
      'run_timeline can only inspect the active run or a run from the active chat.'
    )
    expect(getRunEventReplay).not.toHaveBeenCalled()
  })

  it('redacts private artifact paths from timeline events without dropping safe fields', () => {
    const privateSnapshotPath = '/private/taskwraith/project-reference-snapshots/abc.snapshot'
    const { executor } = createExecutor({
      chats: [chat('chat-a', ['run-history'])],
      replays: {
        'run-history': replay('run-history', [
          event({
            artifacts: [
              {
                id: 'project-reference:abc',
                kind: 'snapshot',
                path: privateSnapshotPath,
                sha256: 'a'.repeat(64),
                sizeBytes: 42,
                sequence: 1,
                metadata: { source: 'project_reference_context', referenceTitle: 'Brief' }
              }
            ]
          })
        ])
      }
    })

    const result = executor.executeRunTimeline(
      { runId: 'run-history', includeEvents: true },
      activeContext
    )

    expect(result.events?.[0]?.artifacts).toEqual([
      {
        id: 'project-reference:abc',
        kind: 'snapshot',
        sha256: 'a'.repeat(64),
        sizeBytes: 42,
        sequence: 1,
        metadata: { source: 'project_reference_context', referenceTitle: 'Brief' }
      }
    ])
    expect(JSON.stringify(result)).not.toContain(privateSnapshotPath)
  })

  it('keeps raw provider event queries in the active chat and redacts their artifact paths', () => {
    const privateArtifactPath = '/private/taskwraith/run-artifacts/run-current/stdout.log'
    const { executor, getRunEvents } = createExecutor({
      chats: [chat('chat-a', ['run-history']), chat('chat-b', ['run-other'])],
      rawEvents: [
        event({
          runId: 'run-history',
          kind: 'provider_raw',
          phase: 'raw',
          source: 'provider',
          artifacts: [
            {
              id: 'run-history:stdout:1',
              kind: 'stdout',
              path: privateArtifactPath,
              sha256: 'b'.repeat(64),
              sizeBytes: 9
            }
          ]
        })
      ]
    })

    expect(() => executor.executeRawProviderEvents({ chatId: 'chat-b' }, activeContext)).toThrow(
      'raw_provider_events can only inspect the active chat.'
    )
    expect(() => executor.executeRawProviderEvents({ runId: 'run-other' }, activeContext)).toThrow(
      'raw_provider_events can only inspect the active run or a run from the active chat.'
    )
    expect(getRunEvents).not.toHaveBeenCalled()

    const result = executor.executeRawProviderEvents({ runId: 'run-history' }, activeContext)
    expect(getRunEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-history',
        kinds: ['provider_raw', 'provider_error', 'provider_exit']
      })
    )
    expect(result.events[0]?.artifacts).toEqual([
      {
        id: 'run-history:stdout:1',
        kind: 'stdout',
        sha256: 'b'.repeat(64),
        sizeBytes: 9
      }
    ])
    expect(JSON.stringify(result)).not.toContain(privateArtifactPath)
  })
})

describe('DesktopToolExecutors scoped attached-window access', () => {
  it('keeps capture, status, Appwatch, and creative attachment state isolated to the canonical app chat', async () => {
    const snapshot = attachedWindowSnapshot('chat-a')
    const attachedWindow = createAttachedWindowState(snapshot)
    const notifications: Array<{ channel: string; payload: unknown }> = []
    const { daemon, calls } = createRunningDaemon((method) =>
      method === 'creative.runningApplications' ? {} : { ok: true }
    )
    const { executor } = createExecutor({
      chats: [],
      daemon,
      attachedWindow: attachedWindow.state,
      notifyRenderer: (channel, payload) => notifications.push({ channel, payload })
    })

    const capture = await executor.executeAttachedWindowCapture({}, otherChatContext)
    const status = await executor.executeAttachedWindowStatus(otherChatContext)
    const start = await executor.executeAppwatchStart({}, otherChatContext)
    const stop = await executor.executeAppwatchStop(otherChatContext)
    const appwatchStatus = await executor.executeAppwatchStatus(otherChatContext)
    const latest = await executor.executeAppwatchLatestFrame(otherChatContext)
    const frames = await executor.executeAppwatchFrames({}, otherChatContext)
    const sameChatCreative = (await executor.executeCreativeAppStatus(
      { appId: 'blender' },
      activeContext
    )) as { apps: Array<{ attached: boolean }> }
    const foreignCreative = (await executor.executeCreativeAppStatus(
      { appId: 'blender' },
      otherChatContext
    )) as { apps: Array<{ attached: boolean }> }
    const foreignCreativeCapabilities = (await executor.executeCreativeAppCapabilities(
      { appId: 'blender' },
      otherChatContext
    )) as { apps: Array<{ attached: boolean }> }
    const missingCapture = await executor.executeAttachedWindowCapture({}, missingChatContext)
    const missingStatus = await executor.executeAttachedWindowStatus(missingChatContext)
    const missingStop = await executor.executeAppwatchStop(missingChatContext)

    expect(capture.structuredContent).toMatchObject({ ok: false, tool: 'attached_window_capture' })
    expect(status.structuredContent).toMatchObject({ ok: true, attached: false })
    expect(start.structuredContent).toMatchObject({ ok: false, tool: 'appwatch_start' })
    expect(stop.structuredContent).toMatchObject({ ok: false, tool: 'appwatch_stop' })
    expect(appwatchStatus.structuredContent).toMatchObject({ ok: true, attached: false })
    expect(latest.structuredContent).toMatchObject({ ok: false, tool: 'appwatch_latest_frame' })
    expect(frames.structuredContent).toMatchObject({ ok: false, tool: 'appwatch_frames' })
    expect(missingCapture.structuredContent).toMatchObject({
      ok: false,
      tool: 'attached_window_capture'
    })
    expect(missingStatus.structuredContent).toMatchObject({ ok: true, attached: false })
    expect(missingStop.structuredContent).toMatchObject({ ok: false, tool: 'appwatch_stop' })
    expect(sameChatCreative.apps[0]?.attached).toBe(true)
    expectNoPrivateAttachmentFields(sameChatCreative)
    expect(foreignCreative.apps[0]?.attached).toBe(false)
    expect(foreignCreativeCapabilities.apps[0]?.attached).toBe(false)
    expect(
      calls.filter(
        (call) => call.method.startsWith('attachedWindow.') || call.method.startsWith('appwatch.')
      )
    ).toHaveLength(0)
    expect(attachedWindow.active()).toBe(snapshot)
    expect(attachedWindow.calls.clearExact).toEqual([])
    expect(notifications).toEqual([])
  })

  it('sends the full scoped access tuple on every attached-window and Appwatch RPC without projecting private fields', async () => {
    const snapshot = attachedWindowSnapshot('chat-a')
    const attachedWindow = createAttachedWindowState(snapshot)
    const notifications: Array<{ channel: string; payload: unknown }> = []
    const { daemon, calls } = createRunningDaemon((method) => {
      if (method === 'attachedWindow.capture') {
        return { ok: true, pngBase64: 'cG5n', byteLength: 3, width: 1, height: 1 }
      }
      if (method === 'attachedWindow.status') return { ok: true }
      if (method === 'appwatch.start') {
        return {
          ok: true,
          streaming: {
            fps: 5,
            bufferSeconds: 8,
            frameCount: 0,
            startedAt: '2026-07-28T03:00:01.000Z'
          }
        }
      }
      if (method === 'appwatch.stop') return { ok: true, streaming: false }
      if (method === 'appwatch.status') return { ok: true, streaming: false }
      if (method === 'appwatch.latestFrame') return { ok: true, hasFrame: false }
      if (method === 'appwatch.frames') return { ok: true, hasFrames: false, frames: [] }
      throw new Error(`Unexpected method ${method}`)
    })
    const { executor } = createExecutor({
      chats: [],
      daemon,
      attachedWindow: attachedWindow.state,
      notifyRenderer: (channel, payload) => notifications.push({ channel, payload })
    })

    const results = [
      await executor.executeAttachedWindowCapture({}, activeContext),
      await executor.executeAttachedWindowStatus(activeContext),
      await executor.executeAppwatchStart({}, activeContext),
      await executor.executeAppwatchStop(activeContext),
      await executor.executeAppwatchStatus(activeContext),
      await executor.executeAppwatchLatestFrame(activeContext),
      await executor.executeAppwatchFrames({}, activeContext)
    ]

    expect(calls.map((call) => call.method)).toEqual([
      'attachedWindow.capture',
      'attachedWindow.status',
      'appwatch.start',
      'appwatch.stop',
      'appwatch.status',
      'appwatch.latestFrame',
      'appwatch.frames'
    ])
    for (const call of calls) {
      expect(call.params).toMatchObject({
        handleID: 'handle-a',
        scopeID: 'scope-a',
        chatID: 'chat-a',
        consentEpoch: 7,
        generation: 3
      })
    }
    for (const result of results) {
      expectNoPrivateAttachmentFields(result)
    }
    expect(notifications).toEqual([])
  })

  it.each([-32001, -32004])(
    'clears the exact active attachment after a gone or revoked response (%s)',
    async (errorCode) => {
      const snapshot = attachedWindowSnapshot('chat-a')
      const attachedWindow = createAttachedWindowState(snapshot)
      const notifications: Array<{ channel: string; payload: unknown }> = []
      const { daemon } = createRunningDaemon((method) => {
        if (method === 'attachedWindow.capture') {
          throw Object.assign(new Error('Selected window is unavailable.'), { code: errorCode })
        }
        throw new Error(`Unexpected method ${method}`)
      })
      const { executor } = createExecutor({
        chats: [],
        daemon,
        attachedWindow: attachedWindow.state,
        notifyRenderer: (channel, payload) => notifications.push({ channel, payload })
      })

      await expect(executor.executeAttachedWindowCapture({}, activeContext)).resolves.toMatchObject(
        {
          structuredContent: { ok: false, tool: 'attached_window_capture' }
        }
      )
      expect(attachedWindow.calls.clearExact).toEqual([snapshot])
      expect(attachedWindow.active()).toBeNull()
      expect(notifications).toEqual([])
    }
  )

  it.each([-32001, -32004])(
    'does not let a stale gone or revoked response (%s) clear a replacement attachment',
    async (errorCode) => {
      const original = attachedWindowSnapshot('chat-a')
      const replacement = attachedWindowSnapshot('chat-a', {
        handleID: 'handle-b',
        scopeID: 'scope-b',
        consentEpoch: 8,
        generation: 4
      })
      const attachedWindow = createAttachedWindowState(original)
      let rejectCapture: ((reason?: unknown) => void) | undefined
      const captureResult = new Promise<unknown>((_resolve, reject) => {
        rejectCapture = reject
      })
      const { daemon } = createRunningDaemon((method) => {
        if (method === 'attachedWindow.capture') return captureResult
        throw new Error(`Unexpected method ${method}`)
      })
      const notifications: Array<{ channel: string; payload: unknown }> = []
      const { executor } = createExecutor({
        chats: [],
        daemon,
        attachedWindow: attachedWindow.state,
        notifyRenderer: (channel, payload) => notifications.push({ channel, payload })
      })

      const pending = executor.executeAttachedWindowCapture({}, activeContext)
      await Promise.resolve()
      attachedWindow.replace(replacement)
      rejectCapture!(
        Object.assign(new Error('Selected window is unavailable.'), { code: errorCode })
      )

      await expect(pending).resolves.toMatchObject({
        structuredContent: { ok: false, tool: 'attached_window_capture' }
      })
      expect(attachedWindow.calls.clearExact).toEqual([original])
      expect(attachedWindow.active()).toBe(replacement)
      expect(notifications).toEqual([])
    }
  )

  it('does not clear another chat attachment after a stale attachment-denied response', async () => {
    const original = attachedWindowSnapshot('chat-a')
    const replacement = attachedWindowSnapshot('chat-b', {
      handleID: 'handle-b',
      scopeID: 'scope-b',
      consentEpoch: 8,
      generation: 4
    })
    const attachedWindow = createAttachedWindowState(original)
    let rejectCapture: ((reason?: unknown) => void) | undefined
    const captureResult = new Promise<unknown>((_resolve, reject) => {
      rejectCapture = reject
    })
    const { daemon } = createRunningDaemon((method) => {
      if (method === 'attachedWindow.capture') return captureResult
      throw new Error(`Unexpected method ${method}`)
    })
    const notifications: Array<{ channel: string; payload: unknown }> = []
    const { executor } = createExecutor({
      chats: [],
      daemon,
      attachedWindow: attachedWindow.state,
      notifyRenderer: (channel, payload) => notifications.push({ channel, payload })
    })

    const pending = executor.executeAttachedWindowCapture({}, activeContext)
    await Promise.resolve()
    attachedWindow.replace(replacement)
    rejectCapture!(Object.assign(new Error('Attachment denied.'), { code: -32003 }))

    await expect(pending).resolves.toMatchObject({
      structuredContent: { ok: false, tool: 'attached_window_capture' }
    })
    expect(attachedWindow.calls.clearExact).toEqual([])
    expect(attachedWindow.active()).toBe(replacement)
    expect(notifications).toEqual([])
  })

  it('discards successful capture pixels when the exact attachment is replaced while awaiting the daemon', async () => {
    const original = attachedWindowSnapshot('chat-a')
    const replacement = attachedWindowSnapshot('chat-a', {
      handleID: 'handle-b',
      scopeID: 'scope-b',
      consentEpoch: 8,
      generation: 4
    })
    const attachedWindow = createAttachedWindowState(original)
    let resolveCapture: ((value: unknown) => void) | undefined
    const capture = new Promise<unknown>((resolve) => {
      resolveCapture = resolve
    })
    const { daemon } = createRunningDaemon((method) => {
      if (method === 'attachedWindow.capture') return capture
      throw new Error(`Unexpected method ${method}`)
    })
    const { executor } = createExecutor({
      chats: [],
      daemon,
      attachedWindow: attachedWindow.state
    })

    const pending = executor.executeAttachedWindowCapture({}, activeContext)
    await Promise.resolve()
    attachedWindow.replace(replacement)
    resolveCapture!({ ok: true, pngBase64: 'stale-pixel', byteLength: 11, width: 1, height: 1 })

    const result = await pending
    expect(result.structuredContent).toMatchObject({
      ok: false,
      tool: 'attached_window_capture'
    })
    expect(result.content?.some((block) => block.type === 'image')).toBe(false)
    expect(JSON.stringify(result)).not.toContain('stale-pixel')
    expect(attachedWindow.active()).toBe(replacement)
    expect(attachedWindow.calls.getForChat).toEqual(['chat-a', 'chat-a'])
  })

  it('does not update streaming from a successful stale Appwatch start', async () => {
    const original = attachedWindowSnapshot('chat-a')
    const replacement = attachedWindowSnapshot('chat-a', {
      handleID: 'handle-b',
      scopeID: 'scope-b',
      consentEpoch: 8,
      generation: 4
    })
    const attachedWindow = createAttachedWindowState(original)
    let resolveStart: ((value: unknown) => void) | undefined
    const start = new Promise<unknown>((resolve) => {
      resolveStart = resolve
    })
    const { daemon } = createRunningDaemon((method) => {
      if (method === 'appwatch.start') return start
      throw new Error(`Unexpected method ${method}`)
    })
    const { executor } = createExecutor({
      chats: [],
      daemon,
      attachedWindow: attachedWindow.state
    })

    const pending = executor.executeAppwatchStart({}, activeContext)
    await Promise.resolve()
    attachedWindow.replace(replacement)
    resolveStart!({
      ok: true,
      streaming: {
        fps: 5,
        bufferSeconds: 8,
        frameCount: 1,
        startedAt: '2026-07-28T03:00:01.000Z'
      }
    })

    await expect(pending).resolves.toMatchObject({
      structuredContent: { ok: false, tool: 'appwatch_start' }
    })
    expect(attachedWindow.calls.updateStreaming).toEqual([])
    expect(attachedWindow.active()).toBe(replacement)
  })

  it.each([
    {
      tool: 'appwatch_latest_frame',
      method: 'appwatch.latestFrame',
      response: {
        ok: true,
        hasFrame: true,
        pngBase64: 'stale-latest-pixel',
        byteLength: 18,
        width: 2,
        height: 2
      },
      invoke: (executor: ReturnType<typeof createDesktopToolExecutors>) =>
        executor.executeAppwatchLatestFrame(activeContext)
    },
    {
      tool: 'appwatch_frames',
      method: 'appwatch.frames',
      response: {
        ok: true,
        hasFrames: true,
        frames: [
          {
            index: 0,
            mimeType: 'image/png',
            imageBase64: 'stale-history-pixel',
            byteLength: 19,
            width: 2,
            height: 2
          }
        ]
      },
      invoke: (executor: ReturnType<typeof createDesktopToolExecutors>) =>
        executor.executeAppwatchFrames({}, activeContext)
    }
  ])(
    'discards successful stale $tool results before returning pixels or metadata',
    async (testCase) => {
      const original = attachedWindowSnapshot('chat-a')
      const replacement = attachedWindowSnapshot('chat-a', {
        handleID: 'handle-b',
        scopeID: 'scope-b',
        consentEpoch: 8,
        generation: 4
      })
      const attachedWindow = createAttachedWindowState(original)
      let resolveResult: ((value: unknown) => void) | undefined
      const result = new Promise<unknown>((resolve) => {
        resolveResult = resolve
      })
      const { daemon } = createRunningDaemon((method) => {
        if (method === testCase.method) return result
        throw new Error(`Unexpected method ${method}`)
      })
      const { executor } = createExecutor({
        chats: [],
        daemon,
        attachedWindow: attachedWindow.state
      })

      const pending = testCase.invoke(executor)
      await Promise.resolve()
      attachedWindow.replace(replacement)
      resolveResult!(testCase.response)

      const completed = await pending
      expect(completed.structuredContent).toMatchObject({ ok: false, tool: testCase.tool })
      expect(completed.content?.some((block) => block.type === 'image')).toBe(false)
      expect(JSON.stringify(completed)).not.toContain('stale-')
      expect(attachedWindow.active()).toBe(replacement)
    }
  )

  it('discards a successful capture result when the daemon stops before it returns', async () => {
    const snapshot = attachedWindowSnapshot('chat-a')
    const attachedWindow = createAttachedWindowState(snapshot)
    let running = true
    let resolveCapture: ((value: unknown) => void) | undefined
    const capture = new Promise<unknown>((resolve) => {
      resolveCapture = resolve
    })
    const daemon: DesktopBridgeDaemon = {
      status: () => ({
        running,
        startedAt: '2026-07-28T03:00:00.000Z',
        pid: running ? 10 : null
      }),
      async request<T>(method: string): Promise<T> {
        if (method !== 'attachedWindow.capture') throw new Error(`Unexpected method ${method}`)
        return (await capture) as T
      }
    }
    const { executor } = createExecutor({
      chats: [],
      daemon,
      attachedWindow: attachedWindow.state
    })

    const pending = executor.executeAttachedWindowCapture({}, activeContext)
    await Promise.resolve()
    running = false
    resolveCapture!({
      ok: true,
      pngBase64: 'stale-daemon-pixel',
      byteLength: 18,
      width: 2,
      height: 2
    })

    const result = await pending
    expect(result.structuredContent).toMatchObject({
      ok: false,
      tool: 'attached_window_capture'
    })
    expect(JSON.stringify(result)).not.toContain('stale-daemon-pixel')
    expect(attachedWindow.active()).toBe(snapshot)
  })
})

describe('DesktopToolExecutors Kimi auth projection', () => {
  function providerAuth(
    status: { available: boolean; authState: string; error?: string },
    storedKimiApiKey: unknown = null
  ): NonNullable<DesktopToolExecutorDeps['providerAuth']> {
    return {
      getGeminiAuthStatusSnapshot: async () => {
        throw new Error('not used by Kimi projection')
      },
      getCodexStatusSnapshot: async () => {
        throw new Error('not used by Kimi projection')
      },
      getCliProviderStatus: async () => status,
      getStoredClaudeApiKey: () => null,
      getStoredKimiApiKey: () => storedKimiApiKey,
      encryptionAvailable: () => true,
      isCodexClientStarted: () => false
    }
  }

  it('distinguishes OAuth-only, provider-key, and unqualified Kimi states', async () => {
    const oauth = createExecutor({
      chats: [],
      providerAuth: providerAuth({ available: true, authState: 'oauth' })
    })
    await expect(
      oauth.executor.executeProviderAuthStatus({ provider: 'kimi' })
    ).resolves.toMatchObject({
      providers: {
        kimi: {
          authState: 'authenticated',
          apiKeyConfigured: false,
          mcpStatusSupport: true
        }
      }
    })

    const managedProviderKey = createExecutor({
      chats: [],
      providerAuth: providerAuth({ available: true, authState: 'api-key' })
    })
    await expect(
      managedProviderKey.executor.executeProviderAuthStatus({ provider: 'kimi' })
    ).resolves.toMatchObject({
      providers: {
        kimi: { authState: 'authenticated', apiKeyConfigured: false }
      }
    })

    const settingsUsageKey = createExecutor({
      chats: [],
      providerAuth: providerAuth({ available: true, authState: 'unknown' }, 'stored-key')
    })
    await expect(
      settingsUsageKey.executor.executeProviderAuthStatus({ provider: 'kimi' })
    ).resolves.toMatchObject({
      providers: {
        kimi: { authState: 'not-observable', apiKeyConfigured: true }
      }
    })

    const unqualified = createExecutor({
      chats: [],
      providerAuth: providerAuth({
        available: false,
        authState: 'oauth',
        error: 'Kimi inventory does not advertise the qualified ACP-only transport posture.'
      })
    })
    await expect(
      unqualified.executor.executeProviderAuthStatus({ provider: 'kimi' })
    ).resolves.toMatchObject({
      providers: {
        kimi: {
          serverState: 'unavailable',
          authState: 'missing',
          authReason: expect.stringContaining('ACP-only transport posture')
        }
      }
    })
  })
})

describe('DesktopToolExecutors Codex auth projection', () => {
  it('uses the private-home app-server snapshot instead of the generic CLI probe', async () => {
    const getCliProviderStatus = vi.fn(async () => ({
      available: true,
      authState: 'unknown'
    }))
    const getCodexStatusSnapshot = vi.fn(async () => ({
      available: true,
      appServer: 'started',
      authState: 'missing',
      requiresOpenaiAuth: true,
      setupRequired: true
    }))
    const { executor } = createExecutor({
      chats: [],
      providerAuth: {
        getGeminiAuthStatusSnapshot: async () => {
          throw new Error('not used by Codex projection')
        },
        getCodexStatusSnapshot,
        getCliProviderStatus,
        getStoredClaudeApiKey: () => null,
        getStoredKimiApiKey: () => null,
        encryptionAvailable: () => true,
        isCodexClientStarted: () => true
      }
    })

    await expect(executor.executeProviderAuthStatus({ provider: 'codex' })).resolves.toMatchObject({
      providers: {
        codex: {
          authState: 'missing',
          requiresOpenaiAuth: true,
          setupRequired: true,
          serverState: 'started',
          transport: 'app-server'
        }
      }
    })
    expect(getCodexStatusSnapshot).toHaveBeenCalledOnce()
    expect(getCliProviderStatus).not.toHaveBeenCalled()
  })
})

describe('DesktopToolExecutors approval status workspace grants', () => {
  it("reports 'agents' wildcard grants alongside the caller's own legacy rows", () => {
    const grants: AgenticWorkspaceGrant[] = [
      {
        id: 'grant-agents',
        provider: 'agents',
        workspacePath: '/workspace',
        service: 'fileChanges',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z'
      },
      {
        id: 'grant-legacy-codex',
        provider: 'codex',
        workspacePath: '/workspace',
        service: 'fileChanges',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z'
      },
      {
        id: 'grant-agents-elsewhere',
        provider: 'agents',
        workspacePath: '/elsewhere',
        service: 'fileChanges',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z'
      }
    ]
    const { executor } = createExecutor({
      chats: [chat('chat-a', [])],
      settings: { agenticWorkspaceGrants: grants } as AppSettings
    })

    // 'agents' rows report for any caller; the legacy codex row stays scoped
    // to codex; the other-workspace row is filtered by path.
    const claudeResult = executor.executeApprovalStatus(activeContext, {}, 'claude') as {
      workspaceGrants: AgenticWorkspaceGrant[]
    }
    expect(claudeResult.workspaceGrants.map((grant) => grant.id)).toEqual(['grant-agents'])

    const codexResult = executor.executeApprovalStatus(activeContext, {}, 'codex') as {
      workspaceGrants: AgenticWorkspaceGrant[]
    }
    expect(codexResult.workspaceGrants.map((grant) => grant.id)).toEqual([
      'grant-agents',
      'grant-legacy-codex'
    ])
  })
})
