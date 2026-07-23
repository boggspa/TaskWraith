import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
const constantsSource = readFileSync(new URL('../index.constants.ts', import.meta.url), 'utf8')

function between(startMarker: string, endMarker: string): string {
  const start = indexSource.indexOf(startMarker)
  const end = indexSource.indexOf(endMarker, start + startMarker.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return indexSource.slice(start, end)
}

describe('AntiGravity S3 runtime integration', () => {
  it('delegates only an official prepared launch into the shared stream and error lifecycle', () => {
    const runtime = between(
      'async function runAntigravityProvider(',
      '// Grok is a first-class provider'
    )

    expect(runtime).toContain('prepareAntigravityProviderLaunch({')
    expect(runtime).toContain('settings: AppStore.getSettings()')
    expect(runtime).toContain("payload.providerSessionId = null")
    expect(runtime).toContain("runCliProviderProcess(event, 'antigravity'")
    expect(runtime).toContain('resolvedEnv: launch.env')
    expect(runtime).toContain("runManager.finish(route.appRunId, 'failed')")
    expect(runtime).toContain("sendAgentCompatError(event.sender, 'antigravity'")
    expect(runtime).toContain("sendAgentCompatExit(event.sender, 'antigravity', 1, route)")
    expect(runtime).not.toContain('resolveCliProviderBinary')
    expect(runtime).not.toContain('--dangerously-skip-permissions')
    expect(runtime).not.toContain('--new-project')
  })

  it('uses the shared exact-run cancellation path and lifecycle inventory', () => {
    expect(indexSource).toContain("cancel: (runId) => cancelProviderRun('antigravity', runId)")
    expect(constantsSource).toContain("'antigravity'")
  })
})
