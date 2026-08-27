import { describe, expect, it } from 'vitest'
import {
  BLACKBOARD_CHANGE_FRESH_WINDOW_MS,
  BLACKBOARD_CHANGE_KIND,
  isBlackboardChangePayload
} from './blackboardChange'

const attribution = {
  provider: 'ollama',
  displayProviderLabel: 'Alibaba',
  displayHueClass: 'alibaba',
  changedAt: '2026-08-27T12:40:00.000Z'
}

describe('Blackboard transcript change payload', () => {
  it('accepts updated, poll-opened, and cleaned mutations', () => {
    expect(
      isBlackboardChangePayload({
        ...attribution,
        action: 'updated',
        key: 'scout5-competitor-research',
        category: 'note',
        scope: 'session'
      })
    ).toBe(true)
    expect(
      isBlackboardChangePayload({
        ...attribution,
        action: 'pollOpened',
        key: 'ship-or-hold',
        category: 'decision',
        scope: 'round',
        optionCount: 3
      })
    ).toBe(true)
    expect(
      isBlackboardChangePayload({
        ...attribution,
        action: 'cleaned',
        removedCount: 2
      })
    ).toBe(true)
  })

  it('rejects malformed attribution and mutation details', () => {
    expect(isBlackboardChangePayload(null)).toBe(false)
    expect(
      isBlackboardChangePayload({
        ...attribution,
        displayHueClass: 'alibaba); color: red',
        action: 'updated',
        key: 'safe-key',
        category: 'note',
        scope: 'session'
      })
    ).toBe(false)
    expect(
      isBlackboardChangePayload({
        ...attribution,
        action: 'pollOpened',
        key: 'ship-or-hold',
        category: 'decision',
        scope: 'round',
        optionCount: 1
      })
    ).toBe(false)
    expect(
      isBlackboardChangePayload({
        ...attribution,
        action: 'pollOpened',
        key: 'ship-or-hold',
        category: 'decision',
        scope: 'round',
        optionCount: 7
      })
    ).toBe(false)
    expect(
      isBlackboardChangePayload({
        ...attribution,
        action: 'cleaned',
        removedCount: 0
      })
    ).toBe(false)
  })

  it('pins the durable kind and bounded fresh-animation window', () => {
    expect(BLACKBOARD_CHANGE_KIND).toBe('ensembleBlackboardChange')
    expect(BLACKBOARD_CHANGE_FRESH_WINDOW_MS).toBe(120_000)
  })
})
