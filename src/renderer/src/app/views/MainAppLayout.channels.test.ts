import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const layoutSource = readFileSync(new URL('./MainAppLayout.tsx', import.meta.url), 'utf8')
const mainCss = readFileSync(new URL('../../assets/main.css', import.meta.url), 'utf8')

describe('MainAppLayout Channel integration', () => {
  it('mounts the self-contained Channel panel directly beside unchanged People controls', () => {
    expect(layoutSource).toContain(
      "import { ChannelHostPanel } from '../../components/ChannelHostPanel'"
    )
    expect(layoutSource).toContain(
      "<ChannelHostPanel chatId={currentChat.appChatId} chatTitle={currentChat.title || 'Chat'} />"
    )

    const peopleButton = layoutSource.indexOf('Invite collaborators to this chat')
    const channelPanel = layoutSource.indexOf('<ChannelHostPanel', peopleButton)
    const existingInviteControl = layoutSource.indexOf(
      '{currentChatHumanCollaborationShare && (',
      peopleButton
    )
    expect(peopleButton).toBeGreaterThan(-1)
    expect(channelPanel).toBeGreaterThan(peopleButton)
    expect(channelPanel).toBeLessThan(existingInviteControl)
    expect(layoutSource).toContain('onClick={handleCreateHumanCollaborationShare}')
    expect(layoutSource).toContain('onClick={handleCopyCurrentHumanCollaborationInvite}')
    expect(layoutSource).toContain('onClick={handleStopHumanCollaborationSharing}')
  })

  it('mounts one process-global joined-member control only in the primary renderer', () => {
    expect(layoutSource).toContain(
      "import { ChannelMemberPanel } from '../../components/ChannelMemberPanel'"
    )
    expect(layoutSource).toContain(
      'const channelMemberControl = isChatPopoutWindow ? null : <ChannelMemberPanel />'
    )
    expect(layoutSource.match(/<ChannelMemberPanel \/>/g)).toHaveLength(1)
    expect(layoutSource).toContain('{!focusedHostOverlayRequired && channelMemberControl}')

    const mainPeopleControls = layoutSource.indexOf('{humanCollaborationControls}', 1_000)
    const mainMemberControl = layoutSource.indexOf('{channelMemberControl}', mainPeopleControls)
    expect(mainPeopleControls).toBeGreaterThan(-1)
    expect(mainMemberControl).toBeGreaterThan(mainPeopleControls)
  })

  it('inherits the existing main, popout, and focused-pane mounting surfaces', () => {
    expect(layoutSource).toContain('const humanCollaborationControls =')
    expect(layoutSource).toContain('currentChat && !isWelcomeChat ? (')
    expect(layoutSource).toContain('chatId === currentChatAppChatId ? (')
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
