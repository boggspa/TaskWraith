import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

function sourceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('goal persist adoption (renderer half)', () => {
  const persist = sourceBetween(
    appSource,
    'const persistGoalForCurrentChat = ',
    'const setGoalFromObjective = '
  )

  it('authors the save from the ref cache, not lagging React state', () => {
    expect(persist).toContain('chatByIdRef.current.get(stateChat.appChatId)')
    expect(persist).not.toContain('const chat = currentChat')
  })

  it('adopts the returned canonical record, then releases the intent', () => {
    const save = persist.indexOf('.saveChat(updated)')
    const adopt = persist.indexOf('.then((canonical)')
    const cache = persist.indexOf('chatByIdRef.current.set(chatId, canonical)', adopt)
    const flush = persist.indexOf('flushCoalescedChatsNow()', cache)
    const release = persist.indexOf('intents.delete(chatId)', flush)
    expect(save).toBeGreaterThanOrEqual(0)
    expect(adopt).toBeGreaterThan(save)
    expect(cache).toBeGreaterThan(adopt)
    expect(flush).toBeGreaterThan(cache)
    expect(release).toBeGreaterThan(flush)
  })

  it('never releases the intent on bare settle', () => {
    expect(persist).not.toContain('.finally(')
  })

  it('rolls a failed save back to the pre-edit base instead of sticking the claim', () => {
    const guard = persist.indexOf('chatByIdRef.current.get(chatId) === updated')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(persist.indexOf('chatByIdRef.current.set(chatId, chat)', guard)).toBeGreaterThan(guard)
  })
})
