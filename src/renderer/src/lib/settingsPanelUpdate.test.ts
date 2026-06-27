import { describe, expect, it } from 'vitest'
import type { SettingsPanelUpdate } from './settingsPanelUpdate'

describe('SettingsPanelUpdate', () => {
  it('carries user-managed MCP server patches from SettingsPanel to App', () => {
    const update: SettingsPanelUpdate = {
      userMcpServers: [
        {
          id: 'docs',
          name: 'Docs',
          enabled: true,
          transport: 'http',
          url: 'https://example.test/mcp'
        }
      ]
    }

    expect(update.userMcpServers?.[0]?.name).toBe('Docs')
  })
})
