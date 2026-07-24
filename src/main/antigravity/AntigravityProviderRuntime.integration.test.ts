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
  it('delegates combined-mode dispatch then keeps official agy launch on the shared stream lifecycle', () => {
    const dispatch = between(
      'async function runAntigravityProvider(',
      'async function runAntigravityAgyProvider('
    )
    expect(dispatch).toContain('dispatchAntigravityCombinedMode(event, payload, {')
    // The gemini-api lane registers its own RunManager session (no child
    // process registers one for it) and delegates the run to the agentic
    // Gemini API runtime under provider 'antigravity'.
    expect(dispatch).toContain("registerRunSession(\n        'antigravity',")
    expect(dispatch).toContain('runGeminiApiAgentTurn:')
    expect(dispatch).toContain('tryRunGeminiApi(')
    expect(dispatch).toContain('antigravityGeminiApiAgentDeps(wireModel)')
    expect(dispatch).toContain('runAgyProvider: runAntigravityAgyProvider')
    expect(dispatch).not.toContain('prepareAntigravityProviderLaunch')

    const agy = between(
      'async function runAntigravityAgyProvider(',
      '// Grok is a first-class provider'
    )
    expect(agy).toContain('prepareAntigravityProviderLaunch({')
    expect(agy).toContain('settings: AppStore.getSettings()')
    expect(agy).toContain('payload.providerSessionId = null')
    expect(agy).toContain("runCliProviderProcess(event, 'antigravity'")
    expect(agy).toContain('resolvedEnv: launch.env')
    expect(agy).toContain("runManager.finish(route.appRunId, 'failed')")
    expect(agy).toContain("sendAgentCompatError(event.sender, 'antigravity'")
    expect(agy).toContain("sendAgentCompatExit(event.sender, 'antigravity', 1, route)")
    expect(agy).not.toContain('resolveCliProviderBinary')
    expect(agy).not.toContain('--dangerously-skip-permissions')
    expect(agy).not.toContain('--new-project')
  })

  it('binds the dedicated Gemini API secret store only after app ready', () => {
    expect(indexSource).toContain(
      'let antigravityGeminiApiSecretStoreRef: AntigravityGeminiApiSecretStore | null = null'
    )
    expect(indexSource).toContain(
      'antigravityGeminiApiSecretStoreRef = antigravityGeminiApiSecretStore'
    )
    const readyIdx = indexSource.indexOf(
      'antigravityGeminiApiSecretStoreRef = antigravityGeminiApiSecretStore'
    )
    const constructIdx = indexSource.indexOf('new AntigravityGeminiApiSecretStore({')
    expect(constructIdx).toBeGreaterThanOrEqual(0)
    expect(readyIdx).toBeGreaterThan(constructIdx)
  })

  it('uses the shared exact-run cancellation path and lifecycle inventory', () => {
    expect(indexSource).toContain("cancel: (runId) => cancelProviderRun('antigravity', runId)")
    expect(constantsSource).toContain("'antigravity'")
  })
})
