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
