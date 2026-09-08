import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { RendererChatPendingDrafts } from './RendererChatPendingDrafts'
import { RendererChatTranscriptPersistence } from './RendererChatTranscriptPersistence'
import { RendererChatConflictNotice } from '../components/RendererChatConflictNotice'
import {
  applyChatTranscriptOps,
  computeChatSubRevisions
} from '../../../shared/chatUpdateTransport'
import type {
  RendererChatTranscriptMutationRequest,
  RendererChatTranscriptMutationResult
} from '../../../shared/rendererChatTranscriptMutation'

const hooks = vi.hoisted(() => ({ finished: () => {} }))
vi.mock('react', () => ({
  useState: (initial: unknown) => [
    initial,
    (next: unknown) => {
      if (typeof initial === 'boolean' && next === false) hooks.finished()
    }
  ],
  useSyncExternalStore: () => {}
}))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function baseChat(): ChatRecord {
  return {
    appChatId: 'chat-1',
    provider: 'mistral',
    scope: 'global',
    title: 'Old title',
    pinned: false,
    persistenceRevision: 3,
    updatedAt: 1,
    createdAt: 1,
    archived: false,
    providerMetadata: { selectedModelType: 'old-model' },
    messages: [
      { id: 'm1', role: 'user', content: 'Original', timestamp: '2026-09-08T10:00:00.000Z' }
    ],
    runs: [{ runId: 'r1', status: 'running', startedAt: '2026-09-08T10:00:00.000Z' }]
  }
}
function canonicalChat(base: ChatRecord): ChatRecord {
  return {
    ...structuredClone(base),
    title: 'Canonical title',
    persistenceRevision: 4,
    updatedAt: 2,
    runs: [
      {
        ...base.runs[0],
        status: 'failed',
        endedAt: '2026-09-08T11:00:00.000Z',
        staleSettlementProvenance: {
          schemaVersion: 1,
          origin: 'stale-run-reconciler',
          runId: 'r1',
          settledAt: '2026-09-08T11:00:00.000Z',
          previousStatus: 'running',
          authoredEndedAt: true,
          authoredExitCode: true
        }
      }
    ]
  }
}
function setup() {
  const base = baseChat()
  const canonical = canonicalChat(base)
  const drafts = new RendererChatPendingDrafts()
  drafts.trackTarget(base)
  const advanced = drafts.advance(base, canonical, { ...base, title: 'Local title' }, canonical)
  if (!advanced) throw new Error('Unexpected cancelled fixture')
  return { base, canonical, drafts, current: advanced.record as ChatRecord | undefined }
}

function buttons(node: unknown): Array<{ props: { children: string; onClick(): void } }> {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(buttons)
  const element = node as { type?: string; props?: { children?: unknown } }
  if (element.type === 'button') return [node as ReturnType<typeof buttons>[number]]
  return buttons(element.props?.children)
}

function notice(
  state: ReturnType<typeof setup>,
  getChat: () => Promise<ChatRecord>,
  saveChat: (chat: ChatRecord) => Promise<ChatRecord>
) {
  vi.stubGlobal('window', { api: { getChat, saveChat } })
  const onResolved = vi.fn((raw: ChatRecord, advanced?: ChatRecord) => {
    if (advanced) state.current = advanced
    state.current = state.drafts.apply(raw, raw, state.current)
  })
  // Calling the component with inert hooks exposes its actual button closures.
  // No renderer, external store listener or DOM is needed to exercise awaits.
  const props = {
    chatId: 'chat-1',
    drafts: state.drafts,
    beforeResolve: async () => {},
    getCurrent: () => state.current,
    onResolved
  }
  const tree = RendererChatConflictNotice(props)
  return {
    onResolved,
    click(label: string): Promise<void> {
      const done = deferred<void>()
      hooks.finished = () => done.resolve()
      const button = buttons(tree).find((candidate) => candidate.props.children === label)
      if (!button) throw new Error(`Missing conflict action ${label}`)
      button.props.onClick()
      return done.promise
    }
  }
}

function persist(chat: ChatRecord): ChatRecord {
  return {
    ...structuredClone(chat),
    persistenceRevision: (chat.persistenceRevision ?? 0) + 1,
    updatedAt: chat.updatedAt + 1
  }
}

describe('renderer conflict resolution lifecycle', () => {
  it('saves the latest current pin and model along with the held title', async () => {
    const state = setup()
    state.current = {
      ...state.current!,
      pinned: true,
      providerMetadata: { selectedModelType: 'new-model' }
    }
    state.drafts.trackTarget(state.current)
    const save = vi.fn(async (chat: ChatRecord) => persist(chat))
    const ui = notice(state, async () => state.canonical, save)
    await ui.click('Save local changes')
    expect(save.mock.calls[0][0]).toMatchObject({
      pinned: true,
      providerMetadata: { selectedModelType: 'new-model' }
    })
    expect(state.current).toMatchObject({
      title: 'Local title',
      pinned: true,
      providerMetadata: { selectedModelType: 'new-model' }
    })
    expect(state.current?.runs[0].status).toBe('failed')
  })

  it('retains an edit made while Save local changes awaits its acknowledgement', async () => {
    const state = setup()
    const started = deferred<void>(),
      result = deferred<ChatRecord>()
    const save = vi.fn((_chat: ChatRecord) => {
      started.resolve()
      return result.promise
    })
    const ui = notice(state, async () => state.canonical, save)
    const completion = ui.click('Save local changes')
    await started.promise
    const submitted = save.mock.calls[0][0]
    state.current = { ...state.current!, title: 'Newer local title' }
    state.drafts.trackTarget(state.current)
    result.resolve(persist(submitted))
    await completion
    expect(state.current?.title).toBe('Newer local title')
    expect(state.drafts.has('chat-1')).toBe(true)
    expect(state.current?.runs[0].status).toBe('failed')
  })

  it('Use saved version preserves only edits made after that choice was clicked', async () => {
    const state = setup()
    const read = deferred<ChatRecord>(),
      started = deferred<void>()
    const save = vi.fn(async (chat: ChatRecord) => persist(chat))
    const ui = notice(
      state,
      () => {
        started.resolve()
        return read.promise
      },
      save
    )
    const completion = ui.click('Use saved version')
    await started.promise
    state.current = { ...state.current!, pinned: true }
    state.drafts.trackTarget(state.current)
    read.resolve(state.canonical)
    await completion
    expect(save).not.toHaveBeenCalled()
    expect(state.current).toMatchObject({ title: 'Canonical title', pinned: true })
  })

  it.each(['Save local changes', 'Use saved version'])(
    '%s cannot republish after discard while the canonical fetch is pending',
    async (label) => {
      const state = setup()
      const read = deferred<ChatRecord>(),
        started = deferred<void>()
      const save = vi.fn(async (chat: ChatRecord) => persist(chat))
      const ui = notice(
        state,
        () => {
          started.resolve()
          return read.promise
        },
        save
      )
      const completion = ui.click(label)
      await started.promise
      state.drafts.discard('chat-1')
      state.current = undefined
      read.resolve(state.canonical)
      await completion
      expect(save).not.toHaveBeenCalled()
      expect(ui.onResolved).not.toHaveBeenCalled()
      expect(state.current).toBeUndefined()
    }
  )

  it('Save local changes cannot publish an old save reply after discard', async () => {
    const state = setup()
    const saved = deferred<ChatRecord>(),
      started = deferred<void>()
    const save = vi.fn((_chat: ChatRecord) => {
      started.resolve()
      return saved.promise
    })
    const ui = notice(state, async () => state.canonical, save)
    const completion = ui.click('Save local changes')
    await started.promise
    const submitted = save.mock.calls[0][0]
    state.drafts.discard('chat-1')
    state.current = undefined
    saved.resolve(persist(submitted))
    await completion
    expect(ui.onResolved).not.toHaveBeenCalled()
    expect(state.current).toBeUndefined()
  })

  it('a held messages conflict never becomes permission to delete unrelated canonical rows', () => {
    const state = setup()
    const local = {
      ...state.current!,
      messages: [{ ...state.current!.messages[0], content: 'Local edit' }]
    }
    const remote: ChatRecord = {
      ...state.canonical,
      persistenceRevision: 5,
      messages: [
        { ...state.canonical.messages[0], content: 'Remote edit' },
        {
          id: 'remote-new',
          role: 'user',
          content: 'New canonical row',
          timestamp: '2026-09-08T12:00:00.000Z'
        }
      ]
    }
    state.current = state.drafts.apply(remote, remote, local)
    expect(state.drafts.conflicts('chat-1')).toContain('messages')
    // The owner can resolve the conflicting message separately; this generic
    // whole-record action must retain the draft and refuse the unsafe overwrite.
    expect(() => state.drafts.resolveLocal(remote, state.current)).toThrow()
    expect(state.drafts.has('chat-1')).toBe(true)
    expect(remote.messages.map(({ id }) => id)).toEqual(['m1', 'remote-new'])
  })

  it('cancel stops recovery retries after a delayed conflict reply, so clear stays empty', async () => {
    const state = setup()
    const base = state.base
    const target: ChatRecord = {
      ...base,
      messages: [
        ...base.messages,
        {
          id: 'm2',
          role: 'user',
          content: 'Must stay cleared',
          timestamp: '2026-09-08T12:00:00.000Z'
        }
      ]
    }
    let canonical = state.canonical
    let current: ChatRecord | undefined = target
    state.drafts.trackTarget(target)
    const gate = deferred<void>()
    const firstConflict: RendererChatTranscriptMutationResult = {
      version: 1,
      accepted: false,
      chatId: 'chat-1',
      reason: 'revision-conflict',
      revision: 4,
      canonical: structuredClone(canonical)
    }
    let calls = 0
    const mutate = vi.fn(
      async (
        request: RendererChatTranscriptMutationRequest
      ): Promise<RendererChatTranscriptMutationResult> => {
        if (++calls === 1) {
          await gate.promise
          return firstConflict
        }
        if (request.baseRevision !== canonical.persistenceRevision)
          return {
            version: 1,
            accepted: false,
            chatId: 'chat-1',
            reason: 'revision-conflict',
            revision: canonical.persistenceRevision ?? 0,
            canonical: structuredClone(canonical)
          }
        const messages = applyChatTranscriptOps(canonical.messages, request.transcriptOps)
        if (!messages) throw new Error('Invalid fixture operation')
        canonical = persist({ ...canonical, messages })
        return {
          version: 1,
          accepted: true,
          chatId: 'chat-1',
          revision: canonical.persistenceRevision ?? 0,
          updatedAt: canonical.updatedAt,
          messageCount: canonical.messages.length,
          recordHash: computeChatSubRevisions(canonical).recordHash
        }
      }
    )
    const onUnrecoverable = vi.fn()
    const persistence = new RendererChatTranscriptPersistence({
      mutate,
      loadCanonical: async () => canonical,
      onUnrecoverable,
      onRecovered(_id, before, next, source) {
        const result = state.drafts.advance(before, next, current, source)
        if (result) current = result.record
      },
      onAccepted(_id, _revision, next, _result, before, source) {
        const result = state.drafts.advance(before, next, current, source)
        if (result) current = result.record
      }
    })
    expect(persistence.queue(base, target)).toBe(true)
    const flushing = persistence.flush('chat-1')
    state.drafts.discard('chat-1')
    persistence.cancel('chat-1')
    canonical = { ...canonical, messages: [], runs: [], persistenceRevision: 5 }
    current = canonical
    gate.resolve()
    await flushing
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(onUnrecoverable).not.toHaveBeenCalled()
    expect(canonical.messages).toEqual([])
    expect(current.messages).toEqual([])
  })
})
