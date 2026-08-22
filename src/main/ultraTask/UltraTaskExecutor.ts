/**
 * UltraTaskExecutor.ts
 *
 * Executes UltraTask waves and manages result aggregation.
 * This is a thin wrapper around delegate_wave with UltraTask-specific logic.
 */
import type { ProviderId } from '../store/types'
import { resolveUltraTaskReasoningEffort, isUltraTaskSupported } from './UltraTaskReasoningResolver'
import { buildUltraTaskWave, type UltraTaskWaveConfig, type BuiltUltraTaskWave } from './UltraTaskWaveBuilder'

// Track running UltraTask instances
const runningUltraTasks = new Map<string, { config: UltraTaskWaveConfig; wave: BuiltUltraTaskWave }>()

/**
 * Execute an UltraTask.
 * 
 * This function:
 * 1. Validates the provider/model supports UltraTask
 * 2. Resolves the highest available reasoning tier
 * 3. Builds the wave configuration
 * 4. Returns the wave for delegation
 * 
 * Note: Actual delegation happens in src/main/index.ts via the ultra_task tool handler.
 */
export function executeUltraTask(config: UltraTaskWaveConfig): BuiltUltraTaskWave {
  const { baseProvider, baseModel, taskPrompt } = config

  // Validate UltraTask support
  if (!isUltraTaskSupported(baseProvider, baseModel)) {
    throw new Error(
      `UltraTask not supported for provider=${baseProvider}, model=${baseModel}. ` +
      `This model does not support multi-agent orchestration.`
    )
  }

  // Resolve and log the reasoning tier
  const reasoningEffort = resolveUltraTaskReasoningEffort(baseProvider, baseModel)
  console.log(
    `[UltraTask] Executing with provider=${baseProvider}, model=${baseModel}, ` +
    `reasoningEffort=${reasoningEffort}`
  )

  // Build the wave
  const wave = buildUltraTaskWave(config)

  // Track the running task (for status/cancellation)
  // In production, this would use a proper ID system
  const taskId = generateUltraTaskId()
  runningUltraTasks.set(taskId, { config, wave })

  return wave
}

/**
 * Execute a cross-provider UltraTask.
 */
export function executeCrossProviderUltraTask(
  config: UltraTaskWaveConfig & {
    researcherProvider?: ProviderId
    researcherModel?: string
    reviewerProvider?: ProviderId
    reviewerModel?: string
  }
): BuiltUltraTaskWave {
  const { baseProvider, baseModel, taskPrompt } = config

  // Validate base provider/model support
  if (!isUltraTaskSupported(baseProvider, baseModel)) {
    throw new Error(
      `UltraTask not supported for base provider=${baseProvider}, model=${baseModel}`
    )
  }

  // Validate researcher provider if specified
  if (config.researcherProvider && config.researcherModel) {
    if (!isUltraTaskSupported(config.researcherProvider, config.researcherModel)) {
      console.warn(
        `[UltraTask] Researcher provider=${config.researcherProvider}, model=${config.researcherModel} ` +
        `does not support UltraTask; falling back to base provider`
      )
    }
  }

  // Validate reviewer provider if specified
  if (config.reviewerProvider && config.reviewerModel) {
    if (!isUltraTaskSupported(config.reviewerProvider, config.reviewerModel)) {
      console.warn(
        `[UltraTask] Reviewer provider=${config.reviewerProvider}, model=${config.reviewerModel} ` +
        `does not support UltraTask; falling back to base provider`
      )
    }
  }

  const wave = buildCrossProviderUltraTaskWave(config)
  const taskId = generateUltraTaskId()
  runningUltraTasks.set(taskId, { config, wave })

  return wave
}

/**
 * Check if an UltraTask is currently running.
 */
export function isUltraTaskRunning(taskId: string): boolean {
  return runningUltraTasks.has(taskId)
}

/**
 * Get the status of an UltraTask.
 */
export function getUltraTaskStatus(taskId: string): { running: boolean; wave?: BuiltUltraTaskWave } {
  const task = runningUltraTasks.get(taskId)
  if (!task) {
    return { running: false }
  }
  return { running: true, wave: task.wave }
}

/**
 * Cancel a running UltraTask.
 */
export function cancelUltraTask(taskId: string): boolean {
  return runningUltraTasks.delete(taskId)
}

/**
 * Generate a unique UltraTask ID.
 */
function generateUltraTaskId(): string {
  return `ultra-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`
}

/**
 * Get the resolved reasoning effort for an UltraTask configuration.
 * Useful for displaying to users what tier will be used.
 */
export function getUltraTaskReasoningEffort(
  provider: ProviderId,
  model: string
): { effort: string; supported: boolean } {
  const supported = isUltraTaskSupported(provider, model)
  const effort = supported ? resolveUltraTaskReasoningEffort(provider, model) : 'none'
  return { effort, supported }
}

/**
 * Clear all running UltraTask tracking.
 * Useful for cleanup/reset.
 */
export function clearAllUltraTasks(): void {
  runningUltraTasks.clear()
}
