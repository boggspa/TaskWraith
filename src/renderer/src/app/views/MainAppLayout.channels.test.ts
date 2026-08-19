import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const layoutSource = readFileSync(new URL('./MainAppLayout.tsx', import.meta.url), 'utf8')
const mainCss = readFileSync(new URL('../../assets/main.css', import.meta.url), 'utf8')

describe('MainAppLayout Channel integration', () => {
  it('mounts the self-contained Channel panel as the only sharing control', () => {
    expect(layoutSource).toContain(
      "import { ChannelHostPanel } from '../../components/ChannelHostPanel'"
    )
    // Mounted from the chat's id/title held as their own values: the element
    // is memoized, and depending on `currentChat` itself would rebuild it on
    // every stream flush (which defeats the pane chrome memo downstream).
    expect(layoutSource).toMatch(
      /<ChannelHostPanel\s+chatId=\{humanCollaborationChatId\}\s+chatTitle=\{humanCollaborationChatTitle\}\s*\/>/
    )
    expect(layoutSource).toContain(
      "const humanCollaborationChatTitle = currentChat?.title || 'Chat'"
    )

    // The legacy People header controls are retired; the Channel panel owns
    // invite creation, copying, and stop-sharing on the channel runtime.
    expect(layoutSource).not.toContain('Invite collaborators to this chat')
    expect(layoutSource).not.toContain('handleCreateHumanCollaborationShare')
    expect(layoutSource).not.toContain('handleCopyCurrentHumanCollaborationInvite')
    expect(layoutSource).not.toContain('handleStopHumanCollaborationSharing')
  })

  it('mounts one process-global joined-member control only in the primary renderer', () => {
    expect(layoutSource).toContain(
      "import { ChannelMemberPanel } from '../../components/ChannelMemberPanel'"
    )
    expect(layoutSource).toMatch(
      /const channelMemberControl = useMemo\(\s*\(\) => \(isChatPopoutWindow \? null : <ChannelMemberPanel \/>\)/
    )
    expect(layoutSource.match(/<ChannelMemberPanel \/>/g)).toHaveLength(1)
    expect(layoutSource).toContain('{!focusedHostOverlayRequired && channelMemberControl}')

    const mainPeopleControls = layoutSource.indexOf('{humanCollaborationControls}', 1_000)
    const mainMemberControl = layoutSource.indexOf('{channelMemberControl}', mainPeopleControls)
    expect(mainPeopleControls).toBeGreaterThan(-1)
    expect(mainMemberControl).toBeGreaterThan(mainPeopleControls)
  })

  it('inherits the existing main, popout, and focused-pane mounting surfaces', () => {
    expect(layoutSource).toContain('const humanCollaborationControls = useMemo(')
    expect(layoutSource).toContain(
      'const humanCollaborationChatId = currentChat && !isWelcomeChat ? currentChat.appChatId : null'
    )
    // Still only the host-projection pane, now through the memoized element.
    expect(layoutSource).toContain(
      'chatId === currentChatAppChatId ? focusedPaneTopLeftChrome : undefined'
    )
    expect(layoutSource).toContain('{humanCollaborationControls}')
    expect(layoutSource).toContain('isChatPopoutWindow && humanCollaborationControls && (')
  })

  it('keeps Channel state and IPC out of the composition root', () => {
    expect(layoutSource).not.toContain('window.api.channels')
    expect(layoutSource).not.toContain('window.api.channelMemberships')
    expect(layoutSource).not.toContain('useChannel')
    expect(layoutSource).not.toContain('channelHostPanelState')
    expect(layoutSource).not.toContain('channelMemberPanelState')
  })

  it('loads both isolated Channel stylesheets after the existing renderer shards', () => {
    expect(mainCss).toContain("@import url('./css/33-channels.css');")
    expect(mainCss.indexOf("@import url('./css/33-channels.css');")).toBeGreaterThan(
      mainCss.indexOf("@import url('./css/32-window-idle-pause.css');")
    )
    expect(mainCss).toContain("@import url('./css/34-channel-memberships.css');")
    expect(mainCss.indexOf("@import url('./css/34-channel-memberships.css');")).toBeGreaterThan(
      mainCss.indexOf("@import url('./css/33-channels.css');")
    )
  })
})
