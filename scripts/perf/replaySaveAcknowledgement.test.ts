import { createRequire } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { SerializedChatPersistence } from '../../src/preload/SerializedChatPersistence'
import type { ChatRecord } from '../../src/main/store/types'

const require = createRequire(import.meta.url)
const {
  createCdpEvaluateAdapter,
  createCdpPageApiAdapter,
  performTrackedSave,
  runDeterministicReplay
} = require('./replayDriver.cjs')

const CHAT_ID = 'replay-ack-chat'
const PRIVATE_CONTENT = 'fixture-content-must-not-appear-in-ack-or-error'
const REJECTION = {
  code: 'T2_REPLAY_SAVE_REJECTED',
  message: 'T2 replay save was not acknowledged as accepted'
}

function fixtureChat(revision = 1) {
  return {
    appChatId: CHAT_ID,
    persistenceRevision: revision,
    updatedAt: 100,
    title: PRIVATE_CONTENT,
    messages: [
      { id: 'message-1', role: 'user', content: PRIVATE_CONTENT },
      { id: 'message-2', role: 'assistant', content: PRIVATE_CONTENT }
    ]
  }
}

type ReplayChat = ReturnType<typeof fixtureChat>
type SavePath = 'prefix' | 'fallback'

function canonicalOutcome(chatOverrides: Record<string, unknown> = {}, accepted: unknown = true) {
  return {
    accepted,
    chat: { ...fixtureChat(), persistenceRevision: 85, updatedAt: 200, ...chatOverrides },
    privateMetadata: PRIVATE_CONTENT
  }
}

/** Execute the emitted expressions and transport only their by-value CDP result. */
function evaluatedPage(
  outcome: unknown | ((chat: ReplayChat) => unknown),
  savePath: SavePath,
  saveReply: (value: unknown) => object = (value) => ({ result: { value } })
) {
  const expressions: string[] = []
  const replies: string[] = []
  const saveChat = vi.fn(() => {
    throw new Error('legacy saveChat cannot prove acceptance')
  })
  const saveChatWithOutcome = vi.fn((chat: ReplayChat) =>
    typeof outcome === 'function' ? outcome(chat) : outcome
  )
  const context = createContext({
    window: { api: { saveChat, saveChatWithOutcome, getChat: () => null } }
  })
  const adapter = createCdpPageApiAdapter(
    createCdpEvaluateAdapter({
      async send(method: string, params: { expression: string; returnByValue: boolean }) {
        expect(method).toBe('Runtime.evaluate')
        expect(params.returnByValue).toBe(true)
        expressions.push(params.expression)
        const value = await runInContext(params.expression, context, { timeout: 1000 })
        const reply = JSON.stringify(
          value && typeof value === 'object' && 'accepted' in value
            ? saveReply(value)
            : { result: { value } }
        )
        replies.push(reply)
        return JSON.parse(reply)
      }
    })
  )
  const api =
    savePath === 'prefix' ? adapter : { getChat: adapter.getChat, saveChat: adapter.saveChat }
  return { api, expressions, replies, saveChat, saveChatWithOutcome }
}

function trackedContext(api: unknown, knownRevision?: number) {
  return {
    api,
    canonicalRevisions: new Map(knownRevision == null ? [] : [[CHAT_ID, knownRevision]]),
    savedCounts: new Map<string, number>()
  }
}

function save(ctx: ReturnType<typeof trackedContext>, chat = fixtureChat()) {
  return performTrackedSave(
    ctx,
    { seq: 1, kind: 'seed_chat', appChatId: CHAT_ID },
    structuredClone(chat),
    { base: chat, messageCount: chat.messages.length }
  )
}

const malformedOutcomes: Array<[string, unknown]> = [
  ['absent outcome', undefined],
  ['null outcome', null],
  ['string outcome', PRIVATE_CONTENT],
  ['array outcome', [canonicalOutcome()]],
  ['empty outcome', {}],
  ['legacy bare chat', canonicalOutcome().chat],
  ['missing acceptance', { chat: canonicalOutcome().chat }],
  ['null acceptance', canonicalOutcome({}, null)],
  ['string acceptance', canonicalOutcome({}, 'true')],
  ['numeric acceptance', canonicalOutcome({}, 1)],
  ['object acceptance', canonicalOutcome({}, { private: PRIVATE_CONTENT })],
  ['missing canonical chat', { accepted: true }],
  ['null canonical chat', { accepted: true, chat: null }],
  ['string canonical chat', { accepted: true, chat: PRIVATE_CONTENT }],
  ['missing chat identity', canonicalOutcome({ appChatId: undefined })],
  ['null chat identity', canonicalOutcome({ appChatId: null })],
  ['empty chat identity', canonicalOutcome({ appChatId: '' })],
  ['wrong chat identity', canonicalOutcome({ appChatId: PRIVATE_CONTENT })],
  ['numeric chat identity', canonicalOutcome({ appChatId: 1 })],
  ['object chat identity', canonicalOutcome({ appChatId: { private: PRIVATE_CONTENT } })],
  ['missing revision', canonicalOutcome({ persistenceRevision: undefined })],
  ['null revision', canonicalOutcome({ persistenceRevision: null })],
  ['string revision', canonicalOutcome({ persistenceRevision: '85' })],
  ['object revision', canonicalOutcome({ persistenceRevision: { private: PRIVATE_CONTENT } })],
  ['NaN revision', canonicalOutcome({ persistenceRevision: NaN })],
  ['infinite revision', canonicalOutcome({ persistenceRevision: Infinity })],
  ['negative infinite revision', canonicalOutcome({ persistenceRevision: -Infinity })],
  ['negative revision', canonicalOutcome({ persistenceRevision: -1 })],
  ['zero revision', canonicalOutcome({ persistenceRevision: 0 })],
  ['unchanged revision', canonicalOutcome({ persistenceRevision: 1 })],
  ['fractional revision', canonicalOutcome({ persistenceRevision: 85.5 })],
  ['unsafe revision', canonicalOutcome({ persistenceRevision: Number.MAX_SAFE_INTEGER + 1 })]
]

describe.each<SavePath>(['prefix', 'fallback'])('replay ACK via %s', (savePath) => {
  it.each([85, 167])('rejects a refused 1 -> %i save without learning it', async (revision) => {
    const page = evaluatedPage(canonicalOutcome({ persistenceRevision: revision }, false), savePath)
    const ctx = trackedContext(page.api, 1)
    ctx.savedCounts.set(CHAT_ID, 3)

    await expect(save(ctx)).rejects.toMatchObject(REJECTION)

    expect(ctx.canonicalRevisions.get(CHAT_ID)).toBe(1)
    expect(ctx.savedCounts.get(CHAT_ID)).toBe(3)
    expect(page.saveChatWithOutcome).toHaveBeenCalledOnce()
    expect(page.saveChat).not.toHaveBeenCalled()
    expect(page.replies.join('')).not.toContain(PRIVATE_CONTENT)
  })

  it.each(malformedOutcomes)('rejects %s', async (_label, outcome) => {
    const page = evaluatedPage(outcome, savePath)
    const ctx = trackedContext(page.api)

    await expect(save(ctx)).rejects.toMatchObject(REJECTION)

    expect(ctx.canonicalRevisions.size).toBe(0)
    expect(ctx.savedCounts.size).toBe(0)
    expect(page.saveChatWithOutcome).toHaveBeenCalledOnce()
    expect(page.saveChat).not.toHaveBeenCalled()
    expect(page.replies.join('')).not.toContain(PRIVATE_CONTENT)
  })

  it.each([
    ['missing CDP result', {}],
    ['missing CDP value', { result: {} }]
  ])('rejects %s after the page save resolves', async (_label, reply) => {
    const page = evaluatedPage(canonicalOutcome(), savePath, () => reply as object)
    const ctx = trackedContext(page.api, 1)

    await expect(save(ctx)).rejects.toMatchObject(REJECTION)

    expect(page.saveChatWithOutcome).toHaveBeenCalledOnce()
    expect(ctx.canonicalRevisions.get(CHAT_ID)).toBe(1)
    expect(ctx.savedCounts.size).toBe(0)
  })

  it('stops a rejected seed before any continuation or success callback', async () => {
    const page = evaluatedPage(canonicalOutcome({}, false), savePath)
    const onProgress = vi.fn()
    const onEventStart = vi.fn()
    const chat = fixtureChat()

    await expect(
      runDeterministicReplay({
        api: page.api,
        fixture: {
          chats: [chat],
          replaySchedule: [
            { seq: 1, kind: 'seed_chat', appChatId: CHAT_ID },
            { seq: 2, kind: 'append_assistant', appChatId: CHAT_ID, messageId: 'message-2' },
            { seq: 3, kind: 'schedule_complete', appChatId: CHAT_ID }
          ]
        },
        onProgress,
        onEventStart
      })
    ).rejects.toMatchObject(REJECTION)

    expect(page.saveChatWithOutcome).toHaveBeenCalledOnce()
    expect(onEventStart).toHaveBeenCalledOnce()
    expect(onEventStart).toHaveBeenCalledWith(expect.objectContaining({ kind: 'seed_chat' }))
    expect(onProgress).not.toHaveBeenCalled()
  })

  it('counts an accepted preload rebase from 1 to 85 and sends 85 next', async () => {
    let canonical = fixtureChat() as unknown as ChatRecord
    let releaseRemote!: () => void
    const remoteGate = new Promise<void>((resolve) => {
      releaseRemote = resolve
    })
    const saveRemote = vi.fn(async (record: ChatRecord) => {
      await remoteGate
      const previous = structuredClone(canonical)
      if (record.persistenceRevision !== previous.persistenceRevision) {
        return { chat: previous, previous, accepted: false }
      }
      canonical = {
        ...structuredClone(record),
        persistenceRevision: (previous.persistenceRevision ?? 0) + 1,
        updatedAt: previous.updatedAt + 1
      }
      return { chat: structuredClone(canonical), previous, accepted: true }
    })
    const persistence = new SerializedChatPersistence(saveRemote, vi.fn())
    const siblings = Array.from({ length: 83 }, () =>
      persistence.saveWithOutcome(structuredClone(canonical))
    )
    let replayQueued!: () => void
    const queued = new Promise<void>((resolve) => {
      replayQueued = resolve
    })
    const page = evaluatedPage((record: ReplayChat) => {
      const pending = persistence.saveWithOutcome(record as unknown as ChatRecord)
      replayQueued()
      return pending
    }, savePath)
    const ctx = trackedContext(page.api, 1)
    const pendingReplay = save(ctx)
    await queued
    releaseRemote()
    await Promise.all([...siblings, pendingReplay])

    expect(saveRemote.mock.calls.at(-1)?.[0].persistenceRevision).toBe(84)
    expect(ctx.canonicalRevisions.get(CHAT_ID)).toBe(85)
    expect(ctx.savedCounts.get(CHAT_ID)).toBe(1)

    await save(ctx)

    expect(
      page.saveChatWithOutcome.mock.calls.map(([record]) => record.persistenceRevision)
    ).toEqual([1, 85])
    expect(ctx.canonicalRevisions.get(CHAT_ID)).toBe(86)
    expect(ctx.savedCounts.get(CHAT_ID)).toBe(2)
    expect(page.saveChat).not.toHaveBeenCalled()
  })

  it.each([
    [0, 1],
    [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]
  ])('accepts safe integer revision advancement %i -> %i', async (sent, next) => {
    const page = evaluatedPage(canonicalOutcome({ persistenceRevision: next }), savePath)
    const ctx = trackedContext(page.api)

    await save(ctx, fixtureChat(sent))

    expect(page.saveChatWithOutcome.mock.calls[0][0].persistenceRevision).toBe(sent)
    expect(ctx.canonicalRevisions.get(CHAT_ID)).toBe(next)
    expect(ctx.savedCounts.get(CHAT_ID)).toBe(1)
  })

  it('returns only a compact acknowledgement, even when canonical contains a large transcript', async () => {
    const content = PRIVATE_CONTENT.repeat(10_000)
    const page = evaluatedPage(
      canonicalOutcome({ messages: [{ content }], privateMetadata: content }),
      savePath
    )
    const ctx = trackedContext(page.api)

    await save(ctx)

    const reply = page.replies.at(-1)!
    expect(JSON.parse(reply).result.value).toEqual({
      accepted: true,
      appChatId: CHAT_ID,
      persistenceRevision: 85,
      updatedAt: 200
    })
    expect(reply.length).toBeLessThan(200)
    expect(reply).not.toContain(PRIVATE_CONTENT)
  })

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid outgoing revision (%s) before sending a save',
    async (revision) => {
      const page = evaluatedPage(canonicalOutcome(), savePath)
      const ctx = trackedContext(page.api)

      await expect(save(ctx, fixtureChat(revision))).rejects.toMatchObject(REJECTION)

      expect(page.saveChatWithOutcome).not.toHaveBeenCalled()
      expect(ctx.canonicalRevisions.size).toBe(0)
      expect(ctx.savedCounts.size).toBe(0)
    }
  )
})

it('keeps evaluated prefix commands bounded after a single fixture seed', async () => {
  const page = evaluatedPage(
    (chat: ReplayChat) => canonicalOutcome({ persistenceRevision: chat.persistenceRevision + 1 }),
    'prefix'
  )
  const chat = fixtureChat()
  chat.messages[0].content = PRIVATE_CONTENT.repeat(10_000)
  const ctx = trackedContext(page.api)

  await save(ctx, chat)
  await performTrackedSave(
    ctx,
    { seq: 2, kind: 'append_user', appChatId: CHAT_ID },
    { ...chat, messages: chat.messages.slice(0, 1) },
    { base: chat, messageCount: 1 }
  )

  expect(page.expressions).toHaveLength(3)
  expect(page.expressions[0]).toContain(PRIVATE_CONTENT)
  for (const command of page.expressions.slice(1)) {
    expect(command.length).toBeLessThan(1000)
    expect(command).not.toContain(PRIVATE_CONTENT)
  }
  expect(page.saveChatWithOutcome.mock.calls.map(([record]) => record.messages.length)).toEqual([
    2, 1
  ])
  expect(page.saveChat).not.toHaveBeenCalled()
  expect(ctx.savedCounts.get(CHAT_ID)).toBe(2)
})
