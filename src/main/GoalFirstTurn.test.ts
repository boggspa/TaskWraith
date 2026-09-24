import { describe, expect, it } from 'vitest'
import { resolveGoalControlCreation } from './GoalControlCreation'

// This file used to carry a hand-copied simulation of the guard that lived in
// index.ts, including its `messages.length === 1` condition. The simulation
// passed while the shipped behaviour was broken, because a copy cannot observe
// that the real call site reads a chat whose assistant row has already landed.
// The creation half now exercises the extracted module directly; the second
// block still models PromptComposition's own heuristic, which is separate.

describe('First-turn goal creation via update_goal', () => {
  const mockChat = (messages: { role?: string; content?: string }[] = []) => ({ messages })
  const mockMessage = (content: string) => ({ role: 'user' as const, content })

  describe('Turn position', () => {
    it('creates when only the user message exists', () => {
      const result = resolveGoalControlCreation({
        toolName: 'update_goal',
        args: {},
        chat: mockChat([mockMessage('Fix the bug in AuthService.ts')])
      })
      expect(result).toEqual({
        create: true,
        objective: 'Fix the bug in AuthService.ts',
        objectiveSource: 'user'
      })
    })

    it('still creates once the thread has more than one message', () => {
      // The regression: the agent's own streamed reply lands before its tool
      // call, so this is what every real attempt actually looked like.
      const result = resolveGoalControlCreation({
        toolName: 'update_goal',
        args: {},
        chat: mockChat([mockMessage('First'), { role: 'assistant', content: 'Second' }])
      })
      expect(result).toMatchObject({ create: true, objective: 'First' })
    })

    it("creates from the call's own objective when the thread has no messages", () => {
      const result = resolveGoalControlCreation({
        toolName: 'update_goal',
        args: { objective: 'Stated objective' },
        chat: mockChat([])
      })
      expect(result).toMatchObject({ create: true, objective: 'Stated objective' })
    })
  })

  describe('Goal tool detection', () => {
    it('allows goal_update', () => {
      const result = resolveGoalControlCreation({
        toolName: 'goal_update',
        args: {},
        chat: mockChat([mockMessage('Implement feature X')])
      })
      expect(result).toMatchObject({ create: true, objective: 'Implement feature X' })
    })

    it('allows update_goal', () => {
      const result = resolveGoalControlCreation({
        toolName: 'update_goal',
        args: {},
        chat: mockChat([mockMessage('Refactor the module')])
      })
      expect(result).toMatchObject({ create: true, objective: 'Refactor the module' })
    })

    it('does not allow goal_complete to create', () => {
      const result = resolveGoalControlCreation({
        toolName: 'goal_complete',
        args: {},
        chat: mockChat([mockMessage('Complete the task')])
      })
      expect(result.create).toBe(false)
    })

    it('does not allow goal_blocked to create', () => {
      const result = resolveGoalControlCreation({
        toolName: 'goal_blocked',
        args: {},
        chat: mockChat([mockMessage('Task is blocked')])
      })
      expect(result.create).toBe(false)
    })
  })

  describe('Objective extraction', () => {
    it('prefers args.objective when available', () => {
      const result = resolveGoalControlCreation({
        toolName: 'update_goal',
        args: { objective: 'Custom objective' },
        chat: mockChat([mockMessage('Original prompt')])
      })
      expect(result).toMatchObject({ objective: 'Custom objective' })
    })

    it('falls back to args.description when objective not available', () => {
      const result = resolveGoalControlCreation({
        toolName: 'update_goal',
        args: { description: 'Description objective' },
        chat: mockChat([mockMessage('Original prompt')])
      })
      expect(result).toMatchObject({ objective: 'Description objective' })
    })

    it('falls back to first message content when neither is available', () => {
      const result = resolveGoalControlCreation({
        toolName: 'update_goal',
        args: {},
        chat: mockChat([mockMessage('First message content')])
      })
      expect(result).toMatchObject({ objective: 'First message content' })
    })

    it('falls back to the placeholder when the first message is empty', () => {
      const result = resolveGoalControlCreation({
        toolName: 'update_goal',
        args: {},
        chat: mockChat([mockMessage('')])
      })
      expect(result).toMatchObject({ objective: 'Auto-created objective' })
    })
  })

  describe('Existing goal handling', () => {
    it('does not create when an activeGoal already exists', () => {
      const result = resolveGoalControlCreation({
        toolName: 'update_goal',
        args: { objective: 'New objective' },
        chat: mockChat([mockMessage('New prompt')]),
        hasActiveGoal: true
      })
      expect(result.create).toBe(false)
    })

    it('does not create when the chat is null', () => {
      const result = resolveGoalControlCreation({
        toolName: 'update_goal',
        args: { objective: 'Some objective' },
        chat: null
      })
      expect(result.create).toBe(false)
    })
  })
})

describe('Prompt composition first-turn hint injection', () => {
  // Test the heuristic logic from PromptComposition.ts:1560-1568
  const shouldInjectGoalHint = (messages: any[], activeGoal: any): boolean => {
    if (activeGoal) return false
    if ((messages || []).length !== 1) return false
    const firstMsg = messages[0]?.content || ''
    return firstMsg.length > 20 && !firstMsg.match(/^(hi|hello|hey|what's up|greetings)\b/i)
  }

  it('injects hint on first turn with task-like prompt over 20 chars', () => {
    const messages = [{ content: 'Please fix the bug in the AuthService module' }]
    expect(shouldInjectGoalHint(messages, null)).toBe(true)
  })

  it('does not inject hint when activeGoal exists', () => {
    const messages = [{ content: 'Please fix the bug in the AuthService module' }]
    const activeGoal = { id: 'goal-1', objective: 'Test' }
    expect(shouldInjectGoalHint(messages, activeGoal)).toBe(false)
  })

  it('does not inject hint when not first turn', () => {
    const messages = [
      { content: 'First message' },
      { content: 'Please fix the bug in the AuthService module' }
    ]
    expect(shouldInjectGoalHint(messages, null)).toBe(false)
  })

  it('does not inject hint when first message is short greeting', () => {
    const messages = [{ content: 'hi' }]
    expect(shouldInjectGoalHint(messages, null)).toBe(false)
  })

  it('does not inject hint when first message is hello', () => {
    const messages = [{ content: 'hello' }]
    expect(shouldInjectGoalHint(messages, null)).toBe(false)
  })

  it('does not inject hint when first message is hey', () => {
    const messages = [{ content: 'hey' }]
    expect(shouldInjectGoalHint(messages, null)).toBe(false)
  })

  it('does not inject hint when first message starts with whats up', () => {
    const messages = [{ content: "what's up everyone" }]
    expect(shouldInjectGoalHint(messages, null)).toBe(false)
  })

  it('does not inject hint when first message starts with greetings', () => {
    const messages = [{ content: 'greetings team' }]
    expect(shouldInjectGoalHint(messages, null)).toBe(false)
  })

  it('does not inject hint when message is exactly 20 chars', () => {
    const messages = [{ content: '12345678901234567890' }]
    expect(shouldInjectGoalHint(messages, null)).toBe(false)
  })

  it('injects hint when message is 21 chars', () => {
    const messages = [{ content: '123456789012345678901' }]
    expect(shouldInjectGoalHint(messages, null)).toBe(true)
  })

  it('injects hint for actionable short prompts over 20 chars', () => {
    const messages = [{ content: 'Fix the login bug now' }]
    expect(shouldInjectGoalHint(messages, null)).toBe(true)
  })
})
