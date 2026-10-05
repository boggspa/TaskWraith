import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadCatalogueDiskReader } from '../store/ThreadCatalogueDiskReader'
import { preparedThreadDirectory } from '../store/ThreadCatalogueMutation'
import type { ThreadFoldRequest } from '../store/ThreadCatalogueWorkerProtocol'

const port = vi.hoisted(() => {
  const handlers: Array<(message: unknown) => void> = []
  const posted: Array<Record<string, unknown>> = []
  return {
    handlers,
    posted,
    on: (_event: string, handler: (message: unknown) => void): void => {
      handlers.push(handler)
    },
    postMessage: (message: Record<string, unknown>): void => {
      posted.push(message)
    }
  }
})

vi.mock('node:worker_threads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:worker_threads')>()),
  parentPort: port
}))

const CHAT = 'chat-decoder-fold'
const SAVED_AT = '2026-03-01T08:00:00.000Z'

describe('history decoder fold request', () => {
  let profile: string

  const options = (): ThreadFoldRequest['options'] => ({
    profilePath: profile,
    runtimeInstanceId: 'rt',
    segmented: false
  })
  function seed(): string {
    fs.mkdirSync(join(profile, 'chats'), { recursive: true })
    fs.writeFileSync(
      join(profile, 'chats', `${CHAT}.json`),
      JSON.stringify({
        appChatId: CHAT,
        title: 'Decoder fold',
        scope: 'global',
        chatKind: 'single',
        provider: 'claude',
        createdAt: 1,
        updatedAt: 2,
        persistenceRevision: 1,
        messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00Z' }],
        runs: []
      })
    )
    return new ThreadCatalogueDiskReader(options()).read(CHAT)!.source.witness
  }
  const request = (sourceWitness: string, overrides: Record<string, unknown> = {}): unknown => ({
    type: 'fold',
    requestId: 7,
    chatId: CHAT,
    options: options(),
    sourceWitness,
    epoch: { global: 'g', chat: 'c' },
    heads: { desktop: null, host: null },
    headRevision: 2,
    updatedAt: SAVED_AT,
    profileAuthority: 'authority-1',
    logEntries: [
      {
        format: 'taskwraith-chat-mutation',
        version: 1,
        chatId: CHAT,
        baseRevision: 1,
        revision: 2,
        savedAt: SAVED_AT,
        operations: [{ type: 'message_content_append', messageId: 'm1', content: ' there' }]
      }
    ],
    ...overrides
  })
  async function send(message: unknown): Promise<Record<string, unknown>> {
    const before = port.posted.length
    for (const handler of port.handlers) handler(message)
    await vi.waitFor(() => expect(port.posted.length).toBeGreaterThan(before))
    // `activeRequest` clears in a `finally` after the reply is posted.
    await new Promise((resolve) => setImmediate(resolve))
    return port.posted[port.posted.length - 1]
  }

  beforeAll(async () => {
    await import('./threadCatalogueDecoder')
  })
  beforeEach(() => {
    profile = fs.mkdtempSync(join(tmpdir(), 'thread-decoder-fold-'))
    port.posted.length = 0
  })
  afterEach(() => fs.rmSync(profile, { recursive: true, force: true }))

  it('accepts a fold request and posts the folded outcome under the same request id', async () => {
    const reply = await send(request(seed()))
    expect(reply).toMatchObject({ type: 'folded', requestId: 7 })
    const folded = reply.folded as { foldId: string; headRevision: number; updatedAt: string }
    expect(folded.headRevision).toBe(2)
    expect(folded.updatedAt).toBe(SAVED_AT)
    expect(
      fs.existsSync(join(preparedThreadDirectory(profile, CHAT), `${folded.foldId}.record.json`))
    ).toBe(true)
  })

  it('posts a null fold for a missing canonical source', async () => {
    const reply = await send(request('a'.repeat(64)))
    expect(reply).toEqual({ type: 'folded', requestId: 7, folded: null })
  })

  it('reports a changed source as changed, not as an unreadable fold', async () => {
    seed()
    const reply = await send(request('b'.repeat(64)))
    expect(reply).toMatchObject({ type: 'error', requestId: 7, reason: 'changed' })
  })

  it.each([
    ['a missing log', { logEntries: undefined }],
    ['a missing head revision', { headRevision: undefined }],
    ['a zero head revision', { headRevision: 0 }],
    ['a missing timestamp', { updatedAt: undefined }],
    ['a missing profile authority', { profileAuthority: undefined }]
  ])('rejects a malformed fold with %s', async (_name, overrides) => {
    const reply = await send(request(seed(), overrides))
    expect(reply).toMatchObject({ type: 'error', requestId: 7, reason: 'unreadable' })
    expect(port.posted.some((message) => message.type === 'folded')).toBe(false)
    expect(fs.existsSync(preparedThreadDirectory(profile, CHAT))).toBe(false)
  })
})
