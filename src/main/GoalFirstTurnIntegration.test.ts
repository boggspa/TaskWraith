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

describe('goal creation via the goal-control tool handler', () => {
  it('delegates the create decision to GoalControlCreation and keeps no turn guard', () => {
    // Locate the goal control tool handler block in index.ts
    const block = sourceBetween(
      indexSource,
      "toolName === 'goal_update' ||\n      toolName === 'update_goal' ||\n      toolName === 'goal_complete' ||\n      toolName === 'goal_blocked'",
      'const lifecycleStatus ='
    )

    // The decision is the extracted module's, wired by one import line.
    expect(indexSource).toContain(
      "import { resolveGoalControlCreation } from './GoalControlCreation'"
    )
    expect(block).toContain('const creation = resolveGoalControlCreation({ toolName, args, chat })')

    // The turn-position guard is GONE. It could not be satisfied: the agent's
    // own streamed assistant row is appended and saved before its tool call
    // reaches this handler, so the app instructed the agent to call update_goal
    // and then refused it every time (observed on mistral, muse and ollama).
    expect(block).not.toContain('isFirstTurn')
    expect(block).not.toContain('messages || []).length === 1')

    // Provenance comes from the decision rather than a hard-coded 'user':
    // agent-authored objective text must not claim a human owns the wording.
    expect(block).toContain(
      'const newGoal = createActiveGoal(chat!.provider!, creation.objective, {'
    )
    expect(block).toContain('objectiveSource: creation.objectiveSource')
    expect(block).not.toContain("objectiveSource: 'user'")

    // Goal is saved to the store and broadcast
    expect(block).toContain(
      'const updatedChat = { ...chat!, activeGoal: newGoal, updatedAt: Date.now() }'
    )
    expect(block).toContain('AppStore.saveChat(updatedChat)')
    expect(block).toContain('broadcastChatUpdated(updatedChat)')

    // The new goal is returned to the tool caller, and a refusal carries the
    // module's own message (which names update_goal as the remedy) rather than
    // a literal re-spelled here.
    expect(block).toContain('text = mcpJson({ ok: true, tool: toolName, goal: newGoal })')
    expect(block).toContain('error: creation.error')
    expect(block).not.toContain('No active TaskWraith goal is set for this chat')
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
