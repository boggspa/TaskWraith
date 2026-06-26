import { describe, expect, it } from 'vitest'
import {
  KEY_COMMAND_DEFINITIONS,
  KEY_COMMAND_GROUPS,
  findKeyCommandConflict,
  formatKeyCommandBinding,
  getKeyCommandForEvent,
  resolveKeyCommandBindings
} from './keyCommands'

function keyEvent(input: {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}): KeyboardEvent {
  return input as KeyboardEvent
}

describe('key command bindings', () => {
  it('resolves defaults and matches the slash commands shortcut', () => {
    const bindings = resolveKeyCommandBindings({})

    expect(formatKeyCommandBinding(bindings['command-palette'])).toEqual(['Cmd/Ctrl', 'K'])
    expect(getKeyCommandForEvent(keyEvent({ key: 'k', metaKey: true }), bindings)?.id).toBe(
      'command-palette'
    )
  })

  it('exposes common chat commands without over-assigning defaults', () => {
    const bindings = resolveKeyCommandBindings({})

    expect(KEY_COMMAND_GROUPS).toEqual([
      'Global',
      'Chat',
      'Composer',
      'Actions',
      'Panels',
      'Windows'
    ])
    expect(KEY_COMMAND_DEFINITIONS.map((definition) => definition.id)).toEqual(
      expect.arrayContaining([
        'new-chat',
        'stop-run',
        'copy-transcript',
        'review-current-diff',
        'attach-files',
        'attach-window'
      ])
    )
    expect(getKeyCommandForEvent(keyEvent({ key: 'n', metaKey: true }), bindings)?.id).toBe(
      'new-chat'
    )
    expect(getKeyCommandForEvent(keyEvent({ key: '.', ctrlKey: true }), bindings)?.id).toBe(
      'stop-run'
    )
    expect(bindings['copy-transcript']).toBeNull()
    expect(bindings['review-current-diff']).toBeNull()
    expect(bindings['attach-files']).toBeNull()
    expect(bindings['attach-window']).toBeNull()
  })

  it('applies custom overrides and supports unassigned commands', () => {
    const bindings = resolveKeyCommandBindings({
      'popout-chat-window': { key: 'P', modifiers: ['primary', 'shift'] },
      'toggle-inspector': null
    })

    expect(getKeyCommandForEvent(keyEvent({ key: 'p', ctrlKey: true, shiftKey: true }), bindings)?.id).toBe(
      'popout-chat-window'
    )
    expect(bindings['toggle-inspector']).toBeNull()
  })

  it('detects conflicts against the resolved binding map', () => {
    const bindings = resolveKeyCommandBindings({})
    const conflict = findKeyCommandConflict(
      'popout-chat-window',
      { key: 'K', modifiers: ['primary'] },
      bindings
    )

    expect(conflict?.id).toBe('command-palette')
  })
})
