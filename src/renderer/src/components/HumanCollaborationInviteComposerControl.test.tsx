import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { HumanCollaborationShare } from '../../../main/collaboration/HumanCollaborationStore'
import type { HumanCollaborationInviteHealth } from '../lib/humanCollaborationInviteHealth'
import { HumanCollaborationInviteComposerControl } from './HumanCollaborationInviteComposerControl'

const share: HumanCollaborationShare = {
  shareId: 'share-1',
  chatId: 'chat-1',
  mode: 'comments',
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  nextSequence: 1,
  participants: [
    {
      collaboratorId: 'guest-1',
      displayName: 'Chris iPad',
      publicKeyId: 'pub-1',
      status: 'active',
      joinedAt: 2
    }
  ],
  invites: [],
  idempotency: {}
}

const health: HumanCollaborationInviteHealth = {
  chatAvailable: true,
  shareEnabled: true,
  bridgeEnabled: true,
  bridgeRunning: true,
  bridgeError: '',
  relayUrls: ['ws://192.168.0.147:8787', 'wss://studio.ts.net'],
  lanAvailable: true,
  remoteAvailable: true,
  tailscaleConfigured: true,
  tailscaleSuggestedUrl: 'wss://studio.ts.net',
  tailscaleReason: ''
}

describe('HumanCollaborationInviteComposerControl', () => {
  it('does not render for chats without an active share', () => {
    const html = renderToStaticMarkup(
      <HumanCollaborationInviteComposerControl active={false} onCopyInvite={() => {}} />
    )

    expect(html).toBe('')
  })

  it('renders a fresh invite action for active shared chats', () => {
    const html = renderToStaticMarkup(
      <HumanCollaborationInviteComposerControl active share={share} onCopyInvite={() => {}} />
    )

    expect(html).toContain('New invite')
    expect(html).toContain('Open People sharing controls')
    expect(html).toContain('composer-human-invite-button')
  })

  it('shows people share status in the compact popover', () => {
    const html = renderToStaticMarkup(
      <HumanCollaborationInviteComposerControl
        active
        defaultOpen
        live
        share={share}
        health={health}
        onCopyInvite={() => {}}
      />
    )

    expect(html).toContain('People share')
    expect(html).toContain('Comments')
    expect(html).toContain('Chris iPad')
    expect(html).toContain('Remote')
    expect(html).toContain('Ready')
    expect(html).toContain('Stop sharing')
  })

  it('can be disabled with the composer lock state', () => {
    const html = renderToStaticMarkup(
      <HumanCollaborationInviteComposerControl active share={share} disabled onCopyInvite={() => {}} />
    )

    expect(html).toContain('disabled=""')
  })
})
