import { describe, expect, it } from 'vitest'
import type { DiscordContextSelection } from '../../../main/channels/DiscordContextService'
import { resolveRunDiscordContextSelection } from './runDiscordContextSelection'

const test1Context: DiscordContextSelection = {
  guildId: 'guild-1',
  channelId: 'test-1-channel',
  channelName: 'Test 1',
  limit: 25
}

const test3Context: DiscordContextSelection = {
  guildId: 'guild-3',
  channelId: 'test-3-channel',
  channelName: 'Test 3',
  limit: 50
}

describe('run Discord context ownership', () => {
  it('dispatches a resting Test 3 pane with its own visible context, not focused Test 1 context', () => {
    expect(
      resolveRunDiscordContextSelection({
        selectedChatId: 'chat-test-3',
        currentComposerChatId: 'chat-test-1',
        currentSelection: test1Context,
        targetSelection: { value: test3Context }
      })
    ).toBe(test3Context)
  })

  it('does not leak focused Test 1 context into a context-free resting Test 3 pane', () => {
    expect(
      resolveRunDiscordContextSelection({
        selectedChatId: 'chat-test-3',
        currentComposerChatId: 'chat-test-1',
        currentSelection: test1Context,
        targetSelection: { value: null }
      })
    ).toBeUndefined()
  })

  it('preserves focused composer context when no chat-specific override was supplied', () => {
    expect(
      resolveRunDiscordContextSelection({
        selectedChatId: 'chat-test-1',
        currentComposerChatId: 'chat-test-1',
        currentSelection: test1Context
      })
    ).toBe(test1Context)
  })

  it('does not attach current UI context to reruns with an existing prompt', () => {
    expect(
      resolveRunDiscordContextSelection({
        existingPrompt: 'rerun this',
        selectedChatId: 'chat-test-3',
        currentComposerChatId: 'chat-test-1',
        currentSelection: test1Context,
        targetSelection: { value: test3Context }
      })
    ).toBeUndefined()
  })
})
