import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

function between(start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('Codex client lifecycle queue integration', () => {
  it('waits through the abortable FIFO instead of a bare promise tail', () => {
    const acquire = between(
      'async function acquireCodexClientLifecycleLease(',
      'async function disposeCodexClientForOwnerTransition('
    )

    expect(source).toContain('const codexClientLifecycleQueue = new CodexClientLifecycleQueue()')
    expect(acquire).toContain('codexClientLifecycleQueue.enqueue()')
    expect(acquire).toContain('queueSlot.waitUntilAcquired(signal)')
    expect(acquire).toContain('queueSlot.release()')
    expect(acquire).not.toContain('Promise.race')
    expect(source).not.toContain('codexClientLifecycleTail')
  })

  it('makes provider setup cancellation abort the lifecycle wait without exec fallback', () => {
    const providerLease = between(
      'async function acquireCodexProviderClientRunLease(',
      '/**\n * 1.0.4-AD — pre-flight reachability probe'
    )
    const provider = between(
      'async function runCodexProvider(',
      'const ollamaMainRuntime = createOllamaMainRuntime('
    )

    expect(providerLease).toContain('payload.providerSetupAbortSignal')
    const abortCatch = provider.indexOf(
      'if (error instanceof CodexClientLifecycleAcquireAbortedError)'
    )
    const fallback = provider.indexOf('await runCodexExecFallback(')
    expect(abortCatch).toBeGreaterThanOrEqual(0)
    expect(abortCatch).toBeLessThan(fallback)
    expect(provider.slice(abortCatch, fallback)).toContain('settleDeniedProviderTransportLaunch(')
    expect(provider.slice(abortCatch, fallback)).toContain('return')
  })
})
