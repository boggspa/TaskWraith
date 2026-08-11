import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

/**
 * The composer Steer button is the ONLY user gesture that reaches the solo
 * live-steering lane (`handleSteer` → prepared barrier → attemptLiveSteering →
 * `steering:inject`). The queued-row Steer action is boundary-only by design
 * (promote → wait for the run to idle → dispatch), so if the composer button
 * disappears, live injection for every provider (pi frame, ACP interrupt,
 * Cursor/Ollama broker-injection) goes dark UI-side while all its main-process
 * machinery keeps passing tests — exactly the regression this file pins.
 *
 * Composer has no DOM test environment, so these are source-structure
 * assertions in the established style of midRunSteeringQueue.test.ts.
 */
describe('composer steer button (solo live steering gesture)', () => {
  const composerSource = readFileSync(
    new URL('../components/Composer.tsx', import.meta.url),
    'utf8'
  )

  it('destructures the live-capable steer handler, not just the queued-row one', () => {
    expect(composerSource).toContain('\n    handleSteer,')
    expect(composerSource).toContain('\n    handleSteerToQueuedMessage,')
  })

  it('renders Steer beside Stop while the chat runs, wired to handleSteer', () => {
    const cluster = composerSource.indexOf('className="composer-send-cluster"')
    expect(cluster).toBeGreaterThan(0)
    const steerBtn = composerSource.indexOf('steer-btn', cluster)
    const stopBtn = composerSource.indexOf('stop-btn', cluster)
    expect(steerBtn).toBeGreaterThan(cluster)
    // Steer renders before Stop so the destructive control keeps its edge slot.
    expect(stopBtn).toBeGreaterThan(steerBtn)
    const steerSlice = composerSource.slice(steerBtn, stopBtn)
    expect(steerSlice).toContain('handleSteer(')
    expect(steerSlice).toContain('SteerSymbolIcon')
    // A second steer for the same chat must wait for the first to settle.
    expect(steerSlice).toContain('isSteerBusyForCurrentChat')
  })

  it('only offers Steer when the gesture can deliver something', () => {
    const cluster = composerSource.indexOf('className="composer-send-cluster"')
    const running = composerSource.indexOf('isCurrentChatRunning ?', cluster)
    const steerGate = composerSource.indexOf('isCurrentChatBusyForSteer', running)
    const stopBtn = composerSource.indexOf('stop-btn', running)
    expect(running).toBeGreaterThan(cluster)
    // The gate lives inside the running branch, ahead of the Stop control.
    expect(steerGate).toBeGreaterThan(running)
    expect(steerGate).toBeLessThan(stopBtn)
    const gateSlice = composerSource.slice(steerGate, stopBtn)
    // Present handler + non-empty draft; a dead or empty steer renders nothing.
    expect(gateSlice).toContain("typeof handleSteer === 'function'")
    expect(gateSlice).toContain('prompt.trim()')
  })

  it('detached side-chat surfaces omit the handler instead of wiring a dead button', () => {
    const sideSource = readFileSync(new URL('./sideChatComposer.ts', import.meta.url), 'utf8')
    expect(sideSource).toContain('handleSteer: undefined')
    expect(sideSource).not.toContain('handleSteer: NOOP_SIDE_CHAT_COMPOSER_ACTION')
  })
})
