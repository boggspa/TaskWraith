import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const promptCompSource = readFileSync(new URL('./PromptComposition.ts', import.meta.url), 'utf8')

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start === -1) {
    throw new Error(`Start marker not found: ${startMarker}`)
  }
  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end === -1) {
    throw new Error(`End marker not found: ${endMarker}`)
  }
  return source.slice(start, end)
}

describe('first-turn goal creation guard integration', () => {
  it('detects first turn and allows update_goal to create and return a goal', () => {
    // Locate the goal control tool handler block in index.ts
    const block = sourceBetween(
      indexSource,
      "toolName === 'goal_update' ||\n      toolName === 'update_goal' ||\n      toolName === 'goal_complete' ||\n      toolName === 'goal_blocked'",
      'No active TaskWraith goal is set for this chat'
    )

    // Verify first turn calculation
    expect(block).toContain('const isFirstTurn = (chat?.messages || []).length === 1')

    // Verify guard relaxation condition
    expect(block).toContain(
      "chat &&\n          isFirstTurn &&\n          (toolName === 'goal_update' || toolName === 'update_goal')"
    )

    // Verify objective extraction fallback
    expect(block).toContain(
      "args.objective || args.description || chat.messages[0]?.content || 'Auto-created objective'"
    )

    // Verify goal creation
    expect(block).toContain("const { createActiveGoal } = require('./GoalState')")
    expect(block).toContain('const newGoal = createActiveGoal(chat.provider, objective, {')
    expect(block).toContain("objectiveSource: 'user'")

    // Verify goal is saved to store
    expect(block).toContain(
      'const updatedChat = { ...chat, activeGoal: newGoal, updatedAt: Date.now() }'
    )
    expect(block).toContain('AppStore.saveChat(updatedChat)')
    expect(block).toContain('broadcastChatUpdated(updatedChat)')

    // Verify the new goal is returned to the tool caller
    expect(block).toContain('text = mcpJson({ ok: true, tool: toolName, goal: newGoal })')
  })

  it('injects hint on first turn only in PromptComposition', () => {
    const block = sourceBetween(
      promptCompSource,
      'if (!input.activeGoal && (input.messages || []).length === 1) {',
      '}\n  }'
    )

    // Ensure first turn gating
    expect(promptCompSource).toContain(
      'if (!input.activeGoal && (input.messages || []).length === 1) {'
    )

    // Ensure it extracts the first message
    expect(block).toContain("const firstMsg = input.messages[0]?.content || ''")

    // Ensure heuristic gating (not a greeting, > 20 chars)
    expect(block).toContain(
      "if (firstMsg.length > 20 && !firstMsg.match(/^(hi|hello|hey|what's up|greetings)\\b/i)) {"
    )

    // Ensure hint text
    expect(block).toContain('No TaskWraith goal is set for this thread.')
    expect(block).toContain(
      'Since your prompt appears to require action, you may call `update_goal` to set the objective'
    )
  })
})
