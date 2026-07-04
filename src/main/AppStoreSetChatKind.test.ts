import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from './store'
import type { ChatRecord, EnsembleParticipant } from './store/types'

const userDataPath = vi.hoisted(() => {
  const tmpRoot =
    process.platform === 'win32' && /^[A-Za-z]:/.test(process.cwd())
      ? `${process.cwd().slice(0, 2)}/tmp`
      : '/tmp'
  return `${tmpRoot}/taskwraith-set-chat-kind-test-${process.pid}`
})

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

function seedParticipant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'seed-1',
    provider: 'codex',
    enabled: true,
    role: 'Primary',
    instructions: '',
    order: 0,
    model: 'gpt-5-codex',
    ...overrides
  }
}

describe('AppStore.setChatKind (Slice C — mid-thread ensemble toggle)', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
  })

  it('converts solo→ensemble in place, seeding EXACTLY one participant and preserving history', () => {
    const solo = AppStore.createGlobalChat()
    AppStore.saveChat({
      ...solo,
      provider: 'codex',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Keep this in the transcript.',
          timestamp: '2026-07-04T00:00:00.000Z'
        }
      ],
      runs: [
        {
          runId: 'run-1',
          provider: 'codex',
          startedAt: '2026-07-04T00:00:00.000Z',
          endedAt: '2026-07-04T00:00:01.000Z',
          status: 'success'
        }
      ]
    } as ChatRecord)

    const converted = AppStore.setChatKind(solo.appChatId, 'ensemble', {
      seedParticipant: seedParticipant()
    })

    // In place: same record id.
    expect(converted.appChatId).toBe(solo.appChatId)
    expect(converted.chatKind).toBe('ensemble')
    // The normalizeChatRecord 6-provider auto-fill landmine must NOT fire.
    expect(converted.ensemble?.participants).toHaveLength(1)
    expect(converted.ensemble?.participants[0]?.id).toBe('seed-1')
    expect(converted.ensemble?.participants[0]?.provider).toBe('codex')
    // History preserved.
    expect(converted.messages).toHaveLength(1)
    expect(converted.runs).toHaveLength(1)

    // Persisted, not just returned.
    const reloaded = AppStore.getChat(solo.appChatId)
    expect(reloaded?.chatKind).toBe('ensemble')
    expect(reloaded?.ensemble?.participants).toHaveLength(1)
    expect(reloaded?.messages).toHaveLength(1)
  })

  it('converts ensemble→solo in place, stripping the ensemble block and setting the canonical provider', () => {
    const ensemble = AppStore.createEnsembleChat()
    AppStore.saveChat({
      ...ensemble,
      provider: 'gemini',
      messages: [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Ensemble history stays.',
          timestamp: '2026-07-04T00:00:00.000Z'
        }
      ]
    } as ChatRecord)

    const converted = AppStore.setChatKind(ensemble.appChatId, 'single', {
      canonicalProvider: 'codex'
    })

    expect(converted.appChatId).toBe(ensemble.appChatId)
    expect(converted.chatKind).toBe('single')
    expect(converted.ensemble).toBeUndefined()
    expect(converted.provider).toBe('codex')
    expect(converted.messages).toHaveLength(1)

    const reloaded = AppStore.getChat(ensemble.appChatId)
    expect(reloaded?.chatKind).toBe('single')
    expect(reloaded?.ensemble).toBeUndefined()
    expect(reloaded?.provider).toBe('codex')
    expect(reloaded?.messages).toHaveLength(1)
  })

  it('is a no-op when the target kind already matches', () => {
    const solo = AppStore.createGlobalChat()
    const result = AppStore.setChatKind(solo.appChatId, 'single')
    expect(result.appChatId).toBe(solo.appChatId)
    expect(result.chatKind).not.toBe('ensemble')
  })

  it('rejects solo→ensemble without a seed participant', () => {
    const solo = AppStore.createGlobalChat()
    expect(() => AppStore.setChatKind(solo.appChatId, 'ensemble')).toThrow(/seed participant/)
  })

  it('rejects a conversion while a run is still running (idle-only guard)', () => {
    const solo = AppStore.createGlobalChat()
    AppStore.saveChat({
      ...solo,
      provider: 'codex',
      runs: [
        {
          runId: 'run-live',
          provider: 'codex',
          startedAt: '2026-07-04T00:00:00.000Z',
          status: 'running'
        }
      ]
    } as ChatRecord)

    expect(() =>
      AppStore.setChatKind(solo.appChatId, 'ensemble', { seedParticipant: seedParticipant() })
    ).toThrow(/turn is active/)

    // Unchanged.
    expect(AppStore.getChat(solo.appChatId)?.chatKind).not.toBe('ensemble')
  })

  it('rejects a conversion while an ensemble round dispatch is live', () => {
    const ensemble = AppStore.createEnsembleChat()
    AppStore.saveChat({
      ...ensemble,
      ensemble: {
        ...ensemble.ensemble!,
        activeRound: {
          status: 'running',
          participants: [{ participantId: 'p1', status: 'running' }]
        }
      }
    } as ChatRecord)

    expect(() =>
      AppStore.setChatKind(ensemble.appChatId, 'single', { canonicalProvider: 'codex' })
    ).toThrow(/turn is active/)

    expect(AppStore.getChat(ensemble.appChatId)?.chatKind).toBe('ensemble')
  })

  it('throws when the chat does not exist', () => {
    expect(() =>
      AppStore.setChatKind('missing-chat', 'ensemble', { seedParticipant: seedParticipant() })
    ).toThrow(/not found/)
  })
})
