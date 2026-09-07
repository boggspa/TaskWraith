/**
 * Settings UI option lists and pane/slider helpers — extracted from
 * `../SettingsPanel.tsx` (behavior-preserving move).
 *
 * Pure presentation data (option arrays, icon thumbnails) plus two stateless
 * helpers. No JSX, no React state; `SettingsPanel.tsx` imports the live-used
 * symbols back.
 */
import type React from 'react'
import type {
  AppSettings,
  CodexSandboxFallbackMode,
  ComposerStyle,
  FanoutLaneLayout,
  NativeSubAgentRequestPolicy,
  PromptSurfaceStyle,
  VisualEffectStyle
} from '../../../../main/store/types'
import type { AppIconVariant } from '../../../../shared/iconVariants'
import appIconRegularThumb from '../../assets/app-icons/regular.png'
import appIconMonolineThumb from '../../assets/app-icons/monoline.png'
import appIconGlassThumb from '../../assets/app-icons/glass.png'
import appIconLightMonolineThumb from '../../assets/app-icons/light-monoline.png'

export const CONTEXT_TURN_OPTIONS = [0, 2, 4, 6, 8, 10, 12, 16, 20]
export const clampPaneOpacity = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 100
}
export const rangeFillStyle = (value: number, min: number, max: number): React.CSSProperties => {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0
  return {
    '--ensemble-context-slider-fill': `${Math.max(0, Math.min(100, fill))}%`
  } as React.CSSProperties
}
export const VISUAL_EFFECT_OPTIONS: Array<{ value: VisualEffectStyle; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'liquid_glass', label: 'LiquidGlass' },
  { value: 'thin_material', label: 'ultraThinMaterial' },
  { value: 'classic', label: 'PoorMansGlassBackground' }
]
export const APP_ICON_THUMBS: Record<AppIconVariant, string> = {
  regular: appIconRegularThumb,
  monoline: appIconMonolineThumb,
  glass: appIconGlassThumb,
  lightMonoline: appIconLightMonolineThumb
}
export const PROMPT_SURFACE_OPTIONS: Array<{ value: PromptSurfaceStyle; label: string }> = [
  { value: 'theme', label: 'Follow theme' },
  { value: 'liquid_glass', label: 'Liquid glass' },
  { value: 'classic', label: 'Poor man glass' },
  { value: 'solid', label: 'Solid' }
]

export const FANOUT_LANE_LAYOUT_OPTIONS: Array<{ value: FanoutLaneLayout; label: string }> = [
  { value: 'stacked', label: 'One per line' },
  { value: 'paired', label: 'Two side by side' }
]
export const COMPOSER_STYLE_OPTIONS: Array<{
  value: ComposerStyle
  label: string
  helper: string
}> = [
  {
    value: 'default',
    label: 'TaskWraith native',
    helper: 'Provider chrome off; keep the existing TaskWraith shell.'
  },
  {
    value: 'codex',
    label: 'Codex shell',
    helper: 'Codex-like composer hierarchy.'
  },
  {
    value: 'chatgpt',
    label: 'ChatGPT shell',
    helper: 'Codex tucked-tab above-row with a flat Cursor-style capsule body and bottom rows.'
  },
  {
    value: 'claude',
    label: 'Claude shell',
    helper: 'Claude-like composer hierarchy.'
  },
  {
    value: 'cursor',
    label: 'Cursor shell',
    helper:
      'Flat neutral-gray Gemini-style pill composer — no glass or gradient effects, theme-immune.'
  },
  {
    value: 'grok',
    label: 'Grok shell',
    helper:
      'Monochrome Grok-like shell with Gemini-style pill layout and no glass or gradient effects.'
  },
  {
    value: 'gemini',
    label: 'Gemini shell',
    helper: 'Gemini-like minimal pill composer, centered welcome, blue focus glow.'
  },
  {
    value: 'kimi',
    label: 'Kimi shell',
    helper: 'Kimi-like dark rounded composer, blue accent, minimal sidebar.'
  },
  {
    value: 'modular',
    label: 'Modular',
    helper: 'Each composer element floats as its own pill — no grouped container.'
  },
  {
    value: 'terminal',
    label: 'Terminal',
    helper: 'Monospace command-line aesthetic with bracketed chips and a caret prompt.'
  },
  {
    value: 'stub',
    label: 'Ticket stub',
    helper: 'Paper-textured composer with a perforated separator above the textarea.'
  },
  {
    value: 'satellite',
    label: 'Satellite',
    helper: 'All containers invisible — every element floats freely on the page.'
  },
  /*
    1.0.5-EW55 — "Obsidian" composer style (renamed from EW54's
    `rimshine`). Pure black fill + crisp 1px white rim + slow rim
    chase animation + subtle white outer glow. Above-row siblings
    (Ensemble chip strip, queued messages, Create-PR, secondary
    workspace pill) inherit the same chrome + corner radius, so
    the composer area reads as one black-with-white-rim family.
  */
  {
    value: 'obsidian',
    label: 'Obsidian',
    helper:
      'Pure black fill with a crisp white rim highlight, slow rim shimmer chase, and matching chrome on the detached rows above.'
  },
  /*
    1.0.5-EW61 — "Alabaster" composer style. Polar inverse of
    obsidian: cream fill, charcoal 2px rim, slow black/charcoal
    rim-chase, warm-cream outer glow. Theme-immune subtree
    (locks light-mode tokens regardless of app theme).
  */
  {
    value: 'alabaster',
    label: 'Alabaster',
    helper:
      'Cream fill with a crisp charcoal rim, slow black rim shimmer chase, and matching chrome on the detached rows above.'
  }
]

export const NATIVE_SUB_AGENT_REQUEST_OPTIONS: Array<{
  value: NativeSubAgentRequestPolicy
  label: string
  helper: string
}> = [
  {
    value: 'ask',
    label: 'Ask',
    helper: 'Prompt on the first observable native sub-agent request.'
  },
  {
    value: 'provider',
    label: 'Provider',
    helper: 'Allow provider-native Task / invoke_agent style sub-agents.'
  },
  {
    value: 'taskwraith',
    label: 'TaskWraith',
    helper: 'Redirect native sub-agent requests to durable TaskWraith sub-threads.'
  }
]
export const CODEX_SANDBOX_FALLBACK_OPTIONS: Array<{
  value: CodexSandboxFallbackMode
  label: string
}> = [
  { value: 'ask_rerun', label: 'Ask to rerun outside sandbox' },
  { value: 'off', label: 'Off' }
]
export const FUN_FX_MODES: Array<{
  value: AppSettings['funFxMode']
  label: string
  helper: string
}> = [
  { value: 'off', label: 'Off', helper: 'No cinematic effects.' },
  { value: 'subtle', label: 'Subtle', helper: 'One effect layer with gentle motion.' },
  { value: 'cinematic', label: 'Cinematic', helper: 'Sky + ghost in synchronized balance.' },
  { value: 'epic', label: 'Epic', helper: 'Adds additional ambient scene accents.' }
]
