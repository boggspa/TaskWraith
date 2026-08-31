import { useSyncExternalStore } from 'react'
import type { TerminalCliId } from '../../../shared/terminalCli'

export interface TerminalRecipe {
  id: string
  workspacePath: string
  command?: string
  lastUsedAt: number
  pinned: boolean
}

const STORAGE_KEY = 'taskwraith-terminal-recipes'
const EMPTY_RECIPES: readonly TerminalRecipe[] = Object.freeze([])

let cachedRaw: string | null = null
let cachedRecipes: TerminalRecipe[] = EMPTY_RECIPES as TerminalRecipe[]

export const terminalSidebarStore = {
  getRecipes(): TerminalRecipe[] {
    if (typeof window === 'undefined') return EMPTY_RECIPES as TerminalRecipe[]
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (raw === cachedRaw) {
        return cachedRecipes
      }
      cachedRaw = raw
      if (raw) {
        cachedRecipes = JSON.parse(raw)
      } else {
        cachedRecipes = EMPTY_RECIPES as TerminalRecipe[]
      }
      return cachedRecipes
    } catch {
      cachedRaw = null
      cachedRecipes = EMPTY_RECIPES as TerminalRecipe[]
      return cachedRecipes
    }
  },
  saveRecipes(recipes: TerminalRecipe[]) {
    if (typeof window === 'undefined') return
    try {
      const raw = JSON.stringify(recipes)
      cachedRaw = raw
      cachedRecipes = recipes
      window.localStorage.setItem(STORAGE_KEY, raw)
      terminalSidebarStore.emit()
    } catch {
      // localStorage can be unavailable in hardened renderer contexts.
    }
  },
  recordRecipe(workspacePath: string, command?: string) {
    const current = terminalSidebarStore.getRecipes()
    const index = current.findIndex((r) => r.workspacePath === workspacePath)
    const now = Date.now()
    const next = [...current]

    if (index >= 0) {
      next[index] = { ...next[index], lastUsedAt: now }
      if (command !== undefined) {
        next[index].command = command
      }
    } else {
      next.unshift({
        id: crypto.randomUUID ? crypto.randomUUID() : `recipe-${now}`,
        workspacePath,
        command,
        lastUsedAt: now,
        pinned: false
      })
    }
    terminalSidebarStore.saveRecipes(next)
  },
  togglePin(recipeId: string) {
    const current = terminalSidebarStore.getRecipes()
    const next = current.map((r) => (r.id === recipeId ? { ...r, pinned: !r.pinned } : r))
    terminalSidebarStore.saveRecipes(next)
  },
  deleteRecipe(recipeId: string) {
    const current = terminalSidebarStore.getRecipes()
    const next = current.filter((r) => r.id !== recipeId)
    terminalSidebarStore.saveRecipes(next)
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
type TerminalLaunchEvent =
  | { type: 'launch'; workspacePath: string; cliId: TerminalCliId }
  | { type: 'request'; preferredWorkspacePath?: string }
  | { type: 'attach'; workspacePath: string; sessionId: string }
const launchListeners = new Set<(event: TerminalLaunchEvent) => void>()

export const terminalLaunchBus = {
  emit(workspacePath: string, cliId: TerminalCliId = 'default') {
    launchListeners.forEach((l) => l({ type: 'launch', workspacePath, cliId }))
  },
  request(preferredWorkspacePath?: string) {
    launchListeners.forEach((l) => l({ type: 'request', preferredWorkspacePath }))
  },
  emitAttach(workspacePath: string, sessionId: string) {
    launchListeners.forEach((l) => l({ type: 'attach', workspacePath, sessionId }))
  },
  subscribe(listener: (event: TerminalLaunchEvent) => void) {
    launchListeners.add(listener)
    return () => launchListeners.delete(listener)
  }
}
