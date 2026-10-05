import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ThreadCatalogueWorkerService } from './ThreadCatalogueWorkerService'

vi.setConfig({ testTimeout: process.env.CI ? 120_000 : 30_000 })

describe('worker erasure resume', () => {
  let directory: string
  let decoderPath: string
  beforeAll(async () => {
    directory = fs.mkdtempSync(join(tmpdir(), 'thread-worker-reestablish-'))
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
  afterAll(() =>
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  )

  function profile(name: string, chatIds: string[]): string {
    const profilePath = join(directory, name)
    fs.mkdirSync(join(profilePath, 'chats'), { recursive: true })
    for (const chatId of chatIds) {
      fs.writeFileSync(
        join(profilePath, 'chats', `${chatId}.json`),
        JSON.stringify({
          appChatId: chatId,
          title: chatId,
          scope: 'global',
          chatKind: 'single',
          provider: 'claude',
          createdAt: 1,
          updatedAt: 2,
          persistenceRevision: 1,
          messages: [],
          runs: []
        })
      )
    }
    return profilePath
  }

  const serviceFor = (profilePath: string) =>
    new ThreadCatalogueWorkerService({
      reader: { profilePath, runtimeInstanceId: 'runtime', segmented: false },
      decoderPath,
      writer: 'desktop',
      writerId: 'owner',
      writerLifecycle: () => 'active',
      assertSourceAuthority: () => {}
    })

  it('a restarted worker resumes the recorded fence and purges what the first run left', async () => {
    const profilePath = profile('resume', ['chat'])
    const first = serviceFor(profilePath)
    const generation = (await first.query({ method: 'erase', chatId: 'chat' })) as string
    await first.dispose()

    const prepared = join(profilePath, 'thread-catalogue-v1', 'prepared', 'chat')
    fs.mkdirSync(prepared, { recursive: true })
    fs.writeFileSync(join(prepared, 'stranded.record.json'), 'PRIVATE_ERASURE_SENTINEL')

    const second = serviceFor(profilePath)
    try {
      const resumed = await second.query({
        method: 'reestablish-erasure',
        chatId: 'chat',
        generation
      })

      expect(resumed).toBe(generation)
      expect(fs.existsSync(prepared)).toBe(false)
      expect(await second.query({ method: 'finish-erasure', chatId: 'chat', generation })).toBe(
        true
      )
    } finally {
      await second.dispose()
    }
  })

  it('refuses to resume under a generation the fence was not minted with', async () => {
    const profilePath = profile('mismatch', ['chat'])
    const service = serviceFor(profilePath)
    try {
      const generation = (await service.query({ method: 'erase', chatId: 'chat' })) as string

      await expect(
        service.query({ method: 'reestablish-erasure', chatId: 'chat', generation: 'other' })
      ).rejects.toThrow(/generation mismatch/)

      expect(await service.query({ method: 'finish-erasure', chatId: 'chat', generation })).toBe(
        true
      )
    } finally {
      await service.dispose()
    }
  })

  it('re-fences a scope whose fence was already lifted, under a new generation', async () => {
    const profilePath = profile('relift', ['chat'])
    const service = serviceFor(profilePath)
    try {
      const first = (await service.query({ method: 'erase', chatId: 'chat' })) as string
      expect(
        await service.query({ method: 'finish-erasure', chatId: 'chat', generation: first })
      ).toBe(true)

      const second = (await service.query({
        method: 'reestablish-erasure',
        chatId: 'chat',
        generation: first
      })) as string

      expect(second).not.toBe(first)
      // The lifted generation can no longer lift the new fence.
      expect(
        await service.query({ method: 'finish-erasure', chatId: 'chat', generation: first })
      ).toBe(false)
      expect(
        await service.query({ method: 'finish-erasure', chatId: 'chat', generation: second })
      ).toBe(true)
    } finally {
      await service.dispose()
    }
  })

  it('fences several chats before any finishes and indexes again once the last one lifts', async () => {
    const profilePath = profile('several', ['chat-a', 'chat-b'])
    const service = serviceFor(profilePath)
    try {
      const a = (await service.query({ method: 'erase', chatId: 'chat-a' })) as string
      const b = (await service.query({ method: 'erase', chatId: 'chat-b' })) as string

      expect(
        await service.query({ method: 'finish-erasure', chatId: 'chat-a', generation: a })
      ).toBe(true)
      // chat-b is still fenced, so it cannot be indexed yet.
      await expect(service.ensureIndexed('chat-b', 'metadata')).rejects.toThrow()

      expect(
        await service.query({ method: 'finish-erasure', chatId: 'chat-b', generation: b })
      ).toBe(true)
      expect((await service.ensureIndexed('chat-a', 'metadata'))?.generation).toBeTruthy()
      expect((await service.ensureIndexed('chat-b', 'metadata'))?.generation).toBeTruthy()
    } finally {
      await service.dispose()
    }
  })
})
