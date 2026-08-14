/**
 * The operator-facing seam for the Studio effect preview (a `.cube` LUT).
 *
 * *** THE PATH NEVER COMES FROM THE RENDERER. ***
 * `load` takes NO arguments. The only way a filesystem path enters this module
 * is `showOpenDialog` running in the main process, which means the operator
 * personally selected the file in a trusted OS dialog. That is enforced
 * structurally rather than by validation: there is no parameter to abuse, so a
 * compromised or confused renderer cannot name a file for the host to read.
 * Preserve that shape — adding a path argument would reintroduce exactly the
 * threat the import jail exists to prevent.
 *
 * This module owns no validation of its own. Bytes are bounded and verified by
 * StudioEffectPreviewSource, made durable by StudioRevisionStore, and delivered
 * by StudioCompanionSupervisor. All of that is already landed and tested; this
 * is the caller those layers never had.
 */
import {
  StudioEffectPreviewError,
  importStudioEffectPreview,
  resolveImportedEffectPreviewName
} from './StudioEffectPreviewSource'

export const STUDIO_EFFECT_PREVIEW_LOAD_CHANNEL = 'studio:effect-preview-load'
export const STUDIO_EFFECT_PREVIEW_CLEAR_CHANNEL = 'studio:effect-preview-clear'
export const STUDIO_EFFECT_PREVIEW_STATE_CHANNEL = 'studio:effect-preview-state'

/** What the toolbar renders. Carries a display name, never a path. */
export interface StudioEffectPreviewState {
  active: boolean
  /** The operator's original filename, or null when it cannot be recovered. */
  displayName: string | null
  effectId: string | null
}

export interface StudioEffectPreviewActionResult {
  ok: boolean
  /** True when the operator dismissed the file dialog; not a failure. */
  canceled?: boolean
  /** Exact machine-readable refusal reason, surfaced to the operator verbatim. */
  code?: string
  message?: string
  state: StudioEffectPreviewState
}

/**
 * The minimum of StudioProductionLifecycle this seam needs. Structural on
 * purpose: the real lifecycle satisfies it, and tests can drive it without
 * standing up a companion process.
 */
export interface StudioEffectPreviewLifecycleLike {
  readonly paths: { readonly effectPreviewRoot: string }
  readonly store: {
    getDocument(): { effectPreview: { effectId: string } | null }
  }
  setEffectPreview(cubePath: string | null): Promise<{
    ok: boolean
    code?: string
    message?: string
  }>
}

export interface StudioEffectPreviewOpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

export interface StudioEffectPreviewHandlerDeps {
  /** Null while Studio is disabled or the companion has not started. */
  getLifecycle: () => StudioEffectPreviewLifecycleLike | null
  /** Main-process file dialog. The ONLY source of a path in this module. */
  showOpenDialog: () => Promise<StudioEffectPreviewOpenDialogResult>
}

const INACTIVE: StudioEffectPreviewState = { active: false, displayName: null, effectId: null }

function readState(lifecycle: StudioEffectPreviewLifecycleLike): StudioEffectPreviewState {
  const preview = lifecycle.store.getDocument().effectPreview
  if (!preview) return INACTIVE
  return {
    active: true,
    displayName: resolveImportedEffectPreviewName(
      lifecycle.paths.effectPreviewRoot,
      preview.effectId
    ),
    effectId: preview.effectId
  }
}

export interface StudioEffectPreviewHandlers {
  /** Open the dialog, import the chosen `.cube`, and apply it. Takes no path. */
  load(): Promise<StudioEffectPreviewActionResult>
  clear(): Promise<StudioEffectPreviewActionResult>
  getState(): Promise<StudioEffectPreviewState>
}

export function createStudioEffectPreviewHandlers(
  deps: StudioEffectPreviewHandlerDeps
): StudioEffectPreviewHandlers {
  const unavailable = (): StudioEffectPreviewActionResult => ({
    ok: false,
    code: 'studio_unavailable',
    message: 'Studio is not running.',
    state: INACTIVE
  })

  return {
    async load(): Promise<StudioEffectPreviewActionResult> {
      const lifecycle = deps.getLifecycle()
      if (!lifecycle) return unavailable()

      const selection = await deps.showOpenDialog()
      const chosen = selection.canceled ? undefined : selection.filePaths[0]
      if (!chosen) {
        return { ok: true, canceled: true, state: readState(lifecycle) }
      }

      let imported
      try {
        imported = importStudioEffectPreview({
          sourcePath: chosen,
          destinationRoot: lifecycle.paths.effectPreviewRoot
        })
      } catch (error) {
        if (error instanceof StudioEffectPreviewError) {
          // A bad LUT is an ordinary operator mistake. Name the exact reason and
          // leave any previously applied preview untouched.
          return {
            ok: false,
            code: error.code,
            message: error.message,
            state: readState(lifecycle)
          }
        }
        throw error
      }

      const outcome = await lifecycle.setEffectPreview(imported.path)
      if (!outcome.ok) {
        return {
          ok: false,
          code: outcome.code ?? 'set_effect_preview_failed',
          message: outcome.message ?? 'The effect preview could not be applied.',
          state: readState(lifecycle)
        }
      }
      // Prefer the name the operator actually chose over re-deriving it from
      // disk, so the label is right even if the root is later swept.
      return {
        ok: true,
        state: {
          active: true,
          displayName: imported.displayName,
          effectId: imported.preview.effectId
        }
      }
    },

    async clear(): Promise<StudioEffectPreviewActionResult> {
      const lifecycle = deps.getLifecycle()
      if (!lifecycle) return unavailable()
      const outcome = await lifecycle.setEffectPreview(null)
      if (!outcome.ok) {
        return {
          ok: false,
          code: outcome.code ?? 'set_effect_preview_failed',
          message: outcome.message ?? 'The effect preview could not be cleared.',
          state: readState(lifecycle)
        }
      }
      return { ok: true, state: readState(lifecycle) }
    },

    async getState(): Promise<StudioEffectPreviewState> {
      const lifecycle = deps.getLifecycle()
      return lifecycle ? readState(lifecycle) : INACTIVE
    }
  }
}

/** Minimal `ipcMain` surface, so registration is testable without Electron. */
export interface StudioEffectPreviewIpcRegistrar {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void
}

/**
 * Register the three channels. Note that NONE of the listeners accept a payload
 * — that is the pathless contract, enforced at the boundary.
 */
export function registerStudioEffectPreviewHandlers(
  ipc: StudioEffectPreviewIpcRegistrar,
  deps: StudioEffectPreviewHandlerDeps
): StudioEffectPreviewHandlers {
  const handlers = createStudioEffectPreviewHandlers(deps)
  ipc.handle(STUDIO_EFFECT_PREVIEW_LOAD_CHANNEL, () => handlers.load())
  ipc.handle(STUDIO_EFFECT_PREVIEW_CLEAR_CHANNEL, () => handlers.clear())
  ipc.handle(STUDIO_EFFECT_PREVIEW_STATE_CHANNEL, () => handlers.getState())
  return handlers
}
