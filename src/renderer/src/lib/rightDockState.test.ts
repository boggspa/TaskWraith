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
  hasSideChat: false,
  isSideChatDockPanelOpen: false,
  showInspector: false,
  showFileEditor: false,
  showOfficeSuite: false,
  isCanvasDockPanelOpen: false,
  hasWorkspaceContext: false,
  isChatMediaPanelOpen: false,
  isProjectReferencesPanelOpen: false,
  isWebSiteLoginsPanelOpen: false,
  isPinnedMessagesPanelOpen: false,
  isTerminalDockAvailable: false
}

describe('rightDockState', () => {
  describe('buildRightDockTabs', () => {
    it('preserves dock tab availability order', () => {
      expect(
        buildRightDockTabs({
          showHome: true,
          hasSideChat: true,
          isSideChatDockPanelOpen: true,
          showInspector: true,
          showFileEditor: true,
          showOfficeSuite: true,
          isCanvasDockPanelOpen: true,
          isAppDriveDockPanelOpen: true,
          hasWorkspaceContext: true,
          isChatMediaPanelOpen: true,
          isProjectReferencesPanelOpen: true,
          isPinnedMessagesPanelOpen: true,
          isTerminalDockAvailable: true
        })
      ).toEqual([
        { id: 'home', label: 'Home' },
        { id: 'chat', label: 'Chat' },
        { id: 'inspector', label: 'Inspect' },
        { id: 'files', label: 'Files' },
        { id: 'office', label: 'Office' },
        { id: 'canvas', label: 'Canvas' },
        { id: 'appdrive', label: 'Drive' },
        { id: 'media', label: 'Media' },
        { id: 'references', label: 'Refs' },
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
        { id: 'files' as const, label: 'Files' },
        { id: 'pins' as const, label: 'Notes' }
      ]

      expect(resolveActiveRightDockTab(availableTabs, 'pins')).toBe('pins')
      expect(resolveActiveRightDockTab(availableTabs, 'media')).toBe('files')
      // Home is the floor: with nothing available there is no other surface
      // that is guaranteed to render.
      expect(resolveActiveRightDockTab([], 'media')).toBe('home')
      expect(resolveActiveRightDockTab([{ id: 'home' }], 'home')).toBe('home')
    })
  })

  describe('resolveRightDockRestore', () => {
    it('restores the selected destination without opening a closed dock', () => {
      expect(
        resolveRightDockRestore({
          savedTab: 'home',
          selectedTab: 'files',
          enabledTabs: ['home', 'files', 'inspector'],
          dockIsOpen: false
        })
      ).toEqual({ tab: 'home', shouldOpen: false })
    })

    it('switches an already-open dock to the remembered surface', () => {
      expect(
        resolveRightDockRestore({
          savedTab: 'inspector',
          selectedTab: 'home',
          enabledTabs: ['home', 'files', 'inspector'],
          dockIsOpen: true
        })
      ).toEqual({ tab: 'inspector', shouldOpen: true })
    })

    it('ignores missing, current, or disabled destinations', () => {
      const base = {
        selectedTab: 'files' as const,
        enabledTabs: ['home', 'files'] as const,
        dockIsOpen: false
      }

      expect(resolveRightDockRestore({ ...base, savedTab: null })).toBeNull()
      expect(resolveRightDockRestore({ ...base, savedTab: 'files' })).toBeNull()
      expect(resolveRightDockRestore({ ...base, savedTab: 'inspector' })).toBeNull()
    })
  })

  describe('RIGHT_DOCK_PANEL_IDS', () => {
    it('preserves the exclusive-close order from App', () => {
      expect(RIGHT_DOCK_PANEL_IDS).toEqual([
        'home',
        'chat',
        'media',
        'references',
        'logins',
        'pins',
        'files',
        'office',
        'canvas',
        'appdrive',
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

  describe('retired surfaces', () => {
    // Run (live lanes), Peers (thread messages) and Compare (fan-out
    // candidates) were removed from the dock. Fan-out candidates remain
    // reachable from the transcript; thread messaging keeps its own feature
    // surfaces. Nothing here should be able to name them again.
    it('offers no tab for a retired surface, whatever the caller passes', () => {
      const retired = ['run', 'peers', 'candidates']
      const tabs = buildRightDockTabs({
        ...allClosed,
        showHome: true,
        hasWorkspaceContext: true,
        isAppDriveDockPanelOpen: true
      })

      expect(tabs.map((tab) => tab.id).filter((id) => retired.includes(id))).toEqual([])
      expect(RIGHT_DOCK_PANEL_IDS.filter((id) => retired.includes(id))).toEqual([])
    })
  })
})
