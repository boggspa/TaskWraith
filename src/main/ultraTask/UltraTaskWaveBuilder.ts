/**
 * UltraTaskWaveBuilder.ts
 *
 * Builds delegate_wave configurations for UltraTask execution.
 * Encourages multi-agent patterns (researcher/worker/reviewer) with
 * automatic result aggregation.
 */
import type { ProviderId } from '../store/types'
import { resolveUltraTaskReasoningEffort } from './UltraTaskReasoningResolver'

export interface UltraTaskWaveConfig {
  baseProvider: ProviderId
  baseModel: string
  taskPrompt: string
  enableResearcherFanout?: boolean
  enableReviewerLayer?: boolean
  maxWorkers?: number
}

export interface DelegateWaveWorkerSpec {
  provider?: ProviderId
  model?: string
  reasoningEffort?: string
  role?: 'scout' | 'worker' | 'reviewer'
  label?: string
  prompt: string
}

export interface WaveJoinPolicy {
  required?: boolean
  quorum?: number
  deadlineMs?: number
  debounceMs?: number
}

export interface BuiltUltraTaskWave {
  workers: DelegateWaveWorkerSpec[]
  join: WaveJoinPolicy
  lifecycle: 'ephemeral' | 'durable'
  allowMultiProvider: boolean
}

/**
 * Build an UltraTask delegate wave configuration.
 * 
 * Creates a multi-agent orchestration with:
 * - Primary worker for the main task
 * - Optional scout/researcher worker for exploration
 * - Optional reviewer worker for validation
 * 
 * All workers use the highest available reasoning tier for their provider/model.
 */
export function buildUltraTaskWave(config: UltraTaskWaveConfig): BuiltUltraTaskWave {
  const {
    baseProvider,
    baseModel,
    taskPrompt,
    enableResearcherFanout = true,
    enableReviewerLayer = true,
    maxWorkers = 4
  } = config

  // Resolve the highest reasoning effort for the base provider/model
  const highestEffort = resolveUltraTaskReasoningEffort(baseProvider, baseModel)

  // Build the worker specifications
  const workers: DelegateWaveWorkerSpec[] = []

  // Primary worker: executes the main task
  workers.push({
    provider: baseProvider,
    model: baseModel,
    reasoningEffort: highestEffort !== 'none' ? highestEffort : undefined,
    role: 'worker',
    label: 'Primary Worker',
    prompt: taskPrompt
  })

  // Scout/Researcher worker: explores and gathers information
  if (enableResearcherFanout && workers.length < maxWorkers) {
    workers.push({
      provider: baseProvider,
      model: baseModel,
      reasoningEffort: highestEffort !== 'none' ? highestEffort : undefined,
      role: 'scout',
      label: 'Researcher',
      prompt: `Research and explore: ${taskPrompt}\n\nFocus on gathering comprehensive information, identifying edge cases, and documenting findings. Do not execute changes - this is a research-only lane.`
    })
  }

  // Reviewer worker: validates and quality-checks
  if (enableReviewerLayer && workers.length < maxWorkers) {
    workers.push({
      provider: baseProvider,
      model: baseModel,
      reasoningEffort: highestEffort !== 'none' ? highestEffort : undefined,
      role: 'reviewer',
      label: 'Reviewer',
      prompt: `Review and validate: ${taskPrompt}\n\nFocus on quality assurance, correctness verification, and risk assessment. Provide structured feedback on the primary worker's output.`
    })
  }

  // Ensure we don't exceed maxWorkers
  const finalWorkers = workers.slice(0, maxWorkers)

  // Build join policy: require all workers for quorum
  const join: WaveJoinPolicy = {
    required: true,
    quorum: finalWorkers.length,
    debounceMs: 2000 // 2 second debounce for coalescing results
  }

  return {
    workers: finalWorkers,
    join,
    lifecycle: 'ephemeral', // Workers die after returning results
    allowMultiProvider: false // All workers use the same provider for now
  }
}

/**
 * Build a cross-provider UltraTask wave for complex multi-provider scenarios.
 * This is an advanced variant that can use different providers for different roles.
 */
export function buildCrossProviderUltraTaskWave(
  config: UltraTaskWaveConfig & {
    researcherProvider?: ProviderId
    researcherModel?: string
    reviewerProvider?: ProviderId
    reviewerModel?: string
  }
): BuiltUltraTaskWave {
  const {
    baseProvider,
    baseModel,
    taskPrompt,
    enableResearcherFanout = true,
    enableReviewerLayer = true,
    maxWorkers = 4,
    researcherProvider,
    researcherModel,
    reviewerProvider,
    reviewerModel
  } = config

  const baseEffort = resolveUltraTaskReasoningEffort(baseProvider, baseModel)
  const researcherEffort = researcherProvider
    ? resolveUltraTaskReasoningEffort(researcherProvider, researcherModel || 'cli-default')
    : baseEffort
  const reviewerEffort = reviewerProvider
    ? resolveUltraTaskReasoningEffort(reviewerProvider, reviewerModel || 'cli-default')
    : baseEffort

  const workers: DelegateWaveWorkerSpec[] = []

  // Primary worker
  workers.push({
    provider: baseProvider,
    model: baseModel,
    reasoningEffort: baseEffort !== 'none' ? baseEffort : undefined,
    role: 'worker',
    label: 'Primary Worker',
    prompt: taskPrompt
  })

  // Researcher worker with potentially different provider
  if (enableResearcherFanout && workers.length < maxWorkers) {
    workers.push({
      provider: researcherProvider || baseProvider,
      model: researcherModel || baseModel,
      reasoningEffort: researcherEffort !== 'none' ? researcherEffort : undefined,
      role: 'scout',
      label: `Researcher (${researcherProvider || baseProvider})`,
      prompt: `Research and explore: ${taskPrompt}\n\nFocus on gathering comprehensive information, identifying edge cases, and documenting findings. Do not execute changes - this is a research-only lane.`
    })
  }

  // Reviewer worker with potentially different provider
  if (enableReviewerLayer && workers.length < maxWorkers) {
    workers.push({
      provider: reviewerProvider || baseProvider,
      model: reviewerModel || baseModel,
      reasoningEffort: reviewerEffort !== 'none' ? reviewerEffort : undefined,
      role: 'reviewer',
      label: `Reviewer (${reviewerProvider || baseProvider})`,
      prompt: `Review and validate: ${taskPrompt}\n\nFocus on quality assurance, correctness verification, and risk assessment. Provide structured feedback on the primary worker's output.`
    })
  }

  const finalWorkers = workers.slice(0, maxWorkers)

  const join: WaveJoinPolicy = {
    required: true,
    quorum: finalWorkers.length,
    debounceMs: 2000
  }

  return {
    workers: finalWorkers,
    join,
    lifecycle: 'ephemeral',
    allowMultiProvider: true // Different providers allowed
  }
}
