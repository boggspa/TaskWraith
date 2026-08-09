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

  it('inherits the existing main, popout, and focused-pane mounting surfaces', () => {
    expect(layoutSource).toContain('const humanCollaborationControls =')
    expect(layoutSource).toContain('currentChat && !isWelcomeChat ? (')
    expect(layoutSource).toContain(
      'chatId === currentChatAppChatId ? humanCollaborationControls : undefined'
    )
    expect(layoutSource).toContain('{humanCollaborationControls}')
    expect(layoutSource).toContain('isChatPopoutWindow && humanCollaborationControls && (')
  })

  it('keeps Channel state and IPC out of the composition root', () => {
    expect(layoutSource).not.toContain('window.api.channels')
    expect(layoutSource).not.toContain('useChannel')
    expect(layoutSource).not.toContain('channelHostPanelState')
  })

  it('loads the isolated Channel stylesheet after the existing renderer shards', () => {
    expect(mainCss).toContain("@import url('./css/33-channels.css');")
    expect(mainCss.indexOf("@import url('./css/33-channels.css');")).toBeGreaterThan(
      mainCss.indexOf("@import url('./css/32-window-idle-pause.css');")
    )
  })
})
