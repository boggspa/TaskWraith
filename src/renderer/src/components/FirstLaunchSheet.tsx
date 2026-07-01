import React, { useEffect, useRef } from 'react'
import type {
  AppSettings,
  ComposerStyle,
  ProviderApiKeyStatus,
  ThemeAppearance,
  UserBubbleColor
} from '../../../main/store/types'
import {
  summariseCliProviderEnabled,
  summariseCodexStatus,
  summariseProviderApiKeyStatus,
  type ProviderAuthVariant
} from '../lib/providerAuthSummary'
import taskwraithGhostMonolineSvg from '../assets/taskwraith-ghost-monoline.svg?raw'
import { ProviderGlyph } from './icons/ProviderGlyph'
import { isRetiredProvider } from '../../../shared/retiredProviders'
import { NotificationZone } from './NotificationZone'
import { CommittedDraftField } from './CommittedDraftField'
import { ComposerShellPreview } from './ComposerShellPreview'
// 1.0.7-EW — onboarding "out of usage" card state. ModelUsageAggregate is the
// same per-provider quota shape the sidebar Model Usage card consumes; type-only
// import from the shared usage aggregate type module.
import type { ModelUsageAggregate } from '../lib/usageAggregateTypes'
import { formatResetShort } from '../lib/UsageFormat'
import { QuotaProgressBar } from './QuotaProgressBar'
import { ProviderInstallCommands } from './ProviderInstallCommands'

type OnboardingProviderId =
  | 'codex'
  | 'claude'
  | 'gemini'
  | 'kimi'
  | 'cursor'
  | 'grok'
  | 'ollama'

/**
 * FirstLaunchSheet — onboarding overlay for fresh TaskWraith testers.
 *
 * Auto-shows on first launch (gated by a localStorage flag in App.tsx)
 * and can be re-opened anytime via the `?` button in the chat-corner
 * controls. Replaces the lightweight T1b sidebar hint as the primary
 * onboarding surface; the sidebar hint remains as a passive inline
 * reminder once the sheet is dismissed.
 *
 * Trade-offs (per the work scope):
 *   1. **Sheet not wizard.** One scrollable sheet with five sections
 *      reads slightly more content-dense than a 4-step wizard, but
 *      it's half the JSX, easier to test, and lets the user skim
 *      sections out of order. A wizard is the right next iteration
 *      if testers report friction.
 *
 *   2. **Deep-link to Settings for auth.** Per-provider sign-in flows
 *      (Claude OAuth + API key, Gemini OAuth + profile management,
 *      Kimi API key) live in `SettingsPanel.tsx` and are tightly
 *      coupled to App-owned state + main-process IPC. Recreating
 *      them inline would mean lifting that wiring into yet another
 *      surface. Cards here show status only and deep-link via
 *      `onOpenSettings()` — the host opens Settings and the user
 *      finishes the flow there. Codex is a special case: it has
 *      no in-app auth UI today (the user signs in to the OS
 *      `codex` CLI via `codex login` in their shell), so the card
 *      surfaces the shell command directly with a copy affordance.
 *
 *   3. **Sidebar hint retained.** Per the "safer" path in the spec:
 *      the lightweight sidebar hint card (T1b) still renders for
 *      empty workspaces. Its dismissal X persists independently
 *      from the sheet's dismissal flag. This gives users two surfaces
 *      for the same prompt without coupling them.
 *
 * Pointer animation: handled by the host (App.tsx) — when the sheet
 * dismisses for the first time, the host flips a transient flag that
 * tells the sidebar's `+` workspace button to render a pulsing
 * highlight + a small "Start here" label for ~6 seconds.
 */

export interface FirstLaunchSheetProps {
  /** Sheet visibility. Host owns the flag; sheet has no internal show
   * state so we don't double-source it. */
  open: boolean
  /** Called when the user dismisses via "Got it", Skip, Esc, or
   * click-outside. The host persists the dismissal flag AND triggers
   * the first-time pointer animation. */
  onDismiss: () => void
  /** Deep-link callback. Closes the sheet and opens the Settings
   * panel — the user finishes provider sign-in there. */
  onOpenSettings: () => void
  /** 1.0.6-CRUX42 — open a Terminal running provider-owned CLI auth. */
  onProviderLogin?: (provider: OnboardingProviderId) => void
  onProviderLogout?: (provider: OnboardingProviderId) => void
  /** Codex CLI status. Pulled from `agentStatusByProvider.codex` or
   * the top-level `codexStatus` in App.tsx. Used to decide whether
   * to show "signed in" / "binary not found" / "not authenticated".
   * Loose any-shape since the underlying store type isn't strict. */
  codexStatus: any
  /** Claude / Kimi auth status objects from App.tsx. */
  claudeAuthStatus: ProviderApiKeyStatus | null
  kimiAuthStatus: ProviderApiKeyStatus | null
  /** Cursor / Grok are CLI-login providers (1.0.6). TaskWraith only knows
   * whether each adapter is registered (enabled) — auth lives in their own
   * CLI — so the cards surface availability + deep-link to Settings.
   * Optional so older hosts / static tests can omit them. */
  cursorProviderAvailable?: boolean
  grokProviderAvailable?: boolean
  /** Ollama local mode has no sign-in; this only reflects whether
   * TaskWraith can see a local Ollama runtime/service. */
  ollamaProviderAvailable?: boolean
  /** Per-provider quota aggregates (App.tsx#usageSummary). Lets a
   * signed-in provider card flip to an explicit "out of usage" state
   * when its window hits ~100% — otherwise a rate-limited provider
   * just reads as "signed in" and the wall looks like a bug. Optional
   * so static tests / older hosts can omit it. */
  usageSummary?: ModelUsageAggregate[]
  /** Appearance controls are optional so static tests and older hosts
   * can render the sheet without wiring the preference preview. */
  themeAppearance?: ThemeAppearance
  composerStyle?: ComposerStyle
  userBubbleColor?: UserBubbleColor
  userName?: string
  onAppearancePreviewChange?: (
    next: Partial<
      Pick<AppSettings, 'themeAppearance' | 'composerStyle' | 'userBubbleColor' | 'userName'>
    >
  ) => void
}

type ProviderRowVariant = ProviderAuthVariant

interface ProviderRowSpec {
  id: OnboardingProviderId
  label: string
  description: string
  variant: ProviderRowVariant
  statusText: string
  /** Optional "what to do" hint. Renders below the status pill. */
  hint: string
  /** When true, the card is visually de-emphasised for optional providers. */
  deemphasised?: boolean
  /** When true, the card is marked optional but still actionable. */
  optional?: boolean
  /** Local setup rows do not show provider-owned sign-in / sign-out actions. */
  localOnly?: boolean
  /** Local-first rows (Ollama) that still expose an OPTIONAL cloud sign-in
   * button (e.g. `ollama signin` for ollama.com) without the generic sign-out
   * (which is driven by run status, not cloud auth). */
  cloudSignIn?: boolean
  /** Set when the provider is signed in but its quota window is at
   * ~100% — drives the "out of usage" card treatment + progress bar. */
  usage?: { fraction: number; resetAt?: string }
}

const SHEET_TITLE_ID = 'first-launch-sheet-title'

/** A provider window counts as "out of usage" once its used fraction
 * reaches ~100% — at that point the provider rate-limits runs, so the
 * card must say so instead of a bare "signed in". 0.999 (not 1.0)
 * absorbs float noise from `usedPercent / 100`. */
const OUT_OF_USAGE_FRACTION = 0.999

/**
 * Worst (most-consumed) quota window for a provider, derived from the
 * same `usageSummary` the sidebar Model Usage card reads. Mirrors
 * ModelUsageCard's `fillFractionForWindow`: prefer the honest
 * `usedPercent`, fall back to `1 - remainingPercent`. Returns null when
 * the provider has no quota data (Cursor/Grok never do; the others only
 * after a usage probe). Kept local to avoid a runtime import cycle with
 * App.tsx — the duplication is 4 lines.
 */
function worstProviderUsage(
  usageSummary: ModelUsageAggregate[] | undefined,
  providerId: OnboardingProviderId
): { fraction: number; resetAt?: string } | null {
  if (!usageSummary || usageSummary.length === 0) return null
  const entry = usageSummary.find(
    (e) => e.provider === providerId && e.model === 'usage limits' && (e.windows?.length || 0) > 0
  )
  if (!entry?.windows) return null
  let worst: { fraction: number; resetAt?: string } | null = null
  for (const w of entry.windows) {
    const used = Number.isFinite(w.usedPercent)
      ? Math.max(0, Math.min(1, (w.usedPercent as number) / 100))
      : Number.isFinite(w.remainingPercent)
        ? Math.max(0, Math.min(1, 1 - (w.remainingPercent as number) / 100))
        : 0
    if (!worst || used > worst.fraction) worst = { fraction: used, resetAt: w.resetAt }
  }
  return worst
}

/**
 * Flip a signed-in provider row to the "out of usage" state when its
 * worst quota window is at ~100%. No-op for every other variant (you
 * can't be "out of usage" if you were never signed in) and when there's
 * no quota data — so tests/hosts that omit `usageSummary` are unchanged.
 */
function applyOutOfUsage(
  row: ProviderRowSpec,
  usageSummary: ModelUsageAggregate[] | undefined
): ProviderRowSpec {
  if (row.variant !== 'signed-in') return row
  const worst = worstProviderUsage(usageSummary, row.id)
  if (!worst || worst.fraction < OUT_OF_USAGE_FRACTION) return row
  const reset = formatResetShort({ resetAt: worst.resetAt })
  return {
    ...row,
    variant: 'out-of-usage',
    statusText: reset ? `100% used · resets ${reset}` : '100% used',
    hint: 'Signed in, but rate-limited right now — wait for the reset, switch provider, or switch model. This is a quota wall, not a bug.',
    usage: worst
  }
}

const ONBOARDING_THEME_OPTIONS: Array<{ value: ThemeAppearance; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'midnight', label: 'Midnight' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'red', label: 'Red' },
  { value: 'orange', label: 'Orange' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'green', label: 'Green' },
  { value: 'graphite', label: 'Graphite' },
  { value: 'rainbow', label: 'Rainbow' },
  { value: 'nebula', label: 'Nebula' },
  { value: 'citrus', label: 'Citrus' },
  { value: 'twilight', label: 'Twilight' },
  { value: 'ocean', label: 'Ocean' },
  { value: 'sunset', label: 'Sunset' },
  { value: 'forest', label: 'Forest' },
  { value: 'cyber', label: 'Cyber' },
  { value: 'candy', label: 'Candy' },
  { value: 'mist', label: 'Mist' },
  { value: 'sage', label: 'Sage' },
  // 1.0.5-EW65 — Surface the EW54/EW61 premium-stone themes
  // in the first-launch picker so new users see them at the
  // onboarding moment (the original window when most theme
  // exploration happens).
  { value: 'obsidian', label: 'Obsidian' },
  { value: 'alabaster', label: 'Alabaster' }
]

const ONBOARDING_COMPOSER_OPTIONS: Array<{ value: ComposerStyle; label: string }> = [
  { value: 'default', label: 'TaskWraith native' },
  { value: 'codex', label: 'Codex shell' },
  { value: 'claude', label: 'Claude shell' },
  { value: 'cursor', label: 'Cursor shell' },
  { value: 'grok', label: 'Grok shell' },
  { value: 'gemini', label: 'Gemini shell' },
  { value: 'kimi', label: 'Kimi shell' },
  { value: 'modular', label: 'Modular' },
  { value: 'terminal', label: 'Terminal' },
  { value: 'stub', label: 'Ticket stub' },
  { value: 'satellite', label: 'Satellite' },
  // 1.0.5-EW65 — Pair the EW55/EW61 premium composer styles
  // with their themes in the picker. Both are theme-immune so
  // they work paired with any theme; presenting them adjacent
  // in the list keeps the picker honest about the family.
  { value: 'obsidian', label: 'Obsidian' },
  { value: 'alabaster', label: 'Alabaster' }
]

const ONBOARDING_BUBBLE_OPTIONS: Array<{ value: UserBubbleColor; label: string }> = [
  { value: 'system', label: 'Default' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'pink', label: 'Pink' },
  { value: 'orange', label: 'Orange' },
  { value: 'green', label: 'Green' },
  { value: 'red', label: 'Red' },
  { value: 'yellow', label: 'Yellow' },
  { value: 'graphite', label: 'Graphite' }
]

export function FirstLaunchSheet({
  open,
  onDismiss,
  onOpenSettings,
  onProviderLogin,
  onProviderLogout,
  codexStatus,
  claudeAuthStatus,
  kimiAuthStatus,
  cursorProviderAvailable = false,
  grokProviderAvailable = false,
  ollamaProviderAvailable = false,
  usageSummary,
  themeAppearance = 'system',
  composerStyle = 'default',
  userBubbleColor = 'system',
  userName = '',
  onAppearancePreviewChange
}: FirstLaunchSheetProps): React.JSX.Element | null {
  const dismissRef = useRef(onDismiss)
  useEffect(() => {
    dismissRef.current = onDismiss
  }, [onDismiss])

  // Dialog element — used for initial focus + the Tab focus trap below.
  const dialogRef = useRef<HTMLDivElement | null>(null)

  // Esc-to-dismiss. Capture-phase listener so we beat any nested
  // shortcut handlers (composer, etc.) that swallow Escape — when
  // the sheet is open, Escape should ALWAYS close it first.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        dismissRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  // Initial focus + lightweight Tab/Shift+Tab focus trap. On open we
  // move focus to the first interactive control (the close button) so
  // keyboard users land inside the modal, then wrap Tab around the
  // dialog's focusable elements so focus can't escape to the page
  // behind the backdrop. Mirrors the autofocus-on-open idiom in
  // BugReportSheet / WorkSessionSetupSheet.
  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    const getFocusable = (): HTMLElement[] =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === document.activeElement)
    const frame = window.requestAnimationFrame(() => {
      getFocusable()[0]?.focus()
    })
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return
      const focusable = getFocusable()
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !dialog.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(frame)
      dialog.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!open) return null

  const codexSummary = summariseCodexStatus(codexStatus)
  const claudeSummary = summariseProviderApiKeyStatus(claudeAuthStatus, 'Claude')
  const kimiSummary = summariseProviderApiKeyStatus(kimiAuthStatus, 'Kimi')
  const cursorSummary = summariseCliProviderEnabled(
    cursorProviderAvailable,
    'Cursor',
    'Sign in once with `cursor-agent login` in your shell, then launch Cursor runs.'
  )
  const grokSummary = summariseCliProviderEnabled(
    grokProviderAvailable,
    'Grok',
    'Authenticate the Grok CLI (in `~/.grok/bin`) in your shell, then launch Grok runs.'
  )

  const baseProviderRows: ProviderRowSpec[] = [
    {
      id: 'codex',
      label: 'Codex',
      description:
        'OpenAI Codex CLI. Fast-twitch shell / agentic work. Sign-in is at the OS level — run `codex login` in your terminal once.',
      ...codexSummary
    },
    {
      id: 'claude',
      label: 'Claude',
      description:
        'Anthropic Claude Code. Strong reasoning and careful edits. Sign-in opens a browser OAuth window, or paste an Anthropic API key in Settings.',
      ...claudeSummary
    },
    {
      id: 'kimi',
      label: 'Kimi',
      description:
        'Moonshot Kimi. Wire-protocol-driven runs and structured tool calls. Skip unless you have a Moonshot API key.',
      ...kimiSummary,
      deemphasised: true,
      optional: true
    },
    {
      id: 'cursor',
      label: 'Cursor',
      description:
        'Cursor Composer 2.5. Write-capable agentic runs via the Cursor CLI. Sign-in is at the OS level — run `cursor-agent login` in your terminal once.',
      ...cursorSummary,
      optional: true
    },
    {
      id: 'grok',
      label: 'Grok',
      description:
        'xAI Grok over its agent CLI. Sign in through the Grok CLI; skip unless you have an xAI/Grok account.',
      ...grokSummary,
      deemphasised: true,
      optional: true
    },
    {
      id: 'ollama',
      label: 'Ollama',
      description:
        'Local models running through Ollama. Best for on-device Qwen, Granite, Gemma, Ornith, GPT OSS, MiniCPM, or Nemotron testing — no cloud account needed. Sign in to ollama.com to also use Ollama Cloud / Turbo and private models.',
      variant: ollamaProviderAvailable ? 'signed-in' : 'partial',
      statusText: ollamaProviderAvailable ? 'Local runtime ready' : 'Local setup optional',
      hint: ollamaProviderAvailable
        ? 'Pick Local / Ollama in the provider picker, then choose an installed model in Settings or the composer.'
        : 'Install Ollama, then pull a model such as `qwen3:4b-instruct`, `qwen3.6:35b`, `ornith:9b`, `granite4.1:30b`, `minicpm-v4.5:8b`, or `gpt-oss:20b`.',
      deemphasised: true,
      optional: true,
      localOnly: true,
      cloudSignIn: true
    }
  ]
  // Flip any signed-in provider whose quota window is maxed to the
  // explicit "out of usage" state — the tester-confusion fix.
  // Retired providers (see retiredProviders.ts) are never offered as onboarding
  // sign-in cards — filtered here defensively even though none are seeded above.
  const providerRows = baseProviderRows
    .map((row) => applyOutOfUsage(row, usageSummary))
    .filter((row) => !isRetiredProvider(row.id))

  return (
    <div
      className="first-launch-sheet-backdrop"
      role="presentation"
      onClick={(e) => {
        // Click-outside to dismiss. Only fire when the click truly
        // started AND ended on the backdrop (not a stray release after
        // dragging out of the sheet's body).
        if (e.target === e.currentTarget) onDismiss()
      }}
    >
      <div
        ref={dialogRef}
        className="first-launch-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={SHEET_TITLE_ID}
      >
        <header className="first-launch-sheet-header">
          <div className="first-launch-sheet-header-text">
            {/*
              Theme-aware monoline mark. The SVG uses currentColor and is
              rendered inline so it inherits the active TaskWraith palette.
            */}
            <span
              className="first-launch-sheet-ghost first-launch-sheet-ghost-monoline"
              aria-hidden
              dangerouslySetInnerHTML={{ __html: taskwraithGhostMonolineSvg }}
            />
            <div>
              <h2 id={SHEET_TITLE_ID}>Welcome to TaskWraith</h2>
              <p className="first-launch-sheet-subtitle">
                First-launch checklist — providers, workspace, goals, look, and Ensemble basics.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="first-launch-sheet-close"
            onClick={onDismiss}
            aria-label="Close onboarding sheet"
            title="Close"
          >
            ×
          </button>
        </header>

        <NotificationZone />

        <section className="first-launch-sheet-section">
          <p className="first-launch-sheet-prose">
            TaskWraith is a multi-provider AI CLI manager. It wraps <strong>Codex</strong>,{' '}
            <strong>Claude</strong>, <strong>Kimi</strong>, <strong>Cursor</strong>,{' '}
            <strong>Grok</strong>, and local <strong>Ollama</strong> models inside one consistent
            chrome so you can run and compare
            them side-by-side in the same UI. Each provider keeps its own auth — sign in to the
            ones you want to use, skip the rest. Goals, approvals, audit runs, and usage history stay
            in TaskWraith&apos;s local ledger so each provider shares the same operating context.
          </p>
        </section>

        <section className="first-launch-sheet-section">
          <label className="settings-label">Your name (optional)</label>
          <CommittedDraftField
            className="settings-select"
            committed={userName}
            onCommit={(value) => onAppearancePreviewChange?.({ userName: value })}
            placeholder="e.g. Chris"
          />
          <p className="first-launch-sheet-section-helper">
            We&apos;ll use this to greet you in your General chats. Leave blank to skip.
          </p>
        </section>

        <section className="first-launch-sheet-section">
          <h3 className="first-launch-sheet-section-title">1. Sign in to your providers</h3>
          <p className="first-launch-sheet-section-helper">
            Status reflects what TaskWraith can see right now. A red dot can mean two different things
            — read the label. Green means TaskWraith can launch that provider from this app. Open
            Settings for inline sign-in flows (OAuth, API keys, CLI paths).
          </p>
          <ul className="first-launch-sheet-status-legend" aria-label="What the status dots mean">
            <li>
              <span
                className="first-launch-sheet-provider-status-dot first-launch-sheet-provider-status-dot-signed-in"
                aria-hidden
              />
              Ready
            </li>
            <li>
              <span
                className="first-launch-sheet-provider-status-dot first-launch-sheet-provider-status-dot-not-signed-in"
                aria-hidden
              />
              Installed · not signed in
            </li>
            <li>
              <span
                className="first-launch-sheet-provider-status-dot first-launch-sheet-provider-status-dot-partial"
                aria-hidden
              />
              Needs setup or sign-in
            </li>
            <li>
              <span
                className="first-launch-sheet-provider-status-dot first-launch-sheet-provider-status-dot-not-available"
                aria-hidden
              />
              CLI not found · install it
            </li>
            <li>
              <span
                className="first-launch-sheet-provider-status-dot first-launch-sheet-provider-status-dot-out-of-usage"
                aria-hidden
              />
              Signed in · out of usage (resets later)
            </li>
          </ul>
          <p className="first-launch-sheet-section-helper">
            Providers sign in three ways: <strong>Codex</strong>, <strong>Cursor</strong>, and{' '}
            <strong>Grok</strong> log in through their own CLI in a Terminal;{' '}
            <strong>Claude</strong> uses in-app OAuth or an API key;{' '}
            <strong>Kimi</strong> takes an API key. <strong>Ollama</strong> is local-only: install
            Ollama, pull a model, and no cloud account is needed. Cursor and Grok auth stays inside
            their CLIs, so TaskWraith marks those cards ready when the provider adapter is available;
            the CLI may still ask you to finish login in Terminal.
          </p>
          <div className="first-launch-sheet-provider-grid">
            {providerRows.map((row) => (
              <ProviderCard
                key={row.id}
                row={row}
                onOpenSettings={onOpenSettings}
                onProviderLogin={onProviderLogin}
                onProviderLogout={onProviderLogout}
              />
            ))}
          </div>
          <details className="first-launch-sheet-install">
            <summary>Don&apos;t have a CLI yet? Official install commands</summary>
            <p className="first-launch-sheet-section-helper">
              Run one in your terminal, then come back and sign in. (npm commands need Node 20+; the
              curl installers are self-contained. Ollama is local: install it, then pull a model.)
            </p>
            <ProviderInstallCommands />
          </details>
        </section>

        <section className="first-launch-sheet-section">
          <h3 className="first-launch-sheet-section-title">2. Add your first workspace</h3>
          <p className="first-launch-sheet-prose">
            A <strong>workspace</strong> is a project folder TaskWraith has read / edit permission
            inside. Every chat is rooted in a workspace, and the agent can only touch files within
            its trust boundary. Find the <span className="first-launch-sheet-plus">+</span> button
            in the sidebar header (next to &quot;Workspaces&quot;) and pick a folder. You can add
            more later.
          </p>
        </section>

        <section className="first-launch-sheet-section">
          <h3 className="first-launch-sheet-section-title">3. Choose your starting look</h3>
          <p className="first-launch-sheet-section-helper">
            These controls write to Appearance settings immediately. The preview is inert, so it
            will never touch your active chat prompt.
          </p>
          <div
            className="first-launch-sheet-preference-card"
            data-theme={themeAppearance}
            data-composer-style={composerStyle}
            data-user-bubble-color={userBubbleColor}
          >
            <div className="first-launch-sheet-preference-controls">
              <label className="first-launch-sheet-preference-field">
                <span>Theme</span>
                <select
                  value={themeAppearance}
                  onChange={(e) =>
                    onAppearancePreviewChange?.({
                      themeAppearance: e.target.value as ThemeAppearance
                    })
                  }
                >
                  {ONBOARDING_THEME_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="first-launch-sheet-preference-field">
                <span>Composer shell</span>
                <select
                  value={composerStyle}
                  onChange={(e) =>
                    onAppearancePreviewChange?.({
                      composerStyle: e.target.value as ComposerStyle
                    })
                  }
                >
                  {ONBOARDING_COMPOSER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="first-launch-sheet-preference-field">
                <span>Message bubble</span>
                <select
                  value={userBubbleColor}
                  onChange={(e) =>
                    onAppearancePreviewChange?.({
                      userBubbleColor: e.target.value as UserBubbleColor
                    })
                  }
                >
                  {ONBOARDING_BUBBLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/*
              Onboarding renders the SAME shared <ComposerShellPreview> the
              Settings → Appearance pane uses, so the shell a tester picks here
              previews identically to the live composer (and can never drift
              from the Settings copy — there is no longer a second replica). The
              onboarding sheet omits the font props (the user hasn't chosen
              fonts yet) so the preview inherits, and leaves `editable` off so
              the inert placeholder div keeps the focus-trap traversal clean.
              The `first-launch-sheet-composer-preview` wrapper stays for the
              onboarding-specific outer spacing.
            */}
            <div className="first-launch-sheet-composer-preview" aria-label="Composer preview">
              <ComposerShellPreview
                composerStyle={composerStyle}
                themeAppearance={themeAppearance}
              />
            </div>
          </div>
        </section>

        <section className="first-launch-sheet-section">
          <h3 className="first-launch-sheet-section-title">4. You stay in control</h3>
          <p className="first-launch-sheet-section-helper">
            Agents ask before doing anything risky — those prompts are the safety feature, not
            errors. You decide how much rope each run gets.
          </p>
          <div className="first-launch-sheet-safety">
            <div className="first-launch-sheet-safety-block">
              <span className="first-launch-sheet-safety-label">When an agent wants to act</span>
              <div className="first-launch-sheet-safety-chips">
                <span className="first-launch-sheet-safety-chip">Allow once</span>
                <span className="first-launch-sheet-safety-chip">In this workspace</span>
                <span className="first-launch-sheet-safety-chip">For this session</span>
                <span className="first-launch-sheet-safety-chip danger">Deny</span>
              </div>
            </div>
            <div className="first-launch-sheet-safety-block">
              <span className="first-launch-sheet-safety-label">Start cautious, dial up</span>
              <div className="first-launch-sheet-safety-chips">
                <span className="first-launch-sheet-safety-chip">Plan workflow</span>
                <span className="first-launch-sheet-safety-chip">Read-only recon</span>
                <span className="first-launch-sheet-safety-chip">Default approval</span>
                <span className="first-launch-sheet-safety-chip">Full workspace access</span>
              </div>
            </div>
          </div>
          <p className="first-launch-sheet-prose">
            Runs are sandboxed to the workspace you grant — files outside the project are off-limits
            unless you allow a path. Set the workflow and permission for each run from the
            composer controls before you hit Enter.
          </p>
        </section>

        <section className="first-launch-sheet-section">
          <h3 className="first-launch-sheet-section-title">5. Track your usage &amp; spend</h3>
          <p className="first-launch-sheet-section-helper">
            Hit a wall mid-run? It&apos;s almost always a provider quota, not a bug. The{' '}
            <strong>Model Usage</strong> card in the sidebar shows how much of each provider&apos;s
            quota you&apos;ve used and when it resets.
          </p>
          <div className="first-launch-sheet-usage-mock" aria-hidden>
            <div className="first-launch-sheet-usage-mock-row">
              <span className="first-launch-sheet-usage-mock-label">Codex</span>
              <QuotaProgressBar fraction={0.78} accent="var(--provider-codex-color)" />
              <span className="first-launch-sheet-usage-mock-pct">78%</span>
            </div>
            <div className="first-launch-sheet-usage-mock-row">
              <span className="first-launch-sheet-usage-mock-label">Claude</span>
              <QuotaProgressBar fraction={0.42} accent="var(--provider-claude-color)" />
              <span className="first-launch-sheet-usage-mock-pct">42%</span>
            </div>
            <div className="first-launch-sheet-usage-mock-row">
              <span className="first-launch-sheet-usage-mock-label">Kimi</span>
              <QuotaProgressBar fraction={0.56} accent="var(--provider-kimi-color)" />
              <span className="first-launch-sheet-usage-mock-pct">56%</span>
            </div>
            <div className="first-launch-sheet-usage-mock-row">
              <span className="first-launch-sheet-usage-mock-label">Cursor</span>
              <QuotaProgressBar fraction={0.12} accent="var(--provider-cursor-color)" />
              <span className="first-launch-sheet-usage-mock-pct">12%</span>
            </div>
            <div className="first-launch-sheet-usage-mock-row">
              <span className="first-launch-sheet-usage-mock-label">Grok</span>
              <QuotaProgressBar fraction={0.07} accent="var(--provider-grok-color)" />
              <span className="first-launch-sheet-usage-mock-pct">7%</span>
            </div>
          </div>
          <p className="first-launch-sheet-prose">
            Every run also shows a live token + cost tally next to Send, and the dashboard fills in
            usage heatmaps and per-provider totals as you go. Local Ollama runs have no cloud quota,
            but their token totals still appear in usage history.
          </p>
        </section>

        <section className="first-launch-sheet-section">
          <h3 className="first-launch-sheet-section-title">6. Try Ensemble chats</h3>
          <p className="first-launch-sheet-section-helper">
            <strong>Get one provider working first</strong> — Ensemble shines with two or more. New
            Ensemble puts multiple provider participants in one shared transcript. Turn mode keeps
            one active speaker at a time; Continuous mode lets the panel keep moving. Hit the
            <strong> Work Session</strong> button in the composer to run a supervised multi-round
            autonomy session with one of five presets (One-shot review · Architecture panel · Scout
            pass · Implementation review · Long-running work session).
          </p>
          <div className="first-launch-sheet-ensemble-preview" aria-label="Ensemble row preview">
            <div className="first-launch-sheet-ensemble-strip">
              <span className="first-launch-sheet-ensemble-chip" data-provider="codex">
                <strong>Worker</strong>
                <em>Codex</em>
              </span>
              <span className="first-launch-sheet-ensemble-arrow" aria-hidden>
                →
              </span>
              <span className="first-launch-sheet-ensemble-chip" data-provider="claude">
                <strong>Explorer</strong>
                <em>Claude</em>
              </span>
              <span className="first-launch-sheet-ensemble-arrow" aria-hidden>
                →
              </span>
              <span className="first-launch-sheet-ensemble-chip" data-provider="kimi">
                <strong>Reviewer</strong>
                <em>Kimi</em>
              </span>
              <span className="first-launch-sheet-ensemble-arrow" aria-hidden>
                →
              </span>
              <span className="first-launch-sheet-ensemble-chip" data-provider="cursor">
                <strong>Editor</strong>
                <em>Cursor</em>
              </span>
              <span className="first-launch-sheet-ensemble-arrow" aria-hidden>
                →
              </span>
              <span className="first-launch-sheet-ensemble-chip" data-provider="grok">
                <strong>Scout</strong>
                <em>Grok</em>
              </span>
              <span className="first-launch-sheet-ensemble-arrow" aria-hidden>
                →
              </span>
              <span className="first-launch-sheet-ensemble-chip" data-provider="ollama">
                <strong>Local</strong>
                <em>Ollama</em>
              </span>
            </div>
            <div className="first-launch-sheet-ensemble-footer">
              <span>+ New → New Ensemble</span>
              <span>Turn / Continuous in the composer</span>
            </div>
          </div>
        </section>

        <section className="first-launch-sheet-section">
          <h3 className="first-launch-sheet-section-title">7. Power-user shortcuts (optional)</h3>
          <ul className="first-launch-sheet-tips">
            <li>
              <strong>-@ to reference files.</strong> Type <code>-@</code> in the composer to
              mention a specific file by path; the agent reads it as part of the turn. Plain{' '}
              <code>@</code> now mentions a sub-agent or Ensemble participant.
            </li>
            <li>
              <strong>/ for slash commands.</strong> Type <code>/</code> at the start of the
              composer for the slash menu — quick handles for compact, help, feedback, model swaps,
              etc.
            </li>
            <li>
              <strong>Cmd-K opens slash commands.</strong> Anywhere in the app, press{' '}
              <kbd>Cmd</kbd>+<kbd>K</kbd> to open the composer slash menu.
            </li>
            <li>
              <strong>Commit &amp; open PRs from the composer.</strong> The composer&apos;s{' '}
              <em>Review changes</em> menu has a real Git flow — see your branch and changed files,
              write a message and <em>Stage all &amp; Commit</em>, then <em>Create PR</em> once the
              branch is pushed and ready.
            </li>
            <li>
              <strong>Permission picker colour-codes the authority.</strong> Plan workflow is
              separate from Read-only recon: Plan drafts for approval, Default stays neutral, and
              Full Workspace Access / Auto-edit can edit files. Check both the workflow and the
              permission before you hit Enter.
            </li>
            <li>
              <strong>Fast Mode toggle.</strong> Inside the model picker, capable models (Codex
              GPT-5.5 / 5.4, Claude Opus 1M, Claude Fable, and Claude Mythos) expose a Fast tier —
              useful when you want snappier turns at higher cost.
            </li>
            <li>
              <strong>Audit tools and shortcuts.</strong> Settings includes MCP and Keyboard
              Shortcuts tabs so you can check which tools the agents can see before a run.
            </li>
            <li>
              <strong>Send a focused report.</strong> The <code>!</code> button captures current
              surface, provider, workspace, theme, and Ensemble context into the local bug log.
            </li>
            <li>
              <strong>Screen Watch.</strong> The eye-on-screen icon in the composer&apos;s timecode
              row picks a macOS window for the AI to see. Click again to detach. A small pulse dot
              signals a live capture is running.
            </li>
            <li>
              <strong>Per-participant retry.</strong> If an Ensemble participant fails (rate limit,
              transient socket flake, etc.), open its chip&apos;s ⋯ menu for a Retry action that
              re-dispatches just that participant against the last user prompt.
            </li>
            <li>
              <strong>Cumulative session timecode.</strong> Composer&apos;s lower-left shows
              <em> two </em>
              counters: per-run elapsed time and total wall-time across every run in this chat.
            </li>
          </ul>
        </section>

        <footer className="first-launch-sheet-footer">
          <span className="first-launch-sheet-footer-helper">
            You can re-open this from the <span className="first-launch-sheet-helper-kbd">?</span>{' '}
            button next to the workspace sidebar toggle.
          </span>
          <div className="first-launch-sheet-footer-actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onDismiss}
              aria-label="Skip onboarding sheet"
            >
              Skip for now
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onDismiss}
              aria-label="Close onboarding sheet"
            >
              Got it
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

interface ProviderCardProps {
  row: ProviderRowSpec
  onOpenSettings: () => void
  // 1.0.6-CRUX42 — provider CLI auth opens in Terminal when available.
  onProviderLogin?: (provider: OnboardingProviderId) => void
  onProviderLogout?: (provider: OnboardingProviderId) => void
}

function ProviderCard({
  row,
  onOpenSettings,
  onProviderLogin,
  onProviderLogout
}: ProviderCardProps): React.JSX.Element {
  const classes = [
    'first-launch-sheet-provider-card',
    `first-launch-sheet-provider-card-${row.variant}`,
    row.deemphasised ? 'first-launch-sheet-provider-card-deemphasised' : '',
    row.optional ? 'first-launch-sheet-provider-card-optional' : ''
  ]
    .filter(Boolean)
    .join(' ')
  const dotVariant =
    (row.id === 'cursor' || row.id === 'grok') && row.variant === 'partial'
      ? 'signed-in'
      : row.variant
  return (
    <div className={classes} data-provider={row.id}>
      <div className="first-launch-sheet-provider-card-header">
        <ProviderGlyph provider={row.id} className="first-launch-sheet-provider-card-logo" />
        <span className="first-launch-sheet-provider-card-label">{row.label}</span>
        {row.optional && (
          <span className="first-launch-sheet-provider-card-optional-badge">Optional</span>
        )}
      </div>
      <div className="first-launch-sheet-provider-card-status">
        <span
          className={`first-launch-sheet-provider-status-dot first-launch-sheet-provider-status-dot-${dotVariant}`}
          aria-hidden
        />
        <span>{row.statusText}</span>
      </div>
      {row.variant === 'out-of-usage' && row.usage && (
        <div className="first-launch-sheet-provider-card-usage" aria-hidden>
          <QuotaProgressBar
            fraction={row.usage.fraction}
            accent={`var(--provider-${row.id}-color)`}
          />
        </div>
      )}
      <p className="first-launch-sheet-provider-card-description">{row.description}</p>
      <p className="first-launch-sheet-provider-card-hint">{row.hint}</p>
      <div className="first-launch-sheet-provider-card-actions">
        {(!row.localOnly || row.cloudSignIn) && onProviderLogin && (
          <button
            type="button"
            // cloudSignIn rows (Ollama) are local-FIRST — the cloud sign-in is
            // optional, so it's a ghost button, not the primary "you must sign
            // in" CTA the cloud providers use.
            className={`btn btn-sm ${row.cloudSignIn ? 'btn-ghost' : 'btn-primary'}`}
            onClick={() => onProviderLogin(row.id)}
            aria-label={row.cloudSignIn ? `Sign in to ${row.label} Cloud` : `Sign in to ${row.label}`}
            title={
              row.cloudSignIn
                ? `Open the ${row.label} cloud sign-in flow. Local ${row.label} runs still work without this.`
                : `Open the ${row.label} sign-in flow used by TaskWraith runs. Credentials stay with the provider CLI or service.`
            }
          >
            {row.cloudSignIn ? 'Sign in to Cloud' : 'Sign in'}
          </button>
        )}
        {row.variant === 'signed-in' && !row.localOnly && onProviderLogout && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => onProviderLogout(row.id)}
            aria-label={`Sign out of ${row.label}`}
            title={`Open the ${row.label} sign-out flow. Future runs may require signing in again.`}
          >
            Sign out
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm"
          onClick={onOpenSettings}
          aria-label={`Open settings for ${row.label}`}
          title={`Open provider settings for ${row.label}, including auth, model, and permission controls.`}
        >
          {row.variant === 'signed-in' ? 'Manage in Settings' : 'Open Settings'}
        </button>
      </div>
    </div>
  )
}
