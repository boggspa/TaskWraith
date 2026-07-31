import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(join(__dirname, 'index.ts'), 'utf8')

// The startup recovery gates keep gaining conjuncts (the 1.9.2 arc added
// `!workspaceLockStartupRecoveryBlockedReason` to every one of them). Each
// addition strictly NARROWS when recovery runs, so it can never weaken the
// deletion fence this tripwire protects. Match the fence clause and tolerate
// any number of further `&& !<name>` conjuncts instead of pinning a literal
// that has already broken this class twice.
const STARTUP_RECOVERY_GATE =
  /if\s*\(\s*!historyDeletionStartupRecoveryBlockedReason(\s*&&\s*![A-Za-z]+)*\s*\)\s*\{/

// The same gate, additionally required to carry the ensemble-wakeups flag.
const ENSEMBLE_WAKEUP_GATE =
  /if\s*\(\s*!historyDeletionStartupRecoveryBlockedReason(\s*&&\s*![A-Za-z]+)*\s*&&\s*ensembleWakeupsEnabled\(\)\s*\)\s*\{/

function lastMatchIndexAtOrBefore(pattern: RegExp, limit: number): number {
  const scanner = new RegExp(pattern.source, 'g')
  let found = -1
  let match: RegExpExecArray | null
  while ((match = scanner.exec(indexSource)) !== null) {
    if (match.index > limit) break
    found = match.index
    scanner.lastIndex = match.index + 1
  }
  return found
}

function firstMatchIndexAfter(pattern: RegExp, from: number): number {
  const scanner = new RegExp(pattern.source, 'g')
  scanner.lastIndex = from
  const match = scanner.exec(indexSource)
  return match ? match.index : -1
}

function between(start: string, end: string): string {
  const from = indexSource.indexOf(start)
  const to = indexSource.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return indexSource.slice(from, to)
}

describe('solo wakeup destructive-history main integration', () => {
  it('keeps solo timer recovery behind the startup deletion-recovery gate', () => {
    const soloRecovery = indexSource.lastIndexOf('recoverPersistedSoloChatWakeups()')
    const guardedBlock = lastMatchIndexAtOrBefore(ENSEMBLE_WAKEUP_GATE, soloRecovery)
    const nextBlock = firstMatchIndexAfter(STARTUP_RECOVERY_GATE, guardedBlock + 1)

    expect(guardedBlock).toBeGreaterThanOrEqual(0)
    expect(soloRecovery).toBeGreaterThan(guardedBlock)
    expect(soloRecovery).toBeLessThan(nextBlock)
  })

  it('returns the solo fallthrough promise to an explicit rejection sink', () => {
    const handler = between(
      'function handleEnsembleWakeupTimerFired',
      '/**\n * 1.0.5-EW37 — Fire handler for solo-chat wakeups.'
    )

    expect(handler).toContain('return handleSoloWakeupTimerFired(wakeupId).catch((error) => {')
    expect(handler).toContain('Solo wakeup handler failed')
  })

  it('scoped delete/truncate raises and joins the wakeup fence inside the synchronous chat hold', () => {
    const lifecycle = between(
      'type ChatHistoryMutationAuthority = {',
      'const beginEnsembleHistoryClear = '
    )

    const genericFence = lifecycle.indexOf('historyClearAdmissionGate.beginChat(chatId)')
    const soloFence = lifecycle.indexOf(
      "soloChatWakeupServiceRef?.beginHistoryClear({ kind: 'chat', chatIds: [chatId] })"
    )
    const joined = lifecycle.indexOf('retained.soloWakeup?.completion')
    const released = lifecycle.indexOf(
      'soloChatWakeupServiceRef?.endHistoryClear(retained.soloWakeup)'
    )

    expect(genericFence).toBeGreaterThanOrEqual(0)
    expect(soloFence).toBeGreaterThan(genericFence)
    expect(joined).toBeGreaterThan(soloFence)
    expect(released).toBeGreaterThan(joined)
  })

  it('workspace/global deletion retains the exact wakeup join through broad commit', () => {
    const broad = between('type BroadHistoryDeletionHolds = {', 'const clearBroadChatHistory = ')
    const genericFence = broad.indexOf('historyGateHeld = true')
    const soloFence = broad.indexOf(
      'soloChatWakeupServiceRef.beginHistoryClear(\n                broadSoloWakeupHistoryScope(preparation)'
    )
    const ensembleFence = broad.indexOf('beginBroadEnsembleHistoryClear(chatId)')
    const joined = broad.indexOf('if (holds.soloWakeupPurge) await holds.soloWakeupPurge.promise')
    const commitRelease = broad.indexOf('soloChatWakeupServiceRef?.endHistoryClear(hold)', joined)

    expect(broad).toContain('soloWakeupHolds: SoloWakeupHistoryHold[]')
    expect(broad).toContain('soloWakeupPurge: BroadHistoryStrictAttempt | null')
    expect(genericFence).toBeGreaterThanOrEqual(0)
    expect(soloFence).toBeGreaterThan(genericFence)
    expect(ensembleFence).toBeGreaterThan(soloFence)
    expect(joined).toBeGreaterThan(ensembleFence)
    expect(commitRelease).toBeGreaterThan(joined)
  })
})
