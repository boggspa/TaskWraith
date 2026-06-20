import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { FirstLaunchSheet } from './FirstLaunchSheet'
import type { GeminiAuthStatus, ProviderApiKeyStatus } from '../../../main/store/types'
import type { ModelUsageAggregate } from '../App'

/**
 * Server-rendered smoke tests for FirstLaunchSheet. The component
 * is mostly presentation — these tests cover the gnarly bits:
 *   1. `open={false}` renders nothing (auto-show gating is host-side
 *      but this is the contract the host depends on).
 *   2. Status-summary lines flip correctly for the four provider
 *      shapes (signed-in / not-available / not-signed-in / no status).
 *   3. Kimi card is rendered with the de-emphasised class so the
 *      light-mode CSS picks up the muted styling.
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

function makeGeminiAuthStatus(overrides: Partial<GeminiAuthStatus> = {}): GeminiAuthStatus {
  return {
    available: true,
    authState: 'authenticated',
    apiKeyConfigured: false,
    encryptionAvailable: true,
    profiles: [],
    activeProfileId: null,
    ...overrides
  }
}

function providerCardMarkup(html: string, provider: string): string {
  const marker = `data-provider="${provider}"`
  const start = html.indexOf(marker)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = html.indexOf('data-provider="', start + marker.length)
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
        kimiAuthStatus={null}
        geminiAuthStatus={null}
      />
    )
    expect(html).toBe('')
  })

  it('renders provider cards including local Ollama when open', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={null}
      />
    )
    expect(html).toContain('data-provider="codex"')
    expect(html).toContain('data-provider="claude"')
    expect(html).toContain('data-provider="gemini"')
    expect(html).toContain('data-provider="kimi"')
    expect(html).toContain('data-provider="ollama"')
  })

  it('renders Welcome heading and the numbered onboarding sections', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={null}
      />
    )
    expect(html).toContain('Welcome to TaskWraith')
    expect(html).toContain('1. Sign in to your providers')
    expect(html).toContain('2. Add your first workspace')
    expect(html).toContain('3. Choose your starting look')
    expect(html).toContain('4. You stay in control')
    expect(html).toContain('5. Track your usage')
    expect(html).toContain('6. Try Ensemble chats')
    expect(html).toContain('7. Power-user shortcuts')
  })

  it('intro prose advertises live providers but not the retired Gemini', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={null}
      />
    )
    // The "It wraps …" sentence is an OFFER surface, so the retired Gemini must
    // not appear there even though its chat history is preserved elsewhere.
    expect(html).toContain('multi-provider AI CLI manager')
    expect(html).toContain('<strong>Codex</strong>')
    expect(html).toContain('<strong>Ollama</strong>')
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
        kimiAuthStatus={null}
        geminiAuthStatus={null}
        themeAppearance="blue"
        composerStyle="claude"
        userBubbleColor="purple"
      />
    )
    expect(html).toContain('Theme')
    expect(html).toContain('Composer shell')
    expect(html).toContain('Message bubble')
    expect(html).toContain('Composer preview')
    expect(html).toContain('data-composer-style="claude"')
    expect(html).toContain('data-user-bubble-color="purple"')
    expect(html).toContain('Plan / Read-only')
  })

  it('renders the Ensemble preview row with provider participants', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={null}
      />
    )
    expect(html).toContain('New Ensemble puts multiple provider participants')
    expect(html).toContain('data-provider="codex"')
    expect(html).toContain('data-provider="claude"')
    expect(html).toContain('data-provider="kimi"')
    expect(html).toContain('data-provider="ollama"')
    // Cursor, Grok, and Ollama complete the CLI/cloud/local preview roster.
    expect(html).toContain('<em>Cursor</em>')
    expect(html).toContain('<em>Grok</em>')
    expect(html).toContain('<em>Ollama</em>')
    expect(html).not.toContain('<em>Gemini</em>')
    expect(html).toContain('Turn / Continuous in the composer')
  })

  it('renders Cursor + Grok cards with original provider glyphs', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={null}
        cursorProviderAvailable={true}
        grokProviderAvailable={false}
      />
    )
    // Both CLI-login providers get cards.
    expect(html).toContain('data-provider="cursor"')
    expect(html).toContain('data-provider="grok"')
    expect(html).toMatch(/data-provider="cursor"[\s\S]*provider-glyph-cursor/)
    expect(html).toMatch(/data-provider="grok"[\s\S]*provider-glyph-grok/)
    expect(html).not.toMatch(/<img[^>]+first-launch-sheet-provider-card-logo/)
    // Enabled Cursor → "Available" sign-in state; disabled Grok → "disabled".
    expect(html).toContain('Available · CLI sign-in')
    expect(html).toContain('Grok disabled')
  })

  it('uses ready status dots for available Cursor, Grok, and Ollama cards', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={null}
        cursorProviderAvailable={true}
        grokProviderAvailable={true}
        ollamaProviderAvailable={true}
      />
    )

    for (const provider of ['cursor', 'grok', 'ollama']) {
      expect(providerCardMarkup(html, provider)).toContain(
        'first-launch-sheet-provider-status-dot-signed-in'
      )
    }
    expect(html).toContain('Needs setup or sign-in')
    expect(html).not.toContain('stay amber')
  })

  it('Kimi card carries the de-emphasised + optional classes for muted styling', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={null}
      />
    )
    // The kimi card div should appear with both modifier classes.
    expect(html).toMatch(
      /first-launch-sheet-provider-card[^"]*first-launch-sheet-provider-card-deemphasised/
    )
  })

  it('does not offer the retired Gemini provider as an onboarding sign-in card', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={null}
      />
    )
    // Gemini is RETIRED — its sign-in card is no longer rendered. The four
    // remaining optional cards are Kimi, Cursor, Grok, Ollama.
    expect(html).not.toContain('Google Gemini CLI')
    const badges = html.match(/first-launch-sheet-provider-card-optional-badge/g)
    expect(badges).toBeTruthy()
    expect(badges!.length).toBe(4)
  })

  it('renders Ollama as a local-only optional provider without sign-in copy', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={null}
        ollamaProviderAvailable={true}
      />
    )
    expect(html).toContain('Local runtime ready')
    expect(providerCardMarkup(html, 'ollama')).toContain(
      'first-launch-sheet-provider-status-dot-signed-in'
    )
    expect(html).toContain('No cloud account is needed')
    expect(html).not.toContain('aria-label="Sign in to Ollama"')
    expect(html).not.toContain('aria-label="Sign out of Ollama"')
  })

  it('Codex card surfaces "signed in" when codexStatus.codexUsage.planType is present', () => {
    const codexStatus = {
      available: true,
      codexUsage: { planType: 'pro', userId: 'user-123' }
    }
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={codexStatus}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={null}
      />
    )
    // Plan label appears in the Codex card status row, AND the
    // signed-in dot variant class is present at least once.
    expect(html).toContain('Signed in (pro)')
    expect(html).toContain('first-launch-sheet-provider-status-dot-signed-in')
  })

  it('Codex card surfaces "Codex CLI not found" when available is false', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={{ available: false }}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={null}
      />
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
        kimiAuthStatus={null}
        geminiAuthStatus={null}
      />
    )
    expect(html).toContain('Usage credential missing')
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
        codexStatus={{ available: true, codexUsage: { planType: 'pro', userId: 'u1' } }}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={null}
        usageSummary={usageSummary}
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
        codexStatus={{ available: true, codexUsage: { planType: 'pro', userId: 'u1' } }}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={null}
        usageSummary={usageSummary}
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
        kimiAuthStatus={null}
        geminiAuthStatus={null}
      />
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
        kimiAuthStatus={null}
        geminiAuthStatus={null}
      />
    )
    expect(html).toContain('CLI not found')
  })

  it('does not surface a Gemini profile card even when a gemini profile is active (retired)', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={makeGeminiAuthStatus({
          activeProfileId: 'profile-1',
          activeProfileLabel: 'work-gemini'
        })}
      />
    )
    expect(html).not.toContain('Active profile: work-gemini')
    expect(html).not.toContain('Google Gemini CLI')
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
        kimiAuthStatus={null}
        geminiAuthStatus={null}
        composerStyle="claude"
      />
    )
    // The rich preview card with its data-attribute is present.
    expect(html).toMatch(/settings-composer-preview-card[^"]*"[^>]*data-composer-style="claude"/)
    // The composer-area className is now intentional, scoped via
    // the settings-composer-preview-area override.
    expect(html).toMatch(/composer-area[^"]*settings-composer-preview-area/)
  })

  it('renders the footer Skip + Got it buttons', () => {
    const html = renderToStaticMarkup(
      <FirstLaunchSheet
        open={true}
        onDismiss={() => {}}
        onOpenSettings={() => {}}
        codexStatus={null}
        claudeAuthStatus={null}
        kimiAuthStatus={null}
        geminiAuthStatus={null}
      />
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
        kimiAuthStatus={null}
        geminiAuthStatus={null}
      />
    )
    expect(html).toContain('npm i -g @openai/codex')
    expect(html).toContain('https://claude.ai/install.sh')
    expect(html).toContain('https://code.kimi.com/install.sh')
    expect(html).toContain('https://ollama.com/install.sh')
    expect(html).toContain('ollama run minicpm-v4.5:8b')
    expect(html).toContain('ollama run granite4.1:30b')
    expect(html).toContain('ollama run nemotron3:33b')
    expect(html).toContain('ollama run qwen3.6:35b')
    expect(html).toContain('Official install commands')
  })
})
