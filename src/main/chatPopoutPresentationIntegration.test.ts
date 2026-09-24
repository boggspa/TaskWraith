import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync('src/main/index.ts', 'utf8')

function sourceSlice(start: string, end: string): string {
  const startIndex = mainSource.indexOf(start)
  const endIndex = mainSource.indexOf(end, startIndex + start.length)
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex)
  return mainSource.slice(startIndex, endIndex)
}

describe('chat popout presentation integration', () => {
  it('normalizes the requested chat presentation inside the authoritative parser', () => {
    const parser = sourceSlice('function parseWorkspacePopoutInput', 'function externalWorkspace')

    expect(parser).toContain('presentation?: ChatPopoutPresentation')
    expect(parser).toContain('normalizeChatPopoutPresentation(input.presentation)')
  })

  it('carries the initial presentation into both renderer URL paths', () => {
    const loader = sourceSlice(
      'async function loadWorkspacePopoutWindow',
      'function normalizeWorkspace'
    )

    expect(loader.match(/searchParams\.set\('presentation', presentation\)/g)).toHaveLength(1)
    expect(loader).toContain('query.presentation = presentation')
  })

  it('resizes the one live chat window and updates its renderer in place', () => {
    const launcher = sourceSlice(
      'async function openWorkspacePopout',
      'async function dockSideChatPopout'
    )

    expect(launcher).toContain('applyChatPopoutWindowPresentation(existing, presentation)')
    expect(launcher).toContain("'chat-popout-presentation-changed'")
    expect(launcher).toContain('chatPopoutWindowPreset(presentation)')
    expect(launcher).toContain("forceCompactGlass = kind === 'chat' && presentation === 'compact'")
    expect(launcher).toContain('applyNativeGlassToWindow(existing, AppStore.getSettings())')
    expect(launcher).toContain("presentation: kind === 'chat' ? presentation : undefined")
  })

  it('keeps compact glass independent from the app-wide appearance mode', () => {
    const glass = sourceSlice('function isCompactChatPopout', 'function appendGeminiCliSessionArgs')
    const updater = sourceSlice('const applyNativeGlassToWindow', 'function windowBoundsAreVisible')

    expect(glass).toContain("workspacePopoutOwners.get(key)?.presentation === 'compact'")
    expect(updater).toContain('const forceCompactGlass = isCompactChatPopout(targetWindow)')
    expect(updater).toContain('(forceCompactGlass ||')
  })
})
