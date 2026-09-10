import { describe, expect, it } from 'vitest'
import { MainSourceProbe } from '../mainSourceProbe.testutil'

const probe = new MainSourceProbe('src/main/index.ts', new URL('../index.ts', import.meta.url))
// The lifecycle inventory lives in its own module, so it gets its own probe
// rather than a raw text read: `binding` throws when the list is renamed or
// removed, where a whole-file `toContain("'antigravity'")` was satisfied by any
// mention anywhere in the file — a comment included.
const constants = new MainSourceProbe(
  'src/main/index.constants.ts',
  new URL('../index.constants.ts', import.meta.url)
)

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
    // Launch preparation belongs to the agy lane alone. (The name is proven
    // live by the agy test below, which requires exactly one call to it there,
    // so this zero-count cannot be satisfied by a rename.)
    expect(probe.callsTo(dispatch, 'prepareAntigravityProviderLaunch')).toHaveLength(0)
  })

  it('launches official agy with a resumable conversation and no permission bypass', () => {
    const agy = probe.fn('runAntigravityAgyProvider')

    const prepare = probe.callsTo(agy, 'prepareAntigravityProviderLaunch')
    expect(prepare).toHaveLength(1)
    expect(probe.propText(prepare[0], 0, 'settings')).toBe('AppStore.getSettings()')
    expect(probe.propText(prepare[0], 0, 'workflowMode')).toBe('payload.workflowMode')
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
    const terminalDrain = probe.propText(run[0], 5, 'beforeTerminalProjection')
    expect(terminalDrain).toContain(
      'completedFinalResponse = await brainTranscriptMonitor.stopAndDrain()'
    )
    const failedExitRecovery = probe.propText(run[0], 5, 'failedExitContentRecovery')
    expect(failedExitRecovery).toContain('planAntigravityFailedExitFinalRecovery')
    expect(failedExitRecovery).toContain('terminalClaimed')
    expect(failedExitRecovery).toContain('finalResponse: completedFinalResponse')

    // The binary and the argv both come from the prepared launch, never
    // re-resolved here. The positional claims are the positive half: without
    // them the zero-count below would also pass over a function that had
    // stopped launching anything at all.
    expect(probe.argText(run[0], 2)).toBe('launch.binary.binaryPath!')
    expect(probe.argText(run[0], 3)).toBe('launch.args')
    expect(probe.callsTo(agy, 'resolveCliProviderBinary')).toHaveLength(0)

    // The only thing this lane does with the bypass flag is filter it OUT of
    // the prepared argv (see the overlay-failure test). Pinning that
    // comparison positively is what keeps the absence claim below honest: it
    // proves the flag is still named here, so `not.toMatch` is answering about
    // a scope that really does handle it.
    expect(probe.comparesStrictly(agy, 'a', "'--dangerously-skip-permissions'")).toBe(true)
    expect(probe.text(agy)).not.toMatch(
      /\.(push|unshift)\(\s*['"]--dangerously-skip-permissions['"]\s*\)/
    )
  })

  it('lets a live hook arbitrate the write lease after an accept-edits launch', () => {
    // `binding` throws if the decision is renamed or folded away, where the
    // old whole-function regex would simply stop matching anything it claimed.
    const allowWrite = probe.binding('allowWrite')

    // Both gates are still present in the decision itself, independent of how
    // it is wrapped or formatted.
    expect(probe.comparesEqual(allowWrite, 'launch.mode', "'accept-edits'")).toBe(true)
    expect(probe.comparesStrictly(allowWrite, 'permissions?.readOnly', 'true')).toBe(true)

    // Ask retains `readOnly: true` in its signed posture, so the live bridge
    // must be the first alternative. An unbridged posture still reaches the
    // readOnly check and cannot open the settings write rule.
    //
    // Operand ORDER is the claim, and the probe has no operand walker, so this
    // half stays textual — but over the normalized initializer only, anchored
    // at its start, so it cannot match some other `allowWrite`-shaped text.
    expect(probe.text(allowWrite).replace(/\s+/g, ' ')).toMatch(
      /^launch\.mode === 'accept-edits' && \(arbitratedByHook \|\| \(permissions\?\.readOnly !== true &&/
    )
  })

  it('settles a setup failure rather than leaving the run unfinished', () => {
    // Previously asserted as a literal `runManager.finish(route.appRunId,
    // 'failed')` inside this function. That call moved into the shared
    // settlement helper without any change to what a failed setup does, so the
    // old assertion failed while the guarantee held. Follow the delegation
    // instead of pinning the mechanism.
    const agy = probe.fn('runAntigravityAgyProvider')
    const settle = probe.callsTo(agy, 'settleVisibleProviderSetupFailure')
    // Three settle sites, and EVERY one must settle the run — an unsettled
    // path is a run Stop can never finish, which is the guarantee this pins:
    //   1. launch preparation threw (setup required: binary/consent/argv);
    //   2. the approval bridge could not be installed for a run whose write
    //      capability depended on it, so proceeding would mean an unarbitrated
    //      writer in a shared checkout. Not a setup problem — retryable;
    //   3. the permission lease could not be written into agy's settings, so
    //      launching would doom the turn to headless auto-denial with no
    //      assistant output. Aborting is the only honest outcome.
    expect(settle).toHaveLength(3)
    for (const call of settle) {
      expect(probe.propText(call, 0, 'provider')).toBe("'antigravity'")
      expect(probe.propText(call, 0, 'fallback')).toBe('false')
    }
    expect(probe.propText(settle[0], 0, 'setupRequired')).toBe('true')
    expect(probe.propText(settle[1], 0, 'setupRequired')).toBe('false')
    expect(probe.propText(settle[2], 0, 'setupRequired')).toBe('false')
    expect(probe.propText(settle[2], 0, 'message')).toContain(
      'signed in-workspace permissions into official agy settings'
    )
    // The lease-failure site must return after settling — continuing past it
    // is what let agy launch with no allow rules and die silently.
    //
    // The window is anchored on the END of that settle call node, and stops at
    // the first brace in either direction, so the `return` it finds is a
    // statement in the SAME block. The previous form searched 1200 characters
    // after a message substring for the word "return", which any surrounding
    // code satisfies — it was green whether or not this site returned.
    const fileText = probe.source.getFullText()
    const afterLeaseSettle = fileText.slice(settle[2].getEnd(), settle[2].getEnd() + 200)
    expect(afterLeaseSettle).toMatch(/^[^{}]*\breturn\b/)

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
    // The module-scope ref starts empty. Constructing the store eagerly would
    // touch safeStorage and userData before Electron is ready.
    expect(probe.text(probe.binding('antigravityGeminiApiSecretStoreRef'))).toBe('null')

    // Lexical containment in the ready callback, which is the actual claim.
    // The old form compared two `indexOf` offsets, which says only that one
    // line is printed below another — it held equally for a store constructed
    // at module load.
    const readyThen = probe
      .callsTo(probe.source, 'then')
      .find((call) => probe.text(call.expression).replace(/\s+/g, '') === 'app.whenReady().then')
    expect(readyThen).toBeDefined()
    const readyScope = readyThen!.arguments[0]
    expect(readyScope).toBeDefined()

    const built = probe.construction('AntigravityGeminiApiSecretStore', readyScope)
    expect(built).toHaveLength(1)
    // Sole construction site in the whole file, so nothing can build one
    // earlier: this is what makes "only after app ready" a real claim rather
    // than a statement about the first textual occurrence.
    expect(probe.construction('AntigravityGeminiApiSecretStore')).toHaveLength(1)
    // And it is post-ready BECAUSE of what it reads — both of these throw or
    // return nothing usable before app ready.
    expect(probe.propText(built[0], 0, 'userDataPath')).toBe("app.getPath('userData')")
    expect(probe.propText(built[0], 0, 'safeStorage')).toBe('safeStorage')

    // The ref is bound from inside the same ready scope, once.
    expect(probe.assignmentsTo(readyScope, 'antigravityGeminiApiSecretStoreRef')).toEqual([
      'antigravityGeminiApiSecretStore'
    ])
    expect(probe.assignmentsTo(probe.source, 'antigravityGeminiApiSecretStoreRef')).toHaveLength(1)
  })

  it('uses the shared exact-run cancellation path and lifecycle inventory', () => {
    // Scoped to the adapter table: `binding` throws if it is renamed or
    // deleted, where a whole-file `toContain` kept passing as long as any copy
    // of the line survived anywhere in index.ts.
    const adapters = probe.binding('antigravityAdapters')
    const cancels = probe.callsTo(adapters, 'cancelProviderRun')
    expect(cancels).toHaveLength(1)
    expect(probe.argText(cancels[0], 0)).toBe("'antigravity'")
    // Exact run: the id the adapter is handed is the id forwarded, never a
    // provider-wide kill.
    expect(probe.argText(cancels[0], 1)).toBe('runId')
    // The call still has to be the adapter's `cancel` seam. The probe reads
    // object-literal properties only inside call/new arguments, and this
    // literal is an array element, so the key binding stays textual — now
    // scoped to the adapter table rather than the whole file.
    expect(probe.text(adapters)).toContain(
      "cancel: (runId) => cancelProviderRun('antigravity', runId)"
    )

    // Lifecycle/cleanup inventory membership, read out of the list itself.
    expect(constants.text(constants.binding('RUN_MANAGER_PROVIDERS'))).toContain("'antigravity'")
  })

  it('projects arbitrated agy tool calls into the transcript', () => {
    const agy = probe.fn('runAntigravityAgyProvider')

    // The PreToolUse bridge callback is agy's only observable seam. Without
    // projection, native tool calls happen headlessly and the transcript
    // stays empty even though work occurred on disk.
    const emitCalls = probe.callsTo(agy, 'emitAgyHookToolEvent')
    // EXACT, not a floor. `toBeGreaterThanOrEqual(4)` stood over SEVEN real
    // projection sites, so three could be deleted and this stayed green — and an
    // arbitrated tool call that goes unprojected is the whole point of the test.
    // A legitimate eighth site should update this number; that edit is the
    // review prompt this assertion exists to force.
    expect(emitCalls).toHaveLength(7)

    // The single sendAgentCompatLine helper inside emitAgyHookToolEvent
    // branches on eventType and emits both tool_use and tool_result shapes.
    const compatCall = probe
      .callsTo(agy, 'sendAgentCompatLine')
      .find((call) => probe.argText(call, 2).includes("'tool_use'"))
    expect(compatCall).toBeDefined()
    expect(probe.argText(compatCall!, 2)).toContain("'tool_result'")
    expect(probe.argText(compatCall!, 3)).toBe('route')

    // The helper must be wired for both shell and write tool kinds. These are
    // template-literal tool-id prefixes built into locals, which the probe has
    // no locator for, so they stay textual — scoped to the agy function, whose
    // existence `fn` has already proven.
    expect(probe.text(agy)).toContain('agy-shell-')
    expect(probe.text(agy)).toContain('agy-write-')
  })

  it('strips --dangerously-skip-permissions if the hook overlay fails to install', () => {
    const agy = probe.fn('runAntigravityAgyProvider')

    // Both halves of the overlay lifecycle, as an exact pair: installed once
    // on the success path, and explicitly unset in the recovery path. A
    // presence-only claim survives deleting either one.
    const overlayAssignments = probe.assignmentsTo(agy, 'hookOverlay')
    expect(overlayAssignments).toHaveLength(2)
    expect(overlayAssignments[0]).toContain('hooksPath:')
    expect(overlayAssignments[1]).toBe('undefined')

    // If the hook bridge failed to stand up, agy's native confirmation MUST
    // not be skipped — so the one and only thing done to the prepared argv is
    // removing the bypass flag. Reading the assignment structurally also pins
    // that nothing ELSE rewrites launch.args in this function.
    expect(probe.assignmentsTo(agy, 'launch.args')).toEqual([
      "launch.args.filter((a) => a !== '--dangerously-skip-permissions')"
    ])

    // Ensure the strip happens in the failure recovery path where the overlay
    // is unset, and close enough to be the same catch block. Block membership
    // is not expressible with the probe's locators, so this half stays
    // positional — but both anchors are proven unique by the exact assignment
    // lists above.
    const source = probe.text(agy)
    const hookOverlayIdx = source.indexOf('hookOverlay = undefined')
    const stripIdx = source.indexOf('launch.args = launch.args.filter(')
    expect(hookOverlayIdx).toBeGreaterThan(-1)
    expect(stripIdx).toBeGreaterThan(hookOverlayIdx)
    expect(stripIdx - hookOverlayIdx).toBeLessThan(500)
  })
})
