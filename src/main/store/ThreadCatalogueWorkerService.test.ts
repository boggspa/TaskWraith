import { createCatalogueControlProjection } from '../startup/ThreadCatalogueControl'
import { catalogueIntrospectionEvidence } from '../startup/ThreadCatalogueIntrospection'
import { harvestIntrospectionEvidence } from '../introspection/IntrospectionEvidenceHarvester'
import { projectTaskWraithControlThreadFacts } from '../control/TaskWraithControlProjector'
import type { ChatRecord } from './types'
import { messageActivityFromChats } from '../../shared/messageActivityAggregate'
import { createThreadCatalogueMessageActivity } from '../startup/ThreadCatalogueMessageActivity'
import { ThreadCatalogueHostRecovery } from '../../host-node/ThreadCatalogueHostRecovery'
import { ThreadCatalogueMirror } from './ThreadCatalogueMirror'
import { ThreadCatalogueSourcePublisher as HostPublisher } from '../../host-shared/thread-catalogue/ThreadCatalogueSourcePublisher'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ThreadCatalogueWorkerService } from './ThreadCatalogueWorkerService'
import { createThreadCatalogueReads } from '../../preload/ThreadCatalogueReads'
import { ThreadCatalogueRecoveryController } from './ThreadCatalogueRecoveryController'
import { ThreadCatalogueSourcePublisher } from './ThreadCatalogueSourcePublisher'
import type { ThreadCatalogueQuery, ThreadCatalogueOpenResult } from './ThreadCatalogueClient'
import type { PreparedThreadMutation } from './ThreadCatalogueMutation'

describe('real isolated history import', () => {
  let directory: string
  let decoderPath: string
  beforeAll(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'thread-worker-integration-'))
    decoderPath = join(directory, 'decoder.cjs')
    await build({
      entryPoints: ['src/main/workers/threadCatalogueDecoder.ts'],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: decoderPath,
      logLevel: 'silent'
    })
  })
  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }))

  it('imports a cold profile, pages a large thread, and reuses durable metadata after restart', async () => {
    const profilePath = join(directory, 'profile')
    fs.mkdirSync(join(profilePath, 'chats'), { recursive: true })
    for (let index = 0; index < 30; index += 1) {
      const chatId = `chat-${index}`
      fs.writeFileSync(
        join(profilePath, 'chats', `${chatId}.json`),
        JSON.stringify({
          appChatId: chatId,
          title: chatId,
          scope: 'global',
          chatKind: 'single',
          provider: 'claude',
          createdAt: 1,
          updatedAt: index + 1,
          persistenceRevision: 1,
          messages: [
            {
              id: 'message',
              role: 'user',
              content: '😀'.repeat(index === 0 ? 600_000 : 100),
              timestamp: '2026-01-01T00:00:00.000Z'
            }
          ],
          runs: []
        })
      )
    }
    const options = {
      reader: { profilePath, runtimeInstanceId: 'runtime', segmented: false },
      decoderPath,
      writer: 'desktop' as const,
      writerId: 'owner',
      writerLifecycle: () => 'active' as const
    }
    let service = new ThreadCatalogueWorkerService(options)
    try {
      expect(service.database.list().coverage).toBe('partial')
      await service.refreshInventory()
      await Promise.all(
        Array.from({ length: 30 }, (_, i) => service.ensureIndexed(`chat-${i}`, 'metadata'))
      )
      expect(service.database.list().entries).toHaveLength(30)
      expect(service.database.list().coverage).toBe('complete')
      const indexed = await service.ensureIndexed('chat-0', 'pages')
      expect(indexed?.snapshot).toBe(false)
      const page = service.database.readObjects(indexed!, 'message', { maxBytes: 1024 })!
      expect(page[0].kind).toBe('chunked')
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024)
      expect(service.database.findRun('absent')).toBeNull()
      const generation = indexed!.generation
      await service.dispose()
      service = new ThreadCatalogueWorkerService(options)
      await service.refreshInventory()
      expect((await service.ensureIndexed('chat-0', 'metadata'))?.generation).toBe(generation)
      expect(service.database.list().coverage).toBe('complete')
    } finally {
      await service.dispose()
    }
  }, 30_000)
  it('opens transcript pages through bounded renderer requests and erases crash-stranded prepared copies', async () => {
    const profilePath = join(directory, 'renderer-profile')
    fs.mkdirSync(join(profilePath, 'chats'), { recursive: true })
    const messages = Array.from({ length: 1601 }, (_, index) => ({
      id: `m-${index}`,
      role: 'user',
      content: index === 1600 ? '😀'.repeat(600_000) : `message ${index}`,
      timestamp: '2026-01-01T00:00:00.000Z'
    }))
    fs.writeFileSync(
      join(profilePath, 'chats', 'chat.json'),
      JSON.stringify({
        appChatId: 'chat',
        title: 'Chat',
        provider: 'claude',
        scope: 'global',
        createdAt: 1,
        updatedAt: 2,
        persistenceRevision: 1,
        messages,
        runs: []
      })
    )
    const service = new ThreadCatalogueWorkerService({
      reader: { profilePath, runtimeInstanceId: 'runtime', segmented: false },
      decoderPath,
      writer: 'desktop',
      writerId: 'owner',
      writerLifecycle: () => 'active',
      assertSourceAuthority: () => {}
    })
    const replies: number[] = []
    const reads = createThreadCatalogueReads(async (channel, request) => {
      expect(channel).toBe('thread-catalogue:read')
      const data = await service.query(request as ThreadCatalogueQuery)
      replies.push(
        data instanceof Uint8Array ? data.byteLength : Buffer.byteLength(JSON.stringify(data))
      )
      return { available: true, data }
    })
    try {
      const tail = await reads.getChatTranscriptPage({
        chatId: 'chat',
        maxMessages: 2,
        includeShell: true
      })
      expect(tail?.messages.map((m) => m.id)).toEqual(['m-1599', 'm-1600'])
      expect(tail?.messages.at(-1)?.metadata?.kind).toBe('catalogueDeferredMessage')
      expect(tail?.messages.at(-1)?.content.length).toBeLessThanOrEqual(1024)
      expect((await reads.getTranscriptMessage('chat', 'm-1600'))?.content).toBe(
        messages.at(-1)!.content
      )
      expect(tail?.shell?.messageCount).toBe(1601)
      expect(tail?.windowStart).toBe(1599)
      const older = await reads.getChatTranscriptPage({
        chatId: 'chat',
        beforeMessageId: 'm-1599',
        maxMessages: 2
      })
      expect(older?.messages.map((m) => m.id)).toEqual(['m-1597', 'm-1598'])
      expect(Math.max(...replies)).toBeLessThanOrEqual(2 * 1024 * 1024 + 65536)
      const prepared = join(profilePath, 'thread-catalogue-v1', 'prepared', 'chat')
      fs.mkdirSync(prepared, { recursive: true })
      fs.writeFileSync(join(prepared, 'crashed.record.json'), 'PRIVATE_ERASURE_SENTINEL')
      const opened = (await service.query({
        method: 'open',
        chatId: 'chat',
        mode: 'pages'
      })) as ThreadCatalogueOpenResult
      const generation = (await service.query({ method: 'erase', chatId: 'chat' })) as string
      expect(fs.existsSync(prepared)).toBe(false)
      await expect(
        service.query({ method: 'objects', leaseId: opened.leaseId, kind: 'message' })
      ).rejects.toThrow()
      expect(await service.query({ method: 'finish-erasure', chatId: 'chat', generation })).toBe(
        true
      )
    } finally {
      await service.dispose()
    }
  }, 30_000)

  it('matches message activity boundaries from durable timestamp facts, with no decoder on repeated dashboard reads', async () => {
    const profilePath = join(directory, 'activity-profile')
    fs.mkdirSync(join(profilePath, 'chats'), { recursive: true })
    const reset = Date.parse('2026-09-01T12:34:56Z')
    const chats = Array.from({ length: 1005 }, (_, index) => ({
      appChatId: `activity-${String(index).padStart(4, '0')}`,
      title: 'Activity',
      provider: 'claude',
      scope: 'global',
      createdAt: 1,
      updatedAt: 2,
      persistenceRevision: 1,
      messages: [reset - 1, reset, reset + 1, reset + 86_400_000]
        .map((at, i) => ({
          id: `m-${i}`,
          role: 'user',
          content: 'Not sent to the aggregate consumer',
          timestamp: new Date(at).toISOString()
        }))
        .concat([
          { id: 'invalid', role: 'user', content: 'invalid timestamp', timestamp: 'invalid' }
        ]),
      runs: []
    }))
    for (const chat of chats)
      fs.writeFileSync(join(profilePath, 'chats', `${chat.appChatId}.json`), JSON.stringify(chat))
    const service = new ThreadCatalogueWorkerService({
      reader: { profilePath, runtimeInstanceId: 'activity', segmented: false },
      decoderPath,
      writer: 'desktop',
      writerId: 'activity',
      writerLifecycle: () => 'active',
      assertSourceAuthority: () => {}
    })
    let pages = 0
    const aggregate = createThreadCatalogueMessageActivity({
      query: async <T>(query: ThreadCatalogueQuery) => {
        expect(query.method).toBe('message-activity')
        const reply = await service.query(query)
        expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(2 * 1024 * 1024)
        pages += 1
        return reply as T
      }
    })
    try {
      await service.refreshInventory()
      await Promise.all(chats.map((chat) => service.ensureIndexed(chat.appChatId, 'metadata')))
      for (const request of [
        { resetAt: 0, rangeStart: 0 },
        { resetAt: reset, rangeStart: reset + 1 },
        { resetAt: reset + 86_400_001, rangeStart: reset }
      ])
        expect(await aggregate(request)).toEqual(messageActivityFromChats(chats, request))
      expect(pages).toBeGreaterThan(3)
      const generation = service.database.current(chats[0].appChatId)!.generation
      expect(await aggregate({ resetAt: 0, rangeStart: reset })).toEqual(
        messageActivityFromChats(chats, { resetAt: 0, rangeStart: reset })
      )
      expect(service.database.current(chats[0].appChatId)!.generation).toBe(generation)
      fs.writeFileSync(
        join(profilePath, 'chats', `${chats[0].appChatId}.json`),
        JSON.stringify({ ...chats[0], persistenceRevision: 2, messages: [] })
      )
      await expect(aggregate({ resetAt: 0, rangeStart: 0 })).rejects.toThrow('still indexing')
    } finally {
      await service.dispose()
    }
    // This functional pagination case fsyncs 1,005 chat generations. Parallel
    // compiler/subprocess suites may contend for disk; latency is measured separately.
  }, 120_000)

  it('serves remote and large control projections through real decoder modes and invalidates same-revision overlays', async () => {
    const profilePath = join(directory, 'control-remote')
    fs.mkdirSync(join(profilePath, 'chats'), { recursive: true })
    const chat: ChatRecord = {
      appChatId: 'chat',
      title: 'Control',
      archived: false,
      scope: 'global',
      provider: 'claude',
      createdAt: 1,
      updatedAt: 2,
      persistenceRevision: 1,
      messages: Array.from({ length: 220 }, (_, i) => ({
        id: `m-${i}`,
        role: i % 2 ? 'assistant' : 'user',
        content: '界'.repeat(4500),
        timestamp: '2026-09-01T00:00:00Z',
        runId: 'run'
      })),
      runs: [
        {
          runId: 'run',
          status: 'success',
          startedAt: '2026-09-01T00:00:00Z',
          endedAt: '2026-09-01T00:01:00Z'
        }
      ]
    }
    fs.writeFileSync(join(profilePath, 'chats', 'chat.json'), JSON.stringify(chat))
    const service = new ThreadCatalogueWorkerService({
      reader: { profilePath, runtimeInstanceId: 'control', segmented: false },
      decoderPath,
      writer: 'desktop',
      writerId: 'control',
      writerLifecycle: () => 'active'
    })
    const requests: ThreadCatalogueQuery[] = []
    const mirror = new ThreadCatalogueMirror({
      query: async <T>(query: ThreadCatalogueQuery) => {
        requests.push(query)
        const result = await service.query(query)
        expect(
          result instanceof Uint8Array
            ? result.byteLength
            : Buffer.byteLength(JSON.stringify(result))
        ).toBeLessThanOrEqual(2 * 1024 * 1024 + 65536)
        return result as T
      }
    })
    try {
      await service.refreshInventory()
      await service.ensureIndexed('chat', 'metadata')
      await mirror.refresh()
      expect(mirror.list()[0].catalogueControl).toEqual(projectTaskWraithControlThreadFacts(chat))
      expect(mirror.list()[0].catalogueViewKey).toBeTruthy()
      const control = createCatalogueControlProjection(() => mirror)
      const selected = await control({ threadId: 'chat', limit: 200 })
      expect(selected.kind).toBe('projection')
      if (selected.kind !== 'projection') throw new Error('Expected pane')
      expect(selected.projection.rows).toHaveLength(200)
      expect(requests.some((q) => q.method === 'chunk')).toBe(true)
      const count = requests.length
      expect(await control({ threadId: 'chat', limit: 200, knownRevision: 1 })).toEqual({
        kind: 'unchanged',
        revision: 1
      })
      expect(requests.slice(count).map((q) => q.method)).toEqual(['summary'])
      fs.mkdirSync(join(profilePath, 'chat-composer-selections'), { recursive: true })
      fs.writeFileSync(
        join(profilePath, 'chat-composer-selections', 'chat.json'),
        JSON.stringify({
          schemaVersion: 1,
          chatId: 'chat',
          baseRevision: 1,
          revision: 2,
          updatedAt: 3,
          providerMetadataPatch: { selectedModelType: 'changed-model' }
        })
      )
      expect((await control({ threadId: 'chat', limit: 200, knownRevision: 1 })).kind).toBe(
        'projection'
      )
      const remote = (await service.query({
        method: 'open',
        chatId: 'chat',
        mode: 'remote',
        projectionOptions: JSON.stringify({ includeViewport: true })
      })) as ThreadCatalogueOpenResult
      try {
        const rows = (await service.query({
          method: 'objects',
          leaseId: remote.leaseId,
          kind: 'remote',
          maxObjects: 1
        })) as Array<{
          kind: string
          value: { taskCard: { threadId: string }; threadSnapshot?: unknown }
        }>
        expect(rows[0]).toMatchObject({ kind: 'inline', value: { taskCard: { threadId: 'chat' } } })
        expect(rows[0].value.threadSnapshot).toBeTruthy()
      } finally {
        await service.query({ method: 'release', leaseId: remote.leaseId })
      }
    } finally {
      await mirror.dispose()
      await service.dispose()
    }
  }, 30_000)

  it('pages exact introspection evidence without sending the corpus to its consumer', async () => {
    const profilePath = join(directory, 'introspection-profile')
    fs.mkdirSync(join(profilePath, 'chats'), { recursive: true })
    const chat: ChatRecord = {
      appChatId: 'chat',
      title: 'Evidence',
      archived: false,
      provider: 'claude',
      scope: 'workspace',
      workspaceId: 'workspace',
      createdAt: 1,
      updatedAt: 2,
      persistenceRevision: 1,
      messages: Array.from({ length: 310 }, (_, i) => ({
        id: `m-${i}`,
        role: i % 2 ? 'user' : 'assistant',
        content:
          i % 2
            ? 'No, always use the repository convention and remember to update the skill.'
            : 'Assistant predecessor',
        timestamp: i === 0 ? '2026-08-31T23:59:59Z' : '2026-09-01T00:00:00Z'
      })),
      runs: []
    }
    for (const value of [
      chat,
      { ...chat, appChatId: 'archived', archived: true },
      { ...chat, appChatId: 'other', workspaceId: 'other' }
    ])
      fs.writeFileSync(join(profilePath, 'chats', `${value.appChatId}.json`), JSON.stringify(value))
    const service = new ThreadCatalogueWorkerService({
      reader: { profilePath, runtimeInstanceId: 'evidence', segmented: false },
      decoderPath,
      writer: 'desktop',
      writerId: 'evidence',
      writerLifecycle: () => 'active'
    })
    let queries = 0
    const mirror = new ThreadCatalogueMirror({
      query: async <T>(query: ThreadCatalogueQuery) => {
        expect(query.method).toBe('introspection')
        queries += 1
        return (await service.query(query)) as T
      }
    })
    try {
      await service.refreshInventory()
      await Promise.all(
        ['chat', 'archived', 'other'].map((id) => service.ensureIndexed(id, 'metadata'))
      )
      const window = {
        windowStart: '2026-09-01T00:00:00Z',
        windowEnd: '2026-09-02T00:00:00Z',
        workspaceId: 'workspace'
      }
      const evidence = await catalogueIntrospectionEvidence(mirror, window)
      const expected = harvestIntrospectionEvidence({ window, substrate: { chats: [chat] } })
      const withoutIds = (items: typeof evidence) => items.map(({ id: _id, ...item }) => item)
      expect(withoutIds(evidence)).toEqual(withoutIds(expected))
      expect(evidence.length).toBeGreaterThan(100)
      expect(queries).toBeGreaterThan(1)
    } finally {
      await service.dispose()
    }
  }, 30_000)

  it('keeps fallback history readable while withholding recovery and negative proofs', async () => {
    const profilePath = join(directory, 'fallback-profile')
    fs.mkdirSync(join(profilePath, 'chats'), { recursive: true })
    fs.mkdirSync(join(profilePath, 'chat-journal-v2'), { recursive: true })
    fs.writeFileSync(
      join(profilePath, 'chats', 'chat.json'),
      JSON.stringify({
        appChatId: 'chat',
        title: 'Fallback',
        provider: 'claude',
        scope: 'global',
        createdAt: 1,
        updatedAt: 2,
        persistenceRevision: 1,
        messages: [
          { id: 'm', role: 'user', content: 'Retained source', timestamp: '2026-01-01T00:00:00Z' }
        ],
        runs: []
      })
    )
    fs.writeFileSync(
      join(profilePath, 'chat-journal-v2', 'chat.checkpoint.json'),
      '{"revision":2,"record":'
    )
    const service = new ThreadCatalogueWorkerService({
      reader: { profilePath, runtimeInstanceId: 'fallback', segmented: false },
      decoderPath,
      writer: 'desktop',
      writerId: 'fallback',
      writerLifecycle: () => 'active'
    })
    try {
      await service.refreshInventory()
      const opened = (await service.query({
        method: 'open',
        chatId: 'chat',
        mode: 'pages'
      })) as ThreadCatalogueOpenResult
      expect(opened.entry.projection.sourceComplete).toBe(false)
      expect(service.database.list().entries[0].projection.summary.title).toBe('Fallback')
      expect(
        (
          (await service.query({
            method: 'objects',
            leaseId: opened.leaseId,
            kind: 'message'
          })) as Array<{ value: unknown }>
        )[0].value
      ).toMatchObject({ content: 'Retained source' })
      await expect(
        service.query({ method: 'objects', leaseId: opened.leaseId, kind: 'recovery' })
      ).rejects.toThrow()
      await expect(service.query({ method: 'run', runId: 'unknown' })).rejects.toThrow('incomplete')
      expect(await service.query({ method: 'known-run', runId: 'unknown' })).toBeNull()
      await service.query({ method: 'release', leaseId: opened.leaseId })
    } finally {
      await service.dispose()
    }
  }, 30_000)

  it('prepares recovery off main, fences admission, and rejects adoption after cancellation', async () => {
    const profilePath = join(directory, 'recovery-profile')
    fs.mkdirSync(join(profilePath, 'chats'), { recursive: true })
    fs.writeFileSync(
      join(profilePath, 'chats', 'chat.json'),
      JSON.stringify({
        appChatId: 'chat',
        title: 'Chat',
        provider: 'claude',
        scope: 'global',
        createdAt: 1,
        updatedAt: 2,
        persistenceRevision: 1,
        messages: [],
        runs: [
          {
            runId: 'run',
            provider: 'claude',
            status: 'running',
            startedAt: '2026-01-01T00:00:00.000Z'
          }
        ]
      })
    )
    const reader = { profilePath, runtimeInstanceId: 'owner', segmented: false }
    const service = new ThreadCatalogueWorkerService({
      reader,
      decoderPath,
      writer: 'desktop',
      writerId: 'owner',
      writerLifecycle: () => 'active',
      assertSourceAuthority: () => {}
    })
    const publisher = new ThreadCatalogueSourcePublisher({
      profilePath,
      writer: 'desktop',
      writerId: 'owner',
      segmented: false,
      canWrite: () => true,
      canManageRecoveryHolds: () => true
    })
    const controller = new ThreadCatalogueRecoveryController({
      reader,
      client: {
        query: async <T>(query: ThreadCatalogueQuery) => (await service.query(query)) as T
      },
      publisher,
      incarnation: 'owner',
      assertAuthority: () => {},
      hasLiveWork: () => false
    })
    try {
      const opened = (await service.query({
        method: 'open',
        chatId: 'chat',
        mode: 'metadata'
      })) as ThreadCatalogueOpenResult
      const hold = controller.begin('chat', 'owner')
      expect(() => publisher.begin('chat')).toThrow()
      const prepared = (await service.query({
        method: 'prepare',
        chatId: 'chat',
        recoveryToken: hold.token,
        sourceWitness: opened.entry.sourceWitness,
        mutation: {
          kind: 'settle-runs',
          nowIso: '2026-09-08T12:00:00.000Z',
          minAgeMs: 0,
          runs: [{ runId: 'run' }]
        }
      })) as PreparedThreadMutation
      expect(prepared).not.toBeNull()
      controller.end('chat', hold.token)
      await expect(controller.adopt('chat', hold.token, prepared.preparedId)).rejects.toThrow()
      expect(
        JSON.parse(fs.readFileSync(join(profilePath, 'chats', 'chat.json'), 'utf8')).runs[0].status
      ).toBe('running')
      const nextHold = controller.begin('chat', 'owner')
      const next = (await service.query({
        method: 'prepare',
        chatId: 'chat',
        recoveryToken: nextHold.token,
        sourceWitness: opened.entry.sourceWitness,
        mutation: {
          kind: 'settle-runs',
          nowIso: '2026-09-08T12:00:00.000Z',
          minAgeMs: 0,
          runs: [{ runId: 'run' }]
        }
      })) as PreparedThreadMutation
      await controller.adopt('chat', nextHold.token, next.preparedId)
      controller.end('chat', nextHold.token)
      const saved = JSON.parse(fs.readFileSync(join(profilePath, 'chats', 'chat.json'), 'utf8'))
      expect(saved.persistenceRevision).toBe(2)
      expect(saved.runs[0].status).toBe('failed')
      expect(saved.messages).toHaveLength(1)
    } finally {
      controller.dispose()
      await service.dispose()
    }
  }, 30_000)

  it('recovers a prior standalone Host incarnation off main and retains an explanation', async () => {
    const profilePath = join(directory, 'host-restart')
    fs.mkdirSync(join(profilePath, 'chats'), { recursive: true })
    const file = join(profilePath, 'chats', 'chat.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        appChatId: 'chat',
        title: 'Chat',
        provider: 'muse',
        scope: 'global',
        createdAt: 1,
        updatedAt: 2,
        persistenceRevision: 1,
        messages: [],
        runs: [
          {
            runId: 'host-run',
            provider: 'muse',
            status: 'running',
            startedAt: '2026-01-01T00:00:00.000Z',
            hostRunOrigin: {
              schemaVersion: 1,
              kind: 'host-node',
              hostId: 'host',
              incarnation: 'old'
            }
          }
        ]
      })
    )
    const reader = { profilePath, runtimeInstanceId: 'new', segmented: false }
    const service = new ThreadCatalogueWorkerService({
      reader,
      decoderPath,
      writer: 'host',
      writerId: 'new',
      writerLifecycle: () => 'active',
      assertSourceAuthority: () => {}
    })
    const client = { query: async <T>(q: ThreadCatalogueQuery) => (await service.query(q)) as T }
    const publisher = new HostPublisher({
      profilePath,
      writer: 'host',
      writerId: 'new',
      segmented: false,
      canWrite: () => true,
      canManageRecoveryHolds: () => true
    })
    const controller = new ThreadCatalogueRecoveryController({
      reader,
      client,
      publisher,
      incarnation: 'new',
      assertAuthority: () => {},
      hasLiveWork: () => false
    })
    const mirror = new ThreadCatalogueMirror(client)
    let recovery: ThreadCatalogueHostRecovery | undefined
    try {
      await service.refreshInventory()
      await service.ensureIndexed('chat', 'metadata')
      await mirror.refresh()
      recovery = new ThreadCatalogueHostRecovery({
        client,
        mirror,
        controller,
        origin: { schemaVersion: 1, kind: 'host-node', hostId: 'host', incarnation: 'new' }
      })
      const deadline = Date.now() + 5000
      let saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      while (saved.runs[0].status === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      }
      expect(saved.runs[0].status).toBe('failed')
      expect(saved.messages).toHaveLength(1)
      expect(saved.messages[0].content).toContain('Interrupted')
    } finally {
      recovery?.dispose()
      controller.dispose()
      await mirror.dispose()
      await service.dispose()
    }
  }, 15_000)
})
