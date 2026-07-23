import React from 'react'
import {
  ArrowUpSendIcon,
  ClaudeReturnSymbolIcon,
  GitCommitSymbolIcon,
  GoalSymbolIcon,
  PlusSymbolIcon,
  RunSymbolIcon,
  ScreenWatchSymbolIcon
} from './AppChromeSymbols'
import { ComposerThreadTimecodeBar } from './ComposerTimecodes'
import { FONT_STACKS, resolveComposerFontFamily } from '../lib/typefaceOptions'
import { composerGitActionUsesCommitIcon } from '../lib/composerGitActionIcon'
import type {
  AgenticServiceId,
  ComposerStyle,
  ExternalPathGrant,
  ProviderId,
  ThemeAppearance,
  WorkspaceRecord
} from '../../../main/store/types'
import { ComposerPlusPicker, type ComposerPlusPickerSection } from './ComposerPlusPicker'
import {
  CombinedModelPicker,
  type CombinedModelPickerProviderGroup
} from './CombinedModelPicker'
import {
  CombinedPermissionsPicker,
  type PermissionOption
} from './CombinedPermissionsPicker'
import { ContextMeterPopover } from './ContextMeterPopover'
import type { ContextMeterModel } from '../lib/contextMeter'
import { DEFAULT_AGENTIC_SERVICES } from '../lib/agenticServicesDefaults'
import { ComposerWorkspaceSwitcher } from './ComposerWorkspaceSwitcher'
import { CopyTranscriptButton, type CopyTranscriptResult } from './CopyTranscriptButton'

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
 * ONE metadata source, so the previews can no longer drift apart. The preview
 * mounts the live composer's first-class picker, context, workspace, transcript
 * copy, and timecode primitives beneath the same `.app-transcript` provider
 * scope as a real chat. Interactive regions are `inert`, so the real visual
 * implementations can render without touching active chat state.
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
    case 'chatgpt':
      // Preview-only. The ChatGPT shell is a Codex/Cursor cross — Codex
      // above-row chrome, flat Cursor capsule body — typically driven by the
      // Codex provider (hence the GPT model chip).
      return {
        providerLabel: 'ChatGPT',
        modelLabel: 'GPT-5.6-Sol',
        permissionLabel: 'Default Approval',
        placeholder: 'Message ChatGPT'
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
        modelLabel: 'K2.7 Coding Thinking',
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
    case 'chatgpt':
      return 'codex'
    default:
      return 'codex'
  }
}

function previewModelIdForStyle(style: ComposerStyle): string {
  switch (style) {
    case 'codex':
      return 'gpt-5.5'
    case 'chatgpt':
      return 'gpt-5.5'
    case 'claude':
      return 'claude-opus-4-8'
    case 'cursor':
      return 'composer-2.5'
    case 'grok':
      return 'grok-composer-2.5-fast'
    case 'gemini':
      return 'pro'
    case 'kimi':
      return 'kimi-k2.7-code'
    case 'terminal':
      return 'preview-shell'
    default:
      return 'preview-auto'
  }
}

function previewPermissionValueForStyle(style: ComposerStyle): string {
  if (style === 'codex') return 'full_access'
  if (style === 'claude') return 'plan'
  if (style === 'kimi') return 'read_only'
  return 'default'
}

const NOOP = (): void => {}
const EMPTY_GRANT_IDS = new Set<AgenticServiceId>()
const PREVIEW_PLUS_SECTIONS: ComposerPlusPickerSection[] = [
  {
    id: 'preview-add',
    title: 'Add',
    items: [
      {
        id: 'preview-attachment',
        label: 'Attachment',
        description: 'Add files or images',
        icon: <PlusSymbolIcon />,
        onSelect: NOOP
      }
    ]
  }
]
const PREVIEW_WORKSPACE: WorkspaceRecord = {
  id: 'preview-workspace',
  path: '/preview/workspace',
  displayName: 'Preview workspace',
  lastOpenedAt: 1,
  createdAt: 1,
  isGitRepo: true,
  branch: 'main',
  pinned: false
}
const PREVIEW_ADDITIONAL_GRANTS: ExternalPathGrant[] = [
  {
    id: 'preview-secondary-workspace',
    provider: 'codex',
    path: '/preview/secondary-workspace',
    kind: 'directory',
    access: 'write',
    duration: 'workspace',
    createdAt: '2026-07-11T00:00:00.000Z',
    order: 0
  }
]
const PREVIEW_COPY_RESULT: CopyTranscriptResult = {
  ok: true,
  messageCount: 2,
  charCount: 128,
  omissions: []
}
const copyPreviewTranscript = async (): Promise<CopyTranscriptResult> => PREVIEW_COPY_RESULT
const copyPreviewMessages = async (): Promise<CopyTranscriptResult> => PREVIEW_COPY_RESULT

/**
 * The send-button glyph mirrors the live composer's switch
 * (Composer.tsx — `claude` → return arrow, the pill-layout branded shells →
 * up-arrow, everything else → the native run glyph).
 */
function PreviewSendGlyph({ composerStyle }: { composerStyle: ComposerStyle }): React.ReactElement {
  if (composerStyle === 'claude') return <ClaudeReturnSymbolIcon />
  if (
    composerStyle === 'codex' ||
    composerStyle === 'chatgpt' ||
    composerStyle === 'gemini' ||
    composerStyle === 'cursor' ||
    composerStyle === 'grok' ||
    composerStyle === 'kimi'
  ) {
    return <ArrowUpSendIcon />
  }
  return <RunSymbolIcon />
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
   * `editable` (Settings) keeps the live `<textarea>` focusable so the user can
   * type sample text AND see `:focus-within` shell styling. Onboarding renders
   * the same textarea read-only beneath `inert`, preserving exact geometry
   * without adding controls to the sheet's focus trap.
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
  const previewModelId = previewModelIdForStyle(composerStyle)
  const previewPermissionValue = previewPermissionValueForStyle(composerStyle)
  const previewModelOptions = [{ id: previewModelId, label: meta.modelLabel }]
  const previewProviderGroups: CombinedModelPickerProviderGroup[] = [
    {
      provider: previewProviderId,
      label: meta.providerLabel,
      modelOptions: previewModelOptions
    }
  ]
  const previewPermissionOptions: PermissionOption[] = [
    { value: previewPermissionValue, label: meta.permissionLabel }
  ]
  const previewContextPercent = 24
  const previewContextLabel = '48k / 200k context'
  const previewContextMeter: ContextMeterModel = {
    solo: {
      id: 'solo',
      provider: previewProviderId,
      modelId: previewModelId,
      usedTokens: 48_000,
      windowTokens: 200_000,
      percent: previewContextPercent
    }
  }
  const aboveRowsFloatAboveStack = composerStyle === 'cursor' || composerStyle === 'codex'
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
  const workspaceAboveRow = (
    <div
      className={`composer-above-bar style-unified composer-workspace-above-row${
        aboveRowsFloatAboveStack ? ' composer-above-bar--cursor-lead' : ''
      }`}
      inert
      aria-hidden="true"
    >
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
        <button type="button" className={actionClassName}>
          {useGitIconAction ? <GitCommitSymbolIcon /> : previewActionLabel}
        </button>
      </div>
    </div>
  )

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
        className={`settings-composer-preview-chat app-transcript provider-${previewProviderId}`}
      >
        <div
          className={`composer-area settings-composer-preview-area interface-${composerStyle}`}
          aria-label={`${meta.providerLabel} composer preview`}
        >
          {aboveRowsFloatAboveStack && workspaceAboveRow}
          <div className="composer-above-bar-stack">
            {!aboveRowsFloatAboveStack && workspaceAboveRow}
          </div>
          <div className="composer-surface settings-composer-preview-surface">
            {/* The same always-mounted lens node as the live composer. Preview
                CSS only re-keys its optional lighting to this card's style. */}
            <div className="composer-refraction-lens" aria-hidden />
            <div className="composer-inner-module">
              <div
                className="composer-textarea-wrap"
                inert={editable ? undefined : true}
                aria-hidden={editable ? undefined : 'true'}
              >
                <textarea
                  className="composer-textarea settings-composer-preview-textarea"
                  value={value ?? ''}
                  onChange={editable ? (event) => onValueChange?.(event.target.value) : undefined}
                  placeholder={meta.placeholder}
                  rows={1}
                  readOnly={!editable}
                  tabIndex={editable ? undefined : -1}
                  aria-label={editable ? 'Composer font preview text' : undefined}
                  style={composerFontStyle}
                />
              </div>
              <div className="composer-bottom-controls">
                <div className="composer-control-footer settings-composer-preview-footer">
                  <div className="composer-inline-pickers" inert aria-hidden="true">
                    <div className="composer-inline-pickers-left">
                      <ComposerPlusPicker
                        provider={previewProviderId}
                        composerStyle={composerStyle}
                        sections={PREVIEW_PLUS_SECTIONS}
                        triggerIcon={<PlusSymbolIcon />}
                      />
                      {composerStyle === 'codex' && (
                        <ContextMeterPopover
                          meter={previewContextMeter}
                          percent={previewContextPercent}
                          label={previewContextLabel}
                          provider={previewProviderId}
                          composerStyle={composerStyle}
                        />
                      )}
                      <CombinedModelPicker
                        provider={previewProviderId}
                        composerStyle={composerStyle}
                        modelOptions={previewModelOptions}
                        selectedModelId={previewModelId}
                        onSelectModel={NOOP}
                        providerGroups={previewProviderGroups}
                        onSelectProviderModel={NOOP}
                        reasoningOptions={[]}
                        selectedReasoning={composerStyle === 'kimi' ? 'on' : ''}
                        onSelectReasoning={NOOP}
                        kimiThinkingEnabled={composerStyle === 'kimi'}
                      />
                      <CombinedPermissionsPicker
                        provider={previewProviderId}
                        composerStyle={composerStyle}
                        permissionOptions={previewPermissionOptions}
                        selectedPermission={previewPermissionValue}
                        onSelectPermission={NOOP}
                        grantServices={[]}
                        enabledGrantIds={EMPTY_GRANT_IDS}
                        agenticServices={DEFAULT_AGENTIC_SERVICES}
                        onToggleGrant={NOOP}
                      />
                    </div>
                    <div className="composer-inline-actions">
                      {composerStyle !== 'codex' && (
                        <ContextMeterPopover
                          meter={previewContextMeter}
                          percent={previewContextPercent}
                          label={previewContextLabel}
                          provider={previewProviderId}
                          composerStyle={composerStyle}
                        />
                      )}
                      <span className="composer-send-cluster">
                        <button
                          type="button"
                          className="composer-action-btn run-btn"
                          title="Run"
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
            {/* Match the live three-zone telemetry row: centre tools in DOM
                first, then the CSS-positioned left workspace and right tally. */}
            <div
              className="composer-telemetry-row"
              data-has-token-tally="true"
              inert
              aria-hidden="true"
            >
              <div className="composer-telemetry-cluster">
                <button
                  type="button"
                  className="composer-screen-watch-button composer-hint-pill"
                  data-hint-label="Screen Watch"
                  aria-label="Open Screen Watch picker"
                >
                  <ScreenWatchSymbolIcon />
                </button>
                <span className="composer-goal-control-wrap">
                  <button
                    type="button"
                    className="composer-goal-button composer-hint-pill is-idle"
                    data-hint-label="Goal"
                    aria-label="Set active goal"
                  >
                    <GoalSymbolIcon />
                  </button>
                </span>
                <CopyTranscriptButton
                  resetKey="composer-shell-preview"
                  composerStyle={composerStyle}
                  onCopy={copyPreviewTranscript}
                  onCopyMessages={copyPreviewMessages}
                />
              </div>
              <div className="composer-telemetry-side composer-telemetry-side--left">
                <ComposerWorkspaceSwitcher
                  workspaces={[PREVIEW_WORKSPACE]}
                  currentWorkspace={PREVIEW_WORKSPACE}
                  onPickExisting={NOOP}
                  onAddNewWorkspace={NOOP}
                  onSelectNoWorkspace={NOOP}
                  additionalGrants={PREVIEW_ADDITIONAL_GRANTS}
                  composerStyle={composerStyle}
                />
              </div>
              <div className="composer-telemetry-side composer-telemetry-side--right">
                <span className="composer-thread-token-tally">1.2M in / 5k out</span>
              </div>
            </div>
          </div>
          <ComposerThreadTimecodeBar running={false} startedAt={null} cumulativeBaseMs={0} />
        </div>
      </div>
    </div>
  )
}
