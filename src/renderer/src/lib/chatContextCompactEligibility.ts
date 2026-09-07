export function canCompactSoloChatContext(input: {
  readonly isEnsemble: boolean
  readonly isRunning: boolean
  readonly provider: string | null | undefined
  readonly hasLinkedSession: boolean
  readonly hasAssistantMessage: boolean
  readonly kimiNativeSession?: boolean
  readonly antigravityApiSession?: boolean
}): boolean {
  if (input.isEnsemble || input.isRunning) return false
  switch (input.provider) {
    case 'claude':
    case 'codex':
      return input.hasLinkedSession
    case 'kimi':
      return input.kimiNativeSession ? input.hasLinkedSession : input.hasAssistantMessage
    case 'antigravity':
      return Boolean(input.antigravityApiSession) && input.hasAssistantMessage
    case 'mistral':
    case 'cursor':
      return input.hasAssistantMessage
    default:
      return false
  }
}
