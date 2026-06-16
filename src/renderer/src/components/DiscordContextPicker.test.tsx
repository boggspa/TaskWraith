import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DiscordContextPicker } from './DiscordContextPicker'

describe('DiscordContextPicker', () => {
  it('renders nothing while closed', () => {
    const html = renderToStaticMarkup(
      <DiscordContextPicker
        open={false}
        targets={null}
        loading={false}
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).toBe('')
  })

  it('renders a loading state while channel targets are being fetched', () => {
    const html = renderToStaticMarkup(
      <DiscordContextPicker
        open
        targets={null}
        loading
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).toContain('Loading Discord channels...')
    expect(html).toContain('Check again')
    expect(html).not.toContain('Add context')
  })

  it('renders an error with retry guidance when Discord target loading fails', () => {
    const html = renderToStaticMarkup(
      <DiscordContextPicker
        open
        targets={null}
        loading={false}
        error="Discord API returned 403 for the configured server."
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).toContain('Discord unavailable')
    expect(html).toContain('Discord API returned 403')
    expect(html).toContain('Retry')
    expect(html).toContain('Check again')
    expect(html).not.toContain('Add context')
  })

  it('renders actionable setup guidance when Discord is not configured', () => {
    const html = renderToStaticMarkup(
      <DiscordContextPicker
        open
        targets={{
          configured: false,
          accountId: 'discord-bot',
          guilds: [],
          reason: 'Discord needs a bot token before TaskWraith can read channels.',
          setup: {
            missing: ['botToken'],
            configFilePath: '/Users/chris/Library/Application Support/TaskWraith/discord-context.env'
          }
        }}
        loading={false}
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).toContain('Discord is not configured')
    expect(html).toContain('Discord needs a bot token')
    expect(html).toContain('discord-context.env')
    expect(html).toContain('Check again')
    expect(html).not.toContain('Add context')
  })

  it('renders channel search, message limits, and add action when configured', () => {
    const html = renderToStaticMarkup(
      <DiscordContextPicker
        open
        targets={{
          configured: true,
          accountId: 'discord-bot',
          guilds: [
            {
              id: '456789012345678901',
              name: 'Task Team',
              channels: [
                {
                  id: '123456789012345678',
                  name: 'build-help',
                  guildId: '456789012345678901',
                  guildName: 'Task Team',
                  type: 0,
                  label: '#build-help'
                }
              ]
            }
          ]
        }}
        loading={false}
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).toContain('Filter servers and channels')
    expect(html).toContain('#build-help')
    expect(html).toContain('Task Team')
    expect(html).toContain('Add context')
    expect(html).toContain('Refresh')
  })

  it('renders an empty-channel state when Discord is configured but no text channels are readable', () => {
    const html = renderToStaticMarkup(
      <DiscordContextPicker
        open
        targets={{
          configured: true,
          accountId: 'discord-bot',
          guilds: [
            {
              id: '456789012345678901',
              name: 'Task Team',
              channels: []
            }
          ]
        }}
        loading={false}
        onRefresh={vi.fn()}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(html).toContain('No readable Discord text channels found.')
    expect(html).toContain('Refresh')
    expect(html).toContain('Add context')
  })
})
