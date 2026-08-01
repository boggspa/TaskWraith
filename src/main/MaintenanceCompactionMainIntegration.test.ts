import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function between(start: string, end: string): string {
  const startAt = source.indexOf(start)
  const endAt = source.indexOf(end, startAt + start.length)
  expect(startAt, `missing start anchor: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endAt, `missing end anchor: ${end}`).toBeGreaterThan(startAt)
  return source.slice(startAt, endAt)
}

describe('main maintenance compaction history-deletion integration', () => {
  it('reserves synchronously at the unified entry and always finishes the exact generation', () => {
    const entry = between(
      'async function compactProviderContextForRequest(',
      'async function compactProviderContextForReservedRequest('
    )
    const reserveAt = entry.indexOf('maintenanceCompactionRegistry.reserve({')
    const firstAwaitAt = entry.indexOf('await compactProviderContextForReservedRequest(')
    expect(reserveAt).toBeGreaterThanOrEqual(0)
    expect(firstAwaitAt).toBeGreaterThan(reserveAt)
    expect(entry).toContain('finally {\n    maintenanceCompactionRegistry.finish(reservation)')
  })

  it('tracks Claude native activity across the SDK iterator and fences rotated-session writes', () => {
    const lane = between(
      'async function compactClaudeProviderContext(',
      '/** Kimi Code native compaction for an ensemble seat.'
    )
    expect(lane.indexOf('maintenanceCompactionRegistry.beginNativeActivity(')).toBeLessThan(
      lane.indexOf('const stream = sdk.query({')
    )
    expect(lane.indexOf('for await (const message of stream)')).toBeLessThan(
      lane.indexOf('maintenanceCompactionRegistry.endNativeActivity(payload.reservation)')
    )
    expect(lane).toContain('if (!maintenanceCompactionRegistry.canWrite(payload.reservation))')
    expect(lane.indexOf('maintenanceCompactionRegistry.canWrite(payload.reservation)')).toBeLessThan(
      lane.indexOf('saveAndBroadcastChat(updatedChat)')
    )
  })

  it('balances Codex only for definitive pre-turn rejection and retains ambiguous timeout activity', () => {
    const lane = between(
      'async function compactCodexProviderContext(',
      '/**\n * Host-triggered Claude context compaction'
    )
    expect(lane).toContain(
      "isCodexAppServerRequestTimeout(firstError, 'thread/compact/start')"
    )
    expect(lane).toContain(
      "updateCodexCompactionLaunchEvidence(\n              compactionLaunchMayBeLive,\n              'timeout'"
    )
    expect(lane).toContain('codexCompactionFailureProvesNoLiveTurn({')
    expect(lane).toContain(
      'maintenanceCompactionRegistry.endNativeActivity(payload.reservation)'
    )
  })

  it('tracks Kimi ACP immediately around spawn and ends only from close/strict-cleanup paths', () => {
    const lane = between(
      'async function compactKimiProviderContext(',
      '/**\n * Host-side SEAT compaction for ensemble Grok participants'
    )
    const beginAt = lane.indexOf('maintenanceCompactionRegistry.beginNativeActivity(')
    const spawnAt = lane.indexOf('child = spawn(admittedBinaryPath')
    expect(beginAt).toBeGreaterThanOrEqual(0)
    expect(spawnAt).toBeGreaterThan(beginAt)
    expect(lane).toContain("payload.reservation.signal.addEventListener('abort'")
    expect(lane).toContain("child?.kill('SIGKILL')")
    const closeAt = lane.indexOf('onClose: (_code, turnComplete, terminalStatus) => {')
    expect(closeAt).toBeGreaterThan(spawnAt)
    expect(
      lane.indexOf('maintenanceCompactionRegistry.endNativeActivity(payload.reservation)', closeAt)
    ).toBeGreaterThan(closeAt)
    expect(lane.lastIndexOf('maintenanceCompactionRegistry.canWrite(payload.reservation)')).toBeLessThan(
      lane.indexOf('appendContextCompactionMessageToChat(', closeAt)
    )
  })

  it('tracks every Grok child from spawn through close and generation-fences checkpoints', () => {
    const runner = between(
      'async function runHostSeatSummaryProcess(',
      'function persistHostSeatCompactionCheckpoint('
    )
    expect(runner.indexOf('maintenanceCompactionRegistry.beginNativeActivity(')).toBeLessThan(
      runner.indexOf('child = spawn(plan.command, plan.args')
    )
    const closeAt = runner.indexOf("child.on('close'")
    expect(closeAt).toBeGreaterThanOrEqual(0)
    expect(runner.indexOf('recordNativeClose()', closeAt)).toBeGreaterThan(closeAt)
    expect(runner).toContain("child.kill('SIGKILL')")

    const checkpoint = between(
      'function persistHostSeatCompactionCheckpoint(',
      'async function compactCliSeatContext('
    )
    expect(checkpoint.indexOf('maintenanceCompactionRegistry.canWrite(input.reservation)')).toBeLessThan(
      checkpoint.indexOf('AppStore.saveChat(updated)')
    )
  })

  it('discovers exact compactions plus a scope barrier and joins them before commit', () => {
    const deletion = between(
      'type BroadHistoryDeletionHolds = {',
      'const clearBroadChatHistory = '
    )
    expect(deletion).toContain("kind: 'maintenance-compaction'")
    expect(deletion).toContain('maintenanceCompactionId: compaction.id')
    expect(deletion).toContain('maintenanceCompactionRegistry.beginHistoryDeletion(')
    expect(deletion).toContain('maintenanceCompactionRegistry.cancelAndJoin(')
    expect(deletion).toContain('maintenanceCompactionRegistry.cancelAndJoinHold(')
    expect(deletion.indexOf('await quiescePreparedHistoryDeletion(')).toBeLessThan(
      deletion.indexOf('AppStore.commitPreparedHistoryDeletion(operationId)')
    )
  })
})
