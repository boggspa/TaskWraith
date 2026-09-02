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

    // Verify guard relaxation condition. 0ede2bbf6 (the 1.9.7 lint pass) let
    // prettier join the guard onto one line — pin the shipped single line.
    expect(block).toContain(
      "if (chat && isFirstTurn && (toolName === 'goal_update' || toolName === 'update_goal')) {"
    )

    // Verify objective extraction fallback. The same pass split the fallback
    // chain across lines, so compare a whitespace-normalised form and stop
    // being a prettier hostage.
    const flatBlock = block.replace(/\s+/g, ' ')
    expect(flatBlock).toContain(
      "args.objective || args.description || chat.messages[0]?.content || 'Auto-created objective'"
    )

    // Verify goal creation. 0ede2bbf6 dropped the inline require because
    // createActiveGoal is already a static top-level import in index.ts, and
    // narrowed the provider with `!` for typecheck.
    expect(block).not.toContain("require('./GoalState')")
    expect(indexSource).toContain('createActiveGoal,')
    expect(block).toContain('const newGoal = createActiveGoal(chat.provider!, objective, {')
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
    // c25e87a40 feat(prompt): dedupe persistent solo context moved the
    // first-turn heuristic out of the old `if` block: PromptComposition now
    // derives firstMessage/suggestDurableGoal and hands the flag to
    // buildAgentWorkState, which renders the hint wording itself. Compare
    // whitespace-normalised source so prettier cannot break these pins.
    const flatPromptComp = promptCompSource.replace(/\s+/g, ' ')

    // First-turn gating: only a goalless thread with exactly one message
    // feeds the heuristic, so the hint stays first-turn-only.
    expect(flatPromptComp).toContain(
      "const firstMessage = !input.activeGoal && (input.messages || []).length === 1 ? input.messages[0]?.content || '' : ''"
    )

    // Heuristic gating (not a greeting, > 20 chars)
    expect(flatPromptComp).toContain(
      "const suggestDurableGoal = firstMessage.length > 20 && !firstMessage.match(/^(hi|hello|hey|what's up|greetings)\\b/i)"
    )

    // The flag is passed into buildAgentWorkState({...})
    expect(flatPromptComp).toContain(
      "buildAgentWorkState({ activeGoal: input.activeGoal, providerOwnsGoalSteering, completionAuthority: 'root', suggestDurableGoal })"
    )

    // The hint wording now lives in the work contract shared by Host and App.
    const workContractSource = readFileSync(
      new URL('../host-shared/AgentWorkContract.ts', import.meta.url),
      'utf8'
    )
    expect(workContractSource).toContain(
      'If it needs multi-turn action, call update_goal once to persist it.'
    )
  })
})
