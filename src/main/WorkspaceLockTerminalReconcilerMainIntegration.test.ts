import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(join(__dirname, 'index.ts'), 'utf8')

describe('workspace-lock terminal reconciliation main composition', () => {
  it('cancels host commands before terminal watchdog admission and routes violations to recovery', () => {
    expect(mainSource).toContain('new WorkspaceLockTerminalReconciler({')
    expect(mainSource).toContain('workspaceLockTerminalReconcilerRef.terminal(event.session.runId)')
    expect(mainSource).toContain(
      'workspaceLockTerminalReconcilerRef?.handleViolation(violation, blockedReason)'
    )
  })

  it('joins brokered command process trees and cancels abandoned broker requests', () => {
    expect(mainSource).toContain('createHostCommandProcessTreeJoin(child.pid)')
    expect(mainSource).toContain(
      'joinProcessTreeAfterClose: () => processTree.joinAfterRootClose()'
    )
    expect(mainSource).toContain('onBrokerRequestAbandoned: cancelAbandonedBrokerHostCommands')
    expect(mainSource).toContain('onDispatchTimeout: cancelTimedOutKimiHostCommands')
  })
})
