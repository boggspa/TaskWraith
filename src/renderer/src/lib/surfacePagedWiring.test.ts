/**
 * Stage 1b paged-open wiring for SECONDARY chat surfaces.
 *
 * `lib/chatSurfacePagedHydration.ts` landed the policy; for a while nothing
 * imported it, so the pop-out / Compact Companion boot and the multiview panes
 * still full-fetched every chat. This suite pins the App.tsx side of that
 * wiring, plus the one surface that deliberately does NOT adopt it.
 *
 * Contract pinned here:
 *
 *  1. The pane coordinator treats a loaded shell as hydrated. The previous
 *     `!isChatSummaryRecord` binding read every shell as un-hydrated, so the
 *     coordinator escalated each one back to a full fetch — including the
 *     FOCUSED chat's shell whenever a pane shared it, which undid Stage 1b for
 *     the main window in split mode.
 *  2. The pop-out boot opens through the shared policy instead of an
 *     unconditional `window.api.getChat`, and resolves the row it already holds
 *     rather than `chatByIdRef` (empty at boot until React commits, which would
 *     make every paged open silently fall through to a full fetch).
 *  3. Pane welcome-ness is shell-aware and uses the same role-aware predicate
 *     as the main projection. A paged shell has no messages loaded, while an
 *     unstarted chat may legitimately contain system-only configuration rows.
 *  4. The linked side chat deliberately stays on FULL hydration. Presenting one
 *     always mutates it (`applySideChatLifecycle`), and `updateChatById` routes
 *     a mutation whose base is a summary record — which a shell is — through the
 *     summary queue, whose `hydrate` is a full `window.api.getChat`. Paging it
 *     would pay for a shell + tail page AND still full-fetch immediately after.
 *
 * App.tsx has no unit harness; this is the repo's source-scan idiom (compare
 * ambientEscalationNarrowing.test.ts). Every marker below was verified by
 * mutation: reverting its site individually reds the named test here.
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

const PANE_SURFACE = 'useChatSurfaceHydration<ChatRecord>(isMultiviewSplit'
const SIDE_SURFACE = 'useChatSurfaceHydration<ChatRecord>(sideChatId'

describe('multiview pane hydration adopts the paged-open policy', () => {
  const paneBinding = sliceBetween(PANE_SURFACE, '})')

  it('treats a loaded shell as hydrated instead of escalating it to a full fetch', () => {
    expect(paneBinding).toContain(
      'isHydrated: (chat) => isSurfaceChatHydrated(chat, chatHydrationRuntime.transcriptStore)'
    )
    expect(paneBinding).not.toContain('isHydrated: (chat) => !isChatSummaryRecord(chat)')
  })

  it('hydrates panes through the shared surface hydrator, not a bare full fetch', () => {
    expect(paneBinding).toContain('hydrateChat: hydrateSurfaceChat')
    expect(paneBinding).not.toContain('hydrateChat: refreshSingleChat')
  })
})

describe('the shared surface hydrator is built once', () => {
  it('is ref-guarded so the module’s per-chat single-flight survives re-renders', () => {
    // A hydrator rebuilt every render would drop `pagedInFlight` on each pass,
    // so concurrent opens for one chat would each fetch their own page.
    const construction = sliceBetween(
      'if (!hydrateSurfaceChatRef.current)',
      'const hydrateSurfaceChat = hydrateSurfaceChatRef.current'
    )
    expect(construction).toContain('createSurfaceChatHydrator({')
    expect(construction).toContain('transcriptStore: chatHydrationRuntime.transcriptStore')
  })
})

describe('pop-out / Compact Companion boot adopts the paged-open policy', () => {
  const popoutOpen = sliceBetween('const popoutSummary = allChats.find', 'if (popoutChat) {')

  it('no longer fetches the whole record unconditionally', () => {
    expect(popoutOpen).not.toContain('await window.api.getChat(popoutSummary.appChatId)')
    expect(popoutOpen).toContain('createSurfaceChatHydrator({')
  })

  it('resolves the row it already holds, not the boot-empty chatByIdRef', () => {
    // `chatMutations.replaceAll` above only reaches `chatByIdRef` once React
    // commits, so resolving through the ref here would size every paging
    // decision from `undefined` and always fall through to full hydration.
    expect(popoutOpen).toContain('resolveChat: () => popoutSummary ?? null')
    expect(popoutOpen).not.toContain('resolveChat: (chatId) => chatByIdRef.current.get(chatId)')
  })

  it('keeps the non-paged path on the raw channel it used before', () => {
    expect(popoutOpen).toContain('fullHydrate: async (chatId) => (await window.api.getChat(chatId))')
  })

  it('commits a paged open through the shell+page committer', () => {
    expect(popoutOpen).toContain('commitPagedShell: applyPagedHydratedChat')
  })
})

describe('pane welcome-ness is shell-aware', () => {
  it('uses the role-aware welcome predicate after rejecting paged shells at both sites', () => {
    const welcomeSites =
      source.match(
        /const viewerIsWelcomeChat =\s*!isTranscriptPagedShell\(viewerChat\) &&\s*shouldRenderWelcome\(\{\s*currentChat: viewerChat,\s*messages: viewerChat\.messages \|\| EMPTY_CHAT_MESSAGES,\s*isCurrentChatRunning: viewerIsRunning\s*\}\)/g
      ) ?? []

    expect(welcomeSites).toHaveLength(2)
    expect(source).not.toMatch(
      /const viewerIsWelcomeChat =[\s\S]{0,180}?\(viewerChat\.messages\?\.length \|\| 0\) === 0/
    )
  })
})

describe('the linked side chat deliberately stays on full hydration', () => {
  const sideBinding = sliceBetween(SIDE_SURFACE, '})')

  it('does NOT adopt the paged policy, because presenting one always mutates it', () => {
    // Guard against a future session "finishing" the wiring: paging here is a
    // pessimisation, not a win. See the block comment above this binding.
    expect(sideBinding).toContain('hydrateChat: hydratePresentedSideChat')
    expect(sideBinding).toContain('isHydrated: (chat) => !isChatSummaryRecord(chat)')
  })

  it('records why, so the omission reads as a decision rather than an oversight', () => {
    const rationale = sliceBetween('// DELIBERATELY NOT on the Stage 1b paged policy', SIDE_SURFACE)
    expect(rationale).toContain('summary queue')
    expect(rationale).toContain('applySideChatLifecycle')
  })
})
