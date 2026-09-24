import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createKimiGatewayReadiness } from './KimiGatewayReadiness'
import { createKimiRunCapabilityReceipt } from './KimiRunCapabilities'
import {
  createKimiRunCapabilityCache,
  KIMI_CAPABILITY_HISTORY_BYTES,
  kimiRunCapabilityCache,
  readKimiRunCapabilityReceipt
} from './KimiRunCapabilityStore'

const receipt = (runId: string) =>
  createKimiRunCapabilityReceipt(
    { runId, chatId: 'chat', assignedScope: { kind: 'workspace', paths: [] } },
    createKimiGatewayReadiness().snapshot()
  )
const row = (value: ReturnType<typeof receipt>) =>
  JSON.stringify({
    runId: value.runId,
    chatId: value.chatId,
    provider: 'kimi',
    source: 'main',
    kind: 'lifecycle',
    sequence: 1,
    payload: { type: 'kimi_capability_receipt', capabilityReceipt: value }
  })

describe('Kimi capability receipt store', () => {
  it('bounds cache entries and age and returns independent exact-chat copies', () => {
    let now = 0
    const cache = createKimiRunCapabilityCache({ maxEntries: 2, maxAgeMs: 10, now: () => now })
    cache.put(receipt('one'))
    cache.put(receipt('two'))
    cache.put(receipt('three'))
    expect(cache.get('one', 'chat')).toBeNull()
    expect(cache.get('two', 'elsewhere')).toBeNull()
    cache.get('two', 'chat')!.blocker = 'modified copy'
    expect(cache.get('two', 'chat')!.blocker).toBeNull()
    now = 11
    expect(cache.get('two', 'chat')).toBeNull()
  })

  it('reads only a bounded asynchronous tail and reports older evidence as unavailable', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'kimi-capability-store-'))
    try {
      await fs.mkdir(join(root, 'run-events'))
      const id = randomUUID()
      const current = receipt(id)
      await fs.writeFile(
        join(root, 'run-events', `${id}.jsonl`),
        `${'x'.repeat(KIMI_CAPABILITY_HISTORY_BYTES + 100)}\n${row(current)}\n`
      )
      expect(
        await readKimiRunCapabilityReceipt({ userDataPath: root, runId: id, chatId: 'chat' })
      ).toEqual(current)
      expect(
        await readKimiRunCapabilityReceipt({ userDataPath: root, runId: id, chatId: 'other' })
      ).toBeNull()
      const oldId = randomUUID()
      await fs.writeFile(
        join(root, 'run-events', `${oldId}.jsonl`),
        `${row(receipt(oldId))}\n${'x'.repeat(KIMI_CAPABILITY_HISTORY_BYTES + 100)}\n`
      )
      expect(
        await readKimiRunCapabilityReceipt({ userDataPath: root, runId: oldId, chatId: 'chat' })
      ).toBeNull()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('never overwrites a live receipt that arrives during a durable lookup', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'kimi-capability-race-'))
    try {
      await fs.mkdir(join(root, 'run-events'))
      const id = randomUUID()
      const old = receipt(id)
      await fs.writeFile(join(root, 'run-events', `${id}.jsonl`), `${row(old)}\n`)
      const pending = readKimiRunCapabilityReceipt({
        userDataPath: root,
        runId: id,
        chatId: 'chat'
      })
      const current = {
        ...old,
        phase: 'blocked' as const,
        outcome: 'blocked' as const,
        blocker: 'current host evidence'
      }
      kimiRunCapabilityCache.put(current)
      expect(await pending).toEqual(current)
      expect(kimiRunCapabilityCache.get(id, 'chat')).toEqual(current)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('returns unknown on an I/O deadline without blocking main', async () => {
    vi.useFakeTimers()
    const stat = vi.spyOn(fs, 'lstat').mockImplementationOnce(() => new Promise<never>(() => {}))
    try {
      const pending = readKimiRunCapabilityReceipt({
        userDataPath: '/unused',
        runId: randomUUID(),
        chatId: 'chat'
      })
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(pending).resolves.toBeNull()
    } finally {
      stat.mockRestore()
      vi.useRealTimers()
    }
  })
})
