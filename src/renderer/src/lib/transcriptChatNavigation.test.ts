import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('transcript chat navigation integration', () => {
  it('routes chat identity transitions through scroll-state capture', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const directAssignments = [...source.matchAll(/currentChatIdRef\.current\s*=(?!=)/g)]

    // One assignment belongs to setCurrentChatIdForNavigation itself; the
    // other is the post-render ref synchronizer for same-chat record updates.
    // Any navigation path adding a third direct write would bypass the outgoing
    // transcript capture and should make this guard fail until it uses the
    // shared transition helper.
    expect(directAssignments).toHaveLength(2)
    expect(source).toContain('setCurrentChatIdForNavigation(selectedChat.appChatId)')
    expect(source).toContain('setCurrentChatIdForNavigation(null)')
  })

  it('keeps external restore ownership until the chat-switch effect observes it', () => {
    const source = readFileSync(
      new URL('../app/state/useTranscriptScrollState.ts', import.meta.url),
      'utf8'
    )
    expect(source).toContain(
      'chatSwitchObserved: committedChatIdRef.current === targetChatId'
    )
    expect(source).toContain(
      "advanceExternalRestoreLifecycle(pending.lifecycle, 'settled')"
    )
    expect(source.match(/pendingExternalRestoreRef\.current = transition\.shouldClear \? null : nextPending/g)).toHaveLength(2)

    const observedIndex = source.indexOf("'chat-switch-observed'")
    const retainedRecordIndex = source.indexOf(
      'pendingExternalRestoreRecord = nextPending',
      observedIndex
    )
    const cachedPlanIndex = source.indexOf(
      'const pendingExternalRestore = pendingExternalRestoreRecord?.cached',
      retainedRecordIndex
    )
    const planIndex = source.indexOf('resolveTranscriptChatSwitchPlan({', cachedPlanIndex)
    expect(observedIndex).toBeGreaterThanOrEqual(0)
    expect(retainedRecordIndex).toBeGreaterThan(observedIndex)
    expect(cachedPlanIndex).toBeGreaterThan(retainedRecordIndex)
    expect(planIndex).toBeGreaterThan(cachedPlanIndex)
  })
})
