// Source-wiring guard for the solo provider-exit ChatRun seal (App.tsx
// handleProviderExit).
//
// The ghost shape this pins: a premature Wire `result` line with a
// non-terminal status ('running' — a Pi/host turn boundary) used to seal the
// run with `endedAt` + `status: 'running'` in the run_finished handler, and
// the provider-exit seal then fell through BOTH of its branches (the
// 'success' → warnings upgrade, and the falsy-status stamp) — leaving a
// finished run permanently labelled 'running'. The close-out read
// "The run ended with status running", the Task Complete receipts lost their
// run-scoped window, and after main's unsealed copy clobbered the seal on
// broadcast the card vanished from the thread entirely.
//
// The seal must now stamp over ANY non-terminal status, mirroring main's
// sealChatRunTerminalFields (isActiveChatRunStatus) plus the adapter's
// 'unknown' fallback. Written against the App.tsx source because the seal is
// an inline closure over run-queue state that cannot be unit-imported.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('provider-exit ChatRun seal hardening', () => {
  it('shares main’s active-status vocabulary for the exit seal', () => {
    expect(appSource).toContain(
      "import { isActiveChatRunStatus } from '../../main/ChatRunReconciler'"
    )
  })

  it('stamps a terminal status over every non-terminal ghost shape', () => {
    const sealStart = appSource.indexOf('// Seal endedAt alongside status')
    expect(sealStart).toBeGreaterThanOrEqual(0)
    const sealBlock = appSource.slice(sealStart, sealStart + 4000)

    // endedAt is sealed first: deriveChatRunCompleteNotice keys the Task
    // Complete card off endedAt alone.
    const endedAtSeal = sealBlock.indexOf('if (!targetRun.endedAt) targetRun.endedAt =')
    const ghostStamp = sealBlock.indexOf('isActiveChatRunStatus(targetRun.status)')
    expect(endedAtSeal).toBeGreaterThanOrEqual(0)
    expect(ghostStamp).toBeGreaterThan(endedAtSeal)

    // The stampable condition covers falsy, the adapter's 'unknown' fallback,
    // and the full active-status set — 'running' can no longer survive an exit.
    expect(sealBlock).toContain('!targetRun.status ||')
    expect(sealBlock).toContain("targetRun.status === 'unknown' ||")
    expect(sealBlock).toContain('isActiveChatRunStatus(targetRun.status)')

    // Terminal statuses still win: the warnings upgrade is the ONLY post-stamp
    // mutation, so a real 'failed'/'cancelled'/'success' is never rewritten.
    const upgrade = sealBlock.indexOf(
      "targetRun.status === 'success' && context.warnings.length > 0"
    )
    expect(upgrade).toBeGreaterThan(ghostStamp)
  })
})
