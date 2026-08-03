import { describe, expect, it } from 'vitest'

import {
  buildRightDockTabs,
  resolveActiveRightDockTab,
  resolveRightDockRestore,
  RIGHT_DOCK_PANEL_IDS,
  shouldShowRightDock,
  type RightDockTabAvailabilityInput
} from './rightDockState'

const allClosed: RightDockTabAvailabilityInput = {
  showHome: false,
  showCockpit: false,
  hasSideChat: false,
  isSideChatDockPanelOpen: false,
  showInspector: false,
  showFileEditor: false,
  showOfficeSuite: false,
  isCanvasDockPanelOpen: false,
  isFanoutCandidatesPanelOpen: false,
  hasWorkspaceContext: false,
  isChatMediaPanelOpen: false,
  isProjectReferencesPanelOpen: false,
  isPinnedMessagesPanelOpen: false,
  isThreadMessagePanelOpen: false,
  isTerminalDockAvailable: false
}

describe('rightDockState', () => {
  describe('buildRightDockTabs', () => {
    it('preserves dock tab availability order', () => {
      expect(
        buildRightDockTabs({
          showHome: true,
          showCockpit: true,
          hasSideChat: true,
          isSideChatDockPanelOpen: true,
          showInspector: true,
          showFileEditor: true,
          showOfficeSuite: true,
          isCanvasDockPanelOpen: true,
          isAppDriveDockPanelOpen: true,
          isFanoutCandidatesPanelOpen: true,
          hasWorkspaceContext: true,
          isChatMediaPanelOpen: true,
          isProjectReferencesPanelOpen: true,
          isPinnedMessagesPanelOpen: true,
          isThreadMessagePanelOpen: true,
          isTerminalDockAvailable: true
        })
      ).toEqual([
        { id: 'home', label: 'Home' },
        { id: 'run', label: 'Run' },
        { id: 'chat', label: 'Chat' },
        { id: 'inspector', label: 'Inspect' },
        { id: 'files', label: 'Files' },
        { id: 'office', label: 'Office' },
        { id: 'canvas', label: 'Canvas' },
        { id: 'appdrive', label: 'Drive' },
        { id: 'candidates', label: 'Compare' },
        { id: 'media', label: 'Media' },
        { id: 'references', label: 'Refs' },
        { id: 'pins', label: 'Notes' },
        { id: 'peers', label: 'Peers' },
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

    it('keeps the dock visible when Home is the only open surface', () => {
      const tabs = buildRightDockTabs({ ...allClosed, showHome: true })

      expect(tabs).toEqual([{ id: 'home', label: 'Home' }])
      expect(
        shouldShowRightDock({
          isChatPopoutWindow: false,
          showSettings: false,
          availableTabCount: tabs.length
        })
      ).toBe(true)
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
      expect(resolveActiveRightDockTab([{ id: 'home' }], 'home')).toBe('home')
    })
  })

  describe('resolveRightDockRestore', () => {
    it('restores the selected destination without opening a closed dock', () => {
      expect(
        resolveRightDockRestore({
          savedTab: 'home',
          selectedTab: 'run',
          enabledTabs: ['home', 'run', 'inspector'],
          dockIsOpen: false
        })
      ).toEqual({ tab: 'home', shouldOpen: false })
    })

    it('switches an already-open dock to the remembered surface', () => {
      expect(
        resolveRightDockRestore({
          savedTab: 'inspector',
          selectedTab: 'home',
          enabledTabs: ['home', 'run', 'inspector'],
          dockIsOpen: true
        })
      ).toEqual({ tab: 'inspector', shouldOpen: true })
    })

    it('ignores missing, current, or disabled destinations', () => {
      const base = {
        selectedTab: 'run' as const,
        enabledTabs: ['home', 'run'] as const,
        dockIsOpen: false
      }

      expect(resolveRightDockRestore({ ...base, savedTab: null })).toBeNull()
      expect(resolveRightDockRestore({ ...base, savedTab: 'run' })).toBeNull()
      expect(resolveRightDockRestore({ ...base, savedTab: 'inspector' })).toBeNull()
    })
  })

  describe('RIGHT_DOCK_PANEL_IDS', () => {
    it('preserves the exclusive-close order from App', () => {
      expect(RIGHT_DOCK_PANEL_IDS).toEqual([
        'home',
        'chat',
        'run',
        'media',
        'references',
        'pins',
        'files',
        'office',
        'canvas',
        'appdrive',
        'candidates',
        'peers',
        'inspector',
        'terminal'
      ])
    })
  })

  describe('appdrive surface availability', () => {
    it('shows Drive only when the App Drive panel open flag is set', () => {
      expect(buildRightDockTabs({ ...allClosed })).toEqual([])
      expect(buildRightDockTabs({ ...allClosed, isAppDriveDockPanelOpen: false })).toEqual([])
      expect(buildRightDockTabs({ ...allClosed, isAppDriveDockPanelOpen: true })).toEqual([
        { id: 'appdrive', label: 'Drive' }
      ])
    })
  })

  describe('peers surface availability', () => {
    // Deliberately NOT gated on a workspace or on having mail: sending to another
    // thread is a first-class action, so the surface has to be reachable from an
    // empty inbox. Only the open flag decides.
    it('shows Peers on the open flag alone', () => {
      expect(buildRightDockTabs({ ...allClosed, isThreadMessagePanelOpen: true })).toEqual([
        { id: 'peers', label: 'Peers' }
      ])
      expect(buildRightDockTabs({ ...allClosed, hasWorkspaceContext: true })).toEqual([])
    })
  })

  describe('candidates surface availability', () => {
    it('shows Compare only when the panel is open AND a workspace exists', () => {
      expect(buildRightDockTabs({ ...allClosed, isFanoutCandidatesPanelOpen: true })).toEqual([])
      expect(
        buildRightDockTabs({
          ...allClosed,
          isFanoutCandidatesPanelOpen: true,
          hasWorkspaceContext: true
        })
      ).toEqual([{ id: 'candidates', label: 'Compare' }])
    })
  })
})
