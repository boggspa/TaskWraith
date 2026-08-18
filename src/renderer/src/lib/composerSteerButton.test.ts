import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

/**
 * Solo live steering used to be reachable only through the composer Steer
 * button — `handleSteer` → prepared barrier → attemptLiveSteering →
 * `steering:inject`. The button was removed (so the destructive Stop control
 * keeps its edge slot) but the live-steering lane itself must stay reachable
 * from the keyboard: pressing Return while a round runs now dispatches
 * `handleSteer` from the Enter handler. The queued-row Steer action is still
 * boundary-only by design (promote → wait for the run to idle → dispatch), so
 * if either gesture disappears, live injection for every provider (pi frame,
 * ACP interrupt, Cursor/Ollama broker-injection) goes dark UI-side while all
 * its main-process machinery keeps passing tests — exactly the regression
 * this file pins.
 *
 * Composer has no DOM test environment, so these are source-structure
 * assertions in the established style of midRunSteeringQueue.test.ts.
 */
describe('composer steer gesture (solo live steering lane)', () => {
  const composerSource = readFileSync(
    new URL('../components/Composer.tsx', import.meta.url),
    'utf8'
  )

  it('destructures the live-capable steer handler, not just the queued-row one', () => {
    expect(composerSource).toContain('\n    handleSteer,')
    expect(composerSource).toContain('\n    handleSteerToQueuedMessage,')
  })

  it('no longer renders a dedicated Steer button inside the send cluster', () => {
    const cluster = composerSource.indexOf('className="composer-send-cluster"')
    expect(cluster).toBeGreaterThan(0)
    // The button class and the glyph import are both gone.
    expect(composerSource).not.toContain('composer-action-btn steer-btn')
    expect(composerSource).not.toContain('<SteerSymbolIcon />')
    expect(composerSource).not.toContain(', SteerSymbolIcon,')
    // Stop keeps its edge slot and is still disabled while a steer is in flight.
    const stopBtn = composerSource.indexOf('stop-btn', cluster)
    expect(stopBtn).toBeGreaterThan(cluster)
    const stopSlice = composerSource.slice(stopBtn, stopBtn + 400)
    expect(stopSlice).toContain('isSteerBusyForCurrentChat')
  })

  it('still offers solo live steering from the Return-key path while a round runs', () => {
    // The gate mirrors the original button gates (handler present, draft
    // non-empty, chat busy enough for steer, not already steering) and lives
    // inside the Enter onKeyDown branch — ahead of the handleRun dispatch so
    // a busy round never falls through to a cold start.
    const enterKey = composerSource.indexOf("e.key === 'Enter'")
    expect(enterKey).toBeGreaterThan(0)
    const runDispatch = composerSource.indexOf('handleRun(', enterKey)
    expect(runDispatch).toBeGreaterThan(enterKey)
    const steerBranch = composerSource.slice(enterKey, runDispatch)
    expect(steerBranch).toContain('isCurrentChatRunning')
    expect(steerBranch).toContain("typeof handleSteer === 'function'")
    expect(steerBranch).toContain('isCurrentChatBusyForSteer')
    expect(steerBranch).toContain('prompt.trim()')
    expect(steerBranch).toContain('isSteerBusyForCurrentChat')
    expect(steerBranch).toContain('void handleSteer()')
  })

  it('detached side-chat surfaces omit the handler instead of wiring a dead button', () => {
    const sideSource = readFileSync(new URL('./sideChatComposer.ts', import.meta.url), 'utf8')
    expect(sideSource).toContain('handleSteer: undefined')
    expect(sideSource).not.toContain('handleSteer: NOOP_SIDE_CHAT_COMPOSER_ACTION')
  })
})
