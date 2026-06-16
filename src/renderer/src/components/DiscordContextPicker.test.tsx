import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DiscordContextPicker } from './DiscordContextPicker'

describe('DiscordContextPicker', () => {
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
})
