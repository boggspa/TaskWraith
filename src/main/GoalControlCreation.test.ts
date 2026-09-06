import { describe, expect, it } from 'vitest'
import {
  GOAL_CONTROL_NO_ACTIVE_GOAL_ERROR,
  GOAL_CONTROL_NO_THREAD_ERROR,
  GOAL_CONTROL_PLACEHOLDER_OBJECTIVE,
  resolveGoalControlCreation
} from './GoalControlCreation'

function chat(messages: { role?: string; content?: string }[]): {
  messages: { role?: string; content?: string }[]
} {
  return { messages }
}

const OPENING = 'Rename the byte pin to spark_pin across the renderer.'

describe('resolveGoalControlCreation — the window is no longer a race', () => {
  // The regression this file exists for. PromptComposition reads
  // messages.length === 1 BEFORE the run to emit "call update_goal once to
  // persist it"; the agent's own streamed assistant row lands before the tool
  // call, so the old `length === 1` guard refused every real attempt.
  it('creates mid-thread, after the agent has already streamed a reply', () => {
    const decision = resolveGoalControlCreation({
      toolName: 'update_goal',
      args: { objective: 'Ship the spark_pin rename with tests' },
      chat: chat([
        { role: 'user', content: OPENING },
        { role: 'assistant', content: 'I will start by reading the renderer rows.' },
        { role: 'tool', content: '' }
      ])
    })
    expect(decision).toEqual({
      create: true,
      objective: 'Ship the spark_pin rename with tests',
      objectiveSource: 'agent'
    })
  })

  it('still creates on the literal first turn', () => {
    const decision = resolveGoalControlCreation({
      toolName: 'update_goal',
      args: {},
      chat: chat([{ role: 'user', content: OPENING }])
    })
    expect(decision).toEqual({ create: true, objective: OPENING, objectiveSource: 'user' })
  })

  it('accepts the goal_update alias', () => {
    const decision = resolveGoalControlCreation({
      toolName: 'goal_update',
      args: { objective: 'Land the fix' },
      chat: chat([
        { role: 'user', content: OPENING },
        { role: 'assistant', content: 'ok' }
      ])
    })
    expect(decision).toEqual({
      create: true,
      objective: 'Land the fix',
      objectiveSource: 'agent'
    })
  })
})

describe('resolveGoalControlCreation — objective provenance', () => {
  it('labels agent-authored objective text as agent, not user', () => {
    // `objectiveSource: 'user'` asserts a HUMAN owns the wording: it mints the
    // expected_outcome specification and is the filter ContinuationProposal
    // reads. Text the model invented must not claim that.
    const decision = resolveGoalControlCreation({
      toolName: 'update_goal',
      args: { objective: 'Objective the model invented' },
      chat: chat([{ role: 'user', content: OPENING }])
    })
    expect(decision).toMatchObject({ objectiveSource: 'agent' })
  })

  it('falls back to args.description', () => {
    const decision = resolveGoalControlCreation({
      toolName: 'update_goal',
      args: { description: 'Described objective' },
      chat: chat([{ role: 'user', content: OPENING }])
    })
    expect(decision).toMatchObject({ objective: 'Described objective' })
  })

  it('adopts the opening HUMAN prompt for a status-only call, not row zero', () => {
    // A resumed/seeded thread can open with a system row; row zero is then not
    // the objective the user asked for.
    const decision = resolveGoalControlCreation({
      toolName: 'update_goal',
      args: { status: 'active' },
      chat: chat([
        { role: 'system', content: '[participant-health] ok' },
        { role: 'user', content: OPENING },
        { role: 'assistant', content: 'working' }
      ])
    })
    expect(decision).toEqual({ create: true, objective: OPENING, objectiveSource: 'user' })
  })

  it('trims whitespace-only objective text rather than creating a blank goal', () => {
    const decision = resolveGoalControlCreation({
      toolName: 'update_goal',
      args: { objective: '   ' },
      chat: chat([{ role: 'user', content: OPENING }])
    })
    expect(decision).toEqual({ create: true, objective: OPENING, objectiveSource: 'user' })
  })

  it('keeps the placeholder when nothing at all supplies text', () => {
    const decision = resolveGoalControlCreation({
      toolName: 'update_goal',
      args: {},
      chat: chat([{ role: 'user', content: '' }])
    })
    expect(decision).toEqual({
      create: true,
      objective: GOAL_CONTROL_PLACEHOLDER_OBJECTIVE,
      objectiveSource: 'user'
    })
  })
})

describe('resolveGoalControlCreation — what still refuses', () => {
  it('refuses goal_complete and goal_blocked, and names the remedy', () => {
    for (const toolName of ['goal_complete', 'goal_blocked']) {
      const decision = resolveGoalControlCreation({
        toolName,
        args: {},
        chat: chat([{ role: 'user', content: OPENING }])
      })
      expect(decision).toEqual({ create: false, error: GOAL_CONTROL_NO_ACTIVE_GOAL_ERROR })
      // The old wording stated a precondition with no agent-reachable fix,
      // which is what drove the retry loop.
      expect(GOAL_CONTROL_NO_ACTIVE_GOAL_ERROR).toContain('update_goal')
    }
  })

  it('refuses when no thread is bound to the run', () => {
    const decision = resolveGoalControlCreation({ toolName: 'update_goal', args: {}, chat: null })
    expect(decision).toEqual({ create: false, error: GOAL_CONTROL_NO_THREAD_ERROR })
  })

  it('fails closed when the thread already has a goal', () => {
    const decision = resolveGoalControlCreation({
      toolName: 'update_goal',
      args: { objective: 'Replacement' },
      chat: chat([{ role: 'user', content: OPENING }]),
      hasActiveGoal: true
    })
    expect(decision).toEqual({ create: false, error: GOAL_CONTROL_NO_ACTIVE_GOAL_ERROR })
  })
})
