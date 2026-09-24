import {
  MIN_INSPECTOR_PANEL_WIDTH,
  MAX_INSPECTOR_PANEL_WIDTH,
  rightPanelViewportMax
} from '../../../shared/panelWidthLimits'

const DEFAULT_FILE_EDITOR_WIDTH = 390
// Single-sourced from shared/panelWidthLimits so main's settings sanitizer
// can never re-clamp a dragged width below the resize handlers' ceiling
// (a stale sanitizer-side 720 previously snapped every wide dock back on the
// next settings round-trip). The effective width is additionally clamped to
// rightPanelViewportMax, so narrow windows are protected by proportion, not
// by the constant — it only needs to stop the dock from swallowing ultrawide
// layouts entirely. Canvas surfaces in the dock (Mesh scenes, desktop-style
// Browser work) are why the ceiling is generous.
const MIN_RIGHT_PANEL_WIDTH = MIN_INSPECTOR_PANEL_WIDTH
const MAX_RIGHT_PANEL_WIDTH = MAX_INSPECTOR_PANEL_WIDTH
const DEFAULT_SIDE_CHAT_WIDTH = 460
const MIN_SIDE_CHAT_WIDTH = 340
const MAX_SIDE_CHAT_WIDTH = 1120
// 340 is the comfortable floor (the workspace/model-usage rows read cleanly at
// this width). It's also the default, so a fresh launch — or one where the
// stored width was lost (e.g. the rebrand moved userData/localStorage) — never
// comes up cramped. getStoredWorkspaceSidebarWidth clamps any smaller stored
// value UP to MIN on launch, so the sidebar can be made larger but never smaller.
const DEFAULT_WORKSPACE_SIDEBAR_WIDTH = 340
const MIN_WORKSPACE_SIDEBAR_WIDTH = 340
const MAX_WORKSPACE_SIDEBAR_WIDTH = 560

// The workspace terminal docks horizontally, so it's the one pane measured by
// height. `--workspace-terminal-height` (declared on `.app-transcript`) is read
// by the pane itself AND by the composer's bottom offset and the transcript's
// scroll reserve, so a single clamp keeps all three in step. 260 is the shipped
// CSS default; the floor keeps the header plus a few rows legible. MAX is only
// the ultrawide stop — a live drag clamps further against the pane's own height
// minus the composer, since growing the terminal pushes the composer upward.
const DEFAULT_WORKSPACE_TERMINAL_HEIGHT = 260
const MIN_WORKSPACE_TERMINAL_HEIGHT = 120
const MAX_WORKSPACE_TERMINAL_HEIGHT = 1200

const clampPanelWidth = (value: number): number => {
  return Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(MAX_RIGHT_PANEL_WIDTH, Math.round(value)))
}

const clampSideChatWidth = (value: number): number => {
  return Math.max(MIN_SIDE_CHAT_WIDTH, Math.min(MAX_SIDE_CHAT_WIDTH, Math.round(value)))
}

const clampWorkspaceSidebarWidth = (value: number): number => {
  return Math.max(
    MIN_WORKSPACE_SIDEBAR_WIDTH,
    Math.min(MAX_WORKSPACE_SIDEBAR_WIDTH, Math.round(value))
  )
}

const clampWorkspaceTerminalHeight = (value: number): number => {
  return Math.max(
    MIN_WORKSPACE_TERMINAL_HEIGHT,
    Math.min(MAX_WORKSPACE_TERMINAL_HEIGHT, Math.round(value))
  )
}

const getStoredWorkspaceTerminalHeight = (): number => {
  try {
    const stored = window.localStorage.getItem('taskwraith.workspaceTerminalHeight')
    const parsed = stored ? Number(stored) : DEFAULT_WORKSPACE_TERMINAL_HEIGHT
    return Number.isFinite(parsed)
      ? clampWorkspaceTerminalHeight(parsed)
      : DEFAULT_WORKSPACE_TERMINAL_HEIGHT
  } catch {
    return DEFAULT_WORKSPACE_TERMINAL_HEIGHT
  }
}

const setStoredWorkspaceTerminalHeight = (height: number): void => {
  try {
    window.localStorage.setItem(
      'taskwraith.workspaceTerminalHeight',
      String(clampWorkspaceTerminalHeight(height))
    )
  } catch {
    // Local persistence is best-effort only.
  }
}

const getStoredFileEditorWidth = (): number => {
  try {
    const stored = window.localStorage.getItem('taskwraith.fileEditorWidth')
    const parsed = stored ? Number(stored) : DEFAULT_FILE_EDITOR_WIDTH
    return Number.isFinite(parsed) ? clampPanelWidth(parsed) : DEFAULT_FILE_EDITOR_WIDTH
  } catch {
    return DEFAULT_FILE_EDITOR_WIDTH
  }
}

const getStoredWorkspaceSidebarWidth = (): number => {
  try {
    const stored = window.localStorage.getItem('taskwraith.workspaceSidebarWidth')
    const parsed = stored ? Number(stored) : DEFAULT_WORKSPACE_SIDEBAR_WIDTH
    return Number.isFinite(parsed)
      ? clampWorkspaceSidebarWidth(parsed)
      : DEFAULT_WORKSPACE_SIDEBAR_WIDTH
  } catch {
    return DEFAULT_WORKSPACE_SIDEBAR_WIDTH
  }
}

const sideChatWidthStorageKey = (parentChatId: string): string =>
  `taskwraith.sideChatWidth.${parentChatId}`

const getStoredSideChatWidth = (parentChatId?: string | null): number => {
  if (!parentChatId) return DEFAULT_SIDE_CHAT_WIDTH
  try {
    const stored = window.localStorage.getItem(sideChatWidthStorageKey(parentChatId))
    const parsed = stored ? Number(stored) : DEFAULT_SIDE_CHAT_WIDTH
    return Number.isFinite(parsed) ? clampSideChatWidth(parsed) : DEFAULT_SIDE_CHAT_WIDTH
  } catch {
    return DEFAULT_SIDE_CHAT_WIDTH
  }
}

const setStoredSideChatWidth = (parentChatId: string, width: number): void => {
  try {
    window.localStorage.setItem(
      sideChatWidthStorageKey(parentChatId),
      String(clampSideChatWidth(width))
    )
  } catch {
    // Local persistence is best-effort only.
  }
}

export {
  DEFAULT_FILE_EDITOR_WIDTH,
  MIN_RIGHT_PANEL_WIDTH,
  MAX_RIGHT_PANEL_WIDTH,
  rightPanelViewportMax,
  DEFAULT_SIDE_CHAT_WIDTH,
  MIN_SIDE_CHAT_WIDTH,
  MAX_SIDE_CHAT_WIDTH,
  DEFAULT_WORKSPACE_SIDEBAR_WIDTH,
  MIN_WORKSPACE_SIDEBAR_WIDTH,
  MAX_WORKSPACE_SIDEBAR_WIDTH,
  DEFAULT_WORKSPACE_TERMINAL_HEIGHT,
  MIN_WORKSPACE_TERMINAL_HEIGHT,
  MAX_WORKSPACE_TERMINAL_HEIGHT,
  clampPanelWidth,
  clampSideChatWidth,
  clampWorkspaceSidebarWidth,
  clampWorkspaceTerminalHeight,
  getStoredFileEditorWidth,
  getStoredSideChatWidth,
  setStoredSideChatWidth,
  getStoredWorkspaceSidebarWidth,
  getStoredWorkspaceTerminalHeight,
  setStoredWorkspaceTerminalHeight
}
