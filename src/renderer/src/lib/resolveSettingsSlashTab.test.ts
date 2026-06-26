import { describe, expect, it } from 'vitest'
import { resolveSettingsTabFromSlashArg } from './resolveSettingsSlashTab'
import { SETTINGS_TABS } from '../components/SettingsPanel'

describe('resolveSettingsTabFromSlashArg', () => {
  it('maps common settings slash args to the expected tab ids', () => {
    expect(resolveSettingsTabFromSlashArg('', { settingsTabs: SETTINGS_TABS })).toBe('appearance')
    expect(resolveSettingsTabFromSlashArg('providers', { settingsTabs: SETTINGS_TABS })).toBe('providers')
    expect(resolveSettingsTabFromSlashArg('approvals', { settingsTabs: SETTINGS_TABS })).toBe('approval-ledger')
    expect(resolveSettingsTabFromSlashArg('ledger', { settingsTabs: SETTINGS_TABS })).toBe('approval-ledger')
    expect(resolveSettingsTabFromSlashArg('usage', { settingsTabs: SETTINGS_TABS })).toBe('model-usage')
    expect(resolveSettingsTabFromSlashArg('keyboard shortcuts', { settingsTabs: SETTINGS_TABS })).toBe(
      'key-commands'
    )
    expect(resolveSettingsTabFromSlashArg('tools mcp', { settingsTabs: SETTINGS_TABS })).toBe('mcp')
    expect(resolveSettingsTabFromSlashArg('mcp servers', { settingsTabs: SETTINGS_TABS })).toBe(
      'mcp-servers'
    )
  })

  it('falls back when the resolved tab is feature-gated', () => {
    const messagesHidden = (tab: string) => tab !== 'messages'

    expect(
      resolveSettingsTabFromSlashArg('channels', {
        settingsTabs: SETTINGS_TABS,
        isTabVisible: messagesHidden
      })
    ).toBe('behavior')
    expect(
      resolveSettingsTabFromSlashArg('providers', {
        settingsTabs: SETTINGS_TABS,
        isTabVisible: messagesHidden
      })
    ).toBe('providers')
  })
})
