import { defaultPiReasoningEffort } from '../../../shared/piReasoning'

export function resolveComposerModelReasoningDefault(options: {
  provider: string
  modelId: string
  modelDefaultReasoningEffort?: string | null
  reasoningOptions: readonly { value: string }[]
}): string {
  const enabled = new Set(options.reasoningOptions.map((option) => option.value))
  const modelDefault = String(options.modelDefaultReasoningEffort || '')
  if (modelDefault && enabled.has(modelDefault)) return modelDefault

  if (options.provider === 'pi') {
    const piDefault = defaultPiReasoningEffort(options.modelId)
    if (piDefault && enabled.has(piDefault)) return piDefault
  }

  return options.reasoningOptions[0]?.value || ''
}
