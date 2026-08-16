import type { AgyCompletedFinalResponse } from './AntigravityFinalResponseLiveness'

export interface AntigravityFailedExitFinalRecovery {
  text: string
  warning: {
    title: string
    message: string
  }
  provenance: {
    recoverySource: 'agy-brain-transcript'
    recoveredAfterProviderFailure: true
    nativeStepIndex: number
    nativeCreatedAt: string
  }
}

export function planAntigravityFailedExitFinalRecovery(input: {
  exitCode: number | null
  assistantText: string
  terminalClaimed: boolean
  finalResponse: AgyCompletedFinalResponse | null
}): AntigravityFailedExitFinalRecovery | null {
  if (
    typeof input.exitCode !== 'number' ||
    !Number.isFinite(input.exitCode) ||
    input.exitCode === 0 ||
    input.terminalClaimed ||
    input.assistantText.trim().length > 0
  ) {
    return null
  }

  const text = input.finalResponse?.content.trim() || ''
  if (!text || !input.finalResponse) return null

  return {
    text,
    warning: {
      title: 'Recovered AntiGravity final response after native failure',
      message:
        `Official agy exited unsuccessfully (code ${input.exitCode}) without delivering its recorded final response on stdout. ` +
        "TaskWraith recovered the exact current-turn DONE planner response from agy's native brain transcript. The provider run remains failed; this recovery does not convert it to success."
    },
    provenance: {
      recoverySource: 'agy-brain-transcript',
      recoveredAfterProviderFailure: true,
      nativeStepIndex: input.finalResponse.stepIndex,
      nativeCreatedAt: input.finalResponse.createdAt
    }
  }
}
