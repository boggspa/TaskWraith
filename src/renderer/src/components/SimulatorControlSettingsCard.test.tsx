import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SimulatorControlSettingsCard } from './SimulatorControlSettingsCard'

describe('SimulatorControlSettingsCard', () => {
  it('does not render or throw when the Simulator control bridge is unavailable', () => {
    const html = renderToStaticMarkup(<SimulatorControlSettingsCard />)
    expect(html).toBe('')
  })
})
