import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MainSourceProbe } from '../mainSourceProbe.testutil'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
const constantsSource = readFileSync(new URL('../index.constants.ts', import.meta.url), 'utf8')
const probe = new MainSourceProbe('src/main/index.ts', new URL('../index.ts', import.meta.url))

describe('AntiGravity S3 runtime integration', () => {
  it('delegates combined-mode dispatch to the shared gemini-api runtime', () => {
    const dispatch = probe.fn('runAntigravityProvider')

    expect(probe.callsTo(dispatch, 'dispatchAntigravityCombinedMode')).toHaveLength(1)
    // The gemini-api lane registers its own RunManager session (no child
    // process registers one for it) and delegates the run to the agentic
    // Gemini API runtime under provider 'antigravity'.
    const register = probe.callsTo(dispatch, 'registerRunSession')
    expect(register).toHaveLength(1)
    expect(probe.argText(register[0], 0)).toBe("'antigravity'")

    const combined = probe.callsTo(dispatch, 'dispatchAntigravityCombinedMode')[0]
    expect(probe.propText(combined, 2, 'runGeminiApiAgentTurn')).not.toBeNull()
    expect(probe.propText(combined, 2, 'runAgyProvider')).toBe('runAntigravityAgyProvider')
    expect(probe.callsTo(dispatch, 'tryRunGeminiApi')).toHaveLength(1)
    expect(probe.callsTo(dispatch, 'antigravityGeminiApiAgentDeps')).toHaveLength(1)
    // Launch preparation belongs to the agy lane alone.
    expect(probe.callsTo(dispatch, 'prepareAntigravityProviderLaunch')).toHaveLength(0)
  })

  it('launches official agy with a resumable conversation and no permission bypass', () => {
    const agy = probe.fn('runAntigravityAgyProvider')

    const prepare = probe.callsTo(agy, 'prepareAntigravityProviderLaunch')
    expect(prepare).toHaveLength(1)
    expect(probe.propText(prepare[0], 0, 'settings')).toBe('AppStore.getSettings()')
    // Resumption: the prior conversation goes in, and the id agy actually used
    // is re-learned from its own receipt after the turn. Both halves are
    // required — passing an id agy does not recognise silently starts a fresh
    // conversation, so without the re-read a stale id would strand the chat.
    expect(probe.propText(prepare[0], 0, 'conversationId')).toBe('payload.providerSessionId')
    expect(probe.assignmentsTo(agy, 'payload.providerSessionId')).toEqual([
      'formatAgyProjectBoundSessionId(launch.resumedConversationId)'
    ])

    const run = probe.callsTo(agy, 'runCliProviderProcess')
    expect(run).toHaveLength(1)
    expect(probe.argText(run[0], 1)).toBe("'antigravity'")
    expect(probe.propText(run[0], 5, 'resolvedEnv')).toBe('launch.env')
    const exitSessionResolver = probe.propText(run[0], 5, 'resolveExitSessionId')
    expect(exitSessionResolver).toContain('readAgyConversationReceipt(payload.workspace)')
    expect(exitSessionResolver).toContain('learned === receiptBeforeFreshProject')
    expect(exitSessionResolver).toContain('formatAgyProjectBoundSessionId(learned)')

    // The binary comes from the prepared launch, never re-resolved here.
    expect(probe.callsTo(agy, 'resolveCliProviderBinary')).toHaveLength(0)
    // Literal argv content — a string check is the right tool for these.
    expect(probe.text(agy)).not.toContain('--dangerously-skip-permissions')
  })

  it('settles a setup failure rather than leaving the run unfinished', () => {
    // Previously asserted as a literal `runManager.finish(route.appRunId,
    // 'failed')` inside this function. That call moved into the shared
    // settlement helper without any change to what a failed setup does, so the
    // old assertion failed while the guarantee held. Follow the delegation
    // instead of pinning the mechanism.
    const agy = probe.fn('runAntigravityAgyProvider')
    const settle = probe.callsTo(agy, 'settleVisibleProviderSetupFailure')
    // Two settle sites, and EVERY one must settle the run — an unsettled path
    // is a run Stop can never finish, which is the guarantee this pins:
    //   1. launch preparation threw (setup required: binary/consent/argv);
    //   2. the approval bridge could not be installed for a run whose write
    //      capability depended on it, so proceeding would mean an unarbitrated
    //      writer in a shared checkout. Not a setup problem — retryable.
    expect(settle).toHaveLength(2)
    for (const call of settle) {
      expect(probe.propText(call, 0, 'provider')).toBe("'antigravity'")
      expect(probe.propText(call, 0, 'fallback')).toBe('false')
    }
    expect(probe.propText(settle[0], 0, 'setupRequired')).toBe('true')
    expect(probe.propText(settle[1], 0, 'setupRequired')).toBe('false')

    // And the helper it delegates to still does both halves: project the
    // failure to the renderer, and finish the run as failed. Without the
    // second, a setup failure leaves a run that Stop can never settle.
    const helper = probe.fn('settleVisibleProviderSetupFailure')
    expect(probe.callsTo(helper, 'projectVisibleProviderSetupFailure')).toHaveLength(1)
    const finish = probe.callsTo(helper, 'settleProviderRunWithoutTransport')
    expect(finish).toHaveLength(1)
    expect(probe.argText(finish[0], 2)).toBe("'failed'")

    // The renderer-visible half: an error line and a non-zero exit.
    const project = probe.fn('projectVisibleProviderSetupFailure')
    expect(probe.callsTo(project, 'sendAgentCompatError')).toHaveLength(1)
    const exit = probe.callsTo(project, 'sendAgentCompatExit')
    expect(exit).toHaveLength(1)
    expect(probe.argText(exit[0], 2)).toBe('input.exitCode ?? 1')
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

  it('projects arbitrated agy tool calls into the transcript', () => {
    const agy = probe.fn('runAntigravityAgyProvider')

    // The PreToolUse bridge callback is agy's only observable seam. Without
    // projection, native tool calls happen headlessly and the transcript
    // stays empty even though work occurred on disk.
    const emitCalls = probe.callsTo(agy, 'emitAgyHookToolEvent')
    expect(emitCalls.length).toBeGreaterThanOrEqual(4)

    // The single sendAgentCompatLine helper inside emitAgyHookToolEvent
    // branches on eventType and emits both tool_use and tool_result shapes.
    const compatCall = probe
      .callsTo(agy, 'sendAgentCompatLine')
      .find((call) => probe.argText(call, 2).includes("'tool_use'"))
    expect(compatCall).toBeDefined()
    expect(probe.argText(compatCall!, 2)).toContain("'tool_result'")
    expect(probe.argText(compatCall!, 3)).toBe('route')

    // The helper must be wired for both shell and write tool kinds.
    expect(probe.text(agy)).toContain('agy-shell-')
    expect(probe.text(agy)).toContain('agy-write-')
  })
})
