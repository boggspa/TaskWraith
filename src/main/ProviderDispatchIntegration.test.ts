import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = indexSource.indexOf(startMarker)
  const end = indexSource.indexOf(endMarker, start + startMarker.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return indexSource.slice(start, end)
}

describe('provider dispatch integration', () => {
  it('routes the legacy Gemini IPC surface through the shared dispatch facade', () => {
    const handler = sourceBetween(
      "ipcMain.handle(\n      'run-gemini'",
      "ipcMain.handle('cancel-gemini'"
    )
    expect(handler).toContain('await dispatchRunWithProviderPause(')
    expect(handler).not.toContain('await runGeminiProvider(')
    expect(handler).not.toContain('ensureProviderRunPreflight(')
  })
})
