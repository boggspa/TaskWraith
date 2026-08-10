import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FirstLaunchSheet } from './FirstLaunchSheet'
import type { ProviderApiKeyStatus } from '../../../main/store/types'
import type { ModelUsageAggregate } from '../lib/usageAggregateTypes'

/**
 * Server-rendered smoke tests for FirstLaunchSheet. The component
 * is mostly presentation — these tests cover the gnarly bits:
 *   1. `open={false}` renders nothing (auto-show gating is host-side
 *      but this is the contract the host depends on).
 *   2. Status-summary lines flip correctly for the four provider
 *      shapes (signed-in / not-available / not-signed-in / no status).
 *   3. Kimi admission copy stays truthful without hiding the provider.
 *
 * We don't simulate clicks — the codebase uses `renderToStaticMarkup`
 * (no jsdom), so interaction coverage lives in manual / e2e testing.
 */

function makeProviderApiKeyStatus(
  overrides: Partial<ProviderApiKeyStatus> = {}
): ProviderApiKeyStatus {
  return {
    available: true,
    authState: 'authenticated',
    apiKeyConfigured: false,
    encryptionAvailable: true,
    ...overrides
  }
}

function providerCardMarkup(html: string, provider: string): string {
  const marker = `data-provider="${provider}"`
  const markerIndex = html.indexOf(marker)
  expect(markerIndex).toBeGreaterThanOrEqual(0)
  const start = html.lastIndexOf('<div', markerIndex)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = html.indexOf('data-provider="', markerIndex + marker.length)
  return html.slice(start, next === -1 ? undefined : next)
}

describe('FirstLaunchSheet', () => {
  it('returns null when not open so the host can mount it unconditionally', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={false}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}      />
    )
    expect(html).toBe('')
  })

  it('renders live onboarding plus historical Gemini reporting when open', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}      />
    )
    expect(html).toContain('data-provider="codex"')
    expect(html).toContain('data-provider="claude"')
    expect(html).toContain('data-provider="gemini"')
    // AntiGravity stays hidden until BOTH pieces of its conditional setup exist.
    expect(html).not.toContain('data-provider="antigravity"')
    expect(html).toContain('data-provider="kimi"')
    expect(html).toContain('data-provider="ollama"')
    expect(html).toContain('data-provider="pi"')
    expect(html).toContain('data-provider="mistral"')
  })

  it('offers Mistral Vibe setup separately from Pi API-key setup', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        onProviderLogin={() => {}}
        onProviderLogout={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        mistralStatus={{ available: true, authState: 'unknown' }}
      />
    )

    const card = providerCardMarkup(html, 'mistral')
    expect(card).toContain('Mistral Vibe')
    expect(card).toContain('vibe --setup')
    expect(card).toContain('Sign in')
    expect(card).toContain('Pi’s metered Mistral API-key route')
    expect(card).not.toContain('Sign out')
  })

  it('renders Welcome heading and the numbered onboarding sections', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}      />
    )
    expect(html).toContain('Welcome to TaskWraith')
    expect(html).toContain('1. Sign in to your providers')
    expect(html).toContain('Product observation — choose now')
    expect(html).toContain('Off until you choose Share.')
    expect(html).toContain('Share minimal activity')
    expect(html).toContain('Don&#x27;t share')
    expect(html).toContain('2. Optional tools')
    expect(html).toContain('3. Where your CLIs live')
    expect(html).toContain('4. Add your first workspace')
    expect(html).toContain('5. Choose your starting look')
    expect(html).toContain('6. You stay in control')
    expect(html).toContain('7. Track your usage')
    expect(html).toContain('8. Try Ensemble chats')
    expect(html).toContain('9. Power-user shortcuts')
    expect(html).toContain('Ask')
    expect(html).toContain('Full WS Access')
    expect(html).toContain('Full Access')
    expect(html).toContain('approval-gated instruments')
    expect(html).toContain('/goal &lt;objective&gt;')
    expect(html).toContain('Delegate a focused worker')
    expect(html).toContain('live token + projected-cost tally')
    expect(html).toContain('BG seats skip ordinary rotation')
    expect(html).toContain('returns control instead of burning hops')
    expect(html).toContain('choose individual saved panels')
    expect(html).toContain('namespaced workspace tools')
    expect(html).toContain('repository-local hooks, filters')
    expect(html).toContain('K2.7 Coding switches between Standard and Highspeed')
    expect(html).toContain('K3 has no Fast tier')
    expect(html).toContain('K2.7 Coding has a fixed On setting')
    expect(html).toContain('K3 lets')
    expect(html).toContain('choose Low, High, or Max effort')
  })

  it('intro prose advertises live providers but not the retired Gemini', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}      />
    )
    // The "It wraps …" sentence is an OFFER surface, so the retired Gemini must
    // not appear there even though its chat history is preserved elsewhere.
    expect(html).toContain('local-first desktop workbench')
    expect(html).toContain('<strong>Codex</strong>')
    expect(html).toContain('<strong>Ollama</strong>')
    expect(html).toContain('<strong>Pi</strong>')
    expect(html).not.toContain('<strong>Gemini</strong>')
  })

  it('renders the Appearance preference controls and preview surfaces', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}        themeAppearance="blue"
        composerStyle="claude"
        diffStatColors={{ additions: '#12C4A0', deletions: '#F15A70' }}
      />
    )
    expect(html).toContain('Theme')
    expect(html).toContain('aria-label="Theme previews"')
    expect(html).toContain('data-theme-preview="blue"')
    expect(html).toContain('data-theme-preview="forest"')
    expect(html).toContain('Theme-aware code diff')
    expect(html).toContain('--theme-preview-diff-additions:#12C4A0')
    expect(html).toContain('--theme-preview-diff-deletions:#F15A70')
    expect(html).toContain('Composer shell')
    expect(html).toContain('Gemini shell')
    expect(html).toContain('Composer preview')
    expect(html).toContain('data-composer-style="claude"')
    expect(html).not.toContain('Message bubble')
    expect(html).toContain('Plan')
  })

  it('renders the Ensemble preview row with provider participants', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}      />
    )
    expect(html).toContain('Toggle Ensemble on an idle top-level chat')
    expect(html).toContain('data-provider="codex"')
    expect(html).toContain('data-provider="claude"')
    expect(html).toContain('data-provider="kimi"')
    expect(html).toContain('data-provider="ollama"')
    // Disabled Cursor is intentionally absent from the runnable preview roster.
    expect(html).not.toContain('<em>Cursor</em>')
    expect(html).toContain('<em>Grok</em>')
    expect(html).toContain('<em>Ollama</em>')
    expect(html).not.toContain('<em>Gemini</em>')
    expect(html).toContain('Toggle Ensemble while the thread is idle')
    expect(html).toContain('Turn / Continuous in the composer')
    expect(html).toContain('detached read-only work')
  })

  it('renders Cursor + Grok cards with official provider PNG marks', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        cursorProviderAvailable={true}
        grokProviderAvailable={false}
      />
    )
    // Both CLI-login providers get cards.
    expect(html).toContain('data-provider="cursor"')
    expect(html).toContain('data-provider="grok"')
    const cursorCard = providerCardMarkup(html, 'cursor')
    const grokCard = providerCardMarkup(html, 'grok')
    expect(cursorCard).toContain('data-provider-logo="cursor"')
    expect(cursorCard).toContain('<img class="provider-brand-logo-image')
    expect(cursorCard).not.toContain('provider-glyph-cursor')
    expect(grokCard).toContain('data-provider-logo="grok"')
    expect(grokCard).toContain('<img class="provider-brand-logo-image')
    expect(grokCard).not.toContain('provider-glyph-grok')
    // Cursor and Grok are both CLI-login providers when available.
    expect(cursorCard).toContain('Available · CLI sign-in')
    expect(cursorCard).toContain('first-launch-sheet-provider-status-dot-signed-in')
    expect(html).toContain('Grok disabled')
  })

  it('uses ready dots for runnable Cursor, Grok, and Ollama cards', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        cursorProviderAvailable={true}
        grokProviderAvailable={true}
        ollamaProviderAvailable={true}
        onProviderLogin={() => {}}
      />
    )

    for (const provider of ['cursor', 'grok', 'ollama']) {
      expect(providerCardMarkup(html, provider)).toContain(
        'first-launch-sheet-provider-status-dot-signed-in'
      )
    }
    expect(providerCardMarkup(html, 'cursor')).toContain('Sign in')
    expect(html).toContain('Needs setup or sign-in')
    expect(html).not.toContain('stay amber')
  })

  it('describes structural Kimi admission and the explicit unreviewed label', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}      />
    )
    const card = providerCardMarkup(html, 'kimi')
    expect(card).toContain('structural identity, probe, and posture admission checks')
    expect(card).toContain('unattested-development')
    expect(card).not.toContain('require reviewed ACP runtime admission')
    expect(card).not.toContain('first-launch-sheet-provider-card-deemphasised')
  })

  it('reports historical Gemini without offering a new-run action', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}      />
    )
    const card = providerCardMarkup(html, 'gemini')
    expect(card).toContain('Historical · not offered for new runs')
    expect(card).toContain('Historical')
    expect(card).not.toContain('Sign in')
    expect(card).not.toContain('Open Settings')
    expect(card).not.toContain('Manage in Settings')
  })

  it('shows AntiGravity only when the host conditional-offer snapshot includes it', () => {
    const render = (antigravityProviderOffered: boolean) =>
      renderToStaticMarkup(
        <FirstLaunchSheet
          open={true}
          onDismiss={() => {}}
          onOpenSettings={() => {}}
          codexStatus={null}
          claudeAuthStatus={null}
          kimiAuthStatus={null}
          antigravityProviderOffered={antigravityProviderOffered}
        />
      )

    expect(render(false)).not.toContain('data-provider="antigravity"')
    const configured = render(true)
    const card = providerCardMarkup(configured, 'antigravity')
    expect(card).toContain('Conditional setup ready')
    expect(card).toContain('host confirms')
    expect(card).toContain('Conditional')
    expect(card).toContain('Open Settings')
  })

  it('adds Pi onboarding as BYOK setup without claiming admission', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        onProviderLogin={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
      />
    )
    const card = providerCardMarkup(html, 'pi')
    expect(card).toContain('BYOK setup in Settings')
    expect(card).toContain('this card does not grant provider admission')
    expect(card).not.toContain('aria-label="Sign in to Pi"')
    expect(card).toContain('Open Settings')
  })

  it('renders Ollama as a local-first provider; no sign-in shown without a login handler', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        ollamaProviderAvailable={true}
      />
    )
    expect(html).toContain('Local runtime ready')
    expect(providerCardMarkup(html, 'ollama')).toContain(
      'first-launch-sheet-provider-status-dot-signed-in'
    )
    expect(html).toContain('no cloud account needed')
    // Without an onProviderLogin handler the optional cloud sign-in is not shown.
    expect(html).not.toContain('aria-label="Sign in to Ollama Cloud"')
    expect(html).not.toContain('aria-label="Sign out of Ollama"')
  })

  it('does not show the optional ollama.com cloud Sign in once local Ollama is ready', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        onProviderLogin={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        ollamaProviderAvailable={true}
      />
    )
    const card = providerCardMarkup(html, 'ollama')
    expect(card).toContain('Local runtime ready')
    expect(card).not.toContain('aria-label="Sign in to Ollama Cloud"')
    expect(card).not.toContain('Sign in to Cloud')
    expect(card).not.toContain('aria-label="Sign out of Ollama"')
  })

  it('exposes the optional ollama.com cloud Sign in while local Ollama still needs setup', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        onProviderLogin={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        ollamaProviderAvailable={false}
      />
    )
    const card = providerCardMarkup(html, 'ollama')
    expect(card).toContain('Local setup optional')
    expect(card).toContain('aria-label="Sign in to Ollama Cloud"')
    expect(card).toContain('Sign in to Cloud')
    expect(card).not.toContain('aria-label="Sign out of Ollama"')
  })

  it('Codex card surfaces "signed in" from the private-home account result', () => {
    const codexStatus = {
      available: true,
      authState: 'chatgpt',
      account: { type: 'chatgpt', planType: 'pro' },
      planType: 'pro',
      codexUsage: { planType: 'pro', userId: 'user-123' }
    }
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={codexStatus}
        claudeAuthStatus={null}
        kimiAuthStatus={null}      />
    )
    // Plan label appears in the Codex card status row, AND the
    // signed-in dot variant class is present at least once.
    expect(html).toContain('Signed in (pro)')
    expect(html).toContain('first-launch-sheet-provider-status-dot-signed-in')
  })

  it('does not show a Sign in action for signed-in provider cards', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        onProviderLogin={() => {}}
        codexStatus={{
          available: true,
          authState: 'chatgpt',
          account: { type: 'chatgpt', planType: 'pro' },
          planType: 'pro',
          codexUsage: { planType: 'pro', userId: 'user-123' }
        }}
        claudeAuthStatus={makeProviderApiKeyStatus({ apiKeyConfigured: true })}
        kimiAuthStatus={null}
      />
    )
    expect(providerCardMarkup(html, 'codex')).not.toContain('aria-label="Sign in to Codex"')
    expect(providerCardMarkup(html, 'claude')).not.toContain('aria-label="Sign in to Claude"')
  })

  it('Codex card surfaces "Codex CLI not found" when available is false', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={{ available: false }}
        claudeAuthStatus={null}
        kimiAuthStatus={null}      />
    )
    expect(html).toContain('Codex CLI not found')
  })

  it('Codex card surfaces "Usage credential missing" when codexUsage.error is set', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={{ available: true, codexUsage: { error: 'no credential' } }}
        claudeAuthStatus={null}
        kimiAuthStatus={null}      />
    )
    expect(html).toContain('Usage credential missing')
  })

  it('keeps a usage-only Codex import distinct from runtime sign-in', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        onProviderLogin={() => {}}
        codexStatus={{
          available: true,
          authState: 'unknown',
          codexUsage: { planType: 'pro', userId: 'usage-only' }
        }}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
      />
    )
    const card = providerCardMarkup(html, 'codex')
    expect(card).toContain('Usage session available')
    expect(card).toContain('Sign in')
  })

  it('flips a signed-in provider to "out of usage" when its quota window is maxed', () => {
    const usageSummary = [
      {
        provider: 'codex',
        model: 'usage limits',
        windows: [
          {
            id: 'weekly',
            label: 'Weekly',
            limitLabel: 'Weekly limit',
            usedPercent: 100,
            resetAt: '2999-01-01T09:30:00.000Z'
          }
        ]
      }
    ] as unknown as ModelUsageAggregate[]
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={{
          available: true,
          authState: 'chatgpt',
          account: { type: 'chatgpt', planType: 'pro' },
          planType: 'pro',
          codexUsage: { planType: 'pro', userId: 'u1' }
        }}
        claudeAuthStatus={null}
        kimiAuthStatus={null}        usageSummary={usageSummary}
      />
    )
    // Codex was "signed in (pro)" but the maxed window flips it to the
    // explicit out-of-usage state: status text + card variant + quota bar.
    // (Assert the CARD class, not the dot class — the §1 legend always
    // renders an out-of-usage dot, so the dot class is not card-specific.)
    expect(html).toContain('100% used')
    expect(html).toContain('first-launch-sheet-provider-card-out-of-usage')
    expect(html).toContain('quota-progress-bar')
  })

  it('does not show a Sign in action for out-of-usage provider cards', () => {
    const usageSummary = [
      {
        provider: 'codex',
        model: 'usage limits',
        windows: [
          {
            id: 'weekly',
            label: 'Weekly',
            limitLabel: 'Weekly limit',
            usedPercent: 100
          }
        ]
      }
    ] as unknown as ModelUsageAggregate[]
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        onProviderLogin={() => {}}
        codexStatus={{
          available: true,
          authState: 'chatgpt',
          account: { type: 'chatgpt', planType: 'pro' },
          planType: 'pro',
          codexUsage: { planType: 'pro', userId: 'u1' }
        }}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        usageSummary={usageSummary}
      />
    )
    const card = providerCardMarkup(html, 'codex')
    expect(card).toContain('first-launch-sheet-provider-card-out-of-usage')
    expect(card).not.toContain('aria-label="Sign in to Codex"')
    expect(card).toContain('Open Settings')
  })

  it('keeps a signed-in provider signed-in when usage is below 100%', () => {
    const usageSummary = [
      {
        provider: 'codex',
        model: 'usage limits',
        windows: [{ id: 'weekly', label: 'Weekly', limitLabel: 'Weekly limit', usedPercent: 40 }]
      }
    ] as unknown as ModelUsageAggregate[]
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={{
          available: true,
          authState: 'chatgpt',
          account: { type: 'chatgpt', planType: 'pro' },
          planType: 'pro',
          codexUsage: { planType: 'pro', userId: 'u1' }
        }}
        claudeAuthStatus={null}
        kimiAuthStatus={null}        usageSummary={usageSummary}
      />
    )
    expect(html).toContain('Signed in (pro)')
    // No CARD should be out-of-usage at 40% (the legend's dot doesn't count).
    expect(html).not.toContain('first-launch-sheet-provider-card-out-of-usage')
  })

  it('Claude card surfaces "signed in" when apiKeyConfigured is true', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={makeProviderApiKeyStatus({ apiKeyConfigured: true })}
        kimiAuthStatus={null}      />
    )
    expect(html).toContain('API key saved')
  })

  it('Claude card shows "CLI not found" when binary is unavailable', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={makeProviderApiKeyStatus({ available: false })}
        kimiAuthStatus={null}      />
    )
    expect(html).toContain('CLI not found')
  })

  it('§3 preview composer renders the rich settings-style card (1.0.5-EW32)', () => {
    // 1.0.5-EW32 — Pre-EW32 the onboarding sheet used a minimal
    // placeholder (`first-launch-sheet-preview-composer`) that
    // looked nearly identical across the 9 composer styles. The
    // original guard test here pinned that by asserting
    // `composer-area` was NOT present (because the docking CSS
    // `position: absolute` had previously escaped the card).
    //
    // EW32 reuses the Settings → Appearance rich-preview card
    // (`.settings-composer-preview-card`) instead, which DOES
    // carry the `composer-area` className — but scoped via
    // `.settings-composer-preview-area` so the docking-escape
    // regression is no longer possible (the absolute positioning
    // is overridden at the .settings-composer-preview-card
    // level). Updated assertion: confirm the rich preview card +
    // its `data-composer-style` are present, and that the
    // composer-area lives inside the
    // `.settings-composer-preview-area` wrapper rather than
    // free-floating in the modal grid.
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}        composerStyle="claude"
      />
    )
    // The rich preview card with its data-attribute is present.
    expect(html).toMatch(/settings-composer-preview-card[^"]*"[^>]*data-composer-style="claude"/)
    // The composer-area className is now intentional, scoped via
    // the settings-composer-preview-area override.
    expect(html).toMatch(/composer-area[^"]*settings-composer-preview-area/)
    // The preview now enters the real live-composer provider scope and mounts
    // the canonical controls beneath inert regions, rather than hand-drawn
    // lookalikes that can drift from Composer.tsx.
    expect(html).toContain('settings-composer-preview-chat app-transcript provider-claude"')
    expect(html).toContain('composer-image-picker-btn composer-plus-picker-trigger')
    expect(html).toContain('data-composer-control="model"')
    expect(html).toContain('data-composer-control="permission"')
    expect(html).toMatch(/composer-inline-pickers"[^>]*inert=""/)
  })

  it('renders the footer Skip + Got it buttons', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}      />
    )
    expect(html).toContain('Skip for now')
    expect(html).toContain('Got it')
  })

  it('renders official CLI install commands for newcomers', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}      />
    )
    expect(html).toContain('npm i -g @openai/codex')
    expect(html).toContain('https://claude.ai/install.sh')
    expect(html).toContain('https://code.kimi.com/install.sh')
    expect(html).toContain('https://ollama.com/install.sh')
    expect(html).toContain('ollama run minicpm-v4.5:8b')
    expect(html).toContain('ollama run granite4.1:30b')
    expect(html).toContain('ollama run nemotron3:33b')
    expect(html).toContain('ollama run ornith:9b')
    expect(html).toContain('ollama run ornith:35b')
    expect(html).toContain('ollama run laguna-xs-2.1:q8_0')
    expect(html).toContain('ollama run qwen3.6:35b')
    expect(html).toContain('ollama run llama3.1:8b')
    expect(html).toContain('ollama run deepseek-r1:8b')
    expect(html).toContain('ollama run rnj-1')
    expect(html).toContain('ollama run glm-4.7-flash:q4_K_M')
    expect(html).toContain('ollama run north-mini-code-1.0:q4_K_M')
    expect(html).toContain('ollama run llama3.2:3b')
    expect(html).toContain('North Mini Code 1.0 needs 0.30.10+')
    expect(html).toContain('Official install commands')
  })
})
