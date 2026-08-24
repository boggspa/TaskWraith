import { useSyncExternalStore } from 'react'

export interface TerminalRecipe {
  id: string
  workspacePath: string
  command?: string
  lastUsedAt: number
  pinned: boolean
}

const STORAGE_KEY = 'taskwraith-terminal-recipes'

export const terminalSidebarStore = {
  getRecipes(): TerminalRecipe[] {
    if (typeof window === 'undefined') return []
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (raw) return JSON.parse(raw)
    } catch {}
    return []
  },
  saveRecipes(recipes: TerminalRecipe[]) {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes))
      terminalSidebarStore.emit()
    } catch {}
  },
  listeners: new Set<() => void>(),
  emit() {
    this.listeners.forEach((l) => l())
  },
  subscribe(listener: () => void) {
    terminalSidebarStore.listeners.add(listener)
    return () => terminalSidebarStore.listeners.delete(listener)
  }
}

export function useTerminalRecipes() {
  return useSyncExternalStore(
    terminalSidebarStore.subscribe,
    terminalSidebarStore.getRecipes,
    () => []
  )
}

// Event bus for Masthead -> MainAppLayout/Workbench to open terminal pane
type TerminalLaunchEvent = { type: 'launch'; workspacePath: string }
const launchListeners = new Set<(event: TerminalLaunchEvent) => void>()

export const terminalLaunchBus = {
  emit(workspacePath: string) {
    launchListeners.forEach((l) => l({ type: 'launch', workspacePath }))
  },
  subscribe(listener: (event: TerminalLaunchEvent) => void) {
    launchListeners.add(listener)
    return () => launchListeners.delete(listener)
  }
}
