import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { needsDispatchHistoryHydration } from './dispatchHistoryHydration'

function shell(patch: Partial<ChatRecord> & { catalogueProjection?: boolean } = {}): ChatRecord {
  return {
    appChatId: 'ensemble-a',
    chatKind: 'ensemble',
    workflowMode: 'normal',
    summaryOnly: true,
    transcriptPaged: true,
    ensemble: { participants: [{ id: 'seat-a', provider: 'codex' }] },
    messages: [],
    runs: [],
    ...patch
  } as ChatRecord
}

describe('needsDispatchHistoryHydration', () => {
  it('dispatches from a complete Ensemble shell without reading transcript arrays', () => {
    const chat = shell()
    for (const key of ['messages', 'runs']) {
      Object.defineProperty(chat, key, {
        get: () => {
          throw new Error('Ensemble dispatch must not read history')
        }
      })
    }
    expect(needsDispatchHistoryHydration(chat, 'normal')).toBe(false)
    expect(needsDispatchHistoryHydration(chat, undefined)).toBe(false)
  })

  it('hydrates solo dispatch before it appends and persists transcript rows', () => {
    expect(needsDispatchHistoryHydration(shell({ chatKind: 'single' }), 'normal')).toBe(true)
  })

  it('hydrates a catalogue fallback whose preflight metadata may be incomplete', () => {
    expect(needsDispatchHistoryHydration(shell({ catalogueProjection: true }), 'normal')).toBe(true)
    expect(needsDispatchHistoryHydration(shell({ ensemble: undefined }), 'normal')).toBe(true)
  })

  it('hydrates when dispatch will persist a workflow-mode change', () => {
    expect(needsDispatchHistoryHydration(shell(), 'plan')).toBe(true)
    expect(needsDispatchHistoryHydration(shell({ workflowMode: undefined }), 'normal')).toBe(true)
  })

  it('keeps full records available and hydrates malformed projections', () => {
    const full = { ...shell(), summaryOnly: false, transcriptPaged: false }
    expect(needsDispatchHistoryHydration(full, 'normal')).toBe(false)
    expect(
      needsDispatchHistoryHydration(
        { ...full, messages: undefined } as unknown as ChatRecord,
        'normal'
      )
    ).toBe(true)
  })
})
