import { describe, expect, it } from 'vitest'
import { PerChatSaveIntentQueue as SharedQueue } from '../../../shared/chatSaveIntentQueue'
import { PerChatSaveIntentQueue } from './chatSaveIntentQueue'

describe('renderer chatSaveIntentQueue path', () => {
  it('re-exports the shared implementation instead of forking it', () => {
    expect(PerChatSaveIntentQueue).toBe(SharedQueue)
  })
})
