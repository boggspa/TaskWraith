import { describe, expect, it } from 'vitest'
import {
  createMuseAnnounceSteerGate,
  museAnnounceSteerAppliesToPrompt,
  MUSE_ANNOUNCE_STEER_TEXT
} from './MuseAnnounceSteer'

const toolStart = { kind: 'toolCall', phase: 'started' } as const
const proseStart = { kind: 'agentMessage', phase: 'started' } as const

describe('museAnnounceSteerAppliesToPrompt', () => {
  it('declines a native slash dispatch, leading whitespace included', () => {
    expect(museAnnounceSteerAppliesToPrompt('/compact')).toBe(false)
    expect(museAnnounceSteerAppliesToPrompt('  \n /model')).toBe(false)
  })

  it('applies to ordinary task prompts', () => {
    expect(museAnnounceSteerAppliesToPrompt('Add more jokes to the repo.')).toBe(true)
  })
})

describe('MUSE_ANNOUNCE_STEER_TEXT', () => {
  it('tells the model to keep working rather than reading the steer as a new task', () => {
    expect(MUSE_ANNOUNCE_STEER_TEXT).toContain('continue the same work in this turn')
    expect(MUSE_ANNOUNCE_STEER_TEXT).toContain('not a new request')
  })
})

describe('createMuseAnnounceSteerGate', () => {
  it('fires on a tool call that opens with no prose behind it', () => {
    const gate = createMuseAnnounceSteerGate()
    expect(gate.observeItem(toolStart)).toBe(true)
  })

  it('stays silent when the model already started prose', () => {
    const gate = createMuseAnnounceSteerGate()
    expect(gate.observeItem(proseStart)).toBe(false)
    expect(gate.observeItem(toolStart)).toBe(false)
  })

  it('fires at most once per turn however many tools follow', () => {
    const gate = createMuseAnnounceSteerGate()
    expect(gate.observeItem(toolStart)).toBe(true)
    expect(gate.observeItem(toolStart)).toBe(false)
    expect(gate.observeItem(toolStart)).toBe(false)
  })

  it('ignores tool frames that are not the opening one', () => {
    const gate = createMuseAnnounceSteerGate()
    expect(gate.observeItem({ kind: 'toolCall', phase: 'updated' })).toBe(false)
    expect(gate.observeItem({ kind: 'toolCall', phase: 'completed' })).toBe(false)
  })

  it('ignores every other item kind, known and unknown', () => {
    const gate = createMuseAnnounceSteerGate()
    for (const kind of ['reasoning', 'userMessage', 'subagent', 'reminderChild', 'somethingNew']) {
      expect(gate.observeItem({ kind, phase: 'started' })).toBe(false)
    }
    // None of those consumed the one-shot budget.
    expect(gate.observeItem(toolStart)).toBe(true)
  })

  it('never fires when disabled', () => {
    const gate = createMuseAnnounceSteerGate(false)
    expect(gate.observeItem(toolStart)).toBe(false)
  })
})
