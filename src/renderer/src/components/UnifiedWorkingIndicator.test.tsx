import type { CSSProperties } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UnifiedWorkingIndicator, type UnifiedWorkingSeat } from './UnifiedWorkingIndicator'

function seat(id: string, label: string, telemetry: string, jumpable = false): UnifiedWorkingSeat {
  return {
    id,
    label,
    statusLabel: `${label} working`,
    accentStyle: {
      '--message-working-accent': 'var(--provider-codex-color)'
    } as CSSProperties,
    telemetry: <span className="message-working-telemetry">{telemetry}</span>,
    ...(jumpable
      ? {
          onJump: () => {},
          jumpTitle: `Go to ${label}'s fan-out lane`
        }
      : {})
  }
}

describe('UnifiedWorkingIndicator', () => {
  it('renders one shared Working signal and a bare seat grid with per-seat telemetry', () => {
    const seats = [
      seat('seat-1', '#1 General', '1h 23m 45s · ≈117 tokens'),
      seat('seat-2', '#2 Specialist', '24m 18s · ≈84 tokens', true),
      seat('seat-3', '#3 Reviewer', '2m 6s · ≈62 tokens'),
      seat('seat-4', '#4 Specialist', '1m 5s · — tokens'),
      seat('seat-5', '#5 Researcher', '41s · ≈41 tokens'),
      seat('seat-6', '#6 Specialist', '3s · ≈76 tokens')
    ]
    const html = renderToStaticMarkup(
      <UnifiedWorkingIndicator label="Working" ariaLabel="Six active seats working" seats={seats} />
    )

    expect(html.match(/class="message-working-ghost"/g) || []).toHaveLength(1)
    expect(html.match(/message-working-seat-label/g) || []).toHaveLength(6)
    expect(html).toContain('message-working-seat-grid')
    expect(html).toContain('1h 23m 45s · ≈117 tokens')
    expect(html).toContain('1m 5s · — tokens')
    expect(html).toContain('aria-label="#1 General working"')
    expect(html).toContain('<button')
    expect(html).toContain('Go to #2 Specialist&#x27;s fan-out lane')
  })

  it('puts seat names on the same shimmer label primitive as Working', () => {
    const html = renderToStaticMarkup(
      <UnifiedWorkingIndicator
        label="Working"
        ariaLabel="One active seat working"
        seats={[seat('seat-1', '#1 General', '5s · ≈12 tokens')]}
      />
    )

    expect(html).toContain('class="message-working-label" data-label="Working"')
    expect(html).toContain(
      'class="message-working-label message-working-seat-label" data-label="#1 General"'
    )
  })
})
