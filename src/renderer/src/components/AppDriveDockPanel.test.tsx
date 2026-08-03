import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AppDriveDockPanel } from './AppDriveDockPanel'
import type { AppDriveDockStatus } from '../lib/appDriveDockState'

function status(over: Partial<AppDriveDockStatus> = {}): AppDriveDockStatus {
  return {
    chatId: 'chat-1',
    observation: {
      applicationName: 'Notes',
      windowTitle: 'Shopping',
      bundleID: 'com.apple.Notes'
    },
    control: {
      provider: 'codex',
      allowedVerbs: ['observe', 'inspect', 'click', 'fill'],
      expiresAt: 1_700_000_900_000,
      stepBudget: 20,
      stepsUsed: 3,
      stepsRemaining: 17,
      approvedBy: 'user',
      trustState: 'user-approved'
    },
    lifecycle: 'driving',
    mode: 'foreground',
    virtualCursor: { x: 0.4, y: 0.6, label: 'click' },
    ...over
  }
}

describe('AppDriveDockPanel', () => {
  it('renders Foreground Drive chrome with target, steps, verbs, and controls', () => {
    const html = renderToStaticMarkup(
      <AppDriveDockPanel status={status()} nowMs={1_700_000_000_000} />
    )
    expect(html).toContain('App Drive')
    expect(html).toContain('Foreground Drive')
    expect(html).toContain('View &amp; Control · current launch')
    expect(html).toContain('Notes')
    expect(html).toContain('Shopping')
    expect(html).toContain('17 / 20')
    expect(html).toContain('15m 00s')
    expect(html).toContain('observe, inspect, click, fill')
    expect(html).toContain('data-testid="appdrive-pause"')
    expect(html).toContain('data-testid="appdrive-takeover"')
    expect(html).toContain('data-testid="appdrive-stop"')
    expect(html).toContain('Agent cursor is display-only')
    expect(html).not.toContain('Background Drive')
    expect(html).not.toContain('Isolated Drive')
  })

  it('shows empty state without control chrome when nothing is attached', () => {
    const html = renderToStaticMarkup(
      <AppDriveDockPanel
        status={status({
          observation: null,
          control: null,
          lifecycle: 'idle',
          virtualCursor: null
        })}
      />
    )
    expect(html).toContain('data-testid="appdrive-empty"')
    expect(html).toContain('No active control session')
    expect(html).not.toContain('data-testid="appdrive-pause"')
  })

  it('refuses agent-act messaging while paused and offers Resume', () => {
    const html = renderToStaticMarkup(
      <AppDriveDockPanel status={status({ lifecycle: 'paused' })} />
    )
    expect(html).toContain('data-testid="appdrive-resume"')
    expect(html).toContain('data-testid="appdrive-refuse-note"')
    expect(html).toContain('machine-wide')
    expect(html).not.toContain('data-testid="appdrive-pause"')
  })

  it('keeps the virtual cursor pointer-events none and display-only', () => {
    const html = renderToStaticMarkup(<AppDriveDockPanel status={status()} />)
    expect(html).toContain('data-testid="appdrive-virtual-cursor"')
    expect(html).toContain('data-cursor-role="display-only"')
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('appdrive-virtual-cursor')
  })

  it('enables lifecycle controls when handlers are supplied', () => {
    const html = renderToStaticMarkup(
      <AppDriveDockPanel
        status={status()}
        onPause={vi.fn()}
        onTakeOver={vi.fn()}
        onStop={vi.fn()}
      />
    )
    expect(html).toContain('data-testid="appdrive-pause"')
    expect(html).not.toMatch(/data-testid="appdrive-pause"[^>]*disabled/)
    expect(html).not.toContain('warp')
    expect(html).not.toContain('CGEvent')
  })

  it('surfaces host warnings without inventing durable app approvals', () => {
    const html = renderToStaticMarkup(
      <AppDriveDockPanel status={status({ warning: 'Lease expires soon.' })} />
    )
    expect(html).toContain('Lease expires soon.')
    expect(html).toContain('current launch')
    expect(html).not.toContain('remember this app')
    expect(html).toContain('com.apple.Notes')
    expect(html).toContain('not an approval key')
  })
})
