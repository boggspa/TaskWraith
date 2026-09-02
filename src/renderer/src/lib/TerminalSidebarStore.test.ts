import { describe, expect, it, vi, beforeEach } from 'vitest'
import { terminalLaunchBus, terminalSidebarStore } from './TerminalSidebarStore'

const mockStorage = new Map<string, string>()
global.window = {
  localStorage: {
    getItem: (k: string) => mockStorage.get(k) ?? null,
    setItem: (k: string, v: string) => mockStorage.set(k, v),
    clear: () => mockStorage.clear()
  }
} as any

describe('terminalSidebarStore', () => {
  beforeEach(() => {
    mockStorage.clear()
    terminalSidebarStore.saveRecipes([])
  })

  it('returns a stable reference across repeated calls with unchanged storage', () => {
    const first = terminalSidebarStore.getRecipes()
    const second = terminalSidebarStore.getRecipes()
    expect(first).toBe(second)
  })

  it('mutates reactivity: subscribe listener fires and snapshot reference changes', () => {
    const listener = vi.fn()
    const unsubscribe = terminalSidebarStore.subscribe(listener)

    const initial = terminalSidebarStore.getRecipes()

    terminalSidebarStore.recordRecipe('/test/path', 'echo test')

    expect(listener).toHaveBeenCalledOnce()
    const next = terminalSidebarStore.getRecipes()
    expect(next).not.toBe(initial)
    expect(next.length).toBe(1)
    expect(next[0].workspacePath).toBe('/test/path')
    expect(next[0].command).toBe('echo test')

    unsubscribe()
  })

  it('persistence round-trip works correctly', () => {
    terminalSidebarStore.recordRecipe('/path/1', 'npm start')
    const initialRecipes = terminalSidebarStore.getRecipes()
    const recipeId = initialRecipes[0].id

    const raw = window.localStorage.getItem('taskwraith-terminal-recipes')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed[0].workspacePath).toBe('/path/1')

    terminalSidebarStore.togglePin(recipeId)
    const toggled = terminalSidebarStore.getRecipes()
    expect(toggled[0].pinned).toBe(true)

    terminalSidebarStore.deleteRecipe(recipeId)
    const finalState = terminalSidebarStore.getRecipes()
    expect(finalState.length).toBe(0)
  })

  it('handles corrupted JSON gracefully and returns stable empty array', () => {
    window.localStorage.setItem('taskwraith-terminal-recipes', '{corrupted')

    const first = terminalSidebarStore.getRecipes()
    const second = terminalSidebarStore.getRecipes()

    expect(first).toEqual([])
    expect(first).toBe(second)
  })

  it('distinguishes a picker request from an immediate default launch', () => {
    const events: unknown[] = []
    const unsubscribe = terminalLaunchBus.subscribe((event) => events.push(event))

    terminalLaunchBus.request('/work/current')
    terminalLaunchBus.emit('/work/recent')

    expect(events).toEqual([
      { type: 'request', preferredWorkspacePath: '/work/current' },
      { type: 'launch', workspacePath: '/work/recent', cliId: 'default' }
    ])
    unsubscribe()
  })
})
