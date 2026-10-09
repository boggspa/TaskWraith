import { isSignedHumanFullAccessPosture } from '../RunPermissionPosture'
import type { EffectiveRunPermissions } from '../store/types'

/** This context is supplied only by main's terminal RunManager event. */
export interface TerminalHostHookAuthority {
  permissions?: EffectiveRunPermissions
}

export function createHostHookApproval(input: {
  runId?: string
  terminal?: TerminalHostHookAuthority
  request: (command: string, runId: string | undefined) => Promise<boolean>
  auditTerminalFullAccess: (command: string) => void
}): (command: string) => Promise<boolean> {
  return async (command) => {
    if (input.terminal) {
      // Stop hooks are configured lifecycle commands, not a new provider tool
      // call. Keep restricted hooks independently askable after their run ends.
      if (isSignedHumanFullAccessPosture(input.terminal.permissions)) {
        input.auditTerminalFullAccess(command)
        return true
      }
      return input.request(command, undefined)
    }
    // Pre/Post calls keep the live-run fence, including cancellation checks.
    return input.request(command, input.runId)
  }
}
