import { RIGHT_DOCK_PANEL_IDS, type RightDockTab } from './rightDockState'

/**
 * Per-chat memory of the last-opened right-dock surface.
 *
 * The active dock surface is ephemeral React state (App.tsx `useState('run')`)
 * with no persistence — every reload dropped back to Run. This stores the
 * chosen surface per chat (keyed by appChatId) in localStorage so each thread
 * reopens to its own surface, across chat switches AND app restarts. Best-effort:
 * a missing/blocked localStorage or an unknown id degrades to "no memory", never
 * throws. Values are validated against RIGHT_DOCK_PANEL_IDS on read.
 */

const KEY_PREFIX = 'taskwraith.rightDockSurface.'

function keyFor(chatId: string): string {
  return `${KEY_PREFIX}${chatId}`
}

export function readDockSurface(chatId: string | null | undefined): RightDockTab | null {
  if (!chatId) return null
  try {
    const raw = window.localStorage.getItem(keyFor(chatId))
    if (raw && (RIGHT_DOCK_PANEL_IDS as readonly string[]).includes(raw)) {
      return raw as RightDockTab
    }
  } catch {
    // localStorage unavailable / quota exceeded — persistence is best-effort.
  }
  return null
}

export function writeDockSurface(chatId: string | null | undefined, tab: RightDockTab): void {
  if (!chatId) return
  try {
    window.localStorage.setItem(keyFor(chatId), tab)
  } catch {
    // best-effort — a failed write just means this thread won't remember.
  }
}
