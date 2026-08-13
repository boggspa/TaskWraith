import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const channelsCss = readFileSync(new URL('../assets/css/33-channels.css', import.meta.url), 'utf8')
const panelSource = readFileSync(
  new URL('../components/ChannelsManagementPanel.tsx', import.meta.url),
  'utf8'
)

function ruleBody(selector: string): string {
  const start = channelsCss.indexOf(`${selector} {`)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = channelsCss.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return channelsCss.slice(start, end + 1)
}

describe('Settings Channels control chrome', () => {
  it('resets native button chrome on both disclosure controls', () => {
    for (const selector of ['.shares-panel-card-title', '.shares-panel-audit-summary']) {
      const rule = ruleBody(selector)
      expect(rule).toContain('appearance: none')
      expect(rule).toContain('border: 0')
      expect(rule).toContain('background: transparent')
      expect(rule).toContain('font: inherit')
    }
  })

  it('keeps channel identity and counts together opposite the destructive action', () => {
    const header = panelSource.indexOf('<div className="shares-panel-card-head">')
    const titleWrap = panelSource.indexOf('<div className="shares-panel-card-title-wrap">', header)
    const title = panelSource.indexOf('className="shares-panel-card-title"', titleWrap)
    const counts = panelSource.indexOf('className="settings-hint shares-panel-card-counts"', title)
    const actions = panelSource.indexOf('<div className="shares-panel-card-actions">', counts)

    expect(header).toBeGreaterThanOrEqual(0)
    expect(titleWrap).toBeGreaterThan(header)
    expect(title).toBeGreaterThan(titleWrap)
    expect(counts).toBeGreaterThan(title)
    expect(actions).toBeGreaterThan(counts)
  })
})
