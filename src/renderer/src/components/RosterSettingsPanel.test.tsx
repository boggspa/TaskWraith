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
  RosterTransferPicker,
  rosterProviderAvailability
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
        captainAssignmentDisabled={false}
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

  it('keeps the configured Boss and disables assigning a fourth Captain', () => {
    const participants = materializeParticipantsFromPresetWithBossman(
      createEmptyEnsembleRosterPreset('Authority panel').participants
    ).participants
    const renderRow = (
      participant: (typeof participants)[number],
      props: { isBossman: boolean; captainAssignmentDisabled: boolean; canRemove: boolean }
    ): string =>
      renderToStaticMarkup(
        <RosterParticipantRow
          participant={participant}
          mentionParticipants={participants}
          index={participant.order - 1}
          total={participants.length}
          canRemove={props.canRemove}
          composerStyle="default"
          grokAvailable={false}
          cursorAvailable={false}
          showApplyToAll
          isBossman={props.isBossman}
          isSecondInCommand={false}
          captainAssignmentDisabled={props.captainAssignmentDisabled}
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

    const bossHtml = renderRow(participants[0], {
      isBossman: true,
      captainAssignmentDisabled: false,
      canRemove: false
    })
    expect(bossHtml).toContain('Every panel keeps exactly one Boss')
    expect(bossHtml).toContain('Assign another Boss before removing this participant')

    const cappedHtml = renderRow(participants[2], {
      isBossman: false,
      captainAssignmentDisabled: true,
      canRemove: true
    })
    expect(cappedHtml).toContain('This panel already has 3 Captains')
  })

  it('renders stored Cursor seats as live editable roster rows', () => {
    const preset = createEmptyEnsembleRosterPreset('Cursor panel')
    const participants = materializeParticipantsFromPresetWithBossman(
      preset.participants
    ).participants
    const cursorParticipant = {
      ...participants[0],
      provider: 'cursor' as const,
      role: 'Cursor reviewer',
      model: undefined
    }
    const html = renderToStaticMarkup(
      <RosterParticipantRow
        participant={cursorParticipant}
        mentionParticipants={[cursorParticipant]}
        index={0}
        total={1}
        canRemove
        composerStyle="default"
        grokAvailable={false}
        cursorAvailable={true}
        showApplyToAll
        isBossman={false}
        isSecondInCommand={false}
        captainAssignmentDisabled={false}
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

    expect(html).toContain('Cursor reviewer')
    expect(html).toContain('data-provider="cursor"')
    expect(html).not.toContain('Security unavailable')
    expect(html).not.toContain('security unavailable')
    expect(html).not.toContain('security-unavailable')
    expect(html).not.toContain('retired')
  })

  it('keeps an admitted conditional AntiGravity seat editable', () => {
    const preset = createEmptyEnsembleRosterPreset('AntiGravity panel')
    const participants = materializeParticipantsFromPresetWithBossman(
      preset.participants
    ).participants
    const participant = {
      ...participants[0],
      provider: 'antigravity' as const,
      role: 'AntiGravity reviewer',
      model: undefined
    }
    const html = renderToStaticMarkup(
      <RosterParticipantRow
        participant={participant}
        configuredProviderSnapshot={{ ready: true, providerIds: ['antigravity'] }}
        mentionParticipants={[participant]}
        index={0}
        total={1}
        canRemove
        composerStyle="default"
        grokAvailable={false}
        cursorAvailable={false}
        showApplyToAll
        isBossman={false}
        isSecondInCommand={false}
        captainAssignmentDisabled={false}
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

    expect(html).toContain('AntiGravity reviewer')
    expect(html).toContain('data-provider="antigravity"')
    expect(html).not.toContain('Setup required')
    expect(html).not.toContain('security unavailable')
  })

  it('labels a conditional provider as setup-required without calling it unsafe', () => {
    expect(
      rosterProviderAvailability('antigravity', { ready: true, providerIds: [] })
    ).toBe('setup-required')
    expect(
      rosterProviderAvailability('antigravity', { ready: false, providerIds: [] })
    ).toBe('available')
    expect(
      rosterProviderAvailability('antigravity', {
        ready: true,
        providerIds: ['antigravity']
      })
    ).toBe('available')
  })

  it('keeps retirement copy specific to stored Gemini seats', () => {
    const preset = createEmptyEnsembleRosterPreset('Historical Gemini panel')
    const participants = materializeParticipantsFromPresetWithBossman(
      preset.participants
    ).participants
    const geminiParticipant = {
      ...participants[0],
      provider: 'gemini' as const,
      role: 'Gemini historian',
      model: undefined
    }
    const html = renderToStaticMarkup(
      <RosterParticipantRow
        participant={geminiParticipant}
        mentionParticipants={[geminiParticipant]}
        index={0}
        total={1}
        canRemove
        composerStyle="default"
        grokAvailable={false}
        cursorAvailable={false}
        showApplyToAll
        isBossman={false}
        isSecondInCommand={false}
        captainAssignmentDisabled={false}
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

    expect(html).toContain('Gemini · Retired')
    expect(html).toContain('retired providers can&#x27;t run')
    expect(html).not.toContain('security-unavailable')
  })
})
