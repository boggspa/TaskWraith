import { describe, expect, it } from 'vitest'

import {
  buildRightDockTabs,
  resolveActiveRightDockTab,
  RIGHT_DOCK_PANEL_IDS,
  shouldShowRightDock,
  type RightDockTabAvailabilityInput
} from './rightDockState'

const allClosed: RightDockTabAvailabilityInput = {
  showCockpit: false,
  hasSideChat: false,
  isSideChatDockPanelOpen: false,
  showInspector: false,
  showFileEditor: false,
  hasWorkspaceContext: false,
  isChatMediaPanelOpen: false,
  isPinnedMessagesPanelOpen: false,
  isTerminalDockAvailable: false
}

describe('rightDockState', () => {
  describe('buildRightDockTabs', () => {
    it('preserves dock tab availability order', () => {
      expect(
        buildRightDockTabs({
          showCockpit: true,
          hasSideChat: true,
          isSideChatDockPanelOpen: true,
          showInspector: true,
          showFileEditor: true,
          hasWorkspaceContext: true,
          isChatMediaPanelOpen: true,
          isPinnedMessagesPanelOpen: true,
          isTerminalDockAvailable: true
        })
      ).toEqual([
        { id: 'run', label: 'Run' },
        { id: 'chat', label: 'Chat' },
        { id: 'inspector', label: 'Inspect' },
        { id: 'files', label: 'Files' },
        { id: 'media', label: 'Media' },
        { id: 'pins', label: 'Notes' },
        { id: 'terminal', label: 'Term' }
      ])
    })

    it('requires side-chat dock visibility and workspace-backed files', () => {
      expect(
        buildRightDockTabs({
          ...allClosed,
          hasSideChat: true,
          showFileEditor: true,
          isChatMediaPanelOpen: true
        })
      ).toEqual([{ id: 'media', label: 'Media' }])
    })
  })

  describe('shouldShowRightDock', () => {
    it('hides the dock in popouts, settings, or when no tab is available', () => {
      expect(
        shouldShowRightDock({
          isChatPopoutWindow: false,
          showSettings: false,
          availableTabCount: 1
        })
      ).toBe(true)
      expect(
        shouldShowRightDock({
          isChatPopoutWindow: true,
          showSettings: false,
          availableTabCount: 1
        })
      ).toBe(false)
      expect(
        shouldShowRightDock({
          isChatPopoutWindow: false,
          showSettings: true,
          availableTabCount: 1
        })
      ).toBe(false)
      expect(
        shouldShowRightDock({
          isChatPopoutWindow: false,
          showSettings: false,
          availableTabCount: 0
        })
      ).toBe(false)
    })
  })

  describe('resolveActiveRightDockTab', () => {
    it('uses the selected tab when available and otherwise falls back to the first tab', () => {
      const availableTabs = [
        { id: 'run' as const, label: 'Run' },
        { id: 'pins' as const, label: 'Notes' }
      ]

      expect(resolveActiveRightDockTab(availableTabs, 'pins')).toBe('pins')
      expect(resolveActiveRightDockTab(availableTabs, 'media')).toBe('run')
      expect(resolveActiveRightDockTab([], 'media')).toBe('run')
    })
  })

  describe('RIGHT_DOCK_PANEL_IDS', () => {
    it('preserves the exclusive-close order from App', () => {
      expect(RIGHT_DOCK_PANEL_IDS).toEqual([
        'home',
        'chat',
        'run',
        'media',
        'pins',
        'files',
        'inspector',
        'terminal'
      ])
    })
  })
})
