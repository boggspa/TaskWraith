import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
const mainSource = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
const mainAppLayoutSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/app/views/MainAppLayout.tsx'),
  'utf8'
)

function sourceSlice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('chat popout presentation handoff integration', () => {
  it('routes sidebar thread pop-outs through the handoff-aware launcher', () => {
    expect(mainAppLayoutSource).toContain('onOpenChatPopout={(chat, presentation) =>')
    expect(mainAppLayoutSource).toContain('popOutLinkedChat(chat, undefined, presentation)')
  })

  it('keeps collaboration Channel chrome out of the compact companion only', () => {
    expect(mainAppLayoutSource).toContain(
      'isChatPopoutWindow && !isCompactChatCompanion && humanCollaborationControls'
    )
  })

  it('sends disclosure with focused, linked, and multiview popout handoffs', () => {
    const linked = sourceSlice(
      appSource,
      'const popOutLinkedChat',
      'const resolveCurrentLinkedParentChat'
    )
    const focused = sourceSlice(
      appSource,
      'const openChatPopoutWindow',
      'const dockChatPopoutWindow'
    )
    const multiview = sourceSlice(
      appSource,
      'const openPaneChatPopout',
      'const openPaneWorkspacePopout'
    )

    expect(linked).toContain(
      'roundExpansion: captureSessionRoundExpansionForChat(targetChat.appChatId)'
    )
    expect(focused).toContain(
      'roundExpansion: captureSessionRoundExpansionForChat(currentChat.appChatId)'
    )
    expect(multiview).toContain('roundExpansion: captureSessionRoundExpansionForChat(chatId)')
  })

  it('captures multiview scroll before focus can replace the pane ref', () => {
    const multiview = sourceSlice(
      appSource,
      'const openPaneChatPopout',
      'const openPaneWorkspacePopout'
    )
    const captureIndex = multiview.indexOf(
      'captureChatScrollState(multiview.paneRefs[paneIndex]?.scrollRef.current)'
    )
    const fallbackIndex = multiview.indexOf(
      'currentChatIdRef.current === chatId ? captureMainTranscriptScrollState() : undefined'
    )
    const focusIndex = multiview.indexOf('focusPaneForChromeAction(paneIndex, chatId)')

    expect(captureIndex).toBeGreaterThanOrEqual(0)
    expect(fallbackIndex).toBeGreaterThan(captureIndex)
    expect(focusIndex).toBeGreaterThan(fallbackIndex)
    expect(multiview).not.toContain('scrollState: undefined')
    expect(multiview).toContain('scrollState: paneScrollState')
  })

  it('hydrates disclosure before initial and storage-event scroll restoration', () => {
    const initial = sourceSlice(
      appSource,
      'const popoutHandoff = readChatPopoutHandoff(popoutChat.appChatId)',
      "console.warn('[chat-popout] requested chat was not found:'"
    )
    const initialHydrateIndex = initial.indexOf('hydrateSessionRoundExpansionForChat')
    const initialRenderIndex = initial.indexOf('setCurrentChat(popoutChat)')
    const initialRestoreIndex = initial.indexOf('restoreMainTranscriptScrollStateWhenReady')
    const initialRouteReadyIndex = initial.indexOf('markInitialRouteSettled(false)')
    expect(initialHydrateIndex).toBeGreaterThanOrEqual(0)
    expect(initialRenderIndex).toBeGreaterThan(initialHydrateIndex)
    expect(initialRestoreIndex).toBeGreaterThan(initialHydrateIndex)
    expect(initialRouteReadyIndex).toBeGreaterThan(initialRestoreIndex)

    const incoming = sourceSlice(
      appSource,
      'const applyIncomingHandoff = () =>',
      'const handleStorage = (event: StorageEvent)'
    )
    const incomingHydrateIndex = incoming.indexOf('hydrateSessionRoundExpansionForChat')
    const incomingRestoreIndex = incoming.indexOf('restoreMainTranscriptScrollStateWhenReady')
    expect(incomingHydrateIndex).toBeGreaterThanOrEqual(0)
    expect(incomingRestoreIndex).toBeGreaterThan(incomingHydrateIndex)
  })

  it('returns disclosure and anchored scroll before opening a docked side pane', () => {
    const dockSender = sourceSlice(
      appSource,
      'const dockChatPopoutWindow',
      'const createNewChatFromKeyboard'
    )
    expect(dockSender).toContain('scrollState: captureMainTranscriptScrollState()')
    expect(dockSender).toContain(
      'roundExpansion: captureSessionRoundExpansionForChat(currentChat.appChatId)'
    )

    const dockReceiver = sourceSlice(
      appSource,
      "if (isChatPopoutWindow || typeof window.api.onSideChatDockRequest !== 'function') return",
      'const handleSideRun ='
    )
    const hydrateIndex = dockReceiver.indexOf('hydrateSessionRoundExpansionForChat')
    const openIndex = dockReceiver.indexOf('openLinkedChatInSidePanelRef.current')
    const restoreIndex = dockReceiver.indexOf('restoreSideTranscriptScrollStateWhenReady')
    expect(hydrateIndex).toBeGreaterThanOrEqual(0)
    expect(hydrateIndex).toBeLessThan(openIndex)
    expect(hydrateIndex).toBeLessThan(restoreIndex)

    const dockRelay = sourceSlice(
      mainSource,
      'async function dockSideChatPopout',
      'if (isGeminiMcpBridgeProcess)'
    )
    expect(dockRelay).toContain('normalizeChatPopoutScrollState(input.scrollState)')
    expect(dockRelay).toContain('normalizeChatPopoutRoundExpansion(input.roundExpansion)')
    expect(dockRelay).toContain('...(roundExpansion ? { roundExpansion } : {})')
  })
})

describe('chat popout transcript-view handoff', () => {
  // The three slices above cover FOUR openers: `openCompactChatCompanion` sits
  // inside the `openChatPopoutWindow` -> `dockChatPopoutWindow` slice and is
  // satisfied by its sibling's line, so it gets its own slice here.
  const openers: ReadonlyArray<readonly [string, string, string, string]> = [
    [
      'linked',
      'const popOutLinkedChat',
      'const resolveCurrentLinkedParentChat',
      'targetChat.appChatId'
    ],
    [
      'focused',
      'const openChatPopoutWindow',
      'const openCompactChatCompanion',
      'currentChat.appChatId'
    ],
    [
      'compact',
      'const openCompactChatCompanion',
      'const dockChatPopoutWindow',
      'currentChat.appChatId'
    ],
    ['multiview', 'const openPaneChatPopout', 'const openPaneWorkspacePopout', 'chatId']
  ]

  it('captures the per-chat view at every one of the four popout openers', () => {
    for (const [name, start, end, idExpression] of openers) {
      const opener = sourceSlice(appSource, start, end)
      // The closing newline is load-bearing. Without it this string is a strict
      // PREFIX of the tri-state form `...(id) ?? null`, so an opener that drifted
      // to sending an explicit clear would still satisfy it — proven by mutation,
      // where exactly that drift left all three opener assertions green.
      expect(opener, name).toContain(
        `transcriptView: captureTranscriptViewOverrideForChat(${idExpression})\n`
      )
    }
  })

  it('counts the openers from source so a fifth one cannot be added uncovered', () => {
    // A hand-maintained slice list fails open. Pin the counts against each
    // other instead: every `writeChatPopoutHandoff` call must carry a capture.
    const writeSites = appSource.match(/writeChatPopoutHandoff\(/g) ?? []
    const captureSites =
      appSource.match(/transcriptView: captureTranscriptViewOverrideForChat\(/g) ?? []
    expect(writeSites).toHaveLength(openers.length)
    // Exactly the openers. The dock sender reads through the same helper but
    // into a local (`const dockedTranscriptView = ...`), because it must decide
    // whether to send the key at all — see the dock-leg test below.
    expect(captureSites).toHaveLength(openers.length)
    expect(appSource).toContain(
      'const dockedTranscriptView = captureTranscriptViewOverrideForChat('
    )
  })

  it('captures through the partial helper, never through a total resolver', () => {
    // `resolveTranscriptView` and `transcriptViewForChat` are both TOTAL: they
    // answer `'standard'` for a chat with no override, which the receiving
    // window would then write as an explicit pin that beats a later Appearance
    // default. Every capture site must use the partial helper instead.
    for (const [name, start, end] of openers) {
      const opener = sourceSlice(appSource, start, end)
      // Positive control in the same test: the slice really does capture.
      expect(opener, name).toContain('captureTranscriptViewOverrideForChat')
      expect(opener, name).not.toContain('resolveTranscriptView')
      expect(opener, name).not.toContain('transcriptViewForChat')
    }
  })

  it('hydrates the carried view before the popout first renders the chat', () => {
    const initial = sourceSlice(
      appSource,
      'const popoutHandoff = readChatPopoutHandoff(popoutChat.appChatId)',
      "console.warn('[chat-popout] requested chat was not found:'"
    )
    // Guarded, not unconditional: an absent carried view must write nothing at
    // all rather than pin the resolved default.
    const guardIndex = initial.indexOf('if (popoutHandoff?.transcriptView) {')
    const applyIndex = initial.indexOf(
      'setTranscriptViewOverride(popoutChat.appChatId, popoutHandoff.transcriptView)'
    )
    const renderIndex = initial.indexOf('setCurrentChat(popoutChat)')
    expect(guardIndex).toBeGreaterThanOrEqual(0)
    expect(applyIndex).toBeGreaterThan(guardIndex)
    expect(renderIndex).toBeGreaterThan(applyIndex)
    expect(initial).not.toContain('resolveTranscriptView')
  })

  it('hydrates the carried view on a re-handoff into an already-open popout', () => {
    // Main REUSES an open popout for the same chat rather than reloading it, so
    // the storage event is the only delivery after the first.
    const incoming = sourceSlice(
      appSource,
      'const applyIncomingHandoff = () =>',
      'const handleStorage = (event: StorageEvent)'
    )
    const guardIndex = incoming.indexOf('if (popoutHandoff?.transcriptView) {')
    const applyIndex = incoming.indexOf(
      'setTranscriptViewOverride(chatId, popoutHandoff.transcriptView)'
    )
    const restoreIndex = incoming.indexOf('restoreMainTranscriptScrollStateWhenReady')
    expect(guardIndex).toBeGreaterThanOrEqual(0)
    expect(applyIndex).toBeGreaterThan(guardIndex)
    expect(restoreIndex).toBeGreaterThan(applyIndex)
    expect(incoming).not.toContain('resolveTranscriptView')
  })

  it('carries a real view home, and never coerces absence into a clear', () => {
    const dockSender = sourceSlice(
      appSource,
      'const dockChatPopoutWindow',
      'const createNewChatFromKeyboard'
    )
    // The wire format is tri-state, but THIS SENDER NEVER SENDS A CLEAR, and
    // that is the behaviour worth pinning. `?? null` here would coerce "I hold
    // no override" into "clear this chat", and the two are not the same thing:
    // `readChatPopoutHandoff` is destructive, so a popout that merely RELOADED
    // holds no override through no act of the user. Coerced, that travels home
    // and deletes a pin the user set in the main window and never touched.
    expect(dockSender).toContain(
      'const dockedTranscriptView = captureTranscriptViewOverrideForChat(currentChat.appChatId)'
    )
    expect(dockSender).toContain(
      '...(dockedTranscriptView !== undefined ? { transcriptView: dockedTranscriptView } : {})'
    )
    // The two ways the coercion could come back.
    expect(dockSender).not.toContain(
      'captureTranscriptViewOverrideForChat(currentChat.appChatId) ??'
    )
    expect(dockSender).not.toContain('transcriptView: dockedTranscriptView ?? null')
    expect(dockSender).not.toContain('resolveTranscriptView')
    // Positive control for the three negatives: the slice really is the dock
    // sender and really does carry the field, so their absence is filtered
    // rather than an artefact of slicing the wrong region.
    expect(dockSender).toContain('dockSideChatPopout')
    expect(dockSender).toContain('transcriptView')
  })

  it('applies the docked view before the side pane opens, clearing on null only', () => {
    const dockReceiver = sourceSlice(
      appSource,
      "if (isChatPopoutWindow || typeof window.api.onSideChatDockRequest !== 'function') return",
      'const handleSideRun ='
    )
    const normalizeIndex = dockReceiver.indexOf(
      'normalizeTranscriptViewOverrideTransfer(request.transcriptView)'
    )
    const guardIndex = dockReceiver.indexOf('if (dockTranscriptView !== undefined) {')
    const applyIndex = dockReceiver.indexOf(
      'setTranscriptViewOverride(linkedChat.appChatId, dockTranscriptView)'
    )
    const openIndex = dockReceiver.indexOf('openLinkedChatInSidePanelRef.current')
    const restoreIndex = dockReceiver.indexOf('restoreSideTranscriptScrollStateWhenReady')
    expect(normalizeIndex).toBeGreaterThanOrEqual(0)
    expect(guardIndex).toBeGreaterThan(normalizeIndex)
    expect(applyIndex).toBeGreaterThan(guardIndex)
    expect(openIndex).toBeGreaterThan(applyIndex)
    expect(restoreIndex).toBeGreaterThan(applyIndex)
    // `!== undefined`, not truthiness: `null` is the clear and must get through.
    expect(dockReceiver).not.toContain('if (dockTranscriptView) {')
    expect(dockReceiver).not.toContain('resolveTranscriptView')
  })

  it('relays the docked view through main without swallowing the null clear', () => {
    const dockRelay = sourceSlice(
      mainSource,
      'async function dockSideChatPopout',
      'if (isGeminiMcpBridgeProcess)'
    )
    expect(dockRelay).toContain('normalizeTranscriptViewOverrideTransfer(input.transcriptView)')
    expect(dockRelay).toContain('...(transcriptView !== undefined ? { transcriptView } : {})')
    // The truthiness idiom its three siblings use would drop `null` silently,
    // making "Follow default" in a popout impossible to dock home.
    expect(dockRelay).not.toContain('...(transcriptView ? { transcriptView } : {})')
    // Positive control for that negative: the sibling that IS truthiness-guarded
    // still is, so the assertion above is about this field, not about the idiom
    // having vanished from the function.
    expect(dockRelay).toContain('...(roundExpansion ? { roundExpansion } : {})')
  })
})
