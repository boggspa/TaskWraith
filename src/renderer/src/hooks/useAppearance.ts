import { useState, useEffect, useLayoutEffect, useCallback } from 'react'
import type {
  AppSettings,
  AppearanceMode,
  ComposerStyle,
  PromptSurfaceStyle,
  ThemeAccentStyle,
  ThemeAppearance,
  ThemeCornerStyle,
  ToolIconAccent,
  UserBubbleColor,
  VisualEffectStyle
} from '../../../main/store/types'
import type { DiffStatColors } from '../../../shared/diffStatColors'
import type { AppIconVariant } from '../../../shared/iconVariants'
import { DEFAULT_DIFF_STAT_COLORS, normalizeDiffStatColors } from '../../../shared/diffStatColors'
import {
  normalizeAgentThemeTokenOverrides,
  type AgentThemeTokenOverrides
} from '../../../shared/agentThemeTokens'
import {
  normalizeSystemThemeAppearance,
  resolveSystemThemeAppearance
} from '../../../shared/systemThemeAppearance'
import {
  COMPOSER_FONT_MATCH_TRANSCRIPT,
  FONT_STACKS,
  normalizeComposerFontFamily,
  normalizeFontFamily,
  resolveComposerFontFamily
} from '../lib/typefaceOptions'
import { getLegacyFunFxSettingsFromLocalStorage, isFunFxMode } from '../lib/funFxSettings'
import { MIN_RIGHT_PANEL_WIDTH, MAX_RIGHT_PANEL_WIDTH } from '../lib/panelWidths'

const DEFAULT_ADVANCED_FX: AppSettings['advancedFx'] = {
  agentAura: true,
  livingWorkspace: true,
  dataViz: true,
  refraction: true,
  intensity: 'cinematic'
}

export interface AppearanceState {
  mode: AppearanceMode
  visualEffectStyle: VisualEffectStyle
  themeAppearance: ThemeAppearance
  themeCornerStyle: ThemeCornerStyle
  themeAccentStyle: ThemeAccentStyle
  toolIconAccent: ToolIconAccent
  userBubbleColor: UserBubbleColor
  diffStatColors: DiffStatColors
  agentThemeTokens: AgentThemeTokenOverrides
  appIconVariant: AppIconVariant
  promptSurfaceStyle: PromptSurfaceStyle
  composerStyle: ComposerStyle
  transcriptFontFamily: string
  composerFontFamily: string
  funFxEnabled: boolean
  funFxMode: AppSettings['funFxMode']
  advancedFx: AppSettings['advancedFx']
  reduceTransparency: boolean
  reduceMotion: boolean
  compactDensity: boolean
  liveActivityViewport: boolean
  showInspector: boolean
  inspectorWidth: number
  sidebarWidth: number
  sidebarOpacity: number
  mainPaneOpacity: number
  sidebarOpacityOverride: boolean
  mainPaneOpacityOverride: boolean
}

const DEFAULT_INSPECTOR_WIDTH = 380
const DEFAULT_SIDEBAR_WIDTH = 260
const DEFAULT_PANE_OPACITY = 100
// Single-source the inspector/right-dock width bounds from panelWidths so this
// normalize clamp can't silently drift below the resize handlers' ceiling. A
// stale local MAX of 720 previously re-clamped every dragged/keyboard width on
// each appearance.update(), so the dock could never grow past 720px on wide
// windows even though startRightPanelResize allows up to min(1120, 58vw).
const MIN_INSPECTOR_WIDTH = MIN_RIGHT_PANEL_WIDTH
const MAX_INSPECTOR_WIDTH = MAX_RIGHT_PANEL_WIDTH
const MIN_SIDEBAR_WIDTH = 220
const MAX_SIDEBAR_WIDTH = 440
const MIN_PANE_OPACITY = 0
const MAX_PANE_OPACITY = 100

const clampNumber = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.round(value)))

const normalizeAppearanceDimension = (
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number => {
  const parsed =
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : typeof value === 'string'
        ? Number(value)
        : fallback
  return Number.isFinite(parsed) ? clampNumber(parsed, min, max) : fallback
}

const normalizePaneOpacity = (value: unknown, fallback = DEFAULT_PANE_OPACITY): number =>
  normalizeAppearanceDimension(value, fallback, MIN_PANE_OPACITY, MAX_PANE_OPACITY)

export const resolvePaneOpacityFactor = (
  value: unknown,
  reduceTransparency: boolean
): number => (reduceTransparency ? 1 : normalizePaneOpacity(value) / 100)

const hostPlatform = (): string =>
  typeof window !== 'undefined' && typeof window.api?.hostPlatform === 'string'
    ? window.api.hostPlatform
    : 'unknown'

const resolveWindowMaterialAttribute = (
  next: Pick<AppearanceState, 'mode' | 'reduceTransparency'>,
  platform: string
): string => {
  const materialEnabled =
    (next.mode === 'native_glass' || next.mode === 'soft_glass') && !next.reduceTransparency
  if (!materialEnabled) return 'solid'
  if (platform === 'darwin') return 'mac-vibrancy'
  if (platform === 'win32') return 'win-mica'
  return 'css-glass'
}

function getInitialState(): AppearanceState {
  const reduceMotion =
    typeof window !== 'undefined'
      ? window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false
      : false
  const reduceTransparency =
    typeof window !== 'undefined'
      ? window.matchMedia?.('(prefers-reduced-transparency: reduce)').matches || false
      : false

  return {
    mode: 'soft_glass',
    visualEffectStyle: 'auto',
    themeAppearance: 'system',
    themeCornerStyle: 'rounded',
    themeAccentStyle: 'system',
    toolIconAccent: 'system',
    userBubbleColor: 'system',
    diffStatColors: DEFAULT_DIFF_STAT_COLORS,
    agentThemeTokens: {},
    appIconVariant: 'regular',
    promptSurfaceStyle: 'liquid_glass',
    composerStyle: 'default',
    transcriptFontFamily: FONT_STACKS.taskwraith,
    composerFontFamily: COMPOSER_FONT_MATCH_TRANSCRIPT,
    funFxEnabled: true,
    funFxMode: 'cinematic',
    advancedFx: DEFAULT_ADVANCED_FX,
    reduceTransparency,
    reduceMotion,
    compactDensity: false,
    liveActivityViewport: true,
    // Inspector open/closed is session chrome, not a persisted appearance preference.
    showInspector: false,
    inspectorWidth: DEFAULT_INSPECTOR_WIDTH,
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    sidebarOpacity: DEFAULT_PANE_OPACITY,
    mainPaneOpacity: DEFAULT_PANE_OPACITY,
    sidebarOpacityOverride: false,
    mainPaneOpacityOverride: false
  }
}

function normalizeAdvancedFx(
  value: Partial<AppSettings['advancedFx']> | undefined,
  fallbackIntensity: AppSettings['advancedFx']['intensity'] = DEFAULT_ADVANCED_FX.intensity
): AppSettings['advancedFx'] {
  const intensity =
    value?.intensity === 'subtle' || value?.intensity === 'cinematic' || value?.intensity === 'epic'
      ? value.intensity
      : fallbackIntensity

  return {
    agentAura: value?.agentAura ?? DEFAULT_ADVANCED_FX.agentAura,
    livingWorkspace: value?.livingWorkspace ?? DEFAULT_ADVANCED_FX.livingWorkspace,
    dataViz: value?.dataViz ?? DEFAULT_ADVANCED_FX.dataViz,
    refraction: value?.refraction ?? DEFAULT_ADVANCED_FX.refraction,
    intensity
  }
}

/**
 * Refractive "liquid glass" is a MATERIAL choice, independent of the "fun FX"
 * system (agent auras / weather). It is its own toggle, gated only on Reduce
 * Transparency (NOT Reduce Motion — the refraction is static, and NOT funFxEnabled
 * — a user who wants glass shouldn't have to also enable the cinematic FX layers).
 * Exported as a pure helper so the gating logic is unit-testable.
 */
export function resolveRefractionEnabled(input: {
  reduceTransparency: boolean
  refraction: boolean
}): boolean {
  return !input.reduceTransparency && input.refraction
}

export function useAppearance() {
  const [state, setState] = useState<AppearanceState>(getInitialState)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    window.api
      .getSettings()
      .then((settings: AppSettings) => {
        const legacyFunFx = getLegacyFunFxSettingsFromLocalStorage()
        const funFxMode = isFunFxMode(settings.funFxMode)
          ? settings.funFxMode
          : legacyFunFx.funFxMode
        const funFxEnabled =
          typeof settings.funFxEnabled === 'boolean'
            ? settings.funFxEnabled
            : legacyFunFx.funFxEnabled
        const themeAppearance = resolveSystemThemeAppearance(
          settings.themeAppearance,
          'system'
        ) as ThemeAppearance
        if (settings.themeAppearance && settings.themeAppearance !== themeAppearance) {
          window.api.updateSettings({ themeAppearance }).catch(() => {})
        }
        setState({
          mode: settings.appearanceMode || 'soft_glass',
          visualEffectStyle: settings.visualEffectStyle || 'auto',
          themeAppearance,
          themeCornerStyle: settings.themeCornerStyle || 'rounded',
          themeAccentStyle: settings.themeAccentStyle || 'system',
          toolIconAccent: settings.toolIconAccent || 'system',
          appIconVariant: settings.appIconVariant || 'regular',
          userBubbleColor: settings.userBubbleColor || 'system',
          diffStatColors: normalizeDiffStatColors(settings.diffStatColors),
          agentThemeTokens: normalizeAgentThemeTokenOverrides(settings.agentThemeTokens),
          promptSurfaceStyle: settings.promptSurfaceStyle || 'liquid_glass',
          composerStyle: settings.composerStyle || 'default',
          transcriptFontFamily: normalizeFontFamily(
            settings.transcriptFontFamily,
            FONT_STACKS.taskwraith
          ),
          composerFontFamily: normalizeComposerFontFamily(settings.composerFontFamily),
          funFxEnabled,
          funFxMode,
          advancedFx: normalizeAdvancedFx(
            settings.advancedFx,
            funFxMode === 'off' ? DEFAULT_ADVANCED_FX.intensity : funFxMode
          ),
          reduceTransparency: settings.reduceTransparency || getInitialState().reduceTransparency,
          reduceMotion: settings.reduceMotion || getInitialState().reduceMotion,
          compactDensity: settings.compactDensity || false,
          liveActivityViewport: settings.liveActivityViewport !== false,
          // Do not hydrate stale persisted `showInspector: true`; a cold launch should
          // start with the right dock closed until the user explicitly opens it.
          showInspector: false,
          inspectorWidth: normalizeAppearanceDimension(
            settings.inspectorWidth,
            DEFAULT_INSPECTOR_WIDTH,
            MIN_INSPECTOR_WIDTH,
            MAX_INSPECTOR_WIDTH
          ),
          sidebarWidth: normalizeAppearanceDimension(
            settings.sidebarWidth,
            DEFAULT_SIDEBAR_WIDTH,
            MIN_SIDEBAR_WIDTH,
            MAX_SIDEBAR_WIDTH
          ),
          sidebarOpacity: normalizePaneOpacity(settings.sidebarOpacity),
          mainPaneOpacity: normalizePaneOpacity(settings.mainPaneOpacity),
          sidebarOpacityOverride: Boolean(settings.sidebarOpacityOverride),
          mainPaneOpacityOverride: Boolean(settings.mainPaneOpacityOverride)
        })
        if (typeof settings.funFxEnabled !== 'boolean' || !isFunFxMode(settings.funFxMode)) {
          window.api
            .updateSettings({
              funFxEnabled,
              funFxMode
            })
            .catch(() => {})
        }
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [])

  const applyToDocument = useCallback((next: AppearanceState) => {
    const root = document.documentElement
    // 1.0.5-EW11 — Briefly disable all transitions when the
    // appearance MODE changes (Solid ↔ Soft Glass ↔ Native Glass).
    // Rapid mode-swaps + complex backdrop-filter transitions could
    // leave stale GPU layer tiles in the renderer, producing the
    // ghost-rectangle / overlay-bleed artifacts the maintainer caught while
    // stress-testing. By adding `is-appearance-transitioning` for
    // 150ms around the attribute swap, CSS transitions on backdrop
    // and background are skipped — the swap is instantaneous, no
    // mid-flight blur layers to glitch. Normal-cadence UX is
    // unaffected because the class is only on for the 150ms window.
    const prevAppearance = root.getAttribute('data-appearance')
    if (prevAppearance && prevAppearance !== next.mode) {
      root.classList.add('is-appearance-transitioning')
      window.setTimeout(() => {
        root.classList.remove('is-appearance-transitioning')
      }, 150)
    }
    root.setAttribute('data-appearance', next.mode)
    const platform = hostPlatform()
    root.setAttribute('data-platform', platform)
    root.setAttribute('data-window-material', resolveWindowMaterialAttribute(next, platform))
    root.setAttribute('data-visual-effect', next.visualEffectStyle)
    root.setAttribute('data-theme', next.themeAppearance)
    root.setAttribute('data-corners', next.themeCornerStyle)
    root.setAttribute('data-accent', next.themeAccentStyle)
    root.setAttribute('data-tool-icon-accent', next.toolIconAccent)
    root.setAttribute('data-user-bubble-color', next.userBubbleColor)
    root.style.setProperty('--diff-stat-add-color', next.diffStatColors.additions)
    root.style.setProperty('--diff-stat-del-color', next.diffStatColors.deletions)
    root.setAttribute('data-prompt-surface', next.promptSurfaceStyle)
    root.setAttribute('data-composer-style', next.composerStyle)
    // NOTE: `data-interface-style` used to mirror the composer shell onto the
    // whole app (transcript/sidebar/message-bubbles). That app-wide repaint was
    // retired — composer shells are purely composer chrome now, and the reading
    // surfaces follow the app theme only. The composer's own styling keys off
    // `data-composer-style` (above) and the `.composer-area.interface-*` class.
    root.setAttribute('data-reduce-transparency', String(next.reduceTransparency))
    root.setAttribute('data-reduce-motion', String(next.reduceMotion))
    root.setAttribute('data-fx-enabled', String(next.funFxEnabled))
    root.setAttribute('data-fx-mode', next.funFxMode)
    const sidebarOpacityFactor = resolvePaneOpacityFactor(
      next.sidebarOpacity,
      next.reduceTransparency
    )
    const mainPaneOpacityFactor = resolvePaneOpacityFactor(
      next.mainPaneOpacity,
      next.reduceTransparency
    )
    root.setAttribute(
      'data-sidebar-opacity-override',
      String(next.sidebarOpacityOverride || next.sidebarOpacity !== DEFAULT_PANE_OPACITY)
    )
    root.setAttribute(
      'data-main-pane-opacity-override',
      String(next.mainPaneOpacityOverride || next.mainPaneOpacity !== DEFAULT_PANE_OPACITY)
    )
    root.style.setProperty('--sidebar-opacity-factor', String(sidebarOpacityFactor))
    root.style.setProperty('--main-pane-opacity-factor', String(mainPaneOpacityFactor))
    root.style.setProperty('--sidebar-opacity-100', `${100 * sidebarOpacityFactor}%`)
    root.style.setProperty('--sidebar-opacity-88', `${88 * sidebarOpacityFactor}%`)
    root.style.setProperty('--sidebar-opacity-42', `${42 * sidebarOpacityFactor}%`)
    root.style.setProperty('--sidebar-opacity-36', `${36 * sidebarOpacityFactor}%`)
    root.style.setProperty('--sidebar-opacity-28', `${28 * sidebarOpacityFactor}%`)
    root.style.setProperty('--sidebar-alpha-048', String(0.48 * sidebarOpacityFactor))
    root.style.setProperty('--sidebar-alpha-042', String(0.42 * sidebarOpacityFactor))
    root.style.setProperty('--sidebar-alpha-036', String(0.36 * sidebarOpacityFactor))
    root.style.setProperty('--sidebar-alpha-034', String(0.34 * sidebarOpacityFactor))
    root.style.setProperty('--sidebar-alpha-028', String(0.28 * sidebarOpacityFactor))
    root.style.setProperty('--sidebar-alpha-026', String(0.26 * sidebarOpacityFactor))
    root.style.setProperty('--sidebar-alpha-024', String(0.24 * sidebarOpacityFactor))
    root.style.setProperty('--sidebar-alpha-022', String(0.22 * sidebarOpacityFactor))
    root.style.setProperty('--sidebar-alpha-020', String(0.2 * sidebarOpacityFactor))
    root.style.setProperty('--sidebar-alpha-018', String(0.18 * sidebarOpacityFactor))
    root.style.setProperty('--sidebar-alpha-014', String(0.14 * sidebarOpacityFactor))
    root.style.setProperty('--sidebar-alpha-010', String(0.1 * sidebarOpacityFactor))
    root.style.setProperty('--sidebar-alpha-006', String(0.06 * sidebarOpacityFactor))
    root.style.setProperty('--sidebar-alpha-002', String(0.02 * sidebarOpacityFactor))
    root.style.setProperty('--main-pane-opacity-100', `${100 * mainPaneOpacityFactor}%`)
    root.style.setProperty('--main-pane-opacity-60', `${60 * mainPaneOpacityFactor}%`)
    root.style.setProperty('--main-pane-alpha-086', String(0.86 * mainPaneOpacityFactor))
    root.setAttribute(
      'data-advanced-fx-agent-aura',
      String(next.funFxEnabled && !next.reduceMotion && next.advancedFx.agentAura)
    )
    root.setAttribute(
      'data-advanced-fx-living-workspace',
      String(next.funFxEnabled && !next.reduceMotion && next.advancedFx.livingWorkspace)
    )
    root.setAttribute(
      'data-advanced-fx-data-viz',
      String(next.funFxEnabled && !next.reduceMotion && next.advancedFx.dataViz)
    )
    root.setAttribute(
      'data-advanced-fx-refraction',
      String(
        resolveRefractionEnabled({
          reduceTransparency: next.reduceTransparency,
          refraction: next.advancedFx.refraction
        })
      )
    )
    root.setAttribute('data-advanced-fx-intensity', next.advancedFx.intensity)
    root.setAttribute('data-compact', String(next.compactDensity))
    const transcriptFontFamily = normalizeFontFamily(next.transcriptFontFamily, FONT_STACKS.taskwraith)
    const composerFontFamily = resolveComposerFontFamily(
      next.composerFontFamily,
      transcriptFontFamily
    )
    root.style.setProperty('--transcript-font-family', transcriptFontFamily)
    root.style.setProperty('--composer-font-family', composerFontFamily)
    root.style.setProperty('--inspector-width', `${next.inspectorWidth}px`)
    root.style.setProperty('--sidebar-width', `${next.sidebarWidth}px`)

    // Agent-set tokens are applied LAST and re-validated here, so a value that
    // reached settings from an older build (or any path that skipped the main
    // sanitiser) still cannot set an unlisted property or an out-of-range one.
    // Applied after --sidebar-width/--inspector-width on purpose: where an agent
    // override names the same token, the explicit agent instruction is what the
    // user asked for and wins over the stored slider value.
    const agentTokens = normalizeAgentThemeTokenOverrides(next.agentThemeTokens)
    for (const [token, value] of Object.entries(agentTokens)) {
      root.style.setProperty(`--${token}`, value)
    }
  }, [])

  useLayoutEffect(() => {
    if (loaded) {
      applyToDocument(state)
    }
  }, [state, loaded, applyToDocument])

  // Live-apply an agent restyle. Settings are otherwise read ONCE on mount, so
  // without this an agent write persists but nothing changes until a reload —
  // which for "ask the agent to round the corners" reads as the tool not
  // working. Folded into state (rather than poking the DOM directly) so the
  // normal apply path stays the single writer, and re-validated on arrival
  // because a renderer must not trust an IPC payload any more than stored data.
  useEffect(() => {
    const unsubscribe = window.api.onAgentThemeTokensChanged?.((tokens) => {
      setState((current) => ({
        ...current,
        agentThemeTokens: normalizeAgentThemeTokenOverrides(tokens)
      }))
    })
    return () => unsubscribe?.()
  }, [])

  const update = useCallback(
    (partial: Partial<AppearanceState>) => {
      setState((prev) => {
        const next = {
          ...prev,
          ...partial,
          diffStatColors: partial.diffStatColors
            ? normalizeDiffStatColors({
                ...prev.diffStatColors,
                ...partial.diffStatColors
              })
            : prev.diffStatColors,
          advancedFx: partial.advancedFx
            ? normalizeAdvancedFx(partial.advancedFx, prev.advancedFx.intensity)
            : prev.advancedFx
        }
        next.themeAppearance = normalizeSystemThemeAppearance(next.themeAppearance) as ThemeAppearance
        next.inspectorWidth = normalizeAppearanceDimension(
          next.inspectorWidth,
          DEFAULT_INSPECTOR_WIDTH,
          MIN_INSPECTOR_WIDTH,
          MAX_INSPECTOR_WIDTH
        )
        next.sidebarWidth = normalizeAppearanceDimension(
          next.sidebarWidth,
          DEFAULT_SIDEBAR_WIDTH,
          MIN_SIDEBAR_WIDTH,
          MAX_SIDEBAR_WIDTH
        )
        next.sidebarOpacity = normalizePaneOpacity(next.sidebarOpacity)
        next.mainPaneOpacity = normalizePaneOpacity(next.mainPaneOpacity)
        // Persist to store
        window.api
          .updateSettings({
            appearanceMode: next.mode,
            visualEffectStyle: next.visualEffectStyle,
            themeAppearance: next.themeAppearance,
            themeCornerStyle: next.themeCornerStyle,
            themeAccentStyle: next.themeAccentStyle,
            toolIconAccent: next.toolIconAccent,
            userBubbleColor: next.userBubbleColor,
            diffStatColors: next.diffStatColors,
            appIconVariant: next.appIconVariant,
            promptSurfaceStyle: next.promptSurfaceStyle,
            composerStyle: next.composerStyle,
            transcriptFontFamily: next.transcriptFontFamily,
            composerFontFamily: next.composerFontFamily,
            funFxEnabled: next.funFxEnabled,
            funFxMode: next.funFxMode,
            advancedFx: next.advancedFx,
            reduceTransparency: next.reduceTransparency,
            reduceMotion: next.reduceMotion,
            compactDensity: next.compactDensity,
            liveActivityViewport: next.liveActivityViewport,
            // Intentionally omit showInspector. The inspector dock is session-only;
            // inspectorWidth remains persisted below.
            inspectorWidth: next.inspectorWidth,
            sidebarWidth: next.sidebarWidth,
            sidebarOpacity: next.sidebarOpacity,
            mainPaneOpacity: next.mainPaneOpacity,
            sidebarOpacityOverride: next.sidebarOpacityOverride,
            mainPaneOpacityOverride: next.mainPaneOpacityOverride
          })
          .catch(() => {})
        // Notify main process for native vibrancy / reduced transparency
        if (partial.mode !== undefined || partial.reduceTransparency !== undefined) {
          window.api
            .setAppearanceMode({
              mode: next.mode,
              reduceTransparency: next.reduceTransparency
            })
            .catch(() => {})
        }
        applyToDocument(next)
        return next
      })
    },
    [applyToDocument]
  )

  // Non-persisting sibling of `update`: moves appearance STATE + document vars
  // for a live preview WITHOUT the settings.json write (and native IPC) that
  // `update` always issues. Used for per-keystroke font previews where the
  // draft commits to disk only on blur — so typing stays live but doesn't
  // thrash the disk. Never call this for values that must persist.
  const applyPreview = useCallback(
    (partial: Partial<AppearanceState>) => {
      setState((prev) => {
        const next = { ...prev, ...partial }
        applyToDocument(next)
        return next
      })
    },
    [applyToDocument]
  )

  useEffect(() => {
    const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const transparencyQuery = window.matchMedia?.('(prefers-reduced-transparency: reduce)')
    if (!motionQuery && !transparencyQuery) {
      return
    }

    const handlePreferenceChange = () => {
      setState((prev) => {
        const nextReduceMotion = prev.reduceMotion || motionQuery?.matches || false
        const nextReduceTransparency =
          prev.reduceTransparency || transparencyQuery?.matches || false
        // Skip the state update entirely when neither resolved value changes —
        // otherwise we return a fresh object reference, which fires the
        // applyToDocument effect and rewrites ~17 attributes on
        // documentElement, restarting any infinite CSS animations gated by
        // those attributes. macOS fires these matchMedia events on focus,
        // Mission Control, OS theme auto-switches, low-power-mode, etc.,
        // which the user perceived as "flicker out of nowhere".
        if (
          nextReduceMotion === prev.reduceMotion &&
          nextReduceTransparency === prev.reduceTransparency
        ) {
          return prev
        }
        return {
          ...prev,
          reduceMotion: nextReduceMotion,
          reduceTransparency: nextReduceTransparency
        }
      })
    }

    motionQuery?.addEventListener?.('change', handlePreferenceChange)
    transparencyQuery?.addEventListener?.('change', handlePreferenceChange)
    return () => {
      motionQuery?.removeEventListener?.('change', handlePreferenceChange)
      transparencyQuery?.removeEventListener?.('change', handlePreferenceChange)
    }
  }, [])

  return { ...state, update, applyPreview, loaded }
}
