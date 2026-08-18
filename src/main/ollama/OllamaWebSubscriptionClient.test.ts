import { describe, expect, it } from 'vitest'
import { parseOllamaSettingsHtml } from './OllamaWebSubscriptionClient'

/** Synthetic markup shaped like ollama.com/settings. The percent cascade and
 *  the limit-reached rules are the whole contract (ported from Limit
 *  Counter's parser; see the module header). */
describe('parseOllamaSettingsHtml', () => {
  it('reads both windows from aria-label percents', () => {
    const page = `
      <h3>Session usage</h3>
      <div role="progressbar" aria-label="Session usage 37.5 %"></div>
      <p>Resets in 3 hours</p>
      <h3>Weekly usage</h3>
      <div role="progressbar" aria-label="Weekly usage 62 %"></div>
      <p>Resets in 4 days</p>
      <h3>Models used</h3>`
    expect(parseOllamaSettingsHtml(page)).toEqual({
      sessionUsedPercent: 37.5,
      sessionResetDescription: 'Resets in 3h',
      weeklyUsedPercent: 62,
      weeklyResetDescription: 'Resets in 4d'
    })
  })

  it('falls back to width-style percents, then plain "N% used" text', () => {
    const widthPage = `
      Session usage <div style="width: 12%"></div>
      Weekly usage <div style="width: 48%"></div>`
    expect(parseOllamaSettingsHtml(widthPage)).toMatchObject({
      sessionUsedPercent: 12,
      weeklyUsedPercent: 48
    })

    const plainPage = `Session usage 9% used … Weekly usage 71% used`
    expect(parseOllamaSettingsHtml(plainPage)).toMatchObject({
      sessionUsedPercent: 9,
      weeklyUsedPercent: 71
    })
  })

  it('reads a weekly "Limit reached" as 100, and a blocked session as 0', () => {
    // When the weekly cap is what blocks you, the session window itself is
    // idle: the session chunk carries "Weekly limit reached" and must read 0,
    // not whatever stale percent the markup still shows.
    const page = `
      <h3>Session usage</h3>
      <p>Weekly limit reached — sessions resume in 2 days</p>
      <h3>Weekly usage</h3>
      <p>Limit reached</p>`
    expect(parseOllamaSettingsHtml(page)).toEqual({
      sessionUsedPercent: 0,
      sessionResetDescription: 'Resumes in 2d',
      weeklyUsedPercent: 100,
      weeklyResetDescription: 'Weekly limit reached'
    })
  })

  it('bounds the weekly chunk at "Models used" so table figures cannot bleed in', () => {
    const page = `
      Session usage <div aria-label="5 %"></div>
      Weekly usage
      <h3>Models used</h3>
      <td>99%</td>`
    const result = parseOllamaSettingsHtml(page)
    expect(result?.sessionUsedPercent).toBe(5)
    expect(result?.weeklyUsedPercent).toBeUndefined()
  })

  it('clamps out-of-range percents', () => {
    const page = `Session usage 130% used … Weekly usage 62% used`
    expect(parseOllamaSettingsHtml(page)?.sessionUsedPercent).toBe(100)
  })

  it('returns null on the login wall — an unauthenticated fetch must never read as 0% used', () => {
    expect(parseOllamaSettingsHtml('<h1>Sign in to Ollama</h1>')).toBeNull()
    expect(parseOllamaSettingsHtml('<a href="/login">Log in</a>')).toBeNull()
  })

  it('returns null when neither window is present', () => {
    expect(parseOllamaSettingsHtml('<html><body>maintenance</body></html>')).toBeNull()
  })
})
