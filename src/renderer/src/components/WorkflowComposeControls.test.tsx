import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowComposeControls } from './WorkflowComposeControls'

function renderControls(
  overrides: Partial<Parameters<typeof WorkflowComposeControls>[0]> = {}
): string {
  return renderToStaticMarkup(
    <WorkflowComposeControls
      cadence="interval"
      onCadenceChange={vi.fn()}
      intervalMinutes={60}
      onIntervalMinutesChange={vi.fn()}
      maxRunsPerDay={24}
      onMaxRunsPerDayChange={vi.fn()}
      unattendedLevel="safe"
      onUnattendedLevelChange={vi.fn()}
      {...overrides}
    />
  )
}

describe('WorkflowComposeControls — unattended permissions', () => {
  it('renders the unattended-permissions control with all three levels', () => {
    const html = renderControls()
    expect(html).toContain('Unattended permissions')
    expect(html).toContain('Safe (read-only)')
    expect(html).toContain('Default permissions')
    expect(html).toContain('Full Access')
  })

  it('defaults to Safe (the safe button is the active one)', () => {
    const html = renderControls({ unattendedLevel: 'safe' })
    expect(html).toMatch(/class="is-active"[^>]*>Safe \(read-only\)</)
    expect(html).not.toMatch(/class="is-active"[^>]*>Full Access</)
  })

  it('marks the chosen non-safe level active', () => {
    const html = renderControls({ unattendedLevel: 'full_access' })
    expect(html).toMatch(/class="is-active"[^>]*>Full Access</)
    expect(html).not.toMatch(/class="is-active"[^>]*>Safe \(read-only\)</)
  })
})
