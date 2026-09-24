/**
 * Ambient-escalation narrowing (blackboard decision `ambient-escalation-narrowing`).
 *
 * A paged thread (summaryOnly shell + bounded store window) must STAY PAGED on
 * plain open: the always-mounted context meter used to force a background full
 * hydration of every oversized thread, reducing paging to fast-first-paint and
 * making accumulated infinite scroll moot for the focused thread. The contract
 * pinned here:
 *
 *  1. The ambient paged → refreshSingleChat effect is DEMAND-GATED: it fires
 *     only when a whole-transcript (Class W) surface is actually open (thread
 *     search invoked, pins panel opened). The gate must sit between the paged
 *     check and the hydrate call, and the effect must re-evaluate when either
 *     surface toggles (both are in the dependency list).
 *  2. The ambient context figure never derives from a bounded page: while
 *     paged, `currentContextUsage` receives run stats only and the
 *     message-derived compaction-evidence part is omitted (unknown), never
 *     page-fed and never a misleading 0.
 *
 * App.tsx has no unit harness; this is the repo's source-scan idiom (compare
 * multiviewWorkspacePresentation.test.ts). Red by construction: every marker
 * asserted below was introduced by the narrowing slice — pre-slice source
 * contains none of them.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

/** Slice from `start` to the next `end` after it; fails naming the marker. */
function sliceBetween(start: string, end: string): string {
  const startIndex = source.indexOf(start)
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

const DEMAND_GATE = 'if (!threadSearchOpen && !isPinnedMessagesPanelOpen) return'
const HYDRATE_CALL = 'void refreshSingleChat(chatId)'

describe('ambient escalation narrowing (paged thread stays paged on plain open)', () => {
  it('demand-gates the paged escalation effect behind an open Class W surface', () => {
    // The paged effect is the one anchored on the paged early-return; it ends
    // where the next derived value (latestSideChatRunResultSeed) begins.
    const effect = sliceBetween(
      '  useEffect(() => {\n    if (!currentChatTranscript.paged) return',
      'const latestSideChatRunResultSeed = useMemo(() => {'
    )

    // The gate exists, and it sits BETWEEN the paged check and the hydrate.
    const gateIndex = effect.indexOf(DEMAND_GATE)
    expect(gateIndex, 'paged effect is not demand-gated').toBeGreaterThanOrEqual(0)
    const hydrateIndex = effect.indexOf(HYDRATE_CALL)
    expect(hydrateIndex, 'paged effect no longer hydrates at all').toBeGreaterThanOrEqual(0)
    expect(gateIndex).toBeLessThan(hydrateIndex)

    // Exactly one hydrate call inside the effect — the demand path.
    expect(effect.match(/void refreshSingleChat\(chatId\)/g)).toHaveLength(1)

    // Both surface states are effect dependencies, so opening search/pins
    // re-fires the effect and issuing the (request-pool-deduped) hydrate.
    expect(effect).toContain('threadSearchOpen,')
    expect(effect).toContain('isPinnedMessagesPanelOpen,')
  })

  it('renders the ambient context figure from run stats only while paged', () => {
    const donut = sliceBetween(
      'const currentContextUsageSnapshot = currentContextUsage(',
      'const currentContextUsedTokens ='
    )
    // Runs always come through the window seam (loaded-window tail is
    // sufficient for the current-run stats)...
    expect(donut).toContain('currentContextUsage(currentChatTranscript.runs')
    // ...and the message-derived compaction evidence is omitted while paged —
    // unknown, never the bounded page and never a hard 0.
    expect(donut).toContain(
      'messages: currentChatTranscript.paged ? undefined : currentChatTranscript.messages'
    )
    // The old ambient shape (always feeding the record's arrays) is gone.
    expect(donut).not.toContain('messages: currentChat?.messages || []')
  })
})
