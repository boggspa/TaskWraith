import { describe, expect, it } from 'vitest'
import { hasNonGraphThreadTurn } from './ExecutionResultOwnerActivity'

describe('execution result owner activity', () => {
  const graph = { chatId: 'thread-one', executionGraph: { executionId: 'graph-one' } }
  const parent = { chatId: 'thread-one' }

  it('does not let a terminalizing graph row impersonate its parent turn', () => {
    expect(hasNonGraphThreadTurn([graph], 'thread-one')).toBe(false)
  })

  it('recognizes an ordinary parent await or continuation turn', () => {
    expect(hasNonGraphThreadTurn([parent], 'thread-one')).toBe(true)
    expect(hasNonGraphThreadTurn([graph, parent], 'thread-one')).toBe(true)
  })

  it('never crosses thread ownership', () => {
    expect(hasNonGraphThreadTurn([{ chatId: 'thread-two' }, graph], 'thread-one')).toBe(false)
  })
})
