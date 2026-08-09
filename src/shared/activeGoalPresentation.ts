export type ActiveGoalPresentationMode =
  | 'codex_native'
  | 'claude_native'
  | 'grok_native'
  | 'taskwraith_steered'
  | 'ollama_harness'

export function activeGoalModeLabel(mode: ActiveGoalPresentationMode): string {
  switch (mode) {
    case 'codex_native':
      return 'Native Codex goal'
    case 'claude_native':
      return 'Native Claude goal'
    case 'grok_native':
      return 'Native Grok goal'
    case 'ollama_harness':
      return 'Ollama managed'
    case 'taskwraith_steered':
    default:
      return 'Guided by TaskWraith'
  }
}
