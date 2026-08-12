import React, { useEffect, useRef } from 'react'
import type {
  AppSettings,
  ComposerStyle,
  ProviderId,
  ProviderApiKeyStatus,
  ThemeAppearance
} from '../../../main/store/types'
import type { DiffStatColors } from '../../../shared/diffStatColors'
import { DEFAULT_DIFF_STAT_COLORS, normalizeDiffStatColors } from '../../../shared/diffStatColors'
import {
  summariseCliProviderEnabled,
  summariseCodexStatus,
  summariseMistralVibeStatus,
  summariseProviderApiKeyStatus,
  type ProviderAuthVariant
} from '../lib/providerAuthSummary'
import taskwraithGhostMonolineSvg from '../assets/taskwraith-ghost-monoline.svg?raw'
import { ProviderBrandLogo } from './icons/ProviderBrandLogo'
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
import { FirstLaunchProductObservation } from './FirstLaunchProductObservation'
import { HostCliToolCard, useHostCliToolStatus } from './HostCliToolInstall'
import { CliPathDirectoriesEditor } from './CliPathDirectoriesEditor'
import { ThemeAppearancePreviewStack } from './ThemeAppearancePreviewStack'

type OnboardingProviderId = ProviderId

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
 *      Kimi user-owned OAuth + usage-key status) live in `SettingsPanel.tsx` and are tightly
 *      coupled to App-owned state + main-process IPC. Recreating
 *      them inline would mean lifting that wiring into yet another
 *      surface. Cards here show status only and deep-link via
 *      `onOpenSettings()` — the host opens Settings and the user
 *      finishes the flow there. Codex is a special case: it has
 *      no in-app auth UI today (the user signs in to the OS
 *      `codex` CLI via TaskWraith's private-home sign-in), so the card
 *      surfaces the shell command directly with a copy affordance.
 *
 *   3. **Sidebar hint retained.** Per the "safer" path in the spec:
 *      the lightweight sidebar hint card (T1b) still renders for
 *      empty workspaces. Its dismissal X persists independently
 *      from the sheet's dismissal flag. This gives users two surfaces
 *      for the same prompt without coupling them.
 */

export interface FirstLaunchSheetProps {
  /** Sheet visibility. Host owns the flag; sheet has no internal show
   * state so we don't double-source it. */
  open: boolean
  /** Called when the user dismisses via "Got it", Skip, Esc, or
   * click-outside. The host persists the dismissal flag. */
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
  /** Cursor and Grok are CLI-login providers. Optional so older hosts /
   * static tests can omit them. */
  cursorProviderAvailable?: boolean
  grokProviderAvailable?: boolean
  /** Mistral Vibe ACP runtime status. The status probe deliberately does not
   * read Vibe's private credential store, so this only drives truthful setup
   * guidance rather than a guessed sign-in state. */
  mistralStatus?: unknown
  /** Ollama local mode has no sign-in; this only reflects whether
   * TaskWraith can see a local Ollama runtime/service. */
  ollamaProviderAvailable?: boolean
  /**
   * AntiGravity stays absent until the host's authoritative conditional-offer
   * snapshot includes it. This reporting prop does not grant admission.
   */
  antigravityProviderOffered?: boolean
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
  /** Reuses saved Appearance colors when onboarding is reopened later. */
  diffStatColors?: DiffStatColors
  userName?: string
  onAppearancePreviewChange?: (
    next: Partial<Pick<AppSettings, 'themeAppearance' | 'composerStyle' | 'userName'>>
  ) => void
  /**
   * Extra directories searched first when resolving ANY external CLI. Surfaced
   * during onboarding because a wrong PATH is a first-launch failure: the
   * provider cards all read "CLI not found" and the user has no way to tell
   * that the binaries are installed and merely invisible to a Finder-launched
   * app. Optional so static tests and older hosts can omit the control.
   */
  cliPathDirectories?: string[]
  onCliPathDirectoriesChange?: (next: string[]) => void
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
  /** Explicit badge for historical or conditional reporting rows. */
  badge?: string
  /** Reporting-only rows expose no sign-in, sign-out, or Settings action. */
  reportingOnly?: boolean
  /** Local setup rows do not show provider-owned sign-in / sign-out actions. */
  localOnly?: boolean
  /** The provider has no bounded CLI logout command. Keep the setup action
   * visible without promising a sign-out operation TaskWraith cannot perform. */
  logoutUnsupported?: boolean
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

const ONBOARDING_COMPOSER_OPTIONS: Array<{ value: ComposerStyle; label: string }> = [
  { value: 'default', label: 'TaskWraith native' },
  { value: 'codex', label: 'Codex shell' },
  { value: 'chatgpt', label: 'ChatGPT shell' },
  { value: 'claude', label: 'Claude shell' },
  { value: 'cursor', label: 'Cursor shell' },
  { value: 'grok', label: 'Grok shell' },
  { value: 'gemini', label: 'Gemini shell' },
  { value: 'kimi', label: 'Kimi shell' },
  { value: 'modular', label: 'Modular' },
  { value: 'terminal', label: 'Terminal' },
  { value: 'stub', label: 'Ticket stub' },
  { value: 'satellite', label: 'Satellite' },
  // EW55/EW61 premium composer styles. These are composer shells
  // only; the matching system themes were retired because they
  // created too many theme/composer contrast conflicts.
  { value: 'obsidian', label: 'Obsidian' },
  { value: 'alabaster', label: 'Alabaster' }
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
  mistralStatus,
  ollamaProviderAvailable = false,
  antigravityProviderOffered = false,
  usageSummary,
  themeAppearance = 'system',
  composerStyle = 'default',
  diffStatColors = DEFAULT_DIFF_STAT_COLORS,
  userName = '',
  onAppearancePreviewChange,
  cliPathDirectories,
  onCliPathDirectoriesChange
}: FirstLaunchSheetProps): React.JSX.Element | null {
  // Probed only while the sheet is open; the card needs a truthful
  // installed/not-installed answer, not a guess from an error string.
  const ghStatus = useHostCliToolStatus('gh', open)
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
  // BugReportSheet.
  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (!dialog) return
    const getFocusable = (): HTMLElement[] =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter(
        (el) =>
          !el.closest('[inert]') &&
          (el.offsetParent !== null || el === document.activeElement)
      )
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

  const normalizedDiffStatColors = normalizeDiffStatColors(diffStatColors)
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
  const mistralSummary = summariseMistralVibeStatus(mistralStatus)

  const baseProviderRows: ProviderRowSpec[] = [
    {
      id: 'codex',
      label: 'Codex',
      description:
        'OpenAI Codex CLI. Sign in once to TaskWraith’s private Codex home; its tasks and native sessions stay separate from the Codex app history.',
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
        'Moonshot Kimi. Every run receives structural identity, probe, and posture admission checks. When no reviewed runtime tuple exists, TaskWraith labels the run unattested-development explicitly; that unreviewed state does not remove Kimi from the provider set.',
      ...kimiSummary,
      optional: true
    },
    {
      id: 'cursor',
      label: 'Cursor',
      description:
        'Cursor Composer 2.5. Write-capable agentic runs via the Cursor CLI, contained by the native OS sandbox. Sign-in is at the OS level — run `cursor-agent login` in your terminal once.',
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
        'Local models running through Ollama. Best for on-device Muse Glimmer, Llama, DeepSeek, Rnj-1, GLM, North, Qwen, Granite, Gemma, Ornith, Devstral, Ministral, GPT OSS, MiniCPM, or Nemotron testing — no cloud account needed. Sign in to ollama.com to also use Ollama Cloud / Turbo and private models.',
      variant: ollamaProviderAvailable ? 'signed-in' : 'partial',
      statusText: ollamaProviderAvailable ? 'Local runtime ready' : 'Local setup optional',
      hint: ollamaProviderAvailable
        ? 'Pick Local / Ollama in the provider picker, then choose an installed model in Settings or the composer.'
        : 'Install Ollama, then pull a model from the commands below. Rnj-1 needs Ollama 0.13.3+, GLM-4.7-Flash needs 0.15.0+, and North Mini Code 1.0 needs 0.30.10+.',
      deemphasised: true,
      optional: true,
      localOnly: true,
      cloudSignIn: true
    },
    {
      id: 'mistral',
      label: 'Mistral',
      description:
        'Mistral Vibe coding agent over ACP. Set up your Mistral plan or Vibe credential in the official Vibe wizard; this first-class seat is separate from Pi’s metered Mistral API-key route.',
      ...mistralSummary,
      optional: true,
      logoutUnsupported: true
    },
    ...(antigravityProviderOffered
      ? [
          {
            id: 'antigravity' as const,
            label: 'AntiGravity',
            description:
              'Conditionally offered AntiGravity identity. It appears here only after the host confirms that one authorized transport lane has satisfied its own consent and credential requirements.',
            variant: 'partial' as const,
            statusText: 'Conditional setup ready',
            hint:
              'The host currently offers this provider; its selected runtime still passes ordinary structural admission checks at launch.',
            optional: true,
            badge: 'Conditional',
            localOnly: true
          }
        ]
      : []),
    {
      id: 'pi',
      label: 'Pi',
      description:
        'Pi coding agent with bring-your-own upstream keys. TaskWraith keeps Pi provider credentials scoped to the configured upstream and applies the selected read/write tool posture.',
      variant: 'partial',
      statusText: 'BYOK setup in Settings',
      hint:
        'Install the Pi CLI, then configure a supported upstream key and model in Settings. Pi is reported here even before setup; this card does not grant provider admission.',
      optional: true,
      localOnly: true
    },
    {
      id: 'gemini',
      label: 'Gemini',
      description:
        'Historical Gemini provider identity. Existing chats, usage, and audit records remain attributed to Gemini, but it is not offered for new runs.',
      variant: 'partial',
      statusText: 'Historical · not offered for new runs',
      hint:
        'Kept visible for honest reporting and history continuity; there is no new-run sign-in or enable action here.',
      badge: 'Historical',
      deemphasised: true,
      reportingOnly: true
    }
  ]
  // Flip any signed-in provider whose quota window is maxed to the
  // explicit "out of usage" state — the tester-confusion fix.
  // Retired providers (see retiredProviders.ts) are never offered as onboarding
  // sign-in cards. A reporting-only historical row may remain visible without
  // exposing any action or changing provider admission.
  const providerRows = baseProviderRows
    .map((row) => applyOutOfUsage(row, usageSummary))
    .filter((row) => row.reportingOnly || !isRetiredProvider(row.id))

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
                First-launch checklist — providers, workspaces, goals, permissions, and Ensemble
                basics.
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
            TaskWraith is a local-first desktop workbench for AI coding agents. It brings together{' '}
            <strong>Codex</strong>,{' '}
            <strong>Claude</strong>, <strong>Kimi</strong>, <strong>Grok</strong>,{' '}
            <strong>Cursor</strong>, local <strong>Ollama</strong> models, and BYOK{' '}
            <strong>Pi</strong>
            {antigravityProviderOffered ? (
              <>
                , plus your conditionally configured <strong>AntiGravity</strong> seat
              </>
            ) : null}{' '}
            inside one consistent
            UI so you can run solo chats, side chats, delegated workers, and Ensembles side by side.
            Each provider keeps its own auth — sign in to the ones you want to use, skip the rest.
            Historical Gemini chats and usage stay visible for reporting even though Gemini is not
            offered for new runs.{' '}
            Chat history, goals, approvals, audit events, and usage stay in TaskWraith&apos;s local
            store; each provider receives only the context for the chat or run it is working on.
            Bare provider filesystem and shell shortcuts that cannot enforce that boundary stay
            disabled — work uses TaskWraith&apos;s namespaced workspace tools instead.
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
            Providers sign in three ways: <strong>Codex</strong> and <strong>Grok</strong> log in
            through their own CLI in a Terminal;{' '}
            <strong>Claude</strong> uses in-app OAuth or an API key;{' '}
            <strong>Kimi</strong> uses its current CLI OAuth login or a provider key configured in
            its own <code>~/.kimi-code/config.toml</code>; the key saved in TaskWraith Settings is
            usage-only. TaskWraith always applies structural admission; an unreviewed runtime is
            labelled <code>unattested-development</code> explicitly. <strong>Ollama</strong>{' '}
            is local-first: install
            Ollama and pull a model with no cloud account, or optionally sign in for Ollama Cloud /
            Turbo and private models. <strong>Cursor</strong> and Grok auth stay inside their CLIs,
            so TaskWraith may ask you to finish login in Terminal (<code>cursor-agent login</code>
            / Grok CLI). Cursor runs use the real ~/.cursor login under a contained --sandbox argv.{' '}
            <strong>Pi</strong> uses the upstream key and model you configure in Settings.{' '}
            <strong>Mistral</strong> opens Vibe&apos;s own Terminal setup wizard, where you choose
            your Mistral plan access or a Vibe API key; it stays separate from Pi&apos;s Mistral
            API-key lane.
            AntiGravity remains absent until the host confirms that an authorized conditional lane
            is ready.
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

        {/*
          Optional tools sit in their OWN section rather than the provider grid.
          `gh` is not a provider — no seat, no model, no run posture — and
          folding it into the provider cards would imply all three.
        */}
        <section className="first-launch-sheet-section">
          <h3 className="first-launch-sheet-section-title">2. Optional tools</h3>
          <p className="first-launch-sheet-section-helper">
            Not providers — separate command-line tools that unlock extra TaskWraith features. Skip
            them if you don&apos;t need what they power; nothing else depends on them.
          </p>
          <div className="host-cli-tool-grid">
            <HostCliToolCard
              toolId="gh"
              presence={ghStatus.presence}
              resolvedPath={ghStatus.path}
              onOpened={ghStatus.refresh}
            />
          </div>
        </section>

        {/*
          Always rendered so the section numbering is stable; only the editor
          itself depends on the host wiring the change handler. A no-op editor
          would be worse than none — it would look like it saved.
        */}
        <section className="first-launch-sheet-section">
          <h3 className="first-launch-sheet-section-title">3. Where your CLIs live</h3>
          <p className="first-launch-sheet-section-helper">
              Only needed if a CLI you know is installed shows as <em>not found</em>. TaskWraith is
              launched by macOS, not by your shell, so it doesn&apos;t inherit your shell&apos;s
              PATH. It already checks the usual places (Homebrew, <code>/usr/local/bin</code>,{' '}
              <code>~/.local/bin</code>, npm and bun global bins). Add a directory here if yours
              lives somewhere else — a version manager shim (asdf, mise, volta), a custom npm
              prefix, or a non-standard Homebrew prefix.
            </p>
            <p className="first-launch-sheet-section-helper">
              These are searched <strong>first</strong>, ahead of everything else, and apply to
              every CLI at once — provider CLIs, <code>git</code>, and <code>gh</code>. Run{' '}
              <code>which codex</code> (or <code>which gh</code>) in your terminal and paste the
              directory part. Pasting a whole PATH works too; it gets split into rows.
            </p>
          {onCliPathDirectoriesChange && (
            <CliPathDirectoriesEditor
              value={cliPathDirectories ?? []}
              onChange={onCliPathDirectoriesChange}
              dense
            />
          )}
        </section>

        <FirstLaunchProductObservation />

        <section className="first-launch-sheet-section">
          <h3 className="first-launch-sheet-section-title">4. Add your first workspace</h3>
          <p className="first-launch-sheet-prose">
            A <strong>workspace</strong> is a project folder TaskWraith has read / edit permission
            inside. Workspace chats are rooted in that folder, and the agent can only touch files
            within its trust boundary unless you explicitly grant another path. General chats can
            start without a project folder, but use a workspace for coding work. Find the{' '}
            <span className="first-launch-sheet-plus">+</span> button next to
            &quot;Workspaces&quot; in the sidebar and pick a folder; you can add more later.
            TaskWraith&apos;s built-in Git actions also treat repository-local hooks, filters,
            helpers, and transport rewrites as untrusted rather than executing them.
          </p>
        </section>

        <section className="first-launch-sheet-section">
          <h3 className="first-launch-sheet-section-title">5. Choose your starting look</h3>
          <p className="first-launch-sheet-section-helper">
            These controls write to Appearance settings immediately. The preview is inert, so it
            will never touch your active chat prompt.
          </p>
          <div
            className="first-launch-sheet-preference-card"
            data-theme={themeAppearance}
            data-composer-style={composerStyle}
          >
            <div className="first-launch-sheet-theme-preview">
              <span className="first-launch-sheet-preference-field">Theme</span>
              <ThemeAppearancePreviewStack
                themeAppearance={themeAppearance}
                additionsColor={normalizedDiffStatColors.additions}
                deletionsColor={normalizedDiffStatColors.deletions}
                onThemeChange={(nextTheme) =>
                  onAppearancePreviewChange?.({ themeAppearance: nextTheme })
                }
              />
            </div>
            <div className="first-launch-sheet-preference-controls first-launch-sheet-preference-controls--secondary">
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
          <h3 className="first-launch-sheet-section-title">6. You stay in control</h3>
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
                <span className="first-launch-sheet-safety-chip">Plan</span>
                <span className="first-launch-sheet-safety-chip">Ask</span>
                <span className="first-launch-sheet-safety-chip">Accept Edits</span>
                <span className="first-launch-sheet-safety-chip">Full WS Access</span>
                <span className="first-launch-sheet-safety-chip">Full Access</span>
              </div>
            </div>
          </div>
          <p className="first-launch-sheet-prose">
            Runs start inside the workspace boundary — files outside the project are off-limits
            unless you allow a path. Plan and Ask stay cautious; Accept Edits keeps
            file actions visible; Full WS Access removes per-action prompts inside the project;
            and lane-scoped Full Access is the highest local authority. Plan-authoring mode can still
            use approval-gated instruments like canvas, media, and sub-thread delegation when you
            allow them, but it does not grant ordinary file mutation by itself.
          </p>
        </section>

        <section className="first-launch-sheet-section">
          <h3 className="first-launch-sheet-section-title">7. Track your usage &amp; spend</h3>
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
              <span className="first-launch-sheet-usage-mock-label">Grok</span>
              <QuotaProgressBar fraction={0.07} accent="var(--provider-grok-color)" />
              <span className="first-launch-sheet-usage-mock-pct">7%</span>
            </div>
          </div>
          <p className="first-launch-sheet-prose">
            Every run also shows a live token + projected-cost tally next to Send. When a provider
            reports its usage, those figures lead while the run is active; TaskWraith labels a
            text-based estimate otherwise. The dashboard fills in usage heatmaps and per-provider
            totals as you go. Local Ollama runs have no cloud quota, but their token totals still
            appear in usage history.
          </p>
        </section>

        <section className="first-launch-sheet-section">
          <h3 className="first-launch-sheet-section-title">8. Try Ensemble chats</h3>
          <p className="first-launch-sheet-section-helper">
            <strong>Get one provider working first</strong> — Ensemble shines with two or more.
            Toggle Ensemble on an idle top-level chat to add multiple provider participants while
            preserving its transcript. Turn mode keeps one active speaker at a time; Continuous mode
            keeps going while actual work remains, but returns control instead of burning hops on a
            no-work, all-yielded consensus. Queued provider/model changes close the current pass
            before the next one starts.
          </p>
          <p className="first-launch-sheet-prose">
            Stage roles shape the hand-off: Scouts investigate in parallel first, Workers take
            serial implementation turns, and Reviewers check the result last. BG seats skip
            ordinary rotation; @mention or delegate one for detached read-only work. They cannot
            take Boss, Captain, or synthesizer authority.
          </p>
          <p className="first-launch-sheet-prose">
            In Settings → Roster, choose individual saved panels when importing or exporting, then
            expand a compact participant card only when you need its detailed controls.
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
              <span>Toggle Ensemble while the thread is idle</span>
              <span>Turn / Continuous in the composer</span>
            </div>
          </div>
        </section>

        <section className="first-launch-sheet-section">
          <h3 className="first-launch-sheet-section-title">9. Power-user shortcuts (optional)</h3>
          <ul className="first-launch-sheet-tips">
            <li>
              <strong>-@ to reference files.</strong> Type <code>-@</code> in the composer to
              mention a specific file by path; the agent reads it as part of the turn. Plain{' '}
              <code>@</code> now mentions a sub-agent or Ensemble participant, including a
              configured BG seat when you want detached background research.
            </li>
            <li>
              <strong>/ for slash commands.</strong> Type <code>/</code> at the start of the
              composer for the slash menu — <code>/goal &lt;objective&gt;</code> sets or updates the
              thread goal immediately, alongside compact, help, feedback, and model shortcuts.
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
              <strong>Permission picker colour-codes the authority.</strong> Plan-authoring mode is
              separate from Ask: Plan drafts for approval, Accept Edits keeps
              actions visible, Full WS Access removes per-action prompts inside the project, and
              Full Access is lane-scoped host authority. Approval-gated instruments remain
              explicit. Check the selected posture before you hit Enter.
            </li>
            <li>
              <strong>Fast Mode toggle.</strong> Inside the model picker, capable models (Codex
              GPT-5.6 / 5.5 / 5.4, supported Claude Opus models, and Kimi K2.7 Coding) expose a
              Fast choice — K2.7 Coding switches between Standard and
              Highspeed (K3 has no Fast tier), while Grok 4.6 and the retained
              Grok 4.5 model on the Grok CLI are always labelled Fast.
            </li>
            <li>
              <strong>Kimi thinking stays on.</strong> K2.7 Coding has a fixed On setting; K3 lets
              you choose Low, High, or Max effort, but thinking cannot be disabled.
            </li>
            <li>
              <strong>Delegate a focused worker.</strong> With approval, an agent can open a
              context-isolated sub-thread on another provider and continue it later. Returned
              results arrive as clearly marked, untrusted invocation cards; open <em>Side chat</em>{' '}
              on a card to inspect the worker&apos;s full thread.
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
              <strong>Screen Watch.</strong> The eye-on-screen icon in the composer&apos;s control row
              picks a macOS window for the AI to see. Click again to detach. A small pulse dot
              signals a live capture is running.
            </li>
            <li>
              <strong>Per-participant retry.</strong> If an Ensemble participant fails (rate limit,
              transient socket flake, etc.), open its chip&apos;s ⋯ menu for a Retry action that
              re-dispatches just that participant against the last user prompt.
            </li>
            <li>
              <strong>Cumulative session timecode.</strong> Composer&apos;s lower-left shows
              the current turn&apos;s elapsed time, while the right side shows total wall-time across
              the thread. Click the time bar for the run-duration breakdown.
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
              className="segmented-control-action"
              onClick={onDismiss}
              aria-label="Skip onboarding sheet"
            >
              Skip for now
            </button>
            <button
              type="button"
              className="segmented-control-action segmented-control-action--primary"
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
  const showSignInAction =
    !row.reportingOnly &&
    Boolean(onProviderLogin) &&
    row.variant !== 'signed-in' &&
    row.variant !== 'out-of-usage' &&
    (!row.localOnly || row.cloudSignIn)
  const signInClass = [
    'segmented-control-action',
    'segmented-control-action--compact',
    row.cloudSignIn ? '' : 'segmented-control-action--primary'
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div className={classes} data-provider={row.id}>
      <div className="first-launch-sheet-provider-card-header">
        <ProviderBrandLogo provider={row.id} className="first-launch-sheet-provider-card-logo" />
        <span className="first-launch-sheet-provider-card-label">{row.label}</span>
        {(row.badge || row.optional) && (
          <span className="first-launch-sheet-provider-card-optional-badge">
            {row.badge || 'Optional'}
          </span>
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
      {!row.reportingOnly && (
        <div className="first-launch-sheet-provider-card-actions">
          {showSignInAction && onProviderLogin && (
            <button
              type="button"
              // cloudSignIn rows (Ollama) are local-FIRST — the cloud sign-in is
              // optional, so it's a ghost button, not the primary "you must sign
              // in" CTA the cloud providers use.
              className={signInClass}
              onClick={() => onProviderLogin(row.id)}
              aria-label={
                row.cloudSignIn ? `Sign in to ${row.label} Cloud` : `Sign in to ${row.label}`
              }
              title={
                row.cloudSignIn
                  ? `Open the ${row.label} cloud sign-in flow. Local ${row.label} runs still work without this.`
                  : `Open the ${row.label} sign-in flow used by TaskWraith runs. Credentials stay with the provider CLI or service.`
              }
            >
              {row.cloudSignIn ? 'Sign in to Cloud' : 'Sign in'}
            </button>
          )}
          {row.variant === 'signed-in' &&
            !row.localOnly &&
            !row.logoutUnsupported &&
            onProviderLogout && (
              <button
                type="button"
                className="segmented-control-action segmented-control-action--compact"
                onClick={() => onProviderLogout(row.id)}
                aria-label={`Sign out of ${row.label}`}
                title={`Open the ${row.label} sign-out flow. Future runs may require signing in again.`}
              >
                Sign out
              </button>
            )}
          <button
            type="button"
            className="segmented-control-action segmented-control-action--compact segmented-control-action--primary"
            onClick={onOpenSettings}
            aria-label={`Open settings for ${row.label}`}
            title={`Open provider settings for ${row.label}, including auth, model, and permission controls.`}
          >
            {row.variant === 'signed-in' ? 'Manage in Settings' : 'Open Settings'}
          </button>
        </div>
      )}
    </div>
  )
}
