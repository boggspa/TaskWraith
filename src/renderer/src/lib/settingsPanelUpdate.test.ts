import { readFileSync } from 'node:fs'
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

  it('persists the selected mid-run message behavior through App', () => {
    const update: SettingsPanelUpdate = { midRunInputBehavior: 'steer' }
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const layoutSource = readFileSync(new URL('../app/views/MainAppLayout.tsx', import.meta.url), 'utf8')

    expect(update.midRunInputBehavior).toBe('steer')
    expect(source).toContain('settingsPatch.midRunInputBehavior = next.midRunInputBehavior')
    expect(layoutSource).toContain('midRunInputBehavior={settings?.midRunInputBehavior}')
  })
})
