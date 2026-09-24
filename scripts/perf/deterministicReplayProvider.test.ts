import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  PROVIDER_TURN_SHAPE_DEFAULTS,
  generateProviderTurnScript,
  runProviderTurnReplay,
  runDryRun
} = require('./deterministicReplayProvider.cjs')
const { TOOL_NAMES } = require('./fixtureGenerator.cjs')

function scriptInput(overrides: Record<string, unknown> = {}) {
  return {
    seed: 7,
    chatId: 'chat-light',
    turnIndex: 0,
    providerId: 'codex',
    ...overrides
  }
}

function replayInput(overrides: Record<string, unknown> = {}) {
  return {
    api: fakeApi(),
    chatId: 'chat-light',
    providerId: 'codex',
    seed: 7,
    turns: 1,
    ...overrides
  }
}

/** In-memory PageApiAdapter with real revision tracking. */
function fakeApi(behavior: Record<string, unknown> = {}) {
  const revisions = new Map<string, number>([['chat-light', 10]])
  const calls: Array<{ op: string; revision: number | null }> = []
  return {
    calls,
    async getChat(chatId: string) {
      if (behavior.getChatNull) return null
      const revision = revisions.get(chatId) ?? 1
      return { appChatId: chatId, persistenceRevision: revision, messages: [] }
    },
    async saveChat(chat: { appChatId: string; persistenceRevision: number }) {
      if (behavior.hang) return new Promise(() => {}) as never
      if (behavior.throwSave) throw new Error('store exploded — must not leak')
      calls.push({ op: 'save', revision: chat.persistenceRevision })
      const next = (revisions.get(chat.appChatId) ?? 0) + 1
      revisions.set(chat.appChatId, next)
      if (behavior.staleAck) return { persistenceRevision: chat.persistenceRevision }
      if (behavior.nullAck) return null
      return { persistenceRevision: next, updatedAt: 1 }
    }
  }
}

function clock(readings: number[]) {
  let index = 0
  return () => readings[Math.min(index++, readings.length - 1)]
}

describe('provider turn scripts (P1)', () => {
  it('generates identical scripts and fingerprints for identical inputs', () => {
    const first = generateProviderTurnScript(scriptInput())
    const second = generateProviderTurnScript(scriptInput())
    expect(second).toEqual(first)
    expect(first.scriptFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('varies the script with seed, chat, turn, and provider', () => {
    const base = generateProviderTurnScript(scriptInput()).scriptFingerprint
    for (const overrides of [
      { seed: 8 },
      { chatId: 'chat-heavy' },
      { turnIndex: 1 },
      { providerId: 'cursor' }
    ]) {
      expect(generateProviderTurnScript(scriptInput(overrides)).scriptFingerprint).not.toBe(base)
    }
  })

  it('shapes turns exactly per the profile with auditable byte totals', () => {
    const script = generateProviderTurnScript(
      scriptInput({ shape: { chunksPerTurn: 3, chunkBytes: 100, toolCallsPerTurn: 2 } })
    )
    expect(script.chunks).toHaveLength(3)
    expect(script.chunks.every((chunk: { bytes: number }) => chunk.bytes === 100)).toBe(true)
    expect(script.toolCalls).toHaveLength(2)
    expect(
      script.toolCalls.every((call: { toolName: string }) =>
        (TOOL_NAMES as string[]).includes(call.toolName)
      )
    ).toBe(true)
    expect(script.runId).toBe('chat-light-replay-run-0')
    expect(script.messageId).toBe('chat-light-replay-turn-0')
    // Default profile is documented load constants, present and positive.
    expect(PROVIDER_TURN_SHAPE_DEFAULTS.chunksPerTurn).toBeGreaterThan(0)
    expect(PROVIDER_TURN_SHAPE_DEFAULTS.chunkBytes).toBeGreaterThan(0)
  })

  it('uses scripted timestamps, never the wall clock', () => {
    const first = generateProviderTurnScript(scriptInput())
    const second = generateProviderTurnScript(scriptInput())
    expect(second.timestamps).toEqual(first.timestamps)
    expect(first.timestamps.length).toBeGreaterThan(0)
  })

  it('refuses malformed script inputs instead of generating a misleading script', () => {
    expect(() => generateProviderTurnScript(null)).toThrow(/options required/)
    expect(() => generateProviderTurnScript(scriptInput({ seed: '7' }))).toThrow(/seed/)
    expect(() => generateProviderTurnScript(scriptInput({ chatId: '' }))).toThrow(/chatId/)
    expect(() => generateProviderTurnScript(scriptInput({ turnIndex: -1 }))).toThrow(/turnIndex/)
    expect(() => generateProviderTurnScript(scriptInput({ providerId: '' }))).toThrow(/providerId/)
    expect(() => generateProviderTurnScript(scriptInput({ shape: { chunksPerTurn: 0 } }))).toThrow(
      /chunksPerTurn/
    )
  })
})

describe('provider turn replay (P1)', () => {
  it('applies scripted parts in order with measured latencies and advancing revisions', async () => {
    const api = fakeApi()
    const nowMs = clock([1000, 1010, 1020, 1030, 1060, 1100])
    const result = await runProviderTurnReplay(
      replayInput({
        api,
        nowMs,
        shape: { chunksPerTurn: 2, chunkBytes: 10, toolCallsPerTurn: 0 }
      })
    )
    expect(result.ok).toBe(true)
    expect(result.status).toBe('complete')
    expect(result.replay).toBe(true)
    expect(result.turns).toHaveLength(1)
    expect(result.turns[0].parts.map((part: { kind: string }) => part.kind)).toEqual([
      'provider_chunk',
      'provider_chunk'
    ])
    expect(result.turns[0].parts[0].latencyMs).toBe(10)
    expect(result.turns[0].parts[1].latencyMs).toBe(30)
    expect(result.latencies).toMatchObject({ count: 2, p50: 10, p95: 30, p99: 30 })
    // CAS: first save sends the observed revision, the second the advanced one.
    expect(api.calls.map((call: { revision: number }) => call.revision)).toEqual([10, 11])
    expect(result.scriptFingerprints).toHaveLength(1)
  })

  it('fails closed on a non-advancing ack and continues later parts', async () => {
    const result = await runProviderTurnReplay(
      replayInput({
        api: fakeApi({ staleAck: true }),
        nowMs: clock([0, 1, 2, 3, 4, 5, 6]),
        shape: { chunksPerTurn: 2, chunkBytes: 10, toolCallsPerTurn: 0 }
      })
    )
    expect(result.turns[0].parts.map((part: { outcome: string }) => part.outcome)).toEqual([
      'failed',
      'failed'
    ])
    expect(result.turns[0].parts[0].reason).toBe('save_rejected')
    expect(result.status).toBe('failed')
    expect(result.ok).toBe(false)
  })

  it('skips the advance assertion for degraded adapters without a revision ack', async () => {
    const result = await runProviderTurnReplay(
      replayInput({
        api: fakeApi({ nullAck: true }),
        nowMs: clock([0, 1, 2, 3]),
        shape: { chunksPerTurn: 1, chunkBytes: 10, toolCallsPerTurn: 0 }
      })
    )
    expect(result.turns[0].parts[0].outcome).toBe('completed')
    expect(result.status).toBe('complete')
  })

  it('reports a missing chat as unsupported without attempting saves', async () => {
    const api = fakeApi({ getChatNull: true })
    const result = await runProviderTurnReplay(replayInput({ api }))
    expect(result.turns[0].outcome).toBe('unsupported')
    expect(result.status).toBe('unsupported')
    expect(api.calls).toHaveLength(0)
  })

  it('contains adapter throws without leaking exception text', async () => {
    const result = await runProviderTurnReplay(
      replayInput({
        api: fakeApi({ throwSave: true }),
        nowMs: clock([0, 1, 2, 3]),
        shape: { chunksPerTurn: 1, chunkBytes: 10, toolCallsPerTurn: 0 }
      })
    )
    expect(result.turns[0].parts[0].outcome).toBe('failed')
    expect(result.turns[0].parts[0].reason).toBe('save_failed')
    expect(JSON.stringify(result)).not.toContain('store exploded')
  })

  it('times out a hung save, reports the pending effect, and stops', async () => {
    const result = await runProviderTurnReplay(
      replayInput({
        api: fakeApi({ hang: true }),
        turns: 2,
        partTimeoutMs: 15,
        shape: { chunksPerTurn: 1, chunkBytes: 10, toolCallsPerTurn: 0 }
      })
    )
    expect(result.turns[0].parts[0].outcome).toBe('failed')
    expect(result.turns[0].parts[0].reason).toBe('part_timeout')
    expect(result.turns[0].parts[0].pendingSave).toBe(true)
    expect(result.turns[1].outcome).toBe('not_attempted')
    expect(result.pendingSaves).toHaveLength(1)
    expect(result.status).toBe('failed')
    expect(result.reason).toBe('part_timeout')
  })

  it('censors the remainder when the deadline passes between turns', async () => {
    const nowMs = clock([0, 10, 20, 5000, 5000, 5000, 5000])
    const result = await runProviderTurnReplay(
      replayInput({
        api: fakeApi(),
        turns: 2,
        deadlineMs: 100,
        nowMs,
        shape: { chunksPerTurn: 1, chunkBytes: 10, toolCallsPerTurn: 0 }
      })
    )
    expect(result.turns.map((turn: { outcome: string }) => turn.outcome)).toEqual([
      'completed',
      'not_attempted'
    ])
    expect(result.status).toBe('censored')
    expect(result.reason).toBe('deadline')
  })

  it('fails the run when the clock regresses', async () => {
    const result = await runProviderTurnReplay(
      replayInput({ api: fakeApi(), nowMs: clock([100, 90, 90, 90]) })
    )
    expect(result.status).toBe('failed')
    expect(result.reason).toBe('clock_invalid')
  })

  it('refuses a second concurrent run over the same chat, then releases it', async () => {
    let release!: () => void
    const gate = new Promise((resolve) => {
      release = () => resolve({ persistenceRevision: 11, updatedAt: 1 })
    })
    const api = {
      async getChat(chatId: string) {
        return { appChatId: chatId, persistenceRevision: 10, messages: [] }
      },
      issueSave: () => gate,
      async saveChat() {
        return gate
      }
    }
    const first = runProviderTurnReplay(
      replayInput({
        api,
        nowMs: clock([0, 1, 2, 3, 4, 5]),
        shape: { chunksPerTurn: 1, chunkBytes: 10, toolCallsPerTurn: 0 }
      })
    )
    await expect(runProviderTurnReplay(replayInput({ api }))).rejects.toThrow(/still owned/)
    release()
    await expect(first).resolves.toMatchObject({ status: 'complete' })
    await expect(runProviderTurnReplay(replayInput({}))).resolves.toMatchObject({
      status: 'complete'
    })
  })

  it('refuses malformed options instead of running a misleading replay', async () => {
    await expect(runProviderTurnReplay(null)).rejects.toThrow(/options required/)
    await expect(runProviderTurnReplay(replayInput({ api: {} }))).rejects.toThrow(/api/)
    await expect(runProviderTurnReplay(replayInput({ chatId: '' }))).rejects.toThrow(/chatId/)
    await expect(runProviderTurnReplay(replayInput({ providerId: '' }))).rejects.toThrow(
      /providerId/
    )
    await expect(runProviderTurnReplay(replayInput({ seed: 1.5 }))).rejects.toThrow(/seed/)
    await expect(runProviderTurnReplay(replayInput({ turns: 0 }))).rejects.toThrow(/turns/)
    await expect(runProviderTurnReplay(replayInput({ partTimeoutMs: 0 }))).rejects.toThrow(
      /partTimeoutMs/
    )
    await expect(runProviderTurnReplay(replayInput({ deadlineMs: -5 }))).rejects.toThrow(
      /deadlineMs/
    )
  })

  it('marks a clean diagnostic run without qualifying it', async () => {
    const result = await runProviderTurnReplay(
      replayInput({ api: fakeApi(), diagnosticOnly: true, nowMs: clock([0, 5, 10, 15, 20]) })
    )
    expect(result.status).toBe('diagnostic')
    expect(result.ok).toBe(false)
    expect(result.replay).toBe(true)
  })

  it('dry-run proves the driver with a fake adapter and scripted turns', async () => {
    const result = await runDryRun()
    expect(result.turns.length).toBeGreaterThanOrEqual(2)
    expect(result.turns.every((turn: { outcome: string }) => turn.outcome === 'completed')).toBe(
      true
    )
    expect(result.status).toBe('diagnostic')
    expect(result.replay).toBe(true)
  })
})
