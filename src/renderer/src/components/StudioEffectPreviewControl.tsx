import { useCallback, useEffect, useState, type ReactNode } from 'react'

/**
 * The compact "LUT…" control for the video MediaPane toolbar.
 *
 * Preview-only: it reaches the already-landed bounded validator, durable store,
 * supervisor delivery and native adoption chain through three PATHLESS IPC
 * calls. The renderer never sees or supplies a filesystem path — main owns the
 * file dialog — so this component cannot be used to make the host read an
 * arbitrary file. Keep the no-argument shape.
 *
 * The state machine is deliberately separated from the view. The renderer test
 * environment renders to static markup with no DOM, so behaviour that matters
 * (retain-on-rejection, label selection) lives in exported pure functions that
 * are tested directly rather than being asserted through a simulated click.
 */

export interface StudioEffectPreviewState {
  active: boolean
  displayName: string | null
  effectId: string | null
}

export interface StudioEffectPreviewActionResult {
  ok: boolean
  canceled?: boolean
  code?: string
  message?: string
  state: StudioEffectPreviewState
}

export interface StudioEffectPreviewViewState {
  active: boolean
  displayName: string | null
  effectId: string | null
  /** Bounded, operator-readable reason for the last refusal, or null. */
  error: string | null
  busy: boolean
}

export const STUDIO_EFFECT_PREVIEW_IDLE: StudioEffectPreviewViewState = {
  active: false,
  displayName: null,
  effectId: null,
  error: null,
  busy: false
}

/** Readable text for the refusal codes the host can actually return. */
const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  studio_unavailable: 'Studio is not running.',
  not_a_cube_file: 'That file is not a .cube LUT.',
  symlink_refused: 'That file is a symbolic link.',
  not_a_regular_file: 'That is not a regular file.',
  empty_file: 'That .cube file is empty.',
  too_large: 'That .cube file is too large.',
  not_utf8: 'That .cube file is not valid UTF-8.',
  control_characters: 'That .cube file contains control characters.',
  missing_lut_3d_size: 'That .cube file has no LUT_3D_SIZE.',
  one_dimensional_lut: '1D LUTs are not supported.',
  unsupported_lut_size: 'That LUT size is not supported.',
  malformed_entry: 'That .cube file has a malformed entry.',
  non_finite_value: 'That .cube file contains a non-finite value.',
  entry_count_mismatch: 'That .cube file has the wrong number of entries.',
  import_failed: 'The LUT could not be imported.'
}

/**
 * Fold one action result into the visible state.
 *
 * The load-bearing rule: a REFUSED or CANCELLED load must retain the previously
 * applied LUT. A bad file is an ordinary mistake and must not silently drop a
 * grade the operator already had.
 */
export function applyStudioEffectPreviewResult(
  prior: StudioEffectPreviewViewState,
  result: StudioEffectPreviewActionResult
): StudioEffectPreviewViewState {
  if (!result.ok) {
    const code = result.code ?? 'unknown_error'
    return {
      active: prior.active,
      displayName: prior.displayName,
      effectId: prior.effectId,
      error: REFUSAL_TEXT[code] ?? result.message ?? code,
      busy: false
    }
  }
  if (result.canceled) {
    return { ...prior, error: null, busy: false }
  }
  return {
    active: result.state.active,
    displayName: result.state.displayName,
    effectId: result.state.effectId,
    error: null,
    busy: false
  }
}

/** Fold a hydrated (restart) state read into the visible state. */
export function adoptStudioEffectPreviewState(
  state: StudioEffectPreviewState
): StudioEffectPreviewViewState {
  return {
    active: state.active,
    displayName: state.displayName,
    effectId: state.effectId,
    error: null,
    busy: false
  }
}

/**
 * What the operator reads at rest. A restored LUT whose imported file has gone
 * still shows something honest rather than an empty label.
 */
export function studioEffectPreviewLabel(state: StudioEffectPreviewViewState): string {
  if (!state.active) return 'None'
  if (state.displayName) return state.displayName
  return state.effectId ? `${state.effectId.slice(0, 12)}…` : 'Active'
}

export interface StudioEffectPreviewApi {
  loadStudioEffectPreview: () => Promise<StudioEffectPreviewActionResult>
  clearStudioEffectPreview: () => Promise<StudioEffectPreviewActionResult>
  getStudioEffectPreviewState: () => Promise<StudioEffectPreviewState>
}

function hostApi(): StudioEffectPreviewApi | null {
  if (typeof window === 'undefined') return null
  const api = window.api as Partial<StudioEffectPreviewApi> | undefined
  if (
    !api?.loadStudioEffectPreview ||
    !api.clearStudioEffectPreview ||
    !api.getStudioEffectPreviewState
  ) {
    return null
  }
  return api as StudioEffectPreviewApi
}

export function StudioEffectPreviewControl({
  api,
  initialState = STUDIO_EFFECT_PREVIEW_IDLE
}: {
  /** Injected in tests; production reads the preload bridge. */
  api?: StudioEffectPreviewApi | null
  initialState?: StudioEffectPreviewViewState
}): ReactNode {
  const [state, setState] = useState<StudioEffectPreviewViewState>(initialState)
  const bridge = api ?? hostApi()

  // Re-query on mount so a restart-hydrated LUT is visible without the operator
  // touching anything. The durable state lives in the Studio document.
  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    void bridge
      .getStudioEffectPreviewState()
      .then((next) => {
        if (!cancelled) setState(adoptStudioEffectPreviewState(next))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [bridge])

  const runLoad = useCallback(() => {
    if (!bridge) return
    setState((prior) => ({ ...prior, busy: true }))
    void bridge
      .loadStudioEffectPreview()
      .then((result) => setState((prior) => applyStudioEffectPreviewResult(prior, result)))
      .catch((error: unknown) =>
        setState((prior) => ({ ...prior, busy: false, error: String(error) }))
      )
  }, [bridge])

  const runClear = useCallback(() => {
    if (!bridge) return
    setState((prior) => ({ ...prior, busy: true }))
    void bridge
      .clearStudioEffectPreview()
      .then((result) => setState((prior) => applyStudioEffectPreviewResult(prior, result)))
      .catch((error: unknown) =>
        setState((prior) => ({ ...prior, busy: false, error: String(error) }))
      )
  }, [bridge])

  const label = studioEffectPreviewLabel(state)

  return (
    <div className="studio-lut-control" data-lut-active={state.active ? 'true' : 'false'}>
      <span className="studio-lut-label" title={`LUT: ${label}`}>
        LUT: {label}
      </span>
      <button
        type="button"
        className="studio-lut-load"
        onClick={runLoad}
        disabled={state.busy || !bridge}
        title="Load a .cube LUT for preview"
      >
        Load .cube…
      </button>
      <button
        type="button"
        className="studio-lut-clear"
        onClick={runClear}
        disabled={state.busy || !bridge || !state.active}
        title="Clear the active LUT"
      >
        Clear LUT
      </button>
      {state.error ? (
        <span className="studio-lut-error" role="status">
          {state.error}
        </span>
      ) : null}
    </div>
  )
}
