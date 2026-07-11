import React from 'react'
import {
  ArrowUpSendIcon,
  ClaudeReturnSymbolIcon,
  CopyResponseIcon,
  FolderSymbolIcon,
  GitCommitSymbolIcon,
  GoalSymbolIcon,
  RunSymbolIcon,
  ScreenWatchSymbolIcon
} from './AppChromeSymbols'
import { ComposerTimecode } from './ComposerTimecodes'
import { FONT_STACKS, resolveComposerFontFamily } from '../lib/typefaceOptions'
import { composerGitActionUsesCommitIcon } from '../lib/composerGitActionIcon'
import type { ComposerStyle, ProviderId, ThemeAppearance } from '../../../main/store/types'
import { ProviderBadgeIcon } from './Sidebar'

/**
 * ComposerShellPreview — the single source of truth for the inert composer
 * "shell preview" card rendered in Settings → Appearance and in the
 * onboarding First-Launch sheet.
 *
 * Why this exists: the live composer shell is inlined across the 4.7k-line
 * `Composer.tsx`, and there is no presentational extraction of it. Before this
 * component, BOTH preview surfaces hand-maintained their OWN static replica of
 * the composer DOM, plus their OWN per-shell metadata table
 * (`getComposerPreviewMeta` in SettingsPanel vs `getOnboardingComposerPreview`
 * in FirstLaunchSheet) — two copies that had already drifted (the onboarding
 * copy was missing the `terminal` case and carried stale codex/kimi copy).
 *
 * This collapses the two replicas + two metadata tables into ONE component and
 * ONE metadata source, so the previews can no longer drift apart, and renders
 * the EXACT same class contract the live composer uses (so the real
 * `data-composer-style`-keyed shell CSS in 07-composer-shells.css et al paints
 * it identically to the chosen variant). It is purely presentational and inert
 * — it never touches the active chat. Every interactive-looking control is
 * `tabIndex={-1}` / `aria-hidden`, matching the prior hand-built previews so the
 * onboarding focus-trap traversal still skips it.
 */

export interface ComposerPreviewMeta {
  providerLabel: string
  modelLabel: string
  permissionLabel: string
  placeholder: string
}

/**
 * The canonical per-shell preview copy. This is the ONLY copy of this table —
 * both preview surfaces now derive their labels from here. Keep every member of
 * the `ComposerStyle` union represented (the `default` branch covers the native
 * shell + `modular`/`stub`/`satellite`, which read as TaskWraith-native).
 */
export function getComposerPreviewMeta(style: ComposerStyle): ComposerPreviewMeta {
  switch (style) {
    case 'codex':
      return {
        providerLabel: 'Codex',
        modelLabel: 'GPT-5.5',
        permissionLabel: 'Full Workspace Access',
        placeholder: 'Ask Codex anything. @ to use plugins or mention files'
      }
    case 'claude':
      return {
        providerLabel: 'Claude',
        // 1.0.6 — Opus 4.8 is the current default (4.7 is now "Legacy" in the
        // model picker); keep the preview in step with the live composer chip.
        modelLabel: 'Opus 4.8',
        permissionLabel: 'Plan',
        placeholder: 'Describe a task or ask a question'
      }
    case 'cursor':
      // Preview-only. Cursor here is the VISUAL shell, not the provider —
      // the flat-gray CSS strips all chroma regardless of provider.
      return {
        providerLabel: 'Cursor',
        modelLabel: 'Composer 2.5',
        permissionLabel: 'Default Approval',
        placeholder: 'Enter prompt for Cursor…'
      }
    case 'grok':
      return {
        providerLabel: 'Grok',
        modelLabel: 'Grok Composer 2.5 Fast',
        permissionLabel: 'Default Approval',
        placeholder: 'What do you want to know?'
      }
    case 'gemini':
      return {
        providerLabel: 'Gemini',
        modelLabel: 'Pro 3.1',
        permissionLabel: 'Default Approval',
        placeholder: 'Ask Gemini'
      }
    case 'kimi':
      return {
        providerLabel: 'Kimi',
        modelLabel: 'K2.7 Code Thinking',
        permissionLabel: 'Read workspace',
        placeholder: 'Type "/" to quickly access skills'
      }
    case 'terminal':
      return {
        providerLabel: 'Terminal',
        modelLabel: 'Shell',
        permissionLabel: 'Ask before tools',
        placeholder: 'run task --describe'
      }
    case 'obsidian':
      // 1.0.5-EW55 — Obsidian composer preview copy. The placeholder reads
      // restrained on purpose; "Premium" labels the surface itself, and the
      // preview surface paints the white rim + chase from the live CSS.
      return {
        providerLabel: 'TaskWraith',
        modelLabel: 'Auto',
        permissionLabel: 'Premium',
        placeholder: 'Compose…'
      }
    case 'alabaster':
      // 1.0.5-EW61 — Alabaster preview copy. Same restraint as obsidian — the
      // rim + cream surface carry the identity.
      return {
        providerLabel: 'TaskWraith',
        modelLabel: 'Auto',
        permissionLabel: 'Premium',
        placeholder: 'Compose…'
      }
    default:
      return {
        providerLabel: 'TaskWraith',
        modelLabel: 'Auto',
        permissionLabel: 'Default Approval',
        placeholder: 'Ask anything...'
      }
  }
}

function previewProviderIdForStyle(style: ComposerStyle): ProviderId {
  switch (style) {
    case 'codex':
      return 'codex'
    case 'claude':
      return 'claude'
    case 'gemini':
      return 'gemini'
    case 'kimi':
      return 'kimi'
    case 'grok':
      return 'grok'
    case 'cursor':
      return 'cursor'
    default:
      return 'codex'
  }
}

/**
 * The send-button glyph mirrors the live composer's switch
 * (Composer.tsx — `claude` → return arrow, the pill-layout branded shells →
 * up-arrow, everything else → the native run glyph).
 */
function PreviewSendGlyph({ composerStyle }: { composerStyle: ComposerStyle }): React.ReactElement {
  if (composerStyle === 'claude') return <ClaudeReturnSymbolIcon />
  if (
    composerStyle === 'codex' ||
    composerStyle === 'gemini' ||
    composerStyle === 'cursor' ||
    composerStyle === 'grok' ||
    composerStyle === 'kimi'
  ) {
    return <ArrowUpSendIcon />
  }
  return <RunSymbolIcon />
}

function PreviewContextWheel({ control = false }: { control?: boolean }): React.ReactElement {
  return (
    <span
      className="context-wheel settings-composer-preview-context"
      data-composer-control={control ? 'context' : undefined}
    >
      <svg viewBox="0 0 18 18" width="18" height="18">
        <circle
          cx="9"
          cy="9"
          r="6.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.22"
        />
        <path
          d="M9 2.4a6.6 6.6 0 0 1 5.4 10.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}

export interface ComposerShellPreviewProps {
  composerStyle: ComposerStyle
  /** Theme is scoped onto the card via `data-theme` so the preview reflects the
   *  selected theme in isolation without touching the document root. */
  themeAppearance: ThemeAppearance
  /**
   * Transcript typeface preview (Settings only). When provided, injects the
   * font on the transcript strip; when `undefined` (onboarding) the strip
   * inherits, matching the prior hand-built onboarding preview exactly.
   */
  transcriptFontFamily?: string
  /** Composer typeface preview (Settings only); injected on the editable
   *  textarea via `resolveComposerFontFamily`. */
  composerFontFamily?: string
  /**
   * `editable` (Settings) renders a real, focusable `<textarea>` so the user
   * can type sample text AND see the `:focus-within` shell styling. Onboarding
   * leaves this off → an inert `aria-hidden` placeholder `<div>` (keeps the
   * onboarding focus-trap traversal clean).
   */
  editable?: boolean
  value?: string
  onValueChange?: (value: string) => void
}

/**
 * Renders the `.settings-composer-preview-card` and everything inside it. The
 * caller owns any outer spacing wrapper (e.g. the onboarding sheet wraps this
 * in `.first-launch-sheet-composer-preview`).
 */
export function ComposerShellPreview({
  composerStyle,
  themeAppearance,
  transcriptFontFamily,
  composerFontFamily,
  editable = false,
  value,
  onValueChange
}: ComposerShellPreviewProps): React.ReactElement {
  const meta = getComposerPreviewMeta(composerStyle)
  const previewProviderId = previewProviderIdForStyle(composerStyle)
  const previewProviderHueClass = previewProviderId
  const useGitIconAction = composerGitActionUsesCommitIcon(composerStyle)
  const actionClassName = [
    'composer-above-bar-action',
    useGitIconAction ? 'composer-above-bar-action--git-commit-icon' : null
  ]
    .filter(Boolean)
    .join(' ')
  const previewActionLabel =
    composerStyle === 'cursor'
      ? 'Commit'
      : composerStyle === 'codex' || composerStyle === 'grok' || composerStyle === 'claude'
        ? 'Create PR'
        : 'Review changes'

  // Font injection mirrors the prior SettingsPanel preview: only inject when the
  // caller actually supplies the font (onboarding omits both → inherit).
  const transcriptStyle =
    transcriptFontFamily !== undefined
      ? { fontFamily: transcriptFontFamily || FONT_STACKS.taskwraith }
      : undefined
  const composerFontStyle =
    composerFontFamily !== undefined
      ? { fontFamily: resolveComposerFontFamily(composerFontFamily, transcriptFontFamily ?? '') }
      : undefined

  return (
    <div
      className="settings-composer-preview-card"
      data-theme={themeAppearance}
      data-composer-style={composerStyle}
      data-interface-style={composerStyle}
    >
      <div className="settings-composer-preview-transcript" style={transcriptStyle}>
        <span className="settings-composer-preview-speaker">{meta.providerLabel}</span>
        <p>
          Assistant transcript text uses this typeface, including inline code, file names, and
          longer status lines.
        </p>
        <div className="settings-composer-preview-tool-row" aria-hidden="true">
          <span>Edited</span>
          <code>src/renderer/src/App.tsx</code>
          <strong>+42</strong>
          <em>-8</em>
        </div>
      </div>
      <div
        className={`composer-area settings-composer-preview-area interface-${composerStyle}`}
        aria-label={`${meta.providerLabel} composer preview`}
      >
        <div className="composer-above-bar-stack">
          <div className="composer-above-bar style-unified composer-workspace-above-row">
            <div className="composer-above-bar-pill composer-above-bar-pill--git">
              <span className="composer-above-bar-branch">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <circle cx="4" cy="3.5" r="1.6" />
                  <circle cx="4" cy="12.5" r="1.6" />
                  <circle cx="12" cy="7" r="1.6" />
                  <path d="M4 5.1v5.8M5.6 7c2 0 4.8 0 4.8-1.5" />
                </svg>
                <span>
                  Preview workspace ·{' '}
                  <span className="composer-above-bar-secondary-branch git-tone-main">main</span>
                </span>
              </span>
            </div>
            <div className="composer-above-bar-pill composer-above-bar-pill--changes">
              <span className="composer-above-bar-files-cluster">
                <span className="composer-above-bar-files">
                  <strong>2</strong> files changed
                </span>
                <span className="composer-above-bar-stats">
                  <span className="composer-diff-add">+42</span>
                  <span className="composer-diff-del">-8</span>
                </span>
              </span>
            </div>
            <div className="composer-above-bar-pill composer-above-bar-pill--action">
              <button type="button" className={actionClassName} tabIndex={-1} aria-hidden="true">
                {useGitIconAction ? <GitCommitSymbolIcon /> : previewActionLabel}
              </button>
            </div>
          </div>
        </div>
        <div className="composer-surface settings-composer-preview-surface">
          {/* Refractive "liquid glass" lens — aria-hidden first child of the
              surface, exactly as the live composer renders it (Composer.tsx).
              Inert (display:none) unless refraction is enabled AND this card is
              previewing the native `default` shell; the preview-scoped lighting
              rule in 04-settings-controls.css re-keys it onto the CARD's
              data-composer-style so the lens follows the PREVIEWED shell rather
              than the user's own global shell. */}
          <div className="composer-refraction-lens" aria-hidden />
          {/*
            The textarea + control rows are wrapped in
            .composer-textarea-wrap / .composer-bottom-controls, both inside
            .composer-inner-module, mirroring the real default composer (the
            Obsidian/Alabaster two-rect split + the default-shell inset panel
            CSS keys off these wrappers; layout-neutral for the other shells via
            the base `.composer-inner-module { display: contents }` rule).
          */}
          <div className="composer-inner-module">
            <div className="composer-textarea-wrap">
              {editable ? (
                <textarea
                  className="composer-textarea settings-composer-preview-textarea"
                  value={value ?? ''}
                  onChange={(e) => onValueChange?.(e.target.value)}
                  placeholder={meta.placeholder}
                  rows={3}
                  aria-label="Composer font preview text"
                  style={composerFontStyle}
                />
              ) : (
                <div
                  className="composer-textarea settings-composer-preview-textarea"
                  aria-hidden="true"
                  style={{ minHeight: '60px', ...composerFontStyle }}
                >
                  {meta.placeholder}
                </div>
              )}
            </div>
            <div className="composer-bottom-controls">
              <div className="composer-control-footer settings-composer-preview-footer">
                <div className="composer-inline-pickers">
                  <div className="composer-inline-pickers-left" aria-hidden="true">
                    <button
                      type="button"
                      className="composer-picker-label settings-composer-preview-control"
                      data-composer-control="attach"
                      tabIndex={-1}
                    >
                      +
                    </button>
                    <span
                      className="composer-picker-label settings-composer-preview-control"
                      data-composer-control="permission"
                    >
                      {meta.permissionLabel}
                    </span>
                    {composerStyle === 'codex' && <PreviewContextWheel control />}
                    <button
                      type="button"
                      className="composer-combined-picker-trigger settings-composer-preview-control"
                      data-composer-control="model"
                      data-provider={previewProviderId}
                      tabIndex={-1}
                      aria-hidden="true"
                      style={
                        {
                          '--chip-accent': `var(--provider-${previewProviderHueClass}-color, currentColor)`
                        } as React.CSSProperties
                      }
                    >
                      <span className="composer-combined-picker-trigger-provider">
                        <span
                          className="composer-combined-picker-trigger-provider-icon"
                          aria-hidden="true"
                        >
                          <ProviderBadgeIcon provider={previewProviderId} />
                        </span>
                        <span className="composer-combined-picker-trigger-provider-label">
                          {meta.providerLabel}
                        </span>
                      </span>
                      <span className="composer-combined-picker-trigger-primary">
                        {meta.modelLabel}
                      </span>
                    </button>
                  </div>
                  <div className="composer-inline-actions" aria-hidden="true">
                    {composerStyle !== 'codex' && <PreviewContextWheel />}
                    <span className="composer-send-cluster">
                      <button
                        type="button"
                        className="composer-action-btn run-btn"
                        tabIndex={-1}
                        aria-label="Preview send button"
                      >
                        <PreviewSendGlyph composerStyle={composerStyle} />
                      </button>
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          {/* Composer telemetry rail (coalesced timecode, Screen-Watch,
              goal, copy-transcript, the workspace switcher chip, and the
              token/cost tally) — a sibling of .composer-inner-module inside
              .composer-surface, matching the live composer. Static/inert. */}
          <div className="composer-telemetry-row" data-has-token-tally="true" aria-hidden="true">
            <ComposerTimecode
              running={false}
              startedAt={null}
              cumulativeBaseMs={0}
              composerStyle={composerStyle}
              interactive={false}
            />
            <button
              type="button"
              className="composer-screen-watch-button settings-composer-preview-control"
              tabIndex={-1}
            >
              <ScreenWatchSymbolIcon />
            </button>
            <span className="composer-goal-control-wrap">
              <button
                type="button"
                className="composer-goal-button is-idle settings-composer-preview-control"
                tabIndex={-1}
              >
                <GoalSymbolIcon />
              </button>
            </span>
            <span className="composer-copy-transcript-wrap">
              <button
                type="button"
                className="composer-copy-transcript-button settings-composer-preview-control"
                tabIndex={-1}
              >
                <CopyResponseIcon />
              </button>
            </span>
            <button
              type="button"
              className="composer-picker-label composer-workspace-button settings-composer-preview-control"
              data-composer-control="workspace"
              tabIndex={-1}
            >
              <FolderSymbolIcon />
              <span className="composer-workspace-button-label">Preview workspace +1</span>
            </button>
            <span className="composer-thread-token-tally">1.2M in / 5k out</span>
          </div>
        </div>
      </div>
    </div>
  )
}
