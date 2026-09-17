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
    expect(resolveSettingsTabFromSlashArg('provider tools', { settingsTabs: SETTINGS_TABS })).toBe(
      'mcp'
    )
    expect(resolveSettingsTabFromSlashArg('mcp', { settingsTabs: SETTINGS_TABS })).toBe(
      'mcp-servers'
    )
    expect(resolveSettingsTabFromSlashArg('mcp servers', { settingsTabs: SETTINGS_TABS })).toBe(
      'mcp-servers'
    )
    expect(resolveSettingsTabFromSlashArg('mcp.json', { settingsTabs: SETTINGS_TABS })).toBe(
      'mcp-servers'
    )
    expect(
      resolveSettingsTabFromSlashArg('cursor mcp.json', { settingsTabs: SETTINGS_TABS })
    ).toBe('mcp-servers')
    expect(
      resolveSettingsTabFromSlashArg('claude_desktop_config.json', {
        settingsTabs: SETTINGS_TABS
      })
    ).toBe('mcp-servers')
    expect(resolveSettingsTabFromSlashArg('codex config toml', { settingsTabs: SETTINGS_TABS })).toBe(
      'mcp-servers'
    )
  })

  it('routes the transcript control queries to Appearance by MATCH, not by fallback', () => {
    // `defaultTab` is deliberately NOT 'appearance'. The shipped default IS 'appearance'
    // (resolveSettingsSlashTab.ts:9), so a query that matches NOTHING still returns
    // 'appearance' and every assertion below would pass vacuously on unmodified HEAD.
    // Forcing the no-match answer to 'behavior' means each expectation can only pass
    // through a real alias hit on the Appearance tab.
    const opts = { settingsTabs: SETTINGS_TABS, defaultTab: 'behavior' as const }

    // Positive control for the disarming itself: an unmatched query must reach 'behavior'.
    // If this ever returns 'appearance', every other line in this test is vacuous.
    expect(resolveSettingsTabFromSlashArg('zzzz no such settings tab', opts)).toBe('behavior')

    expect(resolveSettingsTabFromSlashArg('transcript', opts)).toBe('appearance')
    expect(resolveSettingsTabFromSlashArg('transcript view', opts)).toBe('appearance')
    expect(resolveSettingsTabFromSlashArg('transcript text size', opts)).toBe('appearance')
    expect(resolveSettingsTabFromSlashArg('text size', opts)).toBe('appearance')
    expect(resolveSettingsTabFromSlashArg('transcript width', opts)).toBe('appearance')
    expect(resolveSettingsTabFromSlashArg('width', opts)).toBe('appearance')
    expect(resolveSettingsTabFromSlashArg('view', opts)).toBe('appearance')
  })

  it('wins those queries on score, not on the alphabetical tie-break', () => {
    // resolveSettingsSlashTab.ts:76 breaks ties with `a.tab.id.localeCompare(b.tab.id)`
    // ASCENDING, and 'appearance' sorts before almost every other tab id. An alias set that
    // merely TIES the incumbent would therefore look correct above while being one rename
    // away from flipping. Re-running each query with the Appearance tab given a LAST-sorting
    // id removes that advantage: a tab that still wins, wins on score alone.
    const relabelled = SETTINGS_TABS.map((tab) =>
      tab.id === 'appearance' ? { ...tab, id: 'zzzz-appearance' as typeof tab.id } : tab
    )
    const opts = { settingsTabs: relabelled, defaultTab: 'behavior' as const }

    // Positive control: the rename really is in effect, and a matching query finds it.
    expect(resolveSettingsTabFromSlashArg('theme', opts)).toBe('zzzz-appearance')

    expect(resolveSettingsTabFromSlashArg('transcript', opts)).toBe('zzzz-appearance')
    expect(resolveSettingsTabFromSlashArg('transcript view', opts)).toBe('zzzz-appearance')
    expect(resolveSettingsTabFromSlashArg('text size', opts)).toBe('zzzz-appearance')
    expect(resolveSettingsTabFromSlashArg('width', opts)).toBe('zzzz-appearance')
    expect(resolveSettingsTabFromSlashArg('view', opts)).toBe('zzzz-appearance')
  })

  it('does not steal the queries that belong to other tabs', () => {
    const opts = { settingsTabs: SETTINGS_TABS, defaultTab: 'behavior' as const }

    // The Appearance alias 'transcript' must beat the pinned-messages DESCRIPTION hit
    // ('Pinned transcript snippets...', alias 100 vs description 60 * 0.25 = 15) without
    // dragging the pinned-messages terms along with it.
    expect(resolveSettingsTabFromSlashArg('pinned', opts)).toBe('pinned-messages')
    expect(resolveSettingsTabFromSlashArg('pins', opts)).toBe('pinned-messages')
    expect(resolveSettingsTabFromSlashArg('messages', opts)).toBe('pinned-messages')
    expect(resolveSettingsTabFromSlashArg('saved context', opts)).toBe('pinned-messages')
    expect(resolveSettingsTabFromSlashArg('pinned transcript', opts)).toBe('pinned-messages')
    expect(resolveSettingsTabFromSlashArg('snippets', opts)).toBe('pinned-messages')
    // 'view' is claimed for Appearance, but Local servers keeps its own exact term.
    expect(resolveSettingsTabFromSlashArg('preview', opts)).toBe('local-servers')
    // 'text' stays with Model usage: Appearance carries only the QUALIFIED
    // 'transcript text size', never a bare 'text size' alias, precisely so this does not move.
    expect(resolveSettingsTabFromSlashArg('text', opts)).toBe('model-usage')
    // 'default' stays with Behavior, which owns it through a description hit worth only 15.
    // The Appearance alias for the view control is therefore the BARE 'view' and never the
    // qualified 'default transcript view': scoreMatch (resolveSettingsSlashTab.ts:31) awards
    // a FULL 80 to any alias that merely STARTS WITH the query, so the qualified form would
    // have answered a bare 'default' at 80 and taken the query off Behavior.
    expect(resolveSettingsTabFromSlashArg('default', opts)).toBe('behavior')
  })

  it('falls back when the resolved tab is feature-gated', () => {
    const pairingHidden = (tab: string) => tab !== 'pairing'

    expect(
      resolveSettingsTabFromSlashArg('devices', {
        settingsTabs: SETTINGS_TABS,
        isTabVisible: pairingHidden
      })
    ).toBe('behavior')
    expect(
      resolveSettingsTabFromSlashArg('providers', {
        settingsTabs: SETTINGS_TABS,
        isTabVisible: pairingHidden
      })
    ).toBe('providers')
  })

  it('routes the keep-awake queries to General by MATCH, not by fallback', () => {
    // The disarming runs the OTHER way here, and getting it backwards is the
    // easy mistake: the tab under test IS 'behavior', so the sibling tests'
    // `defaultTab: 'behavior'` would make every line below pass without a
    // single alias existing. Force the no-match answer to 'appearance' instead.
    const opts = { settingsTabs: SETTINGS_TABS, defaultTab: 'appearance' as const }

    // Positive control for the disarming itself: an unmatched query must reach
    // 'appearance'. If this ever returns 'behavior', the rest of this test is
    // vacuous.
    expect(resolveSettingsTabFromSlashArg('zzzz no such settings tab', opts)).toBe('appearance')

    expect(resolveSettingsTabFromSlashArg('sleep', opts)).toBe('behavior')
    expect(resolveSettingsTabFromSlashArg('keep awake', opts)).toBe('behavior')
    expect(resolveSettingsTabFromSlashArg('awake', opts)).toBe('behavior')
    expect(resolveSettingsTabFromSlashArg('power', opts)).toBe('behavior')
    // 'wake' is the contested one: Devices' description ends 'and push wake.',
    // which is a real 15-point hit. The alias must out-score it, not tie it.
    expect(resolveSettingsTabFromSlashArg('wake', opts)).toBe('behavior')
  })

  it('wins the keep-awake queries on score, not on the alphabetical tie-break', () => {
    // 'behavior' already LOSES ties to 'appearance' ascending, so the sibling
    // Appearance test needed a rename and this one does not. What it does need
    // is proof against the tabs that could tie from the other side: give
    // General a last-sorting id and it must still win every query.
    const relabelled = SETTINGS_TABS.map((tab) =>
      tab.id === 'behavior' ? { ...tab, id: 'zzzz-behavior' as typeof tab.id } : tab
    )
    const opts = { settingsTabs: relabelled, defaultTab: 'appearance' as const }

    // Positive control: the rename really is in effect.
    expect(resolveSettingsTabFromSlashArg('timeouts', opts)).toBe('zzzz-behavior')

    expect(resolveSettingsTabFromSlashArg('sleep', opts)).toBe('zzzz-behavior')
    expect(resolveSettingsTabFromSlashArg('keep awake', opts)).toBe('zzzz-behavior')
    expect(resolveSettingsTabFromSlashArg('awake', opts)).toBe('zzzz-behavior')
    expect(resolveSettingsTabFromSlashArg('power', opts)).toBe('zzzz-behavior')
    expect(resolveSettingsTabFromSlashArg('wake', opts)).toBe('zzzz-behavior')
  })
})
