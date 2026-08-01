import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function sourceBetween(start: string, end: string, from = 0): string {
  const startIndex = indexSource.indexOf(start, from)
  const endIndex = indexSource.indexOf(end, startIndex + start.length)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return indexSource.slice(startIndex, endIndex)
}

describe('run orphan process reaper main integration', () => {
  it('shares the exact process observer and reaps before existing queue recovery', () => {
    const identity = indexSource.indexOf(
      'const processIdentity = new WorkspaceLockProcessIdentityService()'
    )
    const reaper = indexSource.indexOf(
      'runOrphanProcessReaperRef = new RunOrphanProcessReaper({',
      identity
    )
    const ownershipCapture = indexSource.indexOf(
      'void runOrphanProcessReaperRef?.capture(runId, pid)'
    )
    const startupReap = indexSource.indexOf('await runOrphanProcessReaperRef?.reap(')
    const queueRecovery = indexSource.indexOf(
      'const startupRecoveryRecords = AppStore.recoverRunQueueAfterStartup()'
    )

    expect(reaper).toBeGreaterThan(identity)
    expect(indexSource.slice(reaper, startupReap)).toContain('processIdentity,')
    expect(ownershipCapture).toBeGreaterThanOrEqual(0)
    expect(startupReap).toBeGreaterThan(reaper)
    expect(queueRecovery).toBeGreaterThan(startupReap)
  })

  it('puts every queue-tracked one-shot provider root in its own POSIX process group', () => {
    const generic = sourceBetween(
      'async function runCliProviderProcess(',
      'runManager.attachProcess(route.appRunId!, child)'
    )
    const grok = sourceBetween(
      'const grokSpawnAcpProcess = (): AcpChildProcess => {',
      '// NOTE: do NOT end stdin — ACP keeps the stdio channel open for requests.'
    )
    const mistral = sourceBetween(
      'const mistralSpawnAcpProcess = (): AcpChildProcess => {',
      '// NOTE: do NOT end stdin — ACP keeps the stdio channel open for requests.'
    )
    const kimiStart = indexSource.indexOf(
      'launch: (production, transportCleanup, admittedBinaryPath) => {'
    )
    const kimi = sourceBetween(
      'return spawn(admittedBinaryPath, args, {',
      '}) as unknown as',
      kimiStart
    )
    const codex = sourceBetween(
      'child = spawn(codexSpawnPlan.command, codexSpawnPlan.args, {',
      'codexExecProcess = child'
    )
    const gemini = sourceBetween(
      'child = spawn(resolved.binaryPath, args, {',
      'geminiProcess = child'
    )

    for (const launch of [generic, grok, mistral, kimi, codex, gemini]) {
      expect(launch).toContain("detached: process.platform !== 'win32'")
    }
  })
})
