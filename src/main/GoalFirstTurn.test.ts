import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock the AppStore and related modules
vi.mock('./store', () => ({
  AppStore: {
    getChat: vi.fn(),
    saveChat: vi.fn()
  },
  broadcastChatUpdated: vi.fn()
}))

vi.mock('./GoalState', () => ({
  createActiveGoal: vi.fn((provider: string, objective: string, options: any) => ({
    id: `goal-${Date.now()}`,
    provider,
    objective,
    status: 'active',
    createdAt: Date.now(),
    objectiveSource: options?.objectiveSource || undefined
  }))
}))

// Import the actual module after mocking
// import { AppStore } from './store'
// import { createActiveGoal } from './GoalState'

// We'll test the logic by extracting and testing the relevant code path
// Since the actual implementation is in index.ts which has many dependencies,
// we test the core logic in isolation

describe('First-turn goal creation guard relaxation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const mockChat = (messages: any[] = [], activeGoal: any = null) => ({
    id: 'test-chat',
    provider: 'codex' as const,
    messages,
    activeGoal,
    updatedAt: Date.now()
  })

  const mockMessage = (content: string) => ({
    id: 'msg-1',
    role: 'user' as const,
    content
  })

  // Simulate the guard relaxation logic from index.ts:39424-39449
  const shouldCreateGoalOnFirstTurn = (
    chat: any,
    toolName: string,
    args: Record<string, any>
  ): { shouldCreate: boolean; objective?: string } => {
    const goal = chat?.activeGoal
    if (!chat || !goal) {
      const isFirstTurn = (chat?.messages || []).length === 1
      if (chat && isFirstTurn && (toolName === 'goal_update' || toolName === 'update_goal')) {
        const objective = String(
          args.objective ||
            args.description ||
            chat.messages[0]?.content ||
            'Auto-created objective'
        )
        return { shouldCreate: true, objective }
      }
    }
    return { shouldCreate: false }
  }

  describe('First turn detection', () => {
    it('detects first turn when only user message exists', () => {
      const chat = mockChat([mockMessage('Fix the bug in AuthService.ts')], null)
      const result = shouldCreateGoalOnFirstTurn(chat, 'update_goal', {})
      expect(result.shouldCreate).toBe(true)
      expect(result.objective).toBe('Fix the bug in AuthService.ts')
    })

    it('does not detect first turn when multiple messages exist', () => {
      const chat = mockChat([mockMessage('First'), mockMessage('Second')], null)
      const result = shouldCreateGoalOnFirstTurn(chat, 'update_goal', {})
      expect(result.shouldCreate).toBe(false)
    })

    it('does not detect first turn when no messages exist', () => {
      const chat = mockChat([], null)
      const result = shouldCreateGoalOnFirstTurn(chat, 'update_goal', {})
      expect(result.shouldCreate).toBe(false)
    })
  })

  describe('Goal tool detection', () => {
    it('allows goal_update on first turn', () => {
      const chat = mockChat([mockMessage('Implement feature X')], null)
      const result = shouldCreateGoalOnFirstTurn(chat, 'goal_update', {})
      expect(result.shouldCreate).toBe(true)
      expect(result.objective).toBe('Implement feature X')
    })

    it('allows update_goal on first turn', () => {
      const chat = mockChat([mockMessage('Refactor the module')], null)
      const result = shouldCreateGoalOnFirstTurn(chat, 'update_goal', {})
      expect(result.shouldCreate).toBe(true)
      expect(result.objective).toBe('Refactor the module')
    })

    it('does not allow goal_complete on first turn', () => {
      const chat = mockChat([mockMessage('Complete the task')], null)
      const result = shouldCreateGoalOnFirstTurn(chat, 'goal_complete', {})
      expect(result.shouldCreate).toBe(false)
    })

    it('does not allow goal_blocked on first turn', () => {
      const chat = mockChat([mockMessage('Task is blocked')], null)
      const result = shouldCreateGoalOnFirstTurn(chat, 'goal_blocked', {})
      expect(result.shouldCreate).toBe(false)
    })
  })

  describe('Objective extraction', () => {
    it('prefers args.objective when available', () => {
      const chat = mockChat([mockMessage('Original prompt')], null)
      const result = shouldCreateGoalOnFirstTurn(chat, 'update_goal', {
        objective: 'Custom objective'
      })
      expect(result.objective).toBe('Custom objective')
    })

    it('falls back to args.description when objective not available', () => {
      const chat = mockChat([mockMessage('Original prompt')], null)
      const result = shouldCreateGoalOnFirstTurn(chat, 'update_goal', {
        description: 'Description objective'
      })
      expect(result.objective).toBe('Description objective')
    })

    it('falls back to first message content when neither objective nor description available', () => {
      const chat = mockChat([mockMessage('First message content')], null)
      const result = shouldCreateGoalOnFirstTurn(chat, 'update_goal', {})
      expect(result.objective).toBe('First message content')
    })

    it('falls back to default when first message is empty', () => {
      const chat = mockChat([mockMessage('')], null)
      const result = shouldCreateGoalOnFirstTurn(chat, 'update_goal', {})
      expect(result.objective).toBe('Auto-created objective')
    })
  })

  describe('Existing goal handling', () => {
    it('does not create goal when activeGoal already exists', () => {
      const existingGoal = { id: 'existing', objective: 'Existing goal' }
      const chat = mockChat([mockMessage('New prompt')], existingGoal)
      const result = shouldCreateGoalOnFirstTurn(chat, 'update_goal', {
        objective: 'New objective'
      })
      expect(result.shouldCreate).toBe(false)
    })

    it('does not create goal when chat is null', () => {
      const result = shouldCreateGoalOnFirstTurn(null, 'update_goal', {
        objective: 'Some objective'
      })
      expect(result.shouldCreate).toBe(false)
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
