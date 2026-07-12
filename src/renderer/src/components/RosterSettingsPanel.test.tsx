import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// RosterSettingsPanel reads presets from localStorage during render, so install
// a Map-backed fake window before importing it (no jsdom in this suite).
const fake = vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    }
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    localStorage,
    addEventListener: () => {},
    removeEventListener: () => {},
    // Sidebar.tsx (pulled in transitively via ComposerProviderPicker →
    // ProviderBadgeIcon) registers a module-load interval; stub it for node.
    setInterval: () => 0,
    clearInterval: () => {}
  }
  return { store }
})

import {
  RosterParticipantRow,
  RosterSettingsPanel,
  RosterTransferPicker
} from './RosterSettingsPanel'
import {
  createEmptyEnsembleRosterPreset,
  materializeParticipantsFromPresetWithBossman
} from '../lib/ensembleRosterPresets'

beforeEach(() => {
  fake.store.clear()
})

describe('RosterSettingsPanel', () => {
  it('renders the empty state when there are no presets', () => {
    const html = renderToStaticMarkup(<RosterSettingsPanel />)
    expect(html).toContain('Roster presets')
    expect(html).toContain('No presets yet')
  })

  it('renders JSON import/export controls', () => {
    const html = renderToStaticMarkup(<RosterSettingsPanel />)
    expect(html).toContain('Import JSON')
    expect(html).toContain('Export JSON')
    expect(html).toContain('type="file"')
    expect(html).toContain('accept=".json,application/json"')
  })

  it('lists an existing preset in the left pane', () => {
    createEmptyEnsembleRosterPreset('Panel A')
    const html = renderToStaticMarkup(<RosterSettingsPanel />)
    expect(html).toContain('Panel A')
  })

  it('renders an accessible multi-select transfer picker', () => {
    const first = createEmptyEnsembleRosterPreset('Panel A')
    const second = createEmptyEnsembleRosterPreset('Panel B')
    const html = renderToStaticMarkup(
      <RosterTransferPicker
        mode="export"
        presets={[first, second]}
        selectedIndexes={[0]}
        skippedCount={0}
        onToggle={() => {}}
        onSelectAll={() => {}}
        onClearAll={() => {}}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    )

    expect(html).toContain('role="dialog"')
    expect(html).toContain('role="group"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked=""')
    expect(html).toContain('Select all')
    expect(html).toContain('Clear all')
    expect(html).toContain('Export 1')
  })

  it('starts participant cards collapsed without removing their editor controls', () => {
    const preset = createEmptyEnsembleRosterPreset('Compact panel')
    const participants = materializeParticipantsFromPresetWithBossman(preset.participants)
      .participants
    const html = renderToStaticMarkup(
      <RosterParticipantRow
        participant={participants[0]}
        mentionParticipants={participants}
        index={0}
        total={participants.length}
        canRemove
        composerStyle="default"
        grokAvailable={false}
        cursorAvailable={false}
        showApplyToAll
        isBossman={false}
        isSecondInCommand={false}
        onMove={() => {}}
        onRemove={() => {}}
        onSetBossman={() => {}}
        onSetSecondInCommand={() => {}}
        onPatch={() => {}}
        onFlush={() => {}}
        onApplyPermissionsToAll={() => {}}
        onSaveToPool={() => {}}
      />
    )

    expect(html).toContain('settings-roster-participant-disclosure')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('settings-roster-participant-content" hidden=""')
    expect(html).toContain('Enabled')
    expect(html).toContain('Role / nickname')
  })
})
