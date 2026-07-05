export interface ClaudeSdkThinkingConfig {
  type: 'adaptive'
  display: 'summarized'
}

export function claudeSdkThinkingConfigForEffort(
  normalizedEffort: string | null | undefined
): ClaudeSdkThinkingConfig | null {
  return normalizedEffort ? { type: 'adaptive', display: 'summarized' } : null
}
