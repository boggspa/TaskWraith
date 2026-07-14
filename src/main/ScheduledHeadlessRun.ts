import type { ComposerInput } from './services/ComposerService'
import type { ProviderId, ScheduledTask } from './store/types'

type ScheduledHeadlessComposeFields = Pick<
  ComposerInput,
  'workflowMode' | 'permissionPresetId' | 'geminiWorktree' | 'kimiFastMode'
>

/**
 * Fields captured when the occurrence was scheduled must win over mutable chat
 * metadata when main composes an unattended run. Keep this projection aligned
 * with the renderer-authority scheduled composition path.
 */
export function scheduledHeadlessComposeFields(
  task: Pick<
    ScheduledTask,
    'workflowMode' | 'permissionPresetId' | 'geminiWorktree' | 'kimiFastMode'
  >
): ScheduledHeadlessComposeFields {
  return {
    workflowMode: task.workflowMode,
    permissionPresetId: task.permissionPresetId,
    geminiWorktree: task.geminiWorktree,
    kimiFastMode: task.kimiFastMode
  }
}

export interface ScheduledLoopStepTimeoutInput {
  composeProvider: ProviderId
  runId: string
  timeoutMs: number
  cancelProviderRun: (provider: ProviderId, runId: string) => unknown
  handleExit: (runId: string, exitCode: number) => void
}

/**
 * Arm a step-local timeout against the provider that actually owns the step.
 * A cross-provider verifier must never try to cancel the maker provider.
 */
export function armScheduledLoopStepTimeout(
  input: ScheduledLoopStepTimeoutInput
): () => void {
  const backstop = setTimeout(() => {
    try {
      void Promise.resolve(
        input.cancelProviderRun(input.composeProvider, input.runId)
      ).catch(() => undefined)
    } catch {
      // The tracked completion still needs settling if cancellation itself fails.
    }
    input.handleExit(input.runId, -1)
  }, input.timeoutMs)
  return () => clearTimeout(backstop)
}
